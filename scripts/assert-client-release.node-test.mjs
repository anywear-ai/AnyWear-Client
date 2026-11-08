// Offline tests for the Client binary release contract (#278).
//
// The pipeline is tag-triggered, so the rules it applies must be provable without
// a tag, a certificate or a network. Every case here is fixed input: the tag
// grammar, the lightweight-tag rule, release-level monotonicity, the declared
// platform set read from `client-release-platforms.json`, the four-state release
// classification, the declared-platform/asset comparison, the release-notes
// contract including its `## Platform availability` section, the six
// `SHA256SUMS` format rules, and the per-platform fail-closed message. The one
// CLI case spawns the real script against the real checkout, which is exactly the
// Development gate:
//
//   node scripts/assert-client-release.mjs verify --tag client-v0.2.0
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKSUM_EXCLUDED_NAMES,
  ClientReleaseError,
  FIXED_ASSET_NAMES,
  MAX_RELEASE_ASSET_BYTES,
  assertAssetSizes,
  assertChecksumText,
  assertCommitIsOnMain,
  assertDeclaredAssets,
  assertLightweightTag,
  assertReleaseMonotonic,
  assertReleaseNotes,
  assertReleaseView,
  assetSizes,
  checksumEntries,
  classifyReleaseState,
  compareReleaseVersions,
  declaredPlatforms,
  duplicateReleaseViolation,
  expectedAssetNames,
  formatChecksums,
  highestReleaseTag,
  missingCredentialMessage,
  parseReleaseTag,
  platformAssetNames,
  platformOfAssetName,
  readReleaseState,
  releaseNotesPath,
  verifyChecksumSet,
  verifyPublishedReleaseChecksums,
} from './assert-client-release.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const allPlatforms = ['windows', 'macos', 'android'];
const platformLabels = {
  windows: '- **Windows:**',
  macos: '- **macOS:**',
  android: '- **Android:**',
};

/** One `## Platform availability` line; free reason text may follow the value. */
function availabilityLine(platform, value) {
  return `${platformLabels[platform]} ${value}`;
}

/** The release-notes fixture in the house shape, with an availability block. */
function releaseNotes({ platforms = allPlatforms, availability, knownIssues = true } = {}) {
  const lines = availability ?? allPlatforms.map((platform) => (
    platforms.includes(platform)
      ? availabilityLine(platform, 'published: fixture artifact')
      : availabilityLine(platform, 'not_published (platform_not_enabled, fixture)')
  ));
  return [
    '# 0.2.0',
    '',
    '## Platform availability',
    '',
    ...lines,
    '',
    ...(knownIssues ? ['## Known issues', '', '- none'] : []),
    '',
  ].join('\n');
}

/** Matches a `ClientReleaseError` whose message contains every fragment. */
function messageIncludes(...fragments) {
  return (failure) => (
    failure instanceof ClientReleaseError && fragments.every((fragment) => failure.message.includes(fragment))
  );
}

/**
 * A temporary repository root: the release notes the caller writes and the
 * committed platform configuration. Every fixture therefore carries the
 * configuration the guard reads, and a configuration that declares `android`
 * carries the project that declaration requires.
 */
function temporaryRoot(files = {}, config = { schema_version: 1, declared_platforms: ['android'] }) {
  const root = mkdtempSync(join(tmpdir(), 'client-release-'));
  mkdirSync(join(root, 'docs', 'client-release-notes'), { recursive: true });
  if (config !== null) {
    writeFileSync(join(root, 'client-release-platforms.json'), `${JSON.stringify(config, null, 2)}\n`);
    const declared = Array.isArray(config.declared_platforms) ? config.declared_platforms : [];
    if (declared.includes('android')) {
      mkdirSync(join(root, 'src-tauri', 'gen', 'android'), { recursive: true });
    }
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'docs', 'client-release-notes', name), content);
  }
  return root;
}

/** Runs the CLI against `root`; returns status and the joined output. */
function runCli(args, root = repositoryRoot) {
  const result = spawnSync(process.execPath, ['scripts/assert-client-release.mjs', ...args, '--root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('the release tag grammar accepts only client-vX.Y.Z without leading zeros', () => {
  for (const tag of ['client-v0.1.0', 'client-v12.0.3', 'client-v0.0.0', 'client-v10.20.30']) {
    assert.equal(parseReleaseTag(tag).version, tag.slice('client-v'.length), `${tag} must be accepted`);
  }
  for (const tag of ['client-v1.2', 'client-v1.2.3.4', 'client-v01.2.3', 'client-v1.02.3', 'client-v1.2.03', 'client-v-1.2.3', 'v1.2.3', 'client-v1.2.3-rc.1', '']) {
    assert.throws(() => parseReleaseTag(tag), new RegExp('is not a client release tag'), `${tag} must be refused`);
  }
});

test('only a lightweight tag is a release identity', () => {
  assert.deepEqual(assertLightweightTag({ tag: 'client-v0.1.0', objectType: 'commit' }), { tag: 'client-v0.1.0', objectType: 'commit' });
  assert.throws(
    () => assertLightweightTag({ tag: 'client-v0.1.0', objectType: 'tag' }),
    /`client-v0\.1\.0` is an annotated tag; this repository publishes from lightweight tags only/,
  );
  assert.throws(() => assertLightweightTag({ tag: 'client-v0.1.0', objectType: 'blob' }), /resolves to a `blob` object, not a commit/);
});

test('the release version must be strictly above the highest other client-v* tag', () => {
  assert.equal(highestReleaseTag(['client-v0.1.0', 'client-v0.10.0', 'client-v0.9.0']), 'client-v0.10.0');
  assert.equal(highestReleaseTag([]), null);
  assert.equal(
    compareReleaseVersions(parseReleaseTag('client-v0.10.0'), parseReleaseTag('client-v0.9.0')),
    1,
    'numeric, not lexical, ordering',
  );

  assert.deepEqual(assertReleaseMonotonic({ tag: 'client-v0.3.0', existingTags: ['client-v0.2.0'] }), {
    tag: 'client-v0.3.0',
    highest: 'client-v0.2.0',
  });
  assert.deepEqual(assertReleaseMonotonic({ tag: 'client-v0.1.0', existingTags: [] }), { tag: 'client-v0.1.0', highest: null });
  for (const [tag, existing] of [
    ['client-v0.2.0', ['client-v0.2.0']],
    ['client-v0.1.9', ['client-v0.2.0']],
    ['client-v0.9.0', ['client-v0.10.0']],
  ]) {
    assert.throws(
      () => assertReleaseMonotonic({ tag, existingTags: existing }),
      /is not strictly above the highest existing client release/,
      `${tag} against ${existing.join(', ')} must be refused`,
    );
  }
});

test('a release note must exist, be non-empty and carry the Known issues heading', () => {
  const platforms = allPlatforms;
  const config = { schema_version: 1, declared_platforms: platforms };
  const good = temporaryRoot({ 'client-v0.1.0.md': releaseNotes() }, config);
  assert.equal(assertReleaseNotes(good, 'client-v0.1.0', platforms), join(good, releaseNotesPath('client-v0.1.0')));

  const missing = temporaryRoot({}, config);
  assert.throws(
    () => assertReleaseNotes(missing, 'client-v0.1.0', platforms),
    /the release notes file `docs\/client-release-notes\/client-v0\.1\.0\.md` is missing/,
  );

  const empty = temporaryRoot({ 'client-v0.1.0.md': '  \n' }, config);
  assert.throws(() => assertReleaseNotes(empty, 'client-v0.1.0', platforms), /is empty/);

  const headingless = temporaryRoot({
    'client-v0.1.0.md': '# 0.1.0\n\n## Platform availability\n\n- **Windows:** published\n- **macOS:** published\n- **Android:** published\n',
  }, config);
  assert.throws(
    () => assertReleaseNotes(headingless, 'client-v0.1.0', platforms),
    /must contain a `## Known issues` section/,
  );

  // The landed revision must satisfy the gate the issue names.
  const landedPlatforms = declaredPlatforms(repositoryRoot);
  assert.ok(assertReleaseNotes(repositoryRoot, 'client-v0.2.0', landedPlatforms));
});

test('the Platform availability section must state each platform consistently with the configuration', () => {
  const platforms = ['android'];
  const config = { schema_version: 1, declared_platforms: platforms };

  const good = temporaryRoot({ 'client-v0.2.0.md': releaseNotes({ platforms }) }, config);
  assert.equal(assertReleaseNotes(good, 'client-v0.2.0', platforms), join(good, releaseNotesPath('client-v0.2.0')));

  const sectionless = temporaryRoot({ 'client-v0.2.0.md': '# 0.2.0\n\n## Known issues\n\n- none\n' }, config);
  assert.throws(
    () => assertReleaseNotes(sectionless, 'client-v0.2.0', platforms),
    messageIncludes('`## Platform availability`', 'must contain'),
  );

  const missingLine = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({
      platforms,
      availability: [
        availabilityLine('windows', 'not_published (platform_not_enabled, deferred)'),
        availabilityLine('android', 'published: fixture artifact'),
      ],
    }),
  }, config);
  assert.throws(
    () => assertReleaseNotes(missingLine, 'client-v0.2.0', platforms),
    messageIncludes('`## Platform availability`', '`- **macOS:**`', 'no'),
  );

  const duplicateLine = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({
      platforms,
      availability: [
        availabilityLine('windows', 'not_published (platform_not_enabled, deferred)'),
        availabilityLine('macos', 'not_published (platform_not_enabled, deferred)'),
        availabilityLine('android', 'published: fixture artifact'),
        availabilityLine('android', 'published: fixture artifact again'),
      ],
    }),
  }, config);
  assert.throws(
    () => assertReleaseNotes(duplicateLine, 'client-v0.2.0', platforms),
    messageIncludes('repeats', '`- **Android:**`'),
  );

  const unknownLabel = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({
      platforms,
      availability: [
        availabilityLine('windows', 'not_published (platform_not_enabled, deferred)'),
        availabilityLine('macos', 'not_published (platform_not_enabled, deferred)'),
        availabilityLine('android', 'published: fixture artifact'),
        '- **Linux:** published: not a release platform',
      ],
    }),
  }, config);
  assert.throws(
    () => assertReleaseNotes(unknownLabel, 'client-v0.2.0', platforms),
    messageIncludes('`- **Linux:**`', 'accepts only'),
  );

  // Android is declared, so its line may not say it was not published.
  const declaredNotPublished = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({ platforms: [] }),
  }, config);
  assert.throws(
    () => assertReleaseNotes(declaredNotPublished, 'client-v0.2.0', platforms),
    messageIncludes('`- **Android:**`', 'is declared by', 'must begin `published`'),
  );

  // Windows is not declared, so its line may not claim it was published.
  const undeclaredPublished = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({ platforms: allPlatforms }),
  }, config);
  assert.throws(
    () => assertReleaseNotes(undeclaredPublished, 'client-v0.2.0', platforms),
    messageIncludes('`- **Windows:**`', 'is not declared by', 'not_published (platform_not_enabled'),
  );

  // Every accepted line may carry free reason text after the required prefix.
  const withReason = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({
      platforms,
      availability: [
        availabilityLine('windows', 'not_published (platform_not_enabled, Windows signing is deferred for this Beta)'),
        availabilityLine('macos', 'not_published (platform_not_enabled, macOS credentials are not provisioned)'),
        availabilityLine('android', 'published: a signed APK for direct installation'),
      ],
    }),
  }, config);
  assert.equal(assertReleaseNotes(withReason, 'client-v0.2.0', platforms), join(withReason, releaseNotesPath('client-v0.2.0')));
});

test('the four preflight states classify absent, draft, complete and gapped releases', () => {
  const tag = 'client-v0.1.0';
  const platforms = ['windows', 'macos'];
  const complete = expectedAssetNames('0.1.0', platforms).map((name) => ({ name }));

  assert.deepEqual(
    classifyReleaseState({ tag, release: null, declaredPlatforms: platforms }),
    { state: 'absent', complete: false, missing: [], extra: [] },
  );
  assert.deepEqual(
    classifyReleaseState({ tag, release: { isDraft: true, isPrerelease: true, tagName: tag, assets: [] }, declaredPlatforms: platforms }),
    { state: 'draft', complete: false, missing: [], extra: [] },
  );
  assert.deepEqual(
    classifyReleaseState({ tag, release: { isDraft: false, isPrerelease: true, tagName: tag, assets: complete }, declaredPlatforms: platforms }),
    { state: 'published', complete: true, missing: [], extra: [] },
  );

  const missingOne = complete.filter((asset) => !asset.name.includes('-macos-'));
  const gapped = classifyReleaseState({
    tag,
    release: { isDraft: false, isPrerelease: true, tagName: tag, assets: missingOne },
    declaredPlatforms: platforms,
  });
  assert.equal(gapped.state, 'published');
  assert.equal(gapped.complete, false);
  assert.deepEqual(gapped.missing, ['AnyWear-0.1.0-macos-universal.dmg']);

  const extra = classifyReleaseState({
    tag,
    release: { isDraft: false, isPrerelease: true, tagName: tag, assets: [...complete, { name: 'stray.exe' }] },
    declaredPlatforms: platforms,
  });
  assert.equal(extra.complete, false);
  assert.deepEqual(extra.extra, ['stray.exe']);
});

test('the state reader verifies a published release’s own checksums and adopts a draft', () => {
  const tag = 'client-v0.1.0';
  const platforms = ['windows', 'macos'];
  const complete = expectedAssetNames('0.1.0', platforms).map((name) => ({ name }));
  const git = () => 'f'.repeat(40);
  const verified = [];
  const runtime = (view, releases = []) => ({
    gh: (args) => {
      if (args[1] === 'view') return view;
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(releases.map((tagName) => ({ tagName }))), stderr: '' };
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    },
    git,
    verifyChecksums: (options) => {
      verified.push(options);
      return 0;
    },
  });

  const absent = runtime({ status: 1, stdout: '', stderr: 'release not found' });
  assert.equal(readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...absent }).state, 'absent');
  assert.deepEqual(verified, [], 'an absent release has no checksums to verify');

  const draft = runtime({ status: 0, stdout: JSON.stringify({ isDraft: true, isPrerelease: true, tagName: tag, assets: [] }), stderr: '' });
  assert.equal(readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...draft }).state, 'draft');
  assert.deepEqual(verified, [], 'a draft is adopted, not verified');

  const published = runtime({
    status: 0,
    stdout: JSON.stringify({ isDraft: false, isPrerelease: true, tagName: tag, assets: complete }),
    stderr: '',
  });
  assert.equal(readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...published }).state, 'published');
  assert.deepEqual(verified, [{ repo: 'anywear-ai/AnyWear-Client', tag }], 'a complete published release is verified before ending green');

  const mismatch = runtime({
    status: 0,
    stdout: JSON.stringify({ isDraft: false, isPrerelease: true, tagName: tag, assets: complete }),
    stderr: '',
  });
  mismatch.verifyChecksums = () => {
    throw new ClientReleaseError('the published release does not match its own SHA256SUMS: `build-metadata.json` does not match SHA256SUMS');
  };
  assert.throws(
    () => readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...mismatch }),
    /does not match its own SHA256SUMS/,
  );

  const gapped = runtime({
    status: 0,
    stdout: JSON.stringify({ isDraft: false, isPrerelease: true, tagName: tag, assets: complete.slice(0, 2) }),
    stderr: '',
  });
  assert.throws(
    () => readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...gapped }),
    /immutable release cannot be patched in place/,
  );

  const duplicate = runtime(
    { status: 0, stdout: JSON.stringify({ isDraft: true, isPrerelease: true, tagName: tag, assets: [] }), stderr: '' },
    ['client-v0.0.9'],
  );
  assert.throws(
    () => readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...duplicate }),
    /already has the client release `client-v0\.0\.9`/,
  );

  const failed = runtime({ status: 1, stdout: '', stderr: 'HTTP 502' });
  assert.throws(
    () => readReleaseState({ repo: 'anywear-ai/AnyWear-Client', tag, declaredPlatforms: platforms, ...failed }),
    /gh release view client-v0\.1\.0 --repo anywear-ai\/AnyWear-Client` failed/,
    'a failed read must not look like an absent release',
  );
});

test('a declared platform with no artifact stops assembly', () => {
  const platforms = ['windows', 'macos'];
  const complete = expectedAssetNames('0.1.0', platforms);
  assert.deepEqual(assertDeclaredAssets({ version: '0.1.0', declaredPlatforms: platforms, assetNames: complete }), []);

  for (const platform of platforms) {
    const assetNames = complete.filter((name) => platformOfAssetName(name) !== platform);
    assert.throws(
      () => assertDeclaredAssets({ version: '0.1.0', declaredPlatforms: platforms, assetNames }),
      new RegExp(`missing a declared platform artifact \\(\\\`${platform}\\\``),
      `a missing ${platform} artifact must fail`,
    );
  }

  assert.throws(
    () => assertDeclaredAssets({ version: '0.1.0', declaredPlatforms: ['windows', 'macos', 'android'], assetNames: complete }),
    /declared platform artifact \(`android`: AnyWear-0\.1\.0-android\.apk, AnyWear-0\.1\.0-android\.aab\)/,
  );

  assert.deepEqual(platformAssetNames('0.1.0').android, ['AnyWear-0.1.0-android.apk', 'AnyWear-0.1.0-android.aab']);
  assert.deepEqual(FIXED_ASSET_NAMES, ['build-metadata.json', 'RELEASE-NOTES.md', 'SHA256SUMS', 'SHA256SUMS.sigstore.json']);
});

test('an AnyWear asset for an undeclared platform is refused', () => {
  const platforms = ['android'];
  const androidOnly = [
    'AnyWear-0.2.0-android.apk',
    'AnyWear-0.2.0-android.aab',
    'build-metadata.json',
    'RELEASE-NOTES.md',
  ];
  assert.deepEqual(assertDeclaredAssets({ version: '0.2.0', declaredPlatforms: platforms, assetNames: androidOnly }), []);

  // A copied desktop asset names both the platform and the file in the refusal.
  for (const [name, platform] of [
    ['AnyWear-0.2.0-windows-x64-setup.exe', 'windows'],
    ['AnyWear-0.2.0-macos-universal.dmg', 'macos'],
  ]) {
    assert.throws(
      () => assertDeclaredAssets({ version: '0.2.0', declaredPlatforms: platforms, assetNames: [...androidOnly, name] }),
      messageIncludes(platform, name, 'does not declare'),
      `an undeclared ${platform} asset must fail`,
    );
  }

  // An unknown `AnyWear-*` name is still this check's business; a plain extra file is not.
  assert.throws(
    () => assertDeclaredAssets({ version: '0.2.0', declaredPlatforms: platforms, assetNames: [...androidOnly, 'AnyWear-0.2.0-linux.AppImage'] }),
    messageIncludes('AnyWear-0.2.0-linux.AppImage', 'names no release platform'),
  );
  assert.deepEqual(
    assertDeclaredAssets({ version: '0.2.0', declaredPlatforms: platforms, assetNames: [...androidOnly, 'stray.txt'] }),
    [],
    'an unrelated non-AnyWear file is left to publish’s inventory readback',
  );
});

test('every release asset is below the 2 GiB single-file limit and the total is reported', () => {
  const underLimit = [
    { name: 'AnyWear-0.1.0-windows-x64-setup.exe', size: 80 * 1024 * 1024 },
    { name: 'AnyWear-0.1.0-macos-universal.dmg', size: MAX_RELEASE_ASSET_BYTES - 1 },
  ];
  assert.equal(MAX_RELEASE_ASSET_BYTES, 2 * 1024 * 1024 * 1024);
  assert.deepEqual(assertAssetSizes({ assets: underLimit }), {
    count: 2,
    total: 80 * 1024 * 1024 + MAX_RELEASE_ASSET_BYTES - 1,
  });
  assert.deepEqual(assertAssetSizes({ assets: [{ name: 'small.bin', size: 99 }], limit: 100 }), { count: 1, total: 99 });

  // GitHub requires every file to be *under* 2 GiB: the boundary itself refuses.
  assert.throws(
    () => assertAssetSizes({ assets: [{ name: 'exact.bin', size: MAX_RELEASE_ASSET_BYTES }] }),
    /`exact\.bin` is 2147483648 bytes/,
  );
  assert.throws(
    () => assertAssetSizes({ assets: [...underLimit, { name: 'huge.exe', size: MAX_RELEASE_ASSET_BYTES + 1 }] }),
    /`huge\.exe` is 2147483649 bytes/,
  );
  assert.throws(
    () => assertAssetSizes({ assets: [{ name: 'over.bin', size: 100 }], limit: 100 }),
    /is not below the 100-byte single-file limit: `over\.bin` is 100 bytes/,
  );

  const directory = mkdtempSync(join(tmpdir(), 'client-sizes-'));
  writeFileSync(join(directory, 'a.bin'), 'a');
  writeFileSync(join(directory, 'b.bin'), 'bb');
  assert.deepEqual(assertAssetSizes({ assets: assetSizes(directory) }), { count: 2, total: 3 });
});

test('the published rerun verifies the release’s own SHA256SUMS against the downloaded bytes', () => {
  const contents = {
    'AnyWear-0.1.0-windows-x64-setup.exe': 'windows-bytes',
    'build-metadata.json': '{"schema_version":3}',
  };
  const checksums = Object.entries(contents).map(([name, text]) => ({
    digest: createHash('sha256').update(text).digest('hex'),
    name,
  }));
  const checksumText = formatChecksums(checksums);
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const downloadWriting = (overrides = {}) => ({ directory }) => {
    writeFileSync(join(directory, 'SHA256SUMS'), checksumText);
    for (const [name, text] of Object.entries(contents)) {
      writeFileSync(join(directory, name), overrides[name] ?? text);
    }
  };

  assert.equal(
    verifyPublishedReleaseChecksums({ repo: 'anywear-ai/AnyWear-Client', tag: 'client-v0.1.0', download: downloadWriting(), hash }),
    2,
    'matching bytes are the only green outcome',
  );
  assert.throws(
    () => verifyPublishedReleaseChecksums({
      repo: 'anywear-ai/AnyWear-Client',
      tag: 'client-v0.1.0',
      download: downloadWriting({ 'build-metadata.json': '{"schema_version":3,"tampered":true}' }),
      hash,
    }),
    /`build-metadata\.json` does not match SHA256SUMS/,
  );
  assert.throws(
    () => verifyPublishedReleaseChecksums({
      repo: 'anywear-ai/AnyWear-Client',
      tag: 'client-v0.1.0',
      download: ({ directory }) => {
        writeFileSync(join(directory, 'build-metadata.json'), '{"schema_version":3}');
      },
      hash,
    }),
    /has no `SHA256SUMS` asset; the idempotent rerun cannot verify its bytes/,
  );

  assert.throws(
    () => verifyChecksumSet({ checksums, digests: new Map([['build-metadata.json', checksums[1].digest]]) }),
    /`AnyWear-0\.1\.0-windows-x64-setup\.exe` is not part of the download/,
  );
});

test('the checksum format accepts the canonical text and refuses each of the six rule breaks', () => {
  const entries = [
    { digest: hashA, name: 'AnyWear-0.1.0-windows-x64-setup.exe' },
    { digest: hashB, name: 'build-metadata.json' },
  ];
  const canonical = formatChecksums(entries);
  assert.equal(
    canonical,
    `${hashA}  AnyWear-0.1.0-windows-x64-setup.exe\n${hashB}  build-metadata.json\n`,
    'two spaces, one line per file, LF, `LC_ALL=C` line order',
  );
  assert.deepEqual(assertChecksumText(canonical), entries);

  // 1. `<64 lowercase hex><two spaces><basename>`.
  for (const line of [
    `${hashA} AnyWear.exe\n`,
    `${hashA}   AnyWear.exe\n`,
    `${'A'.repeat(64)}  AnyWear.exe\n`,
    `${'a'.repeat(63)}  AnyWear.exe\n`,
    `sha256sum output\n`,
  ]) {
    assert.throws(() => assertChecksumText(line), /not `<64 lowercase hex><two spaces><basename>`/, line.trim());
  }
  // 2. LF line endings.
  assert.throws(() => assertChecksumText(`${hashA}  a.exe\r\n`), /carriage return; the file must use LF line endings/);
  assert.throws(() => assertChecksumText(`${hashA}  a.exe`), /must end with an LF newline/);
  // 3. `LC_ALL=C sort` order.
  assert.throws(() => assertChecksumText(`${hashB}  b.exe\n${hashA}  a.exe\n`), /not in `LC_ALL=C sort` order/);
  // 4. No header, no comment, no directory prefix.
  assert.throws(() => assertChecksumText(`# generated\n${hashA}  a.exe\n`), /is a comment/);
  assert.throws(() => assertChecksumText(`${hashA}  release-assets/a.exe\n`), /not a basename/);
  assert.throws(() => assertChecksumText(`${hashA}  nested\\a.exe\n`), /not a basename/);
  // 5. No line for itself or its attestation bundle.
  for (const name of CHECKSUM_EXCLUDED_NAMES) {
    assert.throws(() => assertChecksumText(`${hashA}  ${name}\n`), /must not list itself or its attestation bundle/, name);
  }
  // 6. Never the `*` binary flag.
  assert.throws(() => assertChecksumText(`${hashA} *a.exe\n`), /binary `\*` flag/);
  assert.throws(() => assertChecksumText(`${hashA}  *a.exe\n`), /binary `\*` flag/);
});

test('the checksum generator lists files, never the sums file, and round-trips', () => {
  const directory = mkdtempSync(join(tmpdir(), 'client-sums-'));
  writeFileSync(join(directory, 'AnyWear-0.1.0-macos-universal.dmg'), 'image');
  writeFileSync(join(directory, 'build-metadata.json'), '{}');
  writeFileSync(join(directory, 'SHA256SUMS'), 'ignored');
  writeFileSync(join(directory, 'SHA256SUMS.sigstore.json'), 'ignored');
  const entries = checksumEntries(directory);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['AnyWear-0.1.0-macos-universal.dmg', 'build-metadata.json']);
  const text = formatChecksums(entries);
  assert.deepEqual(assertChecksumText(text).map((entry) => entry.name).sort(), ['AnyWear-0.1.0-macos-universal.dmg', 'build-metadata.json']);
  assert.equal(formatChecksums(assertChecksumText(text)), text, 'the generated text is already canonical');
});

test('each platform names the exact missing signing secret', () => {
  const sites = {
    windows: ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
    macos: ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY_P8'],
    android: ['ANDROID_KEY_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
  };
  for (const [platform, secrets] of Object.entries(sites)) {
    for (const secret of secrets) {
      assert.equal(
        missingCredentialMessage(platform, secret),
        `::error::${secret} is not configured; a ${platform} release artifact cannot be produced`,
      );
    }
  }
});

test('the commit must be in the main history', () => {
  assert.doesNotThrow(() => assertCommitIsOnMain({
    tag: 'client-v0.1.0',
    commit: 'a'.repeat(40),
    mainCommit: 'b'.repeat(40),
    isAncestor: true,
  }));
  assert.throws(
    () => assertCommitIsOnMain({ tag: 'client-v0.1.0', commit: 'a'.repeat(40), mainCommit: 'b'.repeat(40), isAncestor: false }),
    /is not in the `main` history/,
  );
  assert.throws(
    () => assertCommitIsOnMain({ tag: 'client-v0.1.0', commit: 'a'.repeat(40), mainCommit: '', isAncestor: false }),
    /`origin\/main` is not available in this checkout/,
  );
});

test('the declared platform set is read from the committed configuration and validated', () => {
  // Behaviour over the `root` parameter only: these cases hold on any revision, so
  // a sibling issue that touches the Android project cannot turn them red.
  const configuredRoot = (config) => {
    const directory = mkdtempSync(join(tmpdir(), 'client-platforms-'));
    if (config !== undefined) {
      writeFileSync(
        join(directory, 'client-release-platforms.json'),
        typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`,
      );
    }
    return directory;
  };

  // A missing configuration file.
  assert.throws(
    () => declaredPlatforms(configuredRoot()),
    messageIncludes('`client-release-platforms.json`', 'is missing'),
  );
  // Invalid JSON.
  assert.throws(() => declaredPlatforms(configuredRoot('{')), messageIncludes('`client-release-platforms.json`', 'not valid JSON'));
  // A schema version this pipeline does not read.
  for (const config of [{ schema_version: 2, declared_platforms: ['windows'] }, { declared_platforms: ['windows'] }]) {
    assert.throws(() => declaredPlatforms(configuredRoot(config)), messageIncludes('`schema_version`', 'schema 1'));
  }
  // `declared_platforms` missing, not an array, or empty.
  for (const config of [
    { schema_version: 1 },
    { schema_version: 1, declared_platforms: 'android' },
    { schema_version: 1, declared_platforms: [] },
  ]) {
    assert.throws(() => declaredPlatforms(configuredRoot(config)), ClientReleaseError);
  }
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1 })),
    messageIncludes('`declared_platforms`', 'array'),
  );
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: [] })),
    messageIncludes('`declared_platforms`', 'at least one'),
  );
  // An entry outside windows/macos/android.
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: ['linux'] })),
    messageIncludes('`linux`', 'not a release platform'),
  );
  // A duplicate entry.
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: ['windows', 'windows'] })),
    messageIncludes('`windows`', 'more than once'),
  );
  // `android` declared without the project that declaration requires.
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: ['android'] })),
    messageIncludes('`android`', '`src-tauri/gen/android`'),
  );

  // Parsing returns the declared set in canonical order, whatever the file order.
  const unordered = configuredRoot({ schema_version: 1, declared_platforms: ['android', 'windows'] });
  mkdirSync(join(unordered, 'src-tauri', 'gen', 'android'), { recursive: true });
  assert.deepEqual(declaredPlatforms(unordered), ['windows', 'android']);
  assert.deepEqual(
    declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: ['macos', 'windows'] })),
    ['windows', 'macos'],
  );
  assert.throws(
    () => declaredPlatforms(configuredRoot({ schema_version: 1, declared_platforms: ['android', 'macos', 'windows'] })),
    messageIncludes('`android`', '`src-tauri/gen/android`'),
    'android is still refused without the project, not silently dropped',
  );

  // The committed configuration is valid and resolves to the Beta's set.
  assert.deepEqual(declaredPlatforms(repositoryRoot), ['android']);
});

test('a second release for the same commit is refused', () => {
  const commit = 'c'.repeat(40);
  assert.equal(
    duplicateReleaseViolation({ tag: 'client-v0.2.0', commit, releases: [{ tag: 'client-v0.1.0', commit: 'd'.repeat(40) }] }),
    null,
  );
  assert.match(
    duplicateReleaseViolation({ tag: 'client-v0.2.0', commit, releases: [{ tag: 'client-v0.1.0', commit }] }),
    /already has the client release `client-v0\.1\.0`/,
  );
  assert.equal(duplicateReleaseViolation({ tag: 'client-v0.1.0', commit, releases: [{ tag: 'client-v0.1.0', commit }] }), null);
  assert.equal(duplicateReleaseViolation({ tag: 'client-v0.2.0', commit, releases: [{ tag: 'client-v0.1.0', commit: 'd'.repeat(40) }] }), null);
});

test('the release readback must match the declared inventory before and after the flip', () => {
  const tag = 'client-v0.1.0';
  const platforms = ['windows', 'macos'];
  const checksums = expectedAssetNames('0.1.0', platforms)
    .filter((name) => !CHECKSUM_EXCLUDED_NAMES.includes(name))
    .map((name) => ({ digest: hashA, name }));
  const assets = [...checksums.map((entry) => entry.name), ...CHECKSUM_EXCLUDED_NAMES];

  assert.doesNotThrow(() => assertReleaseView({
    tag,
    view: { tagName: tag, isDraft: true, isPrerelease: true, assets: assets.map((name) => ({ name })) },
    expect: 'draft',
    declaredPlatforms: platforms,
    checksums,
  }));
  assert.doesNotThrow(() => assertReleaseView({
    tag,
    view: { tagName: tag, isDraft: false, isPrerelease: true, assets: assets.map((name) => ({ name })) },
    expect: 'published',
    declaredPlatforms: platforms,
    checksums,
  }));

  assert.throws(
    () => assertReleaseView({
      tag,
      view: { tagName: tag, isDraft: false, isPrerelease: true, assets: assets.filter((name) => !name.includes('-macos-')).map((name) => ({ name })) },
      expect: 'published',
      declaredPlatforms: platforms,
      checksums,
    }),
    /missing AnyWear-0\.1\.0-macos-universal\.dmg/,
  );
  assert.throws(
    () => assertReleaseView({
      tag,
      view: { tagName: tag, isDraft: false, isPrerelease: true, assets: [...assets, 'stray.exe'].map((name) => ({ name })) },
      expect: 'published',
      declaredPlatforms: platforms,
      checksums,
    }),
    /unexpected assets stray\.exe/,
  );
  assert.throws(
    () => assertReleaseView({
      tag: 'client-v0.2.0',
      view: { tagName: tag, isDraft: false, isPrerelease: true, assets: assets.map((name) => ({ name })) },
      expect: 'published',
      declaredPlatforms: platforms,
      checksums,
    }),
    /names tag `client-v0\.1\.0`, not `client-v0\.2\.0`/,
  );
  assert.throws(
    () => assertReleaseView({
      tag,
      view: { tagName: tag, isDraft: true, isPrerelease: true, assets: assets.map((name) => ({ name })) },
      expect: 'published',
      declaredPlatforms: platforms,
      checksums,
    }),
    /still a draft after the flip/,
  );
});

test('the CLI verify command is green on the landed revision and red without the release notes', () => {
  const landed = runCli(['verify', '--tag', 'client-v0.2.0']);
  assert.equal(landed.status, 0, landed.output);
  assert.match(landed.output, /client release tag client-v0\.2\.0 is well formed \(0\.2\.0\)/);
  assert.match(
    landed.output,
    /release notes docs\/client-release-notes\/client-v0\.2\.0\.md carry the `## Known issues` and `## Platform availability` sections for android/,
  );

  const missing = temporaryRoot();
  const missingResult = runCli(['verify', '--tag', 'client-v0.2.0'], missing);
  assert.equal(missingResult.status, 1, missingResult.output);
  assert.match(missingResult.output, /::error::the release notes file `docs\/client-release-notes\/client-v0\.2\.0\.md` is missing/);

  const headingless = temporaryRoot({ 'client-v0.2.0.md': '# 0.2.0\n' });
  const headinglessResult = runCli(['verify', '--tag', 'client-v0.2.0'], headingless);
  assert.equal(headinglessResult.status, 1, headinglessResult.output);
  assert.match(headinglessResult.output, /::error::the release notes file .* must contain a `## Known issues` section/);

  // The configuration is read first: a set that contradicts the notes fails verify.
  const contradictory = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({ platforms: [] }),
  }, { schema_version: 1, declared_platforms: ['android'] });
  const contradictoryResult = runCli(['verify', '--tag', 'client-v0.2.0'], contradictory);
  assert.equal(contradictoryResult.status, 1, contradictoryResult.output);
  assert.match(contradictoryResult.output, /::error::the release notes file .* `- \*\*Android:\*\*`/);
  assert.match(contradictoryResult.output, /is declared by `client-release-platforms\.json`/);

  const good = temporaryRoot({
    'client-v0.2.0.md': releaseNotes({ platforms: ['android'] }),
  }, { schema_version: 1, declared_platforms: ['android'] });
  assert.equal(runCli(['verify', '--tag', 'client-v0.2.0'], good).status, 0);

  const illegal = runCli(['verify', '--tag', 'client-v1.2']);
  assert.equal(illegal.status, 1, illegal.output);
  assert.match(illegal.output, /::error::`client-v1\.2` is not a client release tag/);
});

test('the CLI refuses an unknown command and an invalid inventory expectation', () => {
  const unknown = spawnSync(process.execPath, ['scripts/assert-client-release.mjs', 'publish'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /::error::unknown command `publish`/);

  assert.throws(
    () => assertReleaseView({ tag: 'client-v0.1.0', view: { tagName: 'client-v0.1.0' }, expect: 'latest', declaredPlatforms: [], checksums: [] }),
    ClientReleaseError,
  );
});
