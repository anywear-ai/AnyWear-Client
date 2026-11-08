// Contract and checks for the Client binary release pipeline (#278).
//
// `.github/workflows/client-release.yml` publishes a signed, immutable GitHub
// prerelease from a lightweight `client-vX.Y.Z` tag. This module owns the rules
// that workflow applies, in the same source-checked style as the repository's
// other guards:
//
//   - the tag contract (`client-vX.Y.Z`, lightweight only) and the release-level
//     monotonicity rule (strictly above the highest other `client-v*` tag);
//   - the four-state preflight machine (`absent`, `draft`, `published` with a
//     complete asset set, `published` with a gap);
//   - the declared-platform list and the asset set it requires;
//   - the 2 GiB single-file asset limit and the total the assembled set weighs;
//   - the GNU coreutils text-mode `SHA256SUMS` format, and the digest match that
//     the idempotent `published` rerun verifies against the release's own file;
//   - the per-platform, per-secret fail-closed message.
//
// Every rule is a pure function so `scripts/assert-client-release.node-test.mjs`
// exercises it from fixed input, without a tag, a runner or a network. The CLI
// (`node scripts/assert-client-release.mjs ...`) is the same rules wired to this
// checkout:
//
//   verify      offline: tag syntax + the committed release notes (the local gate)
//   preflight   offline: verify + lightweight tag + on main + monotonic + platforms
//   state       one bounded `gh` read: the four-state classification (+ duplicate),
//               and the checksum match when a published release is complete
//   assets      offline: the assembled directory has one asset per declared platform
//   sizes       offline: every asset is below 2 GiB, and the set's total is reported
//   checksums   offline: print the canonical SHA256SUMS, or verify a written one
//   inventory   offline: the release readback matches the declared set and checksums

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The only accepted release tag shape. Leading zeros are refused. */
export const RELEASE_TAG_PATTERN = /^client-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The committed release-notes directory, relative to the repository root. */
export const RELEASE_NOTES_DIRECTORY = 'docs/client-release-notes';

/** Every release note must carry this section heading, on its own line. */
export const KNOWN_ISSUES_HEADING = '## Known issues';

/**
 * The platforms this pipeline has reviewed. `android` joins the list only when
 * the tagged commit carries `src-tauri/gen/android`, which #279 produces.
 */
export const STATIC_PLATFORMS = ['windows', 'macos'];

/** The asset each declared platform must contribute, by release version. */
export function platformAssetNames(version) {
  return {
    windows: [`AnyWear-${version}-windows-x64-setup.exe`],
    macos: [`AnyWear-${version}-macos-universal.dmg`],
    android: [`AnyWear-${version}-android.apk`, `AnyWear-${version}-android.aab`],
  };
}

/** The assets every release carries, independent of the declared platforms. */
export const FIXED_ASSET_NAMES = ['build-metadata.json', 'RELEASE-NOTES.md', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'];

/** `SHA256SUMS` never lists itself or its attestation bundle. */
export const CHECKSUM_EXCLUDED_NAMES = ['SHA256SUMS', 'SHA256SUMS.sigstore.json'];

/** A `variables` entry: `<64 lowercase hex><two spaces><basename>`, text mode only. */
export const CHECKSUM_LINE_PATTERN = /^([0-9a-f]{64})  (\S+)$/;

export class ClientReleaseError extends Error {}

/** Parses and validates a release tag, returning its version components. */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(typeof tag === 'string' ? tag : '');
  if (!match) {
    throw new ClientReleaseError(
      `\`${typeof tag === 'string' ? tag : String(tag)}\` is not a client release tag; expected \`client-vX.Y.Z\` with three numeric components and no leading zero`,
    );
  }
  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}`,
    components: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

/** Negative, zero or positive, comparing two parsed release versions. */
export function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.components[index] !== right.components[index]) return left.components[index] - right.components[index];
  }
  return 0;
}

/** The highest well-formed `client-v*` tag, or null when there is none. */
export function highestReleaseTag(tags) {
  const parsed = tags
    .filter((tag) => RELEASE_TAG_PATTERN.test(tag))
    .map((tag) => parseReleaseTag(tag));
  if (parsed.length === 0) return null;
  parsed.sort(compareReleaseVersions);
  return parsed[parsed.length - 1].tag;
}

/**
 * The release-level monotonicity rule: the candidate is strictly above the
 * highest *other* `client-v*` tag. Equality is refused, because one version may
 * be published only once. `existingTags` excludes the tag being published: a
 * rerun on that tag is the four-state machine's case, not this rule's.
 */
export function assertReleaseMonotonic({ tag, existingTags }) {
  const candidate = parseReleaseTag(tag);
  const highest = highestReleaseTag(existingTags);
  if (highest === null) return { tag, highest: null };
  const highestVersion = parseReleaseTag(highest);
  if (compareReleaseVersions(candidate, highestVersion) <= 0) {
    throw new ClientReleaseError(
      `\`${tag}\` is not strictly above the highest existing client release \`${highest}\`; equality would publish the same version twice, so cut a higher patch version`,
    );
  }
  return { tag, highest };
}

/** Refuses annotated tags, and anything that is not a commit at the tag ref. */
export function assertLightweightTag({ tag, objectType }) {
  if (objectType === 'commit') return { tag, objectType };
  if (objectType === 'tag') {
    throw new ClientReleaseError(
      `\`${tag}\` is an annotated tag; this repository publishes from lightweight tags only (\`git tag ${tag} <commit>\`)`,
    );
  }
  throw new ClientReleaseError(`\`${tag}\` resolves to a \`${objectType ?? 'missing'}\` object, not a commit`);
}

/** The committed release-notes path for a tag, relative to the repository root. */
export function releaseNotesPath(tag) {
  return `${RELEASE_NOTES_DIRECTORY}/${tag}.md`;
}

/** Refuses a missing, empty or heading-less release-notes file. */
export function assertReleaseNotes(root, tag) {
  const relativePath = releaseNotesPath(tag);
  const absolutePath = join(root, RELEASE_NOTES_DIRECTORY, `${tag}.md`);
  if (!existsSync(absolutePath)) {
    throw new ClientReleaseError(`the release notes file \`${relativePath}\` is missing; commit it before tagging`);
  }
  const text = readFileSync(absolutePath, 'utf8');
  if (text.trim() === '') {
    throw new ClientReleaseError(`the release notes file \`${relativePath}\` is empty; it must be non-empty Markdown`);
  }
  if (!new RegExp(`^${KNOWN_ISSUES_HEADING}$`, 'm').test(text)) {
    throw new ClientReleaseError(`the release notes file \`${relativePath}\` must contain a \`${KNOWN_ISSUES_HEADING}\` section`);
  }
  return absolutePath;
}

/** The reviewed platform list for this checkout; `android` needs #279's project. */
export function declaredPlatforms(root = process.cwd()) {
  const platforms = [...STATIC_PLATFORMS];
  if (existsSync(join(root, 'src-tauri', 'gen', 'android'))) platforms.push('android');
  return platforms;
}

/** Every asset the declared platforms and the fixed set require. */
export function expectedAssetNames(version, platforms) {
  const byPlatform = platformAssetNames(version);
  const names = [];
  for (const platform of platforms) {
    const platformNames = byPlatform[platform];
    if (!platformNames) throw new ClientReleaseError(`\`${platform}\` is not a declared release platform (windows, macos, android)`);
    names.push(...platformNames);
  }
  names.push(...FIXED_ASSET_NAMES);
  return names;
}

/** The platform an asset name belongs to, for a named error. */
export function platformOfAssetName(name) {
  if (name.includes('-windows-')) return 'windows';
  if (name.includes('-macos-')) return 'macos';
  if (name.includes('-android.')) return 'android';
  return 'fixed';
}

/** Refuses an assembled asset set that is missing a declared platform's file. */
export function assertDeclaredAssets({ version, declaredPlatforms: platforms, assetNames }) {
  const present = new Set(assetNames);
  const missing = expectedAssetNames(version, platforms)
    .filter((name) => !present.has(name) && platformOfAssetName(name) !== 'fixed');
  if (missing.length === 0) return [];
  const byPlatform = new Map();
  for (const name of missing) {
    const platform = platformOfAssetName(name);
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(name);
  }
  const detail = [...byPlatform].map(([platform, names]) => `\`${platform}\`: ${names.join(', ')}`).join('; ');
  throw new ClientReleaseError(`the assembled asset set is missing a declared platform artifact (${detail})`);
}

/** GitHub Releases' single-file upload limit for one release asset: 2 GiB. */
export const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

/** The name and size of every file in one assembled directory. */
export function assetSizes(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, size: statSync(join(directory, entry.name)).size }));
}

/**
 * Refuses an asset above the single-file limit and reports the set's total.
 * `assets` is fixed input (`[{ name, size }]`), so the rule is testable without
 * writing a 2 GiB file; `assemble` runs it over the directory it is about to
 * upload.
 */
export function assertAssetSizes({ assets, limit = MAX_RELEASE_ASSET_BYTES }) {
  const oversized = assets.filter((asset) => asset.size > limit);
  if (oversized.length > 0) {
    const detail = oversized.map((asset) => `\`${asset.name}\` is ${asset.size} bytes`).join('; ');
    throw new ClientReleaseError(`a release asset is above the ${limit}-byte single-file limit: ${detail}`);
  }
  return {
    count: assets.length,
    total: assets.reduce((sum, asset) => sum + asset.size, 0),
  };
}

/**
 * The four-state preflight classification.
 *
 * `release` is the `gh release view` shape (`isDraft`, `isPrerelease`, `tagName`,
 * `assets: [{name}]`), or null when the tag has no release. `published` is
 * complete only when its asset names equal the declared set exactly.
 */
export function classifyReleaseState({ tag, release, declaredPlatforms: platforms, version }) {
  if (release === null || release === undefined) {
    return { state: 'absent', complete: false, missing: [], extra: [] };
  }
  if (release.isDraft === true) {
    return { state: 'draft', complete: false, missing: [], extra: [] };
  }
  const releaseVersion = version ?? parseReleaseTag(tag).version;
  const expected = expectedAssetNames(releaseVersion, platforms);
  const actual = (release.assets ?? []).map((asset) => (typeof asset === 'string' ? asset : asset.name));
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const expectedSet = new Set(expected);
  const extra = [...actualSet].filter((name) => !expectedSet.has(name)).sort();
  return {
    state: 'published',
    complete: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

/** Refuses a second `client-v*` release for a commit that already has one. */
export function duplicateReleaseViolation({ tag, commit, releases }) {
  if (typeof commit !== 'string' || commit === '') return null;
  const duplicate = (releases ?? []).find((release) => release.tag !== tag && release.commit === commit);
  if (!duplicate) return null;
  return `commit \`${commit}\` already has the client release \`${duplicate.tag}\`; cut a distinct patch version instead of re-tagging the same commit`;
}

/** Refuses a tag whose commit is not in the `main` history. */
export function assertCommitIsOnMain({ tag, commit, mainCommit, isAncestor }) {
  if (typeof commit !== 'string' || commit === '') {
    throw new ClientReleaseError(`the tag \`${tag}\` does not resolve to a commit`);
  }
  if (typeof mainCommit !== 'string' || mainCommit === '') {
    throw new ClientReleaseError('`origin/main` is not available in this checkout; fetch it before preflight');
  }
  if (isAncestor !== true) {
    throw new ClientReleaseError(`the commit \`${commit}\` of \`${tag}\` is not in the \`main\` history; only a tag on main can be published`);
  }
}

/** The named, fail-closed message a platform job emits for a missing secret. */
export function missingCredentialMessage(platform, secret) {
  return `::error::${secret} is not configured; a ${platform} release artifact cannot be produced`;
}

/** Computes the SHA-256 of every file in a directory, for `SHA256SUMS`. */
export function checksumEntries(directory) {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !CHECKSUM_EXCLUDED_NAMES.includes(entry.name))
    .map((entry) => entry.name);
  return names.map((name) => ({
    digest: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
    name,
  }));
}

/** Formats entries as coreutils text-mode `SHA256SUMS`, sorted with `LC_ALL=C`. */
export function formatChecksums(entries) {
  return entries
    .map(({ digest, name }) => `${digest}  ${name}`)
    .sort()
    .join('\n')
    .concat('\n');
}

/**
 * Validates a `SHA256SUMS` file's six rules and returns its entries:
 * `<64 lowercase hex><two spaces><basename>` per line, LF line endings,
 * `LC_ALL=C` line order, no header/comment/directory prefix, no entry for itself
 * (or its attestation bundle), and never the `*` binary flag.
 */
export function assertChecksumText(text) {
  const violations = [];
  if (typeof text !== 'string' || text === '') {
    throw new ClientReleaseError('SHA256SUMS is empty');
  }
  if (text.includes('\r')) {
    throw new ClientReleaseError('SHA256SUMS contains a carriage return; the file must use LF line endings');
  }
  if (!text.endsWith('\n')) {
    violations.push('must end with an LF newline');
  }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  const entries = [];
  lines.forEach((line, index) => {
    const number = index + 1;
    if (/^[0-9a-f]{64} \*/.test(line)) {
      violations.push(`line ${number} uses the binary \`*\` flag; SHA256SUMS must use text mode`);
      return;
    }
    if (line.startsWith('#')) {
      violations.push(`line ${number} is a comment; SHA256SUMS must carry no header or comment`);
      return;
    }
    const match = CHECKSUM_LINE_PATTERN.exec(line);
    if (!match) {
      violations.push(`line ${number} is not \`<64 lowercase hex><two spaces><basename>\`: \`${line}\``);
      return;
    }
    const [, digest, name] = match;
    if (name.startsWith('*')) {
      violations.push(`line ${number} uses the binary \`*\` flag; SHA256SUMS must use text mode`);
      return;
    }
    if (name.includes('/') || name.includes('\\')) {
      violations.push(`line ${number} names \`${name}\`, not a basename; SHA256SUMS must carry no directory prefix`);
      return;
    }
    if (CHECKSUM_EXCLUDED_NAMES.includes(name)) {
      violations.push(`line ${number} names \`${name}\`; SHA256SUMS must not list itself or its attestation bundle`);
      return;
    }
    entries.push({ digest, name });
  });
  const sorted = [...lines].sort();
  if (lines.some((line, index) => line !== sorted[index])) {
    violations.push('the lines are not in `LC_ALL=C sort` order');
  }
  if (violations.length > 0) {
    throw new ClientReleaseError(`SHA256SUMS is not in the published format: ${violations.join('; ')}`);
  }
  return entries;
}

/** The SHA-256 of one downloaded file, or a named failure when it is absent. */
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    throw new ClientReleaseError(`the release has no \`${basename(path)}\`; its SHA256SUMS cannot be verified`);
  }
}

/**
 * The digest rule of the idempotent rerun: every line of the release's own
 * `SHA256SUMS` must match the downloaded bytes, or the published state is not a
 * green no-op. Fixed input, so the node test covers match, mismatch and absence.
 */
export function verifyChecksumSet({ checksums, digests }) {
  const violations = [];
  for (const { digest, name } of checksums) {
    const actual = digests instanceof Map ? digests.get(name) : digests[name];
    if (actual === undefined) violations.push(`\`${name}\` is not part of the download`);
    else if (actual !== digest) violations.push(`\`${name}\` does not match SHA256SUMS`);
  }
  if (violations.length > 0) {
    throw new ClientReleaseError(`the published release does not match its own SHA256SUMS: ${violations.join('; ')}`);
  }
  return checksums.length;
}

/** Downloads one release's assets; injectable so the node test needs no network. */
export function downloadPublishedRelease({ repo, tag, directory, gh = runGh }) {
  const result = gh(['release', 'download', tag, '--repo', repo, '--dir', directory]);
  if (result.status !== 0) {
    throw new ClientReleaseError(`\`gh release download ${tag} --repo ${repo}\` failed: ${ghDetail(result) || `exit ${result.status}`}`);
  }
}

/**
 * Verifies a published release against its own `SHA256SUMS` with read-only
 * permissions. `download` and `hash` are injectable: the CLI passes the real `gh
 * release download` and SHA-256 reader, and the node test supplies fixed bytes.
 */
export function verifyPublishedReleaseChecksums({
  repo,
  tag,
  download = downloadPublishedRelease,
  hash = sha256File,
}) {
  const directory = mkdtempSync(join(tmpdir(), 'client-release-published-'));
  try {
    download({ repo, tag, directory });
    const checksumsPath = join(directory, 'SHA256SUMS');
    if (!existsSync(checksumsPath)) {
      throw new ClientReleaseError(`the published release \`${tag}\` has no \`SHA256SUMS\` asset; the idempotent rerun cannot verify its bytes`);
    }
    const checksums = assertChecksumText(readFileSync(checksumsPath, 'utf8'));
    const digests = new Map(checksums.map(({ name }) => [name, hash(join(directory, name))]));
    return verifyChecksumSet({ checksums, digests });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assetNamesOf(view) {
  return (view.assets ?? []).map((asset) => (typeof asset === 'string' ? asset : asset.name));
}

/**
 * Refuses a release readback that is not in the state `expect` names, does not
 * name the tag, or whose asset set differs from the checksum list and the
 * declared platform set.
 */
export function assertReleaseView({ tag, view, expect, declaredPlatforms: platforms, checksums }) {
  const violations = [];
  if (view.tagName !== tag) violations.push(`the release names tag \`${view.tagName}\`, not \`${tag}\``);
  if (expect === 'draft') {
    if (view.isDraft !== true) violations.push('the release is not a draft before the flip');
  } else if (expect === 'published') {
    if (view.isDraft !== false) violations.push('the release is still a draft after the flip');
    if (view.isPrerelease !== true) violations.push('the release is not marked as a prerelease after the flip');
  } else {
    throw new ClientReleaseError(`\`${expect}\` is not a release state; expected draft or published`);
  }
  const declared = new Set([...checksums.map((entry) => entry.name), ...CHECKSUM_EXCLUDED_NAMES]);
  const actual = assetNamesOf(view);
  const actualSet = new Set(actual);
  const missing = [...declared].filter((name) => !actualSet.has(name)).sort();
  const extra = actual.filter((name) => !declared.has(name)).sort();
  if (missing.length > 0) violations.push(`the release is missing ${missing.join(', ')}`);
  if (extra.length > 0) violations.push(`the release carries unexpected assets ${extra.join(', ')}`);
  try {
    assertDeclaredAssets({ version: parseReleaseTag(tag).version, declaredPlatforms: platforms, assetNames: actual });
  } catch (failure) {
    violations.push(failure.message);
  }
  if (violations.length > 0) {
    throw new ClientReleaseError(`the ${expect} release \`${tag}\` does not match the declared inventory: ${violations.join('; ')}`);
  }
  return { tag, assets: actual };
}

/** Runs one git command in `root` and returns stdout, trimming the trailing newline. */
function gitText(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new ClientReleaseError(`git ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new ClientReleaseError(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout.trim();
}

/** Whether one git command in `root` exits 0. */
function gitSucceeds(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status === 0;
}

/**
 * The offline half of preflight. It reads only this checkout: the tag object,
 * the tag list, `origin/main` and the committed release notes. It reads no
 * secret and does not fail when signing credentials are absent.
 */
export function preflightFromCheckout({ tag, root = process.cwd() }) {
  const parsed = parseReleaseTag(tag);
  assertReleaseNotes(root, tag);
  const objectType = gitText(root, ['cat-file', '-t', `refs/tags/${tag}`]);
  assertLightweightTag({ tag, objectType });
  const otherTags = gitText(root, ['tag', '--list', 'client-v*'])
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '' && name !== tag);
  assertReleaseMonotonic({ tag, existingTags: otherTags });
  const commit = gitText(root, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  const mainCommit = gitSucceeds(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])
    ? gitText(root, ['rev-parse', 'refs/remotes/origin/main^{commit}'])
    : '';
  const isAncestor = mainCommit !== '' && gitSucceeds(root, ['merge-base', '--is-ancestor', commit, mainCommit]);
  assertCommitIsOnMain({ tag, commit, mainCommit, isAncestor });
  const platforms = declaredPlatforms(root);
  return { version: parsed.version, platforms, android: platforms.includes('android'), commit };
}

/** Runs one bounded `gh` command. The runner is injectable for the node test. */
function runGh(args) {
  return spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 });
}

function ghDetail(result) {
  return `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
}

/**
 * The four-state release check. It reads GitHub through `gh` only: one
 * `gh release view` for this tag, one `gh release list` for the duplicate-commit
 * rule, and — when a published release is complete — one `gh release download`
 * followed by the release's own `SHA256SUMS` check, which is what makes the
 * idempotent rerun a verified no-op rather than a name comparison. `gh`, `git`
 * and the checksum verifier are injectable, and the classification itself is
 * `classifyReleaseState`, so the node test needs no network.
 */
export function readReleaseState({
  repo,
  tag,
  declaredPlatforms: platforms,
  root = process.cwd(),
  gh = runGh,
  git = (args) => gitText(root, args),
  verifyChecksums = (options) => verifyPublishedReleaseChecksums(options),
}) {
  const view = gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,isPrerelease,tagName,assets']);
  let release = null;
  if (view.status !== 0) {
    const detail = ghDetail(view);
    if (!/not found/i.test(detail)) {
      throw new ClientReleaseError(`\`gh release view ${tag} --repo ${repo}\` failed: ${detail === '' ? `exit ${view.status}` : detail}`);
    }
  } else {
    release = JSON.parse(view.stdout);
  }
  const classification = classifyReleaseState({ tag, release, declaredPlatforms: platforms });
  if (classification.state === 'published') {
    if (!classification.complete) {
      const detail = [
        ...classification.missing.map((name) => `missing ${name}`),
        ...classification.extra.map((name) => `unexpected ${name}`),
      ].join(', ');
      throw new ClientReleaseError(
        `the published release \`${tag}\` does not match the declared asset set (${detail}); an immutable release cannot be patched in place, so withdraw it and cut a new patch version`,
      );
    }
    // A published release with a complete asset set is a green rerun only when the
    // bytes still match the published checksums; the tag cannot move, so this is a
    // check of the release, not of the build.
    verifyChecksums({ repo, tag });
  }
  const listing = gh(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName']);
  if (listing.status !== 0) {
    throw new ClientReleaseError(`\`gh release list --repo ${repo}\` failed: ${ghDetail(listing) || `exit ${listing.status}`}`);
  }
  const commit = git(['rev-parse', 'HEAD']);
  const releases = [];
  for (const { tagName } of JSON.parse(listing.stdout)) {
    try {
      releases.push({ tag: tagName, commit: git(['rev-parse', `refs/tags/${tagName}^{commit}`]) });
    } catch {
      // A release whose tag is absent from this checkout cannot claim the commit.
    }
  }
  const duplicate = duplicateReleaseViolation({ tag, commit, releases });
  if (duplicate !== null) throw new ClientReleaseError(duplicate);
  return classification;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new ClientReleaseError(`unexpected argument \`${argument}\``);
    const name = argument.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ClientReleaseError(`\`${argument}\` requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === '') throw new ClientReleaseError(`\`--${name}\` is required`);
  return value;
}

function splitPlatforms(text) {
  return text.split(',').map((platform) => platform.trim()).filter((platform) => platform !== '');
}

/**
 * CLI entry point. `verify` is the offline gate the Development stage runs; the
 * other commands are the same rules wired to this checkout for the workflow.
 */
export async function main({
  argv = process.argv.slice(2),
  root = process.cwd(),
  log = console.log,
  error = console.error,
  write = (text) => process.stdout.write(text),
} = {}) {
  try {
    const [command, ...rest] = argv;
    const options = parseOptions(rest);
    const commandRoot = options.root === undefined ? root : resolve(options.root);
    switch (command) {
      case 'verify': {
        const tag = requireOption(options, 'tag');
        const parsed = parseReleaseTag(tag);
        assertReleaseNotes(commandRoot, tag);
        log(`client release tag ${tag} is well formed (${parsed.version})`);
        log(`release notes ${releaseNotesPath(tag)} carry the \`${KNOWN_ISSUES_HEADING}\` section`);
        return 0;
      }
      case 'preflight': {
        const tag = requireOption(options, 'tag');
        const result = preflightFromCheckout({ tag, root: commandRoot });
        log(`version=${result.version}`);
        log(`platforms=${result.platforms.join(',')}`);
        log(`android=${result.android}`);
        return 0;
      }
      case 'state': {
        const tag = requireOption(options, 'tag');
        const platforms = splitPlatforms(requireOption(options, 'platforms'));
        const repo = options.repo ?? 'anywear-ai/AnyWear-Client';
        const classification = readReleaseState({ repo, tag, declaredPlatforms: platforms, root: commandRoot });
        log(`state=${classification.state}`);
        return 0;
      }
      case 'assets': {
        const version = requireOption(options, 'version');
        const platforms = splitPlatforms(requireOption(options, 'platforms'));
        const directory = resolve(commandRoot, options.directory ?? '.');
        const names = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
        assertDeclaredAssets({ version, declaredPlatforms: platforms, assetNames: names });
        log(`every declared platform (${platforms.join(', ')}) has an asset in ${options.directory ?? '.'}`);
        return 0;
      }
      case 'sizes': {
        const directory = resolve(commandRoot, options.directory ?? '.');
        const limit = options.limit === undefined ? MAX_RELEASE_ASSET_BYTES : Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new ClientReleaseError(`\`--limit\` must be a positive integer, found \`${options.limit}\``);
        }
        const result = assertAssetSizes({ assets: assetSizes(directory), limit });
        log(`${result.count} release asset(s), ${result.total} byte(s) total, each at or below ${limit} bytes`);
        return 0;
      }
      case 'checksums': {
        if (options.verify !== undefined) {
          const file = resolve(commandRoot, options.verify);
          const entries = assertChecksumText(readFileSync(file, 'utf8'));
          log(`${options.verify} lists ${entries.length} file(s) in the coreutils text format`);
          return 0;
        }
        const directory = resolve(commandRoot, options.directory ?? '.');
        write(formatChecksums(checksumEntries(directory)));
        return 0;
      }
      case 'inventory': {
        const tag = requireOption(options, 'tag');
        const expect = requireOption(options, 'expect');
        const platforms = splitPlatforms(requireOption(options, 'platforms'));
        const view = JSON.parse(readFileSync(resolve(commandRoot, requireOption(options, 'view')), 'utf8'));
        const checksums = assertChecksumText(readFileSync(resolve(commandRoot, requireOption(options, 'checksums')), 'utf8'));
        assertReleaseView({ tag, view, expect, declaredPlatforms: platforms, checksums });
        log(`the ${expect} release ${tag} matches the declared platform and checksum inventory`);
        return 0;
      }
      default:
        throw new ClientReleaseError(`unknown command \`${command ?? ''}\`; expected verify, preflight, state, assets, checksums or inventory`);
    }
  } catch (failure) {
    error(failure instanceof Error ? `::error::${failure.message}` : `::error::${String(failure)}`);
    process.exitCode = 1;
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
