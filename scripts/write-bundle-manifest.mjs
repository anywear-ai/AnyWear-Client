// The digest's subject: the inventory of every built asset under `dist/`.
//
// `release.yml`'s `build` job writes this manifest after `pnpm build` and before the
// `client-dist` upload, so the uploaded artifact carries it, and publishes the
// manifest file's own SHA-256 as `client_bundle_digest`. `handoff` hands that digest
// to `AnyWear-Infra`, and `verify` recomputes both the inventory and the digest from
// the downloaded artifact, so the value Infra receives names bytes this repository
// re-read rather than a claim it made.
//
// The manifest excludes itself, records no timestamp, sorts the inventory by path and
// is written with a fixed indentation: the same built assets always digest to the
// same value.

import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInterface, isValidInterfaceValue } from './build-interface.mjs';

/** The file name, relative to `dist/`, of the manifest this module writes. */
export const bundleManifestName = 'bundle-manifest.json';

/** The build identity `pnpm build` records beside the manifest. */
export const buildMetadataName = 'build-metadata.json';

/** The manifest schema this repository writes and `verify` accepts. */
export const bundleManifestSchemaVersion = 1;

/** The component every manifest and build-metadata file names. */
export const bundleManifestComponent = 'AnyWear-Client';

const sourceCommitPattern = /^[0-9a-f]{40}$/;

/** The lowercase hexadecimal SHA-256 of `bytes`. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Byte-wise order, so the inventory does not depend on the runner's locale. */
function comparePaths(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Every file under `directory`, as `/`-separated paths relative to it, sorted
 * byte-wise. Directories are walked, not linked: `pnpm build` writes one tree.
 */
export async function listBuiltAssets(directory) {
  const paths = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else paths.push(path);
    }
  }
  return paths.sort(comparePaths);
}

/**
 * The sorted `{path, sha256, bytes}` inventory of every built asset, excluding the
 * manifest itself: a file cannot record its own digest.
 */
export async function inventoryBuiltAssets(directory) {
  const assets = [];
  for (const path of await listBuiltAssets(directory)) {
    if (path === bundleManifestName) continue;
    const bytes = await readFile(join(directory, ...path.split('/')));
    assets.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  return assets;
}

/**
 * The source commit the manifest records. It is the run's `github.sha`, and the
 * build metadata was written from the same environment, so a disagreement means the
 * artifact is not the one this run built.
 */
export function bundleSourceCommit(metadata, environment = process.env) {
  const declared = environment.SOURCE_COMMIT_SHA ?? environment.GITHUB_SHA;
  if (declared === undefined) return metadata.source_commit;
  if (!sourceCommitPattern.test(declared)) {
    throw new Error('SOURCE_COMMIT_SHA/GITHUB_SHA must be a full lowercase 40-character commit SHA');
  }
  if (declared !== metadata.source_commit) {
    throw new Error(`the build metadata records source commit ${metadata.source_commit}, not this run's ${declared}`);
  }
  return declared;
}

/** Fails closed on a `build-metadata.json` this manifest cannot describe. */
export function requireBuildMetadata(metadata) {
  if (metadata?.schema_version !== 3 || metadata.component !== bundleManifestComponent) {
    throw new Error(`${buildMetadataName} has an unexpected schema or component`);
  }
  if (typeof metadata.source_commit !== 'string'
    || (metadata.source_commit !== 'local' && !sourceCommitPattern.test(metadata.source_commit))) {
    throw new Error(`${buildMetadataName} has a malformed source_commit`);
  }
  if (!Number.isSafeInteger(metadata.client_version) || metadata.client_version < 0) {
    throw new Error(`${buildMetadataName} has a malformed client_version`);
  }
  for (const key of Object.keys(buildInterface)) {
    if (!isValidInterfaceValue(key, metadata.interface?.[key])) {
      throw new Error(`${buildMetadataName} has a malformed ${key}`);
    }
  }
  return metadata;
}

/**
 * The manifest for the built tree: the schema version, the component, the run's
 * source commit, the `client_version` and interface values `build-metadata.json`
 * records, and the sorted inventory of every other built asset.
 */
export async function createBundleManifest(distDirectory, metadata, environment = process.env) {
  requireBuildMetadata(metadata);
  return {
    schema_version: bundleManifestSchemaVersion,
    component: bundleManifestComponent,
    source_commit: bundleSourceCommit(metadata, environment),
    client_version: metadata.client_version,
    interface: { ...metadata.interface },
    assets: await inventoryBuiltAssets(distDirectory),
  };
}

/**
 * Writes `dist/bundle-manifest.json` and returns the manifest, its path and the
 * SHA-256 of the file's bytes — the value `build` publishes as
 * `client_bundle_digest`.
 */
export async function writeBundleManifest(distDirectory, environment = process.env) {
  const metadata = JSON.parse(await readFile(join(distDirectory, buildMetadataName), 'utf8'));
  const manifest = await createBundleManifest(distDirectory, metadata, environment);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(distDirectory, bundleManifestName);
  await writeFile(path, contents, 'utf8');
  return { manifest, path, digest: sha256(Buffer.from(contents, 'utf8')) };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { manifest, path, digest } = await writeBundleManifest(resolve(repositoryRoot, 'dist'));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`, 'utf8');
    console.log(`Wrote ${path}: ${manifest.assets.length} built assets, sha256 ${digest}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
