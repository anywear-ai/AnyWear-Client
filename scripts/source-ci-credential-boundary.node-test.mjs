// Offline scope, permission and secret tests for the Client source-CI credential
// boundary. Every case but the first is a negative: the checked-in workflows must
// pass, and each way of widening the checkout credential must be rejected with a
// message naming the file and line.
//
// Run with `pnpm run test:run`, which includes this file in its `node --test` list.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseGitmodules,
  parseIndexGitlink,
  parseWorkflow,
  readSubmoduleRevision,
  sourceCiCredentialBoundary,
  sourceCiCredentialBoundaryWith,
  specificationRepositorySlug,
  tokenSiteWith,
  tokenSites,
  validateSourceCiCredentialBoundary,
} from './source-ci-credential-boundary.mjs';

const repositoryRoot = new URL('../', import.meta.url);
const workflowsDirectory = new URL('.github/workflows/', repositoryRoot);
const gitmodulesPath = new URL('.gitmodules', repositoryRoot);
const workflowFiles = ['build.yml', 'test.yml', 'browser.yml', 'check.yml', 'release.yml'];
const tokenActionOf = (site) => `${sourceCiCredentialBoundary.tokenAction.repository}@${site.ref}`;

// The revision the specification checkout must pin, read from the `api` submodule's
// own checkout rather than from a literal a submodule bump can leave behind.
let cachedRevision;
async function specificationGitlink() {
  cachedRevision ??= readSubmoduleRevision(repositoryRoot, sourceCiCredentialBoundary.specificationPath);
  return cachedRevision;
}

/** The checked-in workflows, parsed fresh so one case cannot leak state into another. */
async function repositoryWorkflows() {
  const documents = [];
  for (const file of workflowFiles) {
    documents.push(parseWorkflow(await readFile(new URL(file, workflowsDirectory), 'utf8'), file));
  }
  return {
    documents,
    submoduleRepositories: parseGitmodules(await readFile(gitmodulesPath, 'utf8')),
    specificationRevision: await specificationGitlink(),
  };
}

/** Fails with the validator's own messages when a workflow leaves the boundary. */
function assertWithinBoundary(workflows) {
  assert.deepEqual(validateSourceCiCredentialBoundary(workflows), []);
}

function documentOf(documents, file) {
  const document = documents.find((candidate) => candidate.workflow.file === file);
  assert.ok(document, `expected a parsed ${file}`);
  return document;
}

function tokenStepOf(documents, file) {
  const site = tokenSites.find((candidate) => candidate.workflow === file);
  assert.ok(site, `expected a token site in ${file}`);
  const step = documentOf(documents, file).steps
    .find((candidate) => candidate.uses.startsWith('actions/create-github-app-token@') && candidate.job === site.job);
  assert.ok(step, `expected an App-token step in ${file}`);
  return step;
}

function specificationCheckoutOf(documents, file) {
  const step = documentOf(documents, file).steps.find((candidate) => candidate.uses === 'actions/checkout@v4' && candidate.with?.has('repository'));
  assert.ok(step, `expected a specification checkout in ${file}`);
  return step;
}

function clientCheckoutOf(documents, file) {
  const step = documentOf(documents, file).steps.find((candidate) => candidate.uses === 'actions/checkout@v4' && !candidate.with?.has('repository'));
  assert.ok(step, `expected a Client checkout in ${file}`);
  return step;
}

test('checked-in Client source workflows stay inside the credential boundary', async () => {
  assertWithinBoundary(await repositoryWorkflows());
});

test('exactly two App-token steps reach exactly one repository and one permission each', async () => {
  const { documents, specificationRevision } = await repositoryWorkflows();
  const steps = documents.flatMap((document) => document.steps);
  const tokenSteps = steps.filter((step) => step.uses.startsWith('actions/create-github-app-token@'));
  const specificationCheckouts = steps.filter((step) => step.uses === 'actions/checkout@v4' && step.with?.has('repository'));

  assert.deepEqual(
    tokenSteps.map((step) => `${step.file}:${step.job}`),
    tokenSites.map((site) => `${site.workflow}:${site.job}`),
    'one credential-bearing step per token site, in the job that site names',
  );
  for (const site of tokenSites) {
    const step = tokenSteps.find((candidate) => `${candidate.file}:${candidate.job}` === `${site.workflow}:${site.job}`);
    assert.deepEqual(Object.fromEntries(step.with), tokenSiteWith(site), `${site.workflow} must pass exactly its site's inputs`);
    assert.equal(step.uses, tokenActionOf(site));
  }

  assert.equal(specificationCheckouts.length, 1);
  const checkout = specificationCheckouts[0];
  const sourceCi = tokenSites.find((site) => site.readsSpecification);
  const sourceCiToken = tokenSteps.find((step) => step.file === sourceCi.workflow);
  assert.equal(checkout.file, 'build.yml');
  assert.equal(checkout.job, sourceCi.job);
  assert.equal(checkout.with.get('repository'), specificationRepositorySlug('git-malu'));
  assert.equal(checkout.with.get('ref'), specificationRevision);
  assert.equal(checkout.with.get('path'), sourceCiCredentialBoundary.specificationPath);
  assert.equal(checkout.with.get('token'), `\${{ steps.${sourceCiToken.id}.outputs.token }}`);
  assert.equal(checkout.with.get('persist-credentials'), 'false');
});

test('every job that does not read the specification holds no credential', async () => {
  const { documents } = await repositoryWorkflows();
  const jobsWithToken = new Set(documents
    .flatMap((document) => document.steps)
    .filter((step) => step.uses.startsWith('actions/create-github-app-token@'))
    .map((step) => `${step.file}:${step.job}`));
  assert.deepEqual([...jobsWithToken], ['build.yml:build', 'release.yml:handoff']);
  for (const [file, job] of [
    ['build.yml', 'rust-check'],
    ['test.yml', 'test'],
    ['browser.yml', 'browser'],
    ['release.yml', 'build'],
    ['release.yml', 'verify'],
    ['release.yml', 'deploy'],
    ['release.yml', 'record'],
  ]) {
    const document = documentOf(documents, file);
    for (const step of document.steps.filter((candidate) => candidate.job === job)) {
      for (const value of step.with?.values() ?? []) {
        assert.doesNotMatch(value, /secrets\./, `${file}:${step.number} must not read a secret`);
      }
      assert.equal(step.with?.has('submodules') ?? false, false, `${file}:${step.number} must not fetch submodules`);
    }
  }
});

test('rejects an App-token action that is not pinned to an immutable commit', async () => {
  for (const site of tokenSites) {
    for (const uses of [
      'actions/create-github-app-token@v1',
      'actions/create-github-app-token@v2',
      'actions/create-github-app-token@v3',
      'actions/create-github-app-token@main',
      `${tokenActionOf(site)} # ${site.version}`,
      'actions/create-github-app-token@fee1f7d',
    ]) {
      const workflows = await repositoryWorkflows();
      tokenStepOf(workflows.documents, site.workflow).uses = uses;
      assert.throws(
        () => assertWithinBoundary(workflows),
        new RegExp(`App-token step must be pinned to actions/create-github-app-token@${site.ref}`),
        `expected ${uses} to be rejected in ${site.workflow}`,
      );
    }
  }
});

test('rejects an allowlist that names any repository but the one its site names', async () => {
  const cases = [
    ['build.yml', 'AnyWear-Client,AnyWear-Service-API', /requests `AnyWear-Client`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['build.yml', 'git-malu/AnyWear-Service-API', /requests `git-malu\/AnyWear-Service-API`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['build.yml', 'AnyWear-Service-API,AnyWear-Service', /requests `AnyWear-Service`; the build\.yml allowlist is exactly `AnyWear-Service-API`/],
    ['release.yml', 'AnyWear-Infra', /requests `AnyWear-Infra`; the release\.yml allowlist is exactly `AnyWear-E2E`/],
    ['release.yml', 'AnyWear-Service-API', /requests `AnyWear-Service-API`; the release\.yml allowlist is exactly `AnyWear-E2E`/],
  ];
  for (const [file, repositories, expected] of cases) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.set('repositories', repositories);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`repositories: ${repositories}\` to be rejected`);
  }
});

test('rejects an App-token step that drops the allowlist entirely', async () => {
  for (const site of tokenSites) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, site.workflow).with.delete('repositories');
    assert.throws(
      () => assertWithinBoundary(workflows),
      new RegExp(`App-token step must set \`repositories: ${site.repository}\`, found nothing`),
      `expected ${site.workflow} to keep its allowlist`,
    );
  }
});

test('rejects every permission beyond the one its site requests', async () => {
  for (const [file, key, value, expected] of [
    ['build.yml', 'permission-contents', 'write', /must request `permission-contents: read`, found `permission-contents: write`/],
    ['build.yml', 'permission-actions', 'read', /passes `permission-actions`, which is not one of the token site's boundary inputs/],
    ['build.yml', 'permission-attestations', 'read', /must request only `permission-contents`, found permission-contents, permission-attestations/],
    ['build.yml', 'permission-metadata', 'read', /must request only `permission-contents`, found permission-contents, permission-metadata/],
    ['build.yml', 'permission-pull-requests', 'write', /must request only `permission-contents`, found permission-contents, permission-pull-requests/],
    ['build.yml', 'permission-workflows', 'write', /must request only `permission-contents`, found permission-contents, permission-workflows/],
    ['release.yml', 'permission-actions', 'read', /must request `permission-actions: write`, found `permission-actions: read`/],
    ['release.yml', 'permission-contents', 'read', /must request only `permission-actions`, found permission-actions, permission-contents/],
    ['release.yml', 'permission-contents', 'write', /must request only `permission-actions`, found permission-actions, permission-contents/],
    ['release.yml', 'permission-workflows', 'write', /must request only `permission-actions`, found permission-actions, permission-workflows/],
  ]) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.set(key, value);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`${key}: ${value}\` in ${file} to be rejected`);
  }

  for (const [file, key, expected] of [
    ['build.yml', 'permission-contents', /must request only `permission-contents`, found no permission input/],
    ['release.yml', 'permission-actions', /must request only `permission-actions`, found no permission input/],
  ]) {
    const workflows = await repositoryWorkflows();
    tokenStepOf(workflows.documents, file).with.delete(key);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${file} without ${key} to be rejected`);
  }
});

test('rejects a substituted App ID or a secret outside the boundary on a token step', async () => {
  for (const [key, value, expected] of [
    ['app-id', '${{ secrets.APP_ID }}', /App ID must not be read from a secret, found `secrets.APP_ID`/],
    ['app-id', '${{ vars.OTHER_APP_ID }}', /App ID must come from `vars.APP_ID`, found `vars.OTHER_APP_ID`/],
    ['private-key', '${{ secrets.SOME_OTHER_TOKEN }}', /must set `private-key: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}`/],
    ['skip-token-revoke', 'true', /passes `skip-token-revoke`, which is not one of the token site's boundary inputs/],
  ]) {
    for (const site of tokenSites) {
      const workflows = await repositoryWorkflows();
      tokenStepOf(workflows.documents, site.workflow).with.set(key, value);
      assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`${key}: ${value}\` in ${site.workflow} to be rejected`);
    }
  }
});

test('rejects a specification checkout that widens or loses its credential', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('token', '${{ secrets.GITHUB_TOKEN }}'), /must use a generated App token output, found `\$\{\{ secrets\.GITHUB_TOKEN \}\}`/],
    [(step) => step.with.delete('token'), /must use a generated App token output, found `nothing`/],
    [(step) => step.with.set('token', '${{ steps.other.outputs.token }}'), /no App-token step declares that id/],
    [(step) => step.with.set('persist-credentials', 'true'), /must set `persist-credentials: false`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(specificationCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }
});

test('rejects a specification checkout that is not pinned to the recorded revision', async () => {
  const { specificationRevision } = await repositoryWorkflows();
  for (const [ref, expected] of [
    ['main', /must pin its revision by full commit, found `ref: main`/],
    [specificationRevision.slice(0, 7), new RegExp(`must pin its revision by full commit, found \`ref: ${specificationRevision.slice(0, 7)}\``)],
    ['0'.repeat(40), /pins `0{40}`, but the `api` submodule is checked out at/],
  ]) {
    const workflows = await repositoryWorkflows();
    specificationCheckoutOf(workflows.documents, 'build.yml').with.set('ref', ref);
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected \`ref: ${ref}\` to be rejected`);
  }

  const workflows = await repositoryWorkflows();
  specificationCheckoutOf(workflows.documents, 'build.yml').with.delete('ref');
  assert.throws(() => assertWithinBoundary(workflows), /must pin its revision by full commit, found `ref: nothing`/);
});

test('rejects a specification checkout that drifts from the submodule it stands in for', async () => {
  // The workflow literal and the submodule pointer must agree; a bump to one alone
  // is what this catches, and neither value is a literal in this test.
  const { documents, submoduleRepositories } = await repositoryWorkflows();
  const bumped = '1'.repeat(40);
  const violations = validateSourceCiCredentialBoundary({ documents, submoduleRepositories, specificationRevision: bumped });
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp('build\\.yml:47 specification checkout pins `[0-9a-f]{40}`, but the `api` submodule is checked out at `1{40}`'));

  const initialized = await specificationGitlink();
  assert.match(initialized, /^[0-9a-f]{40}$/, 'the api submodule must be initialised for this suite to check the pin');
});

test('rejects a checkout of any repository other than the specification', async () => {
  const workflows = await repositoryWorkflows();
  specificationCheckoutOf(workflows.documents, 'build.yml').with.set('repository', 'git-malu/AnyWear-Service');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /checkout fetches `git-malu\/AnyWear-Service`, which is not `git-malu\/AnyWear-Service-API`/,
  );
});

test('rejects a specification checkout that lands somewhere other than the submodule path', async () => {
  const workflows = await repositoryWorkflows();
  specificationCheckoutOf(workflows.documents, 'build.yml').with.set('path', 'spec');
  assert.throws(() => assertWithinBoundary(workflows), /must use `path: api`, found `path: spec`/);
});

test('rejects a Client checkout that takes a credential or fetches submodules', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('token', '${{ steps.generate-token.outputs.token }}'), /Client checkout must use the default credential/],
    [(step) => step.with.set('submodules', 'recursive'), /Client checkout must not fetch submodules; the specification checkout reads `git-malu\/AnyWear-Service-API` with the App token/],
    [(step) => step.with.set('path', 'spec'), /Client checkout must not set `path`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(clientCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }

  const workflows = await repositoryWorkflows();
  const rustCheckout = documentOf(workflows.documents, 'build.yml').steps
    .find((step) => step.job === 'rust-check' && step.uses === 'actions/checkout@v4');
  rustCheckout.with.set('submodules', 'true');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /build\.yml:105 the Client checkout must not fetch submodules/,
    'a job that reads no repository content must not fetch submodules under any spelling',
  );
});

test('rejects a checkout that fetches repository content by submodules rather than the boundary checkout', async () => {
  const workflows = await repositoryWorkflows();
  documentOf(workflows.documents, 'test.yml').steps
    .find((step) => step.uses === 'actions/checkout@v4')
    .with.set('submodules', 'recursive');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /test\.yml:19 the Client checkout must not fetch submodules; the specification checkout reads `git-malu\/AnyWear-Service-API` with the App token/,
  );
});

test('rejects a caller that inherits secrets, substitutes one, or maps one the callee does not declare', async () => {
  const cases = [
    ['inherit', /check\.yml:18 job `build` must map the required secret explicitly instead of `secrets: inherit`/],
    ['substituted', /job `build` must pass `APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}`, found `APP_PRIVATE_KEY: \$\{\{ secrets.SOME_OTHER_TOKEN \}\}`/],
    ['wrong-key', /job `build` passes `OTHER_KEY`, which is outside the credential boundary/],
    ['unmapped', /job `build` does not receive `APP_PRIVATE_KEY`, but its called workflow declares it/],
    ['extra', /job `test` receives `APP_PRIVATE_KEY`, but its called workflow declares no secret/],
  ];
  for (const [variant, expected] of cases) {
    const workflows = await repositoryWorkflows();
    const callers = documentOf(workflows.documents, 'check.yml').workflow.callers;
    const build = callers.find((caller) => caller.job === 'build');
    const unitTest = callers.find((caller) => caller.job === 'test');
    if (variant === 'inherit') {
      build.secretsInherit = true;
      build.mappedSecrets = [];
    } else if (variant === 'substituted') {
      build.mappedSecrets = [{ key: 'APP_PRIVATE_KEY', value: '${{ secrets.SOME_OTHER_TOKEN }}' }];
    } else if (variant === 'wrong-key') {
      build.mappedSecrets = [{ key: 'OTHER_KEY', value: '${{ secrets.APP_PRIVATE_KEY }}' }];
    } else if (variant === 'unmapped') {
      build.mappedSecrets = [];
    } else {
      unitTest.mappedSecrets = [{ key: 'APP_PRIVATE_KEY', value: '${{ secrets.APP_PRIVATE_KEY }}' }];
    }
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected the \`${variant}\` caller to be rejected`);
  }
});

test('rejects a called workflow that stops declaring the required secret', async () => {
  const optional = await repositoryWorkflows();
  documentOf(optional.documents, 'build.yml').workflow.calls = [{ name: 'APP_PRIVATE_KEY', required: 'false', number: 7 }];
  assert.throws(
    () => assertWithinBoundary(optional),
    /build\.yml:7 called workflow must declare secret `APP_PRIVATE_KEY` as `required: true`/,
  );

  const substituted = await repositoryWorkflows();
  documentOf(substituted.documents, 'build.yml').workflow.calls = [{ name: 'GITHUB_TOKEN', required: 'true', number: 7 }];
  assert.throws(
    () => assertWithinBoundary(substituted),
    /build\.yml:7 called workflow must declare only `APP_PRIVATE_KEY`, found `GITHUB_TOKEN`/,
  );

  const emptied = await repositoryWorkflows();
  documentOf(emptied.documents, 'build.yml').workflow.calls = [];
  assert.throws(
    () => assertWithinBoundary(emptied),
    /build\.yml:1 `build\.yml` must declare secret `APP_PRIVATE_KEY`/,
  );
});

test('rejects a workflow that does not declare read-only contents permission', async () => {
  for (const [grants, expected] of [
    [[], /build\.yml:9 workflow permissions must be exactly `contents: read`, found \{\}/],
    [[['contents', 'write']], /found \{"contents":"write"\}/],
    [[['contents', 'read'], ['id-token', 'write']], /found \{"contents":"read","id-token":"write"\}/],
    [[['actions', 'read']], /found \{"actions":"read"\}/],
  ]) {
    const workflows = await repositoryWorkflows();
    documentOf(workflows.documents, 'build.yml').workflow.permissions = { number: 9, grants: new Map(grants), inline: undefined };
    assert.throws(() => assertWithinBoundary(workflows), expected, `expected ${JSON.stringify(grants)} to be rejected`);
  }

  const missing = await repositoryWorkflows();
  documentOf(missing.documents, 'build.yml').workflow.permissions = null;
  assert.throws(() => assertWithinBoundary(missing), /build\.yml:1 workflow must declare `permissions: contents: read`/);

  const inline = await repositoryWorkflows();
  documentOf(inline.documents, 'build.yml').workflow.permissions = { number: 9, grants: new Map(), inline: 'read-all' };
  assert.throws(() => assertWithinBoundary(inline), /must declare `permissions: contents: read` as a mapping, found `read-all`/);
});

test('rejects a specification origin or submodule that the allowlist does not name', async () => {
  const { documents, specificationRevision } = await repositoryWorkflows();
  const renamed = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map([['api', 'git-malu/AnyWear-Service']]),
    specificationRevision,
  });
  assert.match(renamed.join('\n'), /`api` points at `git-malu\/AnyWear-Service`, and the allowlist names `AnyWear-Service-API`/);

  const extra = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map([['api', 'git-malu/AnyWear-Service-API'], ['extra', 'git-malu/AnyWear-E2E']]),
    specificationRevision,
  });
  assert.match(extra.join('\n'), /submodule `extra` points at `git-malu\/AnyWear-E2E`, which no checkout in the boundary fetches/);

  const absent = validateSourceCiCredentialBoundary({
    documents,
    submoduleRepositories: new Map(),
    specificationRevision,
  });
  assert.match(absent.join('\n'), /`\.gitmodules` declares no `api` submodule/);
});

test('rejects the boundary credential on any step but the two token sites and the specification checkout', async () => {
  for (const [file, mutate, expected] of [
    ['browser.yml', (document) => document.steps.find((step) => step.uses === 'pnpm/action-setup@v6').with.set('token', '${{ secrets.APP_PRIVATE_KEY }}'), /browser\.yml:30 step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites \(build\.yml:build, release\.yml:handoff\) and the specification checkout carry that credential/],
    ['test.yml', (document) => document.steps.find((step) => step.uses === 'actions/setup-node@v4').with.set('auth-token', '${{ secrets.APP_PRIVATE_KEY }}'), /test\.yml:25 step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites/],
    ['build.yml', (document) => document.steps.find((step) => step.job === 'rust-check' && step.uses === 'actions/checkout@v4').with.set('token', '${{ secrets.APP_PRIVATE_KEY }}'), /build\.yml:105/],
    ['release.yml', (document) => document.steps.find((step) => step.job === 'record' && step.uses === 'actions/upload-artifact@v4').with.set('name', '${{ secrets.APP_PRIVATE_KEY }}'), /release\.yml:\d+ step reads `secrets\.APP_PRIVATE_KEY`; only the two token sites/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(documentOf(workflows.documents, file));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }

  const workflows = await repositoryWorkflows();
  documentOf(workflows.documents, 'test.yml').steps.find((step) => step.uses === 'actions/setup-node@v4').with.set('auth-token', '${{ secrets.SOME_OTHER }}');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /test\.yml:25 step reads `secrets\.SOME_OTHER`, which is outside the credential boundary/,
  );
});

test('rejects a specification checkout that reads the secret directly or fetches submodules', async () => {
  for (const [mutate, expected] of [
    [(step) => step.with.set('extra-token', '${{ secrets.APP_PRIVATE_KEY }}'), /build\.yml:47 specification checkout reads `secrets\.APP_PRIVATE_KEY` directly/],
    [(step) => step.with.set('submodules', 'recursive'), /build\.yml:47 specification checkout must not fetch submodules; found `submodules: recursive`/],
  ]) {
    const workflows = await repositoryWorkflows();
    mutate(specificationCheckoutOf(workflows.documents, 'build.yml'));
    assert.throws(() => assertWithinBoundary(workflows), expected);
  }
});

test('fails closed when the credential surface is emptied or a call resolves elsewhere', async () => {
  const emptied = await repositoryWorkflows();
  for (const document of emptied.documents) document.steps = [];
  assert.throws(
    () => assertWithinBoundary(emptied),
    /no App-token step was found; the boundary is unverified/,
    'removing the token steps must not silently satisfy a suite that matches nothing',
  );

  const moved = await repositoryWorkflows();
  const caller = documentOf(moved.documents, 'check.yml').workflow.callers.find((candidate) => candidate.job === 'build');
  caller.uses = 'uses: ./.github/workflows/browser.yml';
  assert.throws(
    () => assertWithinBoundary(moved),
    /the credential-bearing workflow is `build\.yml`, and job `build` resolves to `browser\.yml`/,
  );
});

test('the boundary names the two token sites, each one repository and one permission', async () => {
  const submoduleRepositories = parseGitmodules(await readFile(gitmodulesPath, 'utf8'));
  assert.deepEqual([...submoduleRepositories], [['api', 'git-malu/AnyWear-Service-API']]);
  assert.equal(sourceCiCredentialBoundary.specificationRepository, 'AnyWear-Service-API');
  assert.equal(sourceCiCredentialBoundary.specificationPath, 'api');
  assert.equal(specificationRepositorySlug('git-malu'), 'git-malu/AnyWear-Service-API');
  assert.deepEqual(sourceCiCredentialBoundaryWith, {
    'app-id': '${{ vars.APP_ID }}',
    'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
    owner: '${{ github.repository_owner }}',
    repositories: 'AnyWear-Service-API',
    'permission-contents': 'read',
  });
  assert.deepEqual(tokenSites, [
    {
      workflow: 'build.yml',
      job: 'build',
      ref: 'fee1f7d63c2ff003460e3d139729b119787bc349',
      version: 'v2.2.2',
      repository: 'AnyWear-Service-API',
      permissions: { contents: 'read' },
      readsSpecification: true,
    },
    {
      workflow: 'release.yml',
      job: 'handoff',
      ref: '64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
      version: 'v3.3.0',
      repository: 'AnyWear-E2E',
      permissions: { actions: 'write' },
      readsSpecification: false,
    },
  ]);
  assert.deepEqual(tokenSites.map(tokenSiteWith), [
    {
      'app-id': '${{ vars.APP_ID }}',
      'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: 'AnyWear-Service-API',
      'permission-contents': 'read',
    },
    {
      'app-id': '${{ vars.APP_ID }}',
      'private-key': '${{ secrets.APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: 'AnyWear-E2E',
      'permission-actions': 'write',
    },
  ]);
});

test('the Client publication path adds one token, in handoff, and its checkouts keep the default credential', async () => {
  const { documents } = await repositoryWorkflows();
  const publisher = documentOf(documents, 'release.yml');
  const tokenSteps = publisher.steps.filter((step) => step.uses.startsWith('actions/create-github-app-token@'));
  assert.equal(tokenSteps.length, 1);
  assert.equal(`${tokenSteps[0].file}:${tokenSteps[0].job}`, 'release.yml:handoff');
  assert.deepEqual(publisher.steps.filter((step) => step.with?.has('submodules')), []);
  assert.deepEqual(publisher.workflow.calls, []);
  const checkouts = publisher.steps.filter((step) => step.uses === 'actions/checkout@v4');
  assert.ok(checkouts.length > 0, 'the publication chain still checks the Client out');
  for (const checkout of checkouts) {
    assert.equal(checkout.with.has('token'), false);
    assert.equal(checkout.with.has('repository'), false);
  }
});

test('a token step outside the two sites is rejected, so no other job can mint one', async () => {
  // The dispatch and the record jobs are the dangerous ones: either could start an
  // E2E run or edit a release if it minted a token of its own.
  for (const [file, job] of [['release.yml', 'record'], ['release.yml', 'deploy'], ['build.yml', 'rust-check'], ['check.yml', 'test']]) {
    const workflows = await repositoryWorkflows();
    const document = documentOf(workflows.documents, file);
    document.steps.push({
      file,
      number: 999,
      job,
      name: 'Extra token',
      id: 'extra',
      uses: tokenActionOf(tokenSites[0]),
      with: new Map(Object.entries(tokenSiteWith(tokenSites[0]))),
    });
    assert.throws(
      () => assertWithinBoundary(workflows),
      new RegExp(`App-token step is in \`${file}:${job}\`, which is not one of the two token sites`),
      `expected a token in ${file}:${job} to be rejected`,
    );
  }

  // Removing one of the two sites must fail, not quietly narrow the boundary.
  const workflows = await repositoryWorkflows();
  const release = documentOf(workflows.documents, 'release.yml');
  release.steps = release.steps.filter((step) => step.job !== 'handoff');
  assert.throws(
    () => assertWithinBoundary(workflows),
    /no App-token step was found in `release\.yml:handoff`; the release\.yml token site is unverified/,
  );
});

test('the pinned App-token action accepts every input each token site passes', async (t) => {
  // The action's own metadata and bundled implementation at each pinned commit are
  // the authority for what it accepts. This reaches the network; without it the
  // other cases still cover the boundaries the workflows must stay inside.
  const pinned = sourceCiCredentialBoundary.tokenAction;
  const source = async (ref, path) => {
    const response = await fetch(`https://raw.githubusercontent.com/${pinned.repository}/${ref}/${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, `${pinned.repository}@${ref}/${path} must be readable`);
    return response.text();
  };

  const metadata = new Map();
  try {
    for (const site of tokenSites) metadata.set(site.workflow, await source(site.ref, 'action.yml'));
  } catch (error) {
    t.diagnostic(`Pinned action metadata was not reachable: ${error.message}`);
    return;
  }

  // Every input each site passes must be an input that site's pin declares, and the
  // permission the site asks for must be one the action can request.
  for (const site of tokenSites) {
    const action = metadata.get(site.workflow);
    for (const key of Object.keys(tokenSiteWith(site))) {
      assert.match(action, new RegExp(`^\\s{2}${key}:$`, 'm'), `action.yml@${site.version} must declare input \`${key}\`, which ${site.workflow} passes`);
    }
    for (const name of Object.keys(site.permissions)) {
      assert.match(action, new RegExp(`^\\s{2}permission-${name}:$`, 'm'), `action.yml@${site.version} must declare \`permission-${name}\``);
    }
  }

  const sourceCi = tokenSites[0];
  assert.match(
    metadata.get(sourceCi.workflow),
    /^\s{2}permission-contents:\n(?:\s+.*\n)*?\s+description: "[^"]*'read' or 'write'\."/m,
    'the source-CI pin must keep declaring `permission-contents` as a read/write level',
  );

  // Runtime behaviour at the source-CI pin: the allowlist is applied to the named
  // owner, and the requested permission set is exactly what the workflow asks for.
  let implementation;
  try {
    implementation = await source(sourceCi.ref, 'dist/main.cjs');
  } catch (error) {
    t.diagnostic(`Pinned action implementation was not reachable: ${error.message}`);
    return;
  }

  assert.ok(implementation.includes("Inputs 'owner' and 'repositories' are set. Creating token for the following repositories"));
  assert.ok(implementation.includes('"GET /repos/{owner}/{repo}/installation"'));
  assert.ok(implementation.includes('"POST /app/installations/{installation_id}/access_tokens"'));
  assert.ok(implementation.includes('var repositories = getInput("repositories").split(/[\\n,]+/).map((s) => s.trim())'));
  assert.ok(implementation.includes('repositoryNames: parsedRepositoryNames,\n    permissions: permissions2'));

  // The v3 line deprecates `app-id` for `client-id`, so the source-CI pin stays inside
  // v2, whose declared inputs the specification checkout is written against. The
  // release handoff uses the v3 line and passes `app-id`, which that pin still
  // declares and accepts.
  assert.equal(sourceCi.version, 'v2.2.2');
  assert.equal(tokenSites[1].version, 'v3.3.0');
});

test('the submodule revision comes from the index gitlink, not a literal', async () => {
  const gitlink = await specificationGitlink();
  assert.match(gitlink, /^[0-9a-f]{40}$/);
  assert.equal(await readSubmoduleRevision(repositoryRoot, sourceCiCredentialBoundary.specificationPath), gitlink);

  // The reader must refuse anything that is not the gitlink it is looking for, rather
  // than answering with something that looks like a revision.
  assert.throws(
    () => parseIndexGitlink(Buffer.from('nope'), 'api'),
    /The git index does not start with DIRC/,
  );
  const index = await readIndexFileForTest();
  assert.equal(parseIndexGitlink(index, sourceCiCredentialBoundary.specificationPath), gitlink);
  assert.throws(() => parseIndexGitlink(index, 'not-a-path'), /The git index records no `not-a-path` entry/);
  assert.throws(
    () => parseIndexGitlink(index, '.gitmodules'),
    /Index entry `\.gitmodules` is mode 100644, not a gitlink/,
    'a tracked file at the same path must not be read as a revision',
  );
});

/** The repository's git index, located the same way for a clone and a worktree. */
async function readIndexFileForTest() {
  const entryPath = new URL('.git', repositoryRoot);
  const entry = await readFile(entryPath, 'utf8').catch(() => undefined);
  if (entry === undefined) return readFile(new URL('.git/index', repositoryRoot));
  const gitDirectory = /^gitdir:\s*(.+)$/m.exec(entry)?.[1]?.trim();
  return readFile(new URL('index', pathToFileURL(`${resolve(fileURLToPath(repositoryRoot), gitDirectory)}${sep}`)));
}

test('an unreadable workflow or .gitmodules is reported instead of passing silently', async () => {
  assert.throws(
    () => parseWorkflow('name: X\nfoo: bar\n', 'broken.yml'),
    /Unsupported top-level workflow key on line 2: foo/,
    'an unknown top-level key means the file was not read as expected',
  );
  assert.throws(
    () => parseWorkflow('name: X\njobs:\n  build:\n    steps:\n      - run\n', 'broken.yml'),
    /Unsupported workflow syntax on line 5: run/,
    'a step that is not `- key: value` must not be read as a boundary-shaped file',
  );
  assert.throws(
    () => parseWorkflow('name: X\njobs:\n  build:\n    steps:\n      with: x\n', 'broken.yml'),
    /Expected a workflow step on line 5: with: x/,
    'a steps block that is not a sequence must not be read as steps',
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\turl = https://github.com/git-malu/AnyWear-Service-API.git\n'),
    /declares a url before its path/,
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\tpath = api\n\turl = git@gitlab.com:git-malu/AnyWear-Service-API.git\n'),
    /url is not a GitHub repository/,
  );
  assert.throws(
    () => parseGitmodules('[submodule "api"]\n\tpath = api\n'),
    /declares path 'api' without a url/,
  );
});
