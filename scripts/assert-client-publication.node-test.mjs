import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertClientPublication } from '../.github/scripts/assert-client-publication.mjs';

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
  AWS_ACCOUNT_ID: '650880818323',
  AWS_REGION: 'ap-east-1',
  CLIENT_PUBLISH_ROLE_ARN: 'arn:aws:iam::650880818323:role/beta-client-publish-role',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};
const declared = {
  DECLARED_API_BASE_URL: values.api_base_url,
  DECLARED_COGNITO_USER_POOL_ID: values.cognito_user_pool_id,
  DECLARED_COGNITO_CLIENT_ID: values.cognito_client_id,
};
const live = {
  LIVE_API_BASE_URL: values.api_base_url,
  LIVE_COGNITO_USER_POOL_ID: values.cognito_user_pool_id,
  LIVE_COGNITO_CLIENT_ID: values.cognito_client_id,
};
const metadata = {
  schema_version: 3,
  component: 'AnyWear-Client',
  source_commit: source,
  client_version: 1,
  interface: values,
};
const record = {
  schema_version: 1,
  component: 'AnyWear-Client',
  source_commit: source,
  run_id: '123',
  run_attempt: '1',
  bucket: 'anywear-client-beta-bucket',
  distribution_id: 'E2ABCDEFGHIJK1',
  invalidation_id: 'I2J0ABCDEFGHIJ',
  interface: values,
};

test('ordinary Client release needs no migration window or issue-comment inputs', () => {
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...declared }, 'verify', metadata));
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...live }, 'deploy', metadata));
  assert.doesNotThrow(() => assertClientPublication(environment, 'record', record));
});

test('accepts a push to main as a publication and refuses every other event or ref', () => {
  // A merge publishes with the reviewed constants; the dispatch path is unchanged.
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...declared, GITHUB_EVENT_NAME: 'push' }, 'verify', metadata));
  assert.doesNotThrow(() => assertClientPublication({ ...environment, ...live, GITHUB_EVENT_NAME: 'push' }, 'deploy', metadata));
  assert.doesNotThrow(() => assertClientPublication({ ...environment, GITHUB_EVENT_NAME: 'push' }, 'record', record));

  // Only the two entry events are publications: an automatic check, a tag and a
  // scheduler run are not.
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'release', 'schedule', 'merge_group']) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...declared, GITHUB_EVENT_NAME: event }, 'verify', metadata),
      /Publication requires the main deploy workflow dispatch or a push to main/,
      `expected ${event} to be refused`,
    );
  }

  // A push of a tag is not a publication: the ref and the workflow ref must both be main.
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
        `expected ${repository} on ${event} to publish`,
      );
      assert.doesNotThrow(
        () => assertClientPublication({ ...identity, ...live }, 'deploy', metadata),
        `expected ${repository} on ${event} to deploy`,
      );
      assert.doesNotThrow(() => assertClientPublication(identity, 'record', record), `expected ${repository} to record`);
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

test('rejects an untrusted source, disabled release or wrong AWS scope', async (t) => {
  const invalidInputs = [
    ['BETA_MUTATION_ENABLED', 'false'],
    ['GITHUB_REPOSITORY_ID', '123'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_WORKFLOW_REF', 'git-malu/AnyWear-Client/.github/workflows/other.yml@refs/heads/main'],
    ['GITHUB_SHA', 'main'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
    ['AWS_ACCOUNT_ID', '123456789012'],
    ['AWS_REGION', 'us-east-1'],
    ['CLIENT_PUBLISH_ROLE_ARN', 'arn:aws:iam::650880818323:role/beta-github-actions-pipeline-role'],
    ['CLIENT_PUBLISH_ROLE_ARN', ''],
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ATTEMPT', '0'],
  ];
  for (const [key, value] of invalidInputs) {
    await t.test(`${key}=${value}`, () => {
      assert.throws(() => assertClientPublication({ ...environment, ...declared, [key]: value }, 'verify', metadata));
    });
  }
});

test('rejects missing, malformed or different built Client identity before publication', () => {
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
  assert.throws(() => assertClientPublication(environment, 'unknown', metadata), /Unknown publication/);
});

test('rejects a built interface that differs from the live Beta interface', () => {
  for (const key of Object.keys(live)) {
    assert.throws(
      () => assertClientPublication({ ...environment, ...live, [key]: 'different' }, 'deploy', metadata),
      /Built Client metadata does not match the live Beta interface values/,
      `expected a different live ${key} to be rejected`,
    );
  }
  assert.throws(
    () => assertClientPublication({ ...environment, ...live }, 'deploy', undefined),
    /Built Client metadata/,
  );
});

test('rejects an incomplete or inconsistent publication record', () => {
  for (const input of [
    undefined,
    {},
    { ...record, component: 'AnyWear-Service' },
    { ...record, source_commit: 'b'.repeat(40) },
    { ...record, run_id: '999' },
    { ...record, run_attempt: '2' },
    { ...record, bucket: '' },
    { ...record, distribution_id: '' },
    { ...record, distribution_id: 'not a distribution' },
    { ...record, invalidation_id: '' },
    { ...record, interface: undefined },
    { ...record, interface: { ...values, cognito_client_id: 'short' } },
  ]) {
    assert.throws(() => assertClientPublication(environment, 'record', input), /Publication record/);
  }
});

test('workflow CLI reads the artifact, the live interface and the record, and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-client-publication-'));
  const script = join(directory, '.github', 'scripts', 'assert-client-publication.mjs');
  const contract = join(directory, 'scripts', 'build-interface.mjs');
  const output = join(directory, 'dist', 'build-metadata.json');
  const assets = join(directory, 'dist', 'assets', 'index-abc123.js');
  const publication = join(directory, 'publication', 'publication-record.json');
  try {
    await mkdir(join(directory, '.github', 'scripts'), { recursive: true });
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
    await mkdir(join(directory, 'publication'));
    await copyFile(new URL('../.github/scripts/assert-client-publication.mjs', import.meta.url), script);
    await copyFile(new URL('./build-interface.mjs', import.meta.url), contract);
    const run = (phase, extra = {}) => spawnSync(process.execPath, [script, phase], {
      env: {
        ...process.env, ...environment, ...declared, ...live, ...extra, GITHUB_STEP_SUMMARY: '',
      },
      encoding: 'utf8',
    });
    const writeAssets = (body) => writeFile(assets, body, 'utf8');

    await writeFile(output, JSON.stringify(metadata));
    await writeAssets(`const values=${JSON.stringify(values)};`);
    await writeFile(publication, JSON.stringify(record));

    assert.equal(run('verify').status, 0);
    assert.equal(run('deploy').status, 0);
    assert.equal(run('record').status, 0);

    // The merge entry runs the same three phases, and a tag push does not.
    assert.equal(run('verify', { GITHUB_EVENT_NAME: 'push' }).status, 0);
    assert.equal(run('deploy', { GITHUB_EVENT_NAME: 'push' }).status, 0);
    assert.equal(run('verify', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' }).status, 1);

    // The built assets must actually carry the interface the metadata records.
    await writeAssets(`const values=${JSON.stringify({ ...values, cognito_client_id: undefined })};`);
    assert.equal(run('verify').status, 1);
    await writeAssets(`const values=${JSON.stringify(values)};`);

    await writeFile(output, '{invalid json');
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify({ ...metadata, source_commit: 'b'.repeat(40) }));
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify({ ...metadata, client_version: undefined }));
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify({ ...metadata, client_version: '1' }));
    assert.equal(run('verify').status, 1);
    await writeFile(output, JSON.stringify(metadata));
    assert.equal(run('verify', { DECLARED_API_BASE_URL: 'https://other.example' }).status, 1);
    assert.equal(run('deploy', { LIVE_COGNITO_CLIENT_ID: 'zyxwvutsrqponmlkjihgfedcba' }).status, 1);

    await rm(output);
    assert.equal(run('verify').status, 1);

    await rm(publication);
    assert.equal(run('record').status, 1);
    await writeFile(publication, JSON.stringify({ ...record, run_id: '999' }));
    assert.equal(run('record').status, 1);
    await writeFile(publication, JSON.stringify(record));
    assert.equal(run('record').status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
