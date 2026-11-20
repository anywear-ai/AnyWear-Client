import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertBundleManifest,
  assertBuiltConfiguration,
  assertClientPublication,
} from '../.github/scripts/assert-client-publication.mjs';
import { bundleManifestName, sha256, writeBundleManifest } from './write-bundle-manifest.mjs';

const source = 'a'.repeat(40);
const values = {
  api_base_url: 'https://api.beta.anywear.example',
  cognito_user_pool_id: 'ap-east-1_AbCdEfGhI',
  cognito_client_id: 'abcdefghijklmnopqrstuvwxyz',
};
// #266: the run's own repository names. `GITHUB_WORKFLOW_REF` is qualified by the
// same repository the run reports, whatever owner that repository is under, so the
// fabricated identity is built from the repository rather than a literal.
const ownerRelative = (repository) => ({
  GITHUB_REPOSITORY: repository,
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`,
});
const environment = {
  BETA_MUTATION_ENABLED: 'true',
  ...ownerRelative('git-malu/AnyWear-Client'),
  GITHUB_REPOSITORY_ID: '1176104200',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: source,
  GITHUB_WORKFLOW_SHA: source,
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};
const declared = {
  DECLARED_API_BASE_URL: values.api_base_url,
  DECLARED_COGNITO_USER_POOL_ID: values.cognito_user_pool_id,
  DECLARED_COGNITO_CLIENT_ID: values.cognito_client_id,
};
const metadata = {
  schema_version: 3,
  component: 'AnyWear-Client',
  source_commit: source,
  client_version: 1,
  interface: values,
};

/** A built `dist/` tree with the metadata, an asset and the manifest beside them. */
async function builtTree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'build-metadata.json'), JSON.stringify(metadata), 'utf8');
  await writeFile(join(directory, 'assets', 'index-abc123.js'), `const values=${JSON.stringify(values)};\n`, 'utf8');
  await writeFile(join(directory, 'index.html'), '<!doctype html>\n', 'utf8');
  const { digest } = await writeBundleManifest(directory, { SOURCE_COMMIT_SHA: source });
  return { directory, digest };
}

test('the Client verifies its build and declared interface without any AWS identity', () => {
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...declared }, 'verify', metadata));
});

test('the deploy and record phases are gone, not merely unreachable', () => {
  // The retired AWS path: each phase this repository no longer runs is refused by
  // name, so a workflow that still calls it fails instead of verifying nothing.
  for (const phase of ['deploy', 'record']) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...declared }, phase, metadata),
      new RegExp(`Unknown publication validation phase: ${phase}`),
      `expected the retired ${phase} phase to be refused`,
    );
  }
  assert.throws(() => assertClientPublication({ ...environment, ...declared }, undefined, metadata), /Unknown publication validation phase/);
});

test('the retired AWS assertions no longer gate the Client', () => {
  // These values were required while `deploy` assumed the publish role. The Client
  // holds no AWS principal now, so their absence and their junk both verify.
  for (const retired of [
    {},
    { AWS_ACCOUNT_ID: '123456789012' },
    { AWS_REGION: 'us-east-1' },
    { CLIENT_PUBLISH_ROLE_ARN: '' },
    { CLIENT_PUBLISH_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-client-publish-role' },
    { AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', CLIENT_PUBLISH_ROLE_ARN: 'arn:aws:iam::650880818323:role/other' },
  ]) {
    assert.doesNotThrow(
      () => assertClientPublication({ ...environment, ...declared, ...retired }, 'verify', metadata),
      `expected ${JSON.stringify(retired)} not to be an assertion any more`,
    );
  }
});

test('accepts a push to main as a handoff and refuses every other event or ref', () => {
  // A merge hands over with the reviewed constants; the dispatch path is unchanged.
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...declared, GITHUB_EVENT_NAME: 'push' }, 'verify', metadata));

  // Only the two entry events are handoffs: an automatic check, a tag and a
  // scheduler run are not.
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'release', 'schedule', 'merge_group']) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...declared, GITHUB_EVENT_NAME: event }, 'verify', metadata),
      /Publication requires the main deploy workflow dispatch or a push to main/,
      `expected ${event} to be refused`,
    );
  }

  // A push of a tag is not a handoff: the ref and the workflow ref must both be main.
  assert.throws(
    () => assertClientPublication({ ...environment, ...declared, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' }, 'verify', metadata),
    /Publication requires the Client repository id 1176104200 and main ref/,
  );
  assert.throws(
    () => assertClientPublication({
      ...environment,
      ...declared,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/release.yml@refs/tags/v1.2.3',
    }, 'verify', metadata),
    /Publication requires the main deploy workflow dispatch or a push to main/,
  );
});

test('#266: the repository id is the guard, so either owner publishes through the transfer', () => {
  // The numeric id does not change when the repository moves to `anywear-ai`; the
  // owner-qualified name appears in the event as either value during the window.
  for (const repository of ['git-malu/AnyWear-Client', 'anywear-ai/AnyWear-Client']) {
    for (const event of ['workflow_dispatch', 'push']) {
      const identity = { ...environment, ...ownerRelative(repository), GITHUB_EVENT_NAME: event };
      assert.doesNotThrow(
        () => assertClientPublication({ ...identity, ...declared }, 'verify', metadata),
        `expected ${repository} on ${event} to hand over`,
      );
    }
    // The id, not the name, is the repository guard: the same name under another id
    // is not this repository. A wrong id fails under either owner's name.
    assert.throws(
      () => assertClientPublication({ ...environment, ...ownerRelative(repository), ...declared, GITHUB_REPOSITORY_ID: '123' }, 'verify', metadata),
      /Publication requires the Client repository id 1176104200 and main ref/,
      `expected ${repository} with a different repository id to be refused`,
    );
  }
});

test('#266: the workflow ref must be this run\'s own repository, release.yml and main', () => {
  const mismatches = [
    ['the other owner', { GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-Client/.github/workflows/release.yml@refs/heads/main' }],
    ['the old owner', {
      GITHUB_REPOSITORY: 'anywear-ai/AnyWear-Client',
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/release.yml@refs/heads/main',
    }],
    ['a different repository', {
      GITHUB_REPOSITORY: 'anywear-ai/AnyWear-Client',
      GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-Service/.github/workflows/release.yml@refs/heads/main',
    }],
    ['a different workflow file', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/build.yml@refs/heads/main' }],
    ['a tag ref', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/release.yml@refs/tags/v1.2.3' }],
    ['a feature branch', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/release.yml@refs/heads/feature' }],
    ['no repository prefix', { GITHUB_WORKFLOW_REF: '.github/workflows/release.yml@refs/heads/main' }],
  ];
  for (const [label, override] of mismatches) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...declared, ...override }, 'verify', metadata),
      /Publication requires the main deploy workflow dispatch or a push to main/,
      `expected ${label} to be refused`,
    );
  }
});

test('rejects an untrusted source, disabled release or missing run identity', async (t) => {
  const invalidInputs = [
    ['BETA_MUTATION_ENABLED', 'false'],
    ['BETA_MUTATION_ENABLED', ''],
    ['GITHUB_REPOSITORY_ID', '123'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_WORKFLOW_REF', 'git-malu/AnyWear-Client/.github/workflows/other.yml@refs/heads/main'],
    ['GITHUB_SHA', 'main'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ATTEMPT', '0'],
  ];
  for (const [key, value] of invalidInputs) {
    await t.test(`${key}=${value}`, () => {
      assert.throws(() => assertClientPublication({ ...environment, ...declared, [key]: value }, 'verify', metadata));
    });
  }
});

test('rejects missing, malformed or different built Client identity before the handoff', () => {
  const invalidMetadata = [
    undefined,
    null,
    {},
    { ...metadata, source_commit: 'b'.repeat(40) },
    { ...metadata, source_commit: 'local' },
    { ...metadata, schema_version: 1 },
    { ...metadata, schema_version: 2 },
    { ...metadata, schema_version: 4 },
    { ...metadata, component: 'AnyWear-Service' },
    { ...metadata, client_version: undefined },
    { ...metadata, client_version: -1 },
    { ...metadata, client_version: 1.5 },
    { ...metadata, client_version: '1' },
    { ...metadata, client_version: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata, client_version: null },
    { ...metadata, interface: undefined },
    { ...metadata, interface: { ...values, api_base_url: undefined } },
    { ...metadata, interface: { ...values, api_base_url: 'http://api.beta.anywear.example' } },
    { ...metadata, interface: { ...values, cognito_user_pool_id: 'ap-east-1' } },
    { ...metadata, interface: { ...values, cognito_client_id: 'short' } },
  ];
  for (const input of invalidMetadata) {
    assert.throws(() => assertClientPublication({ ...environment, ...declared }, 'verify', input), /Built Client metadata/);
  }
  for (const key of Object.keys(declared)) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...declared, [key]: 'different' }, 'verify', metadata),
      /Built Client metadata does not match the declared interface values/,
      `expected a different ${key} to be rejected`,
    );
  }
});

test('the compiled assets must carry the interface the metadata records', async (t) => {
  const { directory } = await builtTree(t);
  assert.doesNotThrow(() => assertBuiltConfiguration(join(directory, 'assets'), values));
  for (const key of Object.keys(values)) {
    assert.throws(
      () => assertBuiltConfiguration(join(directory, 'assets'), { ...values, [key]: `different-${key}` }),
      new RegExp(`Built assets do not contain the ${key} recorded in build-metadata.json`),
      `expected a different ${key} to be refused`,
    );
  }
});

test('the bundle manifest matches the build metadata and its own asset inventory', async (t) => {
  const { directory, digest } = await builtTree(t);
  assert.equal(await assertBundleManifest(directory, metadata, digest), digest);

  // Every identity field the manifest repeats is compared with build-metadata.json.
  const mismatches = [
    [{ ...metadata, source_commit: 'b'.repeat(40) }, /does not match build-metadata\.json \(source_commit\)/],
    [{ ...metadata, client_version: 2 }, /does not match build-metadata\.json \(client_version\)/],
    [{ ...metadata, interface: { ...values, cognito_client_id: 'zyxwvutsrqponmlkjihgfedcba' } }, /does not match build-metadata\.json \(interface cognito_client_id\)/],
  ];
  for (const [changed, expected] of mismatches) {
    await assert.rejects(() => assertBundleManifest(directory, changed, digest), expected);
  }
});

test('the bundle manifest is refused when it is missing, unsorted or not its own subject', async (t) => {
  const { directory, digest } = await builtTree(t);
  const path = join(directory, bundleManifestName);
  const text = await readFile(path, 'utf8');
  const manifest = JSON.parse(text);
  const write = (changed) => writeFile(path, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
  // An entry added to the inventory must keep the list sorted, or the ordering rule
  // fires first and the rule under test is never reached.
  const withAssets = (extra) => [...manifest.assets, ...extra]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  await assert.rejects(
    () => assertBundleManifest(join(directory, 'not-a-build'), metadata, digest),
    /the bundle manifest cannot be read/,
  );
  for (const [changed, expected] of [
    [{ ...manifest, schema_version: 2 }, /unexpected schema or component/],
    [{ ...manifest, component: 'AnyWear-Service' }, /unexpected schema or component/],
    [{ ...manifest, assets: [] }, /records no built assets/],
    [{ ...manifest, assets: [{ path: '' }] }, /records an asset with no path/],
    [{ ...manifest, assets: [...manifest.assets].reverse() }, /inventory is not sorted by path/],
    [{ ...manifest, assets: withAssets([{ path: bundleManifestName, sha256: 'a'.repeat(64), bytes: 1 }]) }, /must not list itself/],
    [{ ...manifest, assets: withAssets([{ path: 'assets/absent.js', sha256: 'a'.repeat(64), bytes: 1 }]) }, /lists assets\/absent\.js, which the build does not contain/],
    [{ ...manifest, assets: manifest.assets.filter((asset) => asset.path !== 'index.html') }, /Built asset index\.html is missing from the bundle manifest/],
    [{ ...manifest, assets: manifest.assets.map((asset) => (asset.path === 'index.html' ? { ...asset, bytes: asset.bytes + 1 } : asset)) }, /Built asset index\.html does not match the bundle manifest/],
  ]) {
    await write(changed);
    await assert.rejects(() => assertBundleManifest(directory, metadata, digest), expected, `expected ${JSON.stringify(changed).slice(0, 120)} to be refused`);
  }

  // The digest is the manifest file's own SHA-256: a recorded digest that is not it,
  // or none at all, is refused.
  await writeFile(path, text, 'utf8');
  await assert.rejects(
    () => assertBundleManifest(directory, metadata, sha256('something else')),
    /The bundle manifest digest is [0-9a-f]{64}, not the published client_bundle_digest/,
  );
  for (const declaredDigest of [undefined, '', 'not-a-digest']) {
    await assert.rejects(
      () => assertBundleManifest(directory, metadata, declaredDigest),
      /The build did not publish a client_bundle_digest/,
      `expected ${declaredDigest} to be refused`,
    );
  }
});

test('workflow CLI verifies the bundle and fails closed on every retired or tampered input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-publication-cli-'));
  try {
    const script = join(directory, '.github', 'scripts', 'assert-client-publication.mjs');
    const output = join(directory, 'dist', 'build-metadata.json');
    const assets = join(directory, 'dist', 'assets', 'index-abc123.js');
    const manifest = join(directory, 'dist', bundleManifestName);
    await mkdir(join(directory, '.github', 'scripts'), { recursive: true });
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
    await copyFile(new URL('../.github/scripts/assert-client-publication.mjs', import.meta.url), script);
    await copyFile(new URL('./build-interface.mjs', import.meta.url), join(directory, 'scripts', 'build-interface.mjs'));
    await copyFile(new URL('./write-bundle-manifest.mjs', import.meta.url), join(directory, 'scripts', 'write-bundle-manifest.mjs'));

    await writeFile(output, JSON.stringify(metadata));
    await writeFile(assets, `const values=${JSON.stringify(values)};`);
    const { digest } = await writeBundleManifest(join(directory, 'dist'), { SOURCE_COMMIT_SHA: source });
    const run = (phase, extra = {}) => spawnSync(process.execPath, [script, phase], {
      env: {
        ...process.env, ...environment, ...declared, CLIENT_BUNDLE_DIGEST: digest, GITHUB_STEP_SUMMARY: '', ...extra,
      },
      encoding: 'utf8',
    });

    assert.equal(run('verify').status, 0);
    // The merge entry runs the same phase, and a tag push does not.
    assert.equal(run('verify', { GITHUB_EVENT_NAME: 'push' }).status, 0);
    assert.equal(run('verify', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' }).status, 1);
    // The retired phases are refused by name, so a stale workflow cannot pass.
    for (const phase of ['deploy', 'record']) {
      const retired = run(phase);
      assert.equal(retired.status, 1, `expected ${phase} to fail`);
      assert.match(retired.stderr, new RegExp(`::error::Unknown publication validation phase: ${phase}`));
    }

    // The built assets must actually carry the interface the metadata records.
    await writeFile(assets, `const values=${'{}'};`);
    assert.equal(run('verify').status, 1);
    await writeFile(assets, `const values=${JSON.stringify(values)};`);

    await writeFile(output, '{invalid json');
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify({ ...metadata, source_commit: 'b'.repeat(40) }));
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify(metadata));
    assert.equal(run('verify', { DECLARED_API_BASE_URL: 'https://other.example' }).status, 1);

    // The manifest is the digest's subject: a changed asset, a changed manifest and
    // a digest that is not the manifest's are each refused.
    await writeFile(assets, `const values=${JSON.stringify(values)}; // tampered`);
    assert.equal(run('verify').status, 1);
    await writeFile(assets, `const values=${JSON.stringify(values)};`);
    await writeFile(manifest, '{invalid json');
    assert.equal(run('verify').status, 1);
    await writeBundleManifest(join(directory, 'dist'), { SOURCE_COMMIT_SHA: source });
    assert.equal(run('verify', { CLIENT_BUNDLE_DIGEST: sha256('something else') }).status, 1);
    assert.equal(run('verify', { CLIENT_BUNDLE_DIGEST: '' }).status, 1);
    await rm(manifest);
    assert.equal(run('verify').status, 1);

    await rm(output);
    assert.equal(run('verify').status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
