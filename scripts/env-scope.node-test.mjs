import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #163: an environment-scope guard for workflow configuration.
//
// The defect class: a job reads a configuration name that is configured at
// environment scope while the job declares no `environment`, so GitHub resolves
// it as empty and the failure only surfaces at the credentialed step. Client hit
// the same class as Infra and E2E. The fix was at the configuration layer
// (repository-scoped variables, no stale beta switch); this file makes the
// structure that prevented the defect visible in source, so a regression fails
// `pnpm run test:run` instead of the next release.
//
// The text is sliced without a YAML dependency, in the same style as the other
// repository source guards.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const read = (name) => readFileSync(join(workflowsDirectory, name), 'utf8');

// The explicit allowlist of configuration names a job without `environment:`
// may read. Every name here is configured at repository scope, so it is
// resolvable before any environment exists. This list is a deliberate
// maintenance point: adding a name is a scope decision, and removing the last
// reference to a name must also prune it here (stale entries fail).
const REPOSITORY_SCOPED = {
  vars: [
    // Repository-scoped: App id used to mint the API-spec token; resolvable before any environment exists.
    'APP_ID',
    // Repository-scoped: Beta account asserted before any AWS call; resolvable before any environment exists.
    'AWS_ACCOUNT_ID',
    // Repository-scoped: Beta region asserted before any AWS call; resolvable before any environment exists.
    'AWS_REGION',
    // Repository-scoped: dedicated Beta publish-role ARN; resolvable before any environment exists.
    'CLIENT_PUBLISH_ROLE_ARN',
    // Repository-scoped: the single stage switch that gates the deploy chain; resolvable before any environment exists.
    'ENABLE_BETA_MUTATION',
  ],
  secrets: [
    // Repository-scoped: App private key used only by the API-spec token step; resolvable before any environment exists.
    'APP_PRIVATE_KEY',
  ],
};

// Configuration names that resolve only after the job enters its environment.
// The list is empty today: every name the workflows read is configured at
// repository scope. Populating it is a deliberate decision, and the referencing
// job must then declare `environment:`, or this guard fails. Adding a name here
// is not a way to make a reference pass silently.
const ENVIRONMENT_SCOPED = [];

const configurationReference = /\$\{\{\s*(vars|secrets)\.([A-Za-z0-9_]+)\s*\}\}/g;

/** The `vars.*` / `secrets.*` expressions a block of workflow text contains. */
function references(text) {
  return [...text.matchAll(configurationReference)].map((match) => ({ kind: match[1], name: match[2] }));
}

/** The workflow's jobs, each with the text of its section, in file order. */
function jobEntries(workflow) {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'the workflow must declare a top-level `jobs:` block');
  const body = workflow.slice(start + marker.length);
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)];
  assert.ok(headers.length > 0, 'the workflow must declare at least one job');
  return headers.map((header, index) => ({
    name: header[1],
    section: body.slice(header.index, index + 1 < headers.length ? headers[index + 1].index : body.length),
  }));
}

/** Whether a job section declares a job-level `environment:`. */
function declaresEnvironment(section) {
  return /^ {4}environment:/m.test(section);
}

test('every configuration reference declares a repository or environment scope', () => {
  const declared = new Set();
  for (const file of workflowFiles) {
    for (const job of jobEntries(read(file))) {
      for (const reference of references(job.section)) {
        const key = `${reference.kind}.${reference.name}`;
        declared.add(key);
        assert.ok(
          REPOSITORY_SCOPED[reference.kind].includes(reference.name) || ENVIRONMENT_SCOPED.includes(reference.name),
          `${file}:${job.name} reads ${key}, which is not in REPOSITORY_SCOPED or ENVIRONMENT_SCOPED; decide and document its scope`,
        );
      }
    }
  }

  // The allowlist is a decision log, not a lint suppression: an entry nothing
  // references any more must be pruned deliberately so the list cannot drift.
  assert.ok(declared.size > 0, 'the workflows must reference production configuration for this guard to be meaningful');
  for (const kind of ['vars', 'secrets']) {
    for (const name of REPOSITORY_SCOPED[kind]) {
      assert.ok(declared.has(`${kind}.${name}`), `${kind}.${name} is allowlisted as repository-scoped but no workflow references it`);
    }
  }
});

test('a job without an environment reads only repository-scoped configuration', () => {
  let jobsWithEnvironment = 0;
  for (const file of workflowFiles) {
    for (const job of jobEntries(read(file))) {
      if (declaresEnvironment(job.section)) {
        jobsWithEnvironment += 1;
        continue;
      }
      for (const reference of references(job.section)) {
        assert.ok(
          !ENVIRONMENT_SCOPED.includes(reference.name),
          `${file}:${job.name} reads ${reference.kind}.${reference.name} without declaring \`environment:\`, so the value would resolve empty`,
        );
      }
    }
  }
  assert.ok(jobsWithEnvironment > 0, 'at least one job must declare an environment for this guard to be meaningful');
});

test('the deploy chain keeps the publish role at repository scope until the single environment job', () => {
  const release = read('release.yml');
  const jobs = Object.fromEntries(jobEntries(release).map((job) => [job.name, job.section]));
  assert.deepEqual(Object.keys(jobs), ['build', 'verify', 'deploy', 'record']);

  // One environment, one OIDC token, and only on the job that publishes.
  const withEnvironment = Object.keys(jobs).filter((name) => declaresEnvironment(jobs[name]));
  assert.deepEqual(withEnvironment, ['deploy'], 'only deploy may declare an environment');
  assert.match(jobs.deploy, /^ {4}environment: beta$/m);

  const withIdToken = Object.keys(jobs).filter((name) => /^ {6}id-token:/m.test(jobs[name]));
  assert.deepEqual(withIdToken, ['deploy'], 'only deploy may declare an OIDC token');
  assert.match(jobs.deploy, /^ {6}id-token: write$/m);

  // The publishing job is where the role is assumed, and it is the only one
  // allowed to resolve it behind an environment.
  assert.match(jobs.deploy, /^ {10}role-to-assume: \$\{\{ vars\.CLIENT_PUBLISH_ROLE_ARN \}\}$/m);

  // verify and record must keep resolving the role at repository scope: no
  // environment, no OIDC token, and no other spelling of the name.
  for (const name of ['verify', 'record']) {
    assert.doesNotMatch(jobs[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(jobs[name], /^ {6}id-token:/m, `${name} must not declare an OIDC token`);
    const roleExpressions = [...jobs[name].matchAll(/\$\{\{[^}]*CLIENT_PUBLISH_ROLE_ARN[^}]*\}\}/g)].map((match) => match[0]);
    assert.ok(roleExpressions.length > 0, `${name} must keep the repository-scoped publish role reference`);
    for (const expression of roleExpressions) {
      assert.equal(expression, '${{ vars.CLIENT_PUBLISH_ROLE_ARN }}', `${name} must resolve the role at repository scope`);
    }
  }

  // The chain order is explicit and survives any edit to the sections above.
  assert.doesNotMatch(jobs.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(jobs.verify, /^ {4}needs: \[build\]$/m);
  assert.match(jobs.deploy, /^ {4}needs: \[verify\]$/m);
  assert.match(jobs.record, /^ {4}needs: \[deploy\]$/m);
});

test('the automatic entry stays automatic and the release entry stays the only dispatch surface', () => {
  const dispatchSurfaces = workflowFiles.filter((file) => /^ {2}workflow_dispatch:$/m.test(read(file)));
  assert.deepEqual(dispatchSurfaces, ['release.yml']);

  const check = read('check.yml');
  assert.doesNotMatch(check, /workflow_dispatch/);
  assert.match(check, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);
});
