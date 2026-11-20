import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bundleManifestComponent,
  bundleManifestName,
  bundleManifestSchemaVersion,
  inventoryBuiltAssets,
  listBuiltAssets,
  sha256,
  writeBundleManifest,
} from './write-bundle-manifest.mjs';

const source = 'a'.repeat(40);
const values = {
  api_base_url: 'https://api.beta.anywear.example',
  cognito_user_pool_id: 'ap-east-1_AbCdEfGhI',
  cognito_client_id: 'abcdefghijklmnopqrstuvwxyz',
};
const metadata = {
  schema_version: 3,
  component: 'AnyWear-Client',
  source_commit: source,
  client_version: 3,
  interface: values,
};

const environment = { SOURCE_COMMIT_SHA: source };

/** One `dist/` tree with the metadata and a nested asset, in a fresh directory. */
async function builtTree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'build-metadata.json'), JSON.stringify(metadata), 'utf8');
  await writeFile(join(directory, 'index.html'), '<!doctype html>\n', 'utf8');
  await writeFile(join(directory, 'assets', 'index-abc123.js'), `const values=${JSON.stringify(values)};\n`, 'utf8');
  return directory;
}

test('the manifest names the run, the metadata identity and every built asset', async (t) => {
  const directory = await builtTree(t);
  const { manifest, path, digest } = await writeBundleManifest(directory, environment);

  assert.equal(path, join(directory, bundleManifestName));
  assert.equal(manifest.schema_version, bundleManifestSchemaVersion);
  assert.equal(manifest.component, bundleManifestComponent);
  assert.equal(manifest.source_commit, source);
  assert.equal(manifest.client_version, metadata.client_version);
  assert.deepEqual(manifest.interface, values);

  // The inventory is every file under `dist/` except the manifest, sorted by path,
  // each with its own SHA-256 and byte count.
  assert.deepEqual(manifest.assets.map((asset) => asset.path), [
    'assets/index-abc123.js',
    'build-metadata.json',
    'index.html',
  ]);
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(directory, ...asset.path.split('/')));
    assert.equal(asset.sha256, sha256(bytes), `${asset.path} must carry its own digest`);
    assert.equal(asset.bytes, bytes.length, `${asset.path} must carry its byte count`);
  }
  assert.equal(manifest.assets.some((asset) => asset.path === bundleManifestName), false, 'the manifest excludes itself');

  // The published digest is the SHA-256 of the manifest file itself.
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, sha256(await readFile(path)), 'the digest must be the manifest file bytes');
});

test('the manifest is deterministic: no timestamp, sorted inventory, fixed layout', async (t) => {
  const directory = await builtTree(t);
  const first = await writeBundleManifest(directory, environment);
  const firstText = await readFile(first.path, 'utf8');
  const second = await writeBundleManifest(directory, environment);
  const secondText = await readFile(second.path, 'utf8');

  assert.equal(secondText, firstText, 'the same built tree must write the same bytes');
  assert.equal(second.digest, first.digest, 'the same built tree must digest the same');
  assert.equal(firstText.includes('built_at'), false, 'a timestamp would make the digest unstable');
  assert.ok(firstText.endsWith('\n'), 'the manifest file ends with a newline');
});

test('the inventory walk is sorted, recursive and excludes nothing but the manifest', async (t) => {
  const directory = await builtTree(t);
  await mkdir(join(directory, 'assets', 'nested'), { recursive: true });
  await writeFile(join(directory, 'assets', 'nested', 'deep.css'), 'a{}\n', 'utf8');
  await writeFile(join(directory, 'z-last.txt'), 'z\n', 'utf8');
  await writeFile(join(directory, 'B-upper.txt'), 'B\n', 'utf8');

  const paths = await listBuiltAssets(directory);
  assert.deepEqual(paths, [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.deepEqual(paths, ['B-upper.txt', 'assets/index-abc123.js', 'assets/nested/deep.css', 'build-metadata.json', 'index.html', 'z-last.txt']);

  await writeFile(join(directory, bundleManifestName), '{"written":"after"}\n', 'utf8');
  const inventory = await inventoryBuiltAssets(directory);
  assert.deepEqual(inventory.map((asset) => asset.path), paths, 'the manifest itself is never part of the inventory');
});

test('a malformed or missing build metadata fails the manifest instead of describing it', async (t) => {
  const directory = await builtTree(t);
  const cases = [
    ['a missing file', async () => rm(join(directory, 'build-metadata.json')), /ENOENT/],
    ['invalid JSON', async () => writeFile(join(directory, 'build-metadata.json'), '{nope', 'utf8'), /(?:Unexpected token|Expected property name|JSON)/],
    ['an older schema', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, schema_version: 2 })), /unexpected schema or component/],
    ['another component', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, component: 'AnyWear-Service' })), /unexpected schema or component/],
    ['a short commit', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, source_commit: 'main' })), /malformed source_commit/],
    ['a fractional version', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, client_version: 1.5 })), /malformed client_version/],
    ['a missing version', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, client_version: undefined })), /malformed client_version/],
    ['a malformed interface', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, interface: { ...values, cognito_client_id: 'short' } })), /malformed cognito_client_id/],
    ['a missing interface', async () => writeFile(join(directory, 'build-metadata.json'), JSON.stringify({ ...metadata, interface: undefined })), /malformed api_base_url/],
  ];
  for (const [label, mutate, expected] of cases) {
    await mutate();
    await assert.rejects(() => writeBundleManifest(directory, environment), expected, `expected ${label} to be refused`);
  }
});

test('the run\'s source commit must be the one the build metadata records', async (t) => {
  const directory = await builtTree(t);
  // github.sha, not the metadata, is what a run knows; a disagreement is the
  // artifact not being this run's build.
  await assert.rejects(
    () => writeBundleManifest(directory, { GITHUB_SHA: 'b'.repeat(40) }),
    /the build metadata records source commit a{40}, not this run's b{40}/,
  );
  await assert.rejects(
    () => writeBundleManifest(directory, { SOURCE_COMMIT_SHA: 'main' }),
    /must be a full lowercase 40-character commit SHA/,
  );
  // A local build has no run identity, so the metadata's own `local` is recorded.
  const local = await writeBundleManifest(directory, {});
  assert.equal(local.manifest.source_commit, source);
});

test('the workflow CLI writes the manifest and publishes its digest as a step output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-manifest-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'scripts', 'write-bundle-manifest.mjs');
  const output = join(directory, 'github-output.txt');
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
  await copyFile(new URL('./write-bundle-manifest.mjs', import.meta.url), script);
  await copyFile(new URL('./build-interface.mjs', import.meta.url), join(directory, 'scripts', 'build-interface.mjs'));
  await writeFile(join(directory, 'dist', 'build-metadata.json'), JSON.stringify(metadata), 'utf8');
  await writeFile(join(directory, 'dist', 'assets', 'index-abc123.js'), 'x();\n', 'utf8');
  await writeFile(output, '', 'utf8');

  const run = (env = {}) => spawnSync(process.execPath, [script], {
    env: { ...process.env, ...environment, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });

  assert.equal(run().status, 0);
  const written = JSON.parse(await readFile(join(directory, 'dist', bundleManifestName), 'utf8'));
  assert.equal(written.assets.length, 2);
  const stepOutput = await readFile(output, 'utf8');
  assert.match(stepOutput, /^digest=[0-9a-f]{64}\n$/m, 'the step output carries the digest');
  assert.equal(`digest=${sha256(await readFile(join(directory, 'dist', bundleManifestName)))}`, stepOutput.trim());

  // A missing metadata file is a failed step, not a manifest of nothing.
  await rm(join(directory, 'dist', 'build-metadata.json'));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /::error::/);
});
