import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #163: the repository-side census of the entry face. Client ends this change with
// exactly two entries — one automatic check and one manual release — one manual
// dispatch surface and one activation switch, and the deploy chain keeps the only
// AWS-credential job behind the credential-free verify job with a credential-free
// record job after it. These are source assertions, read as text with no YAML
// dependency, so the next change cannot drift the entry face without failing
// `pnpm run test:run`.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const read = (name) => readFileSync(join(workflowsDirectory, name), 'utf8');

const automaticEntry = 'check.yml';
const manualEntry = 'release.yml';
const calledWorkflows = ['build.yml', 'test.yml', 'browser.yml'];

/** The top-level `on:` block, ending at the next column-zero mapping key. */
function onSection(workflow) {
  const match = /^on:\n/m.exec(workflow);
  assert.ok(match, 'the workflow must declare a top-level `on:` block');
  const rest = workflow.slice(match.index + match[0].length);
  const next = rest.search(/^[a-z][a-z0-9-]*:\n/m);
  return rest.slice(0, next < 0 ? undefined : next);
}

/** Trigger names declared directly under `on:`. */
function triggers(workflow) {
  return [...onSection(workflow).matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]);
}

/** Job ids declared under `jobs:`, in file order. */
function jobNames(workflow) {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'the workflow must declare a top-level `jobs:` block');
  return [...workflow.slice(start + marker.length).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
    .map((match) => match[1]);
}

/** One job's text, from its two-space `id:` line to the next two-space key. */
function jobSection(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

/** One `workflow_dispatch.inputs` entry, from its six-space `name:` line. */
function inputBlock(workflow, name) {
  const marker = `\n      ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `${name} must be a workflow input`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {6}[a-z0-9_]+:\n/);
  return rest.slice(0, next < 0 ? undefined : next);
}

/** One `steps:` entry, from its six-space `- name:` line to the next step. */
function stepSection(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `the workflow must declare the ${name} step`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {6}- /);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

test('the workflow directory contains exactly the five repository workflows', () => {
  assert.deepEqual(workflowFiles, ['browser.yml', 'build.yml', 'check.yml', 'release.yml', 'test.yml']);
});

test('the repository exposes exactly two entries: one automatic check and one manual release', () => {
  // An entry is a workflow with a repository event or a dispatch surface. Everything
  // else must be a called workflow, which has no entry identity of its own.
  const entries = workflowFiles.filter((name) => {
    const declared = triggers(read(name));
    return declared.some((trigger) => trigger === 'push' || trigger === 'pull_request' || trigger === 'workflow_dispatch');
  });
  assert.deepEqual(entries, [automaticEntry, manualEntry]);

  for (const name of calledWorkflows) {
    assert.deepEqual(triggers(read(name)), ['workflow_call'], `${name} is a called workflow, not an entry`);
  }
});

test('the manual dispatch surface is exactly one workflow, release.yml', () => {
  const manual = workflowFiles.filter((name) => triggers(read(name)).includes('workflow_dispatch'));
  assert.deepEqual(manual, [manualEntry]);
  assert.equal([...read(manualEntry).matchAll(/^ {2}workflow_dispatch:$/gm)].length, 1);

  const check = read(automaticEntry);
  assert.deepEqual(triggers(check).sort(), ['pull_request', 'push']);
  assert.doesNotMatch(check, /workflow_dispatch/, 'the automatic check has no dispatch surface');
});

test('release.yml offers exactly one required choice operation: deploy', () => {
  const release = read(manualEntry);
  const operation = inputBlock(release, 'operation');
  assert.match(operation, /^ {8}type: choice$/m);
  assert.match(operation, /^ {8}required: true$/m);
  assert.match(operation, /^ {8}options: \[deploy\]$/m);
});

test('only deploy holds an environment and an OIDC token, after verify, with a credential-free record', () => {
  const release = read(manualEntry);
  const names = jobNames(release);
  assert.deepEqual(names, ['build', 'verify', 'deploy', 'record']);

  const sections = Object.fromEntries(names.map((name) => {
    const section = jobSection(release, name);
    assert.ok(section.length > 0, `release.yml must declare the ${name} job`);
    return [name, section];
  }));

  // The credential boundary is a single job, and it is the last one before recording.
  assert.deepEqual(names.filter((name) => /^ {4}environment:/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /^ {6}id-token: write$/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /configure-aws-credentials/.test(sections[name])), ['deploy']);
  for (const name of ['build', 'verify', 'record']) {
    assert.doesNotMatch(sections[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(sections[name], /id-token/, `${name} must not declare an OIDC token`);
    assert.doesNotMatch(sections[name], /configure-aws-credentials/, `${name} must not acquire AWS credentials`);
  }

  assert.match(sections.deploy, /^ {4}environment: beta$/m);
  assert.match(sections.deploy, /^ {6}id-token: write$/m);
  assert.match(sections.deploy, /^ {4}needs: \[verify\]$/m);

  // The chain order is explicit: build -> verify -> deploy -> record.
  assert.doesNotMatch(sections.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(sections.verify, /^ {4}needs: \[build\]$/m);
  assert.match(sections.record, /^ {4}needs: \[deploy\]$/m);
  assert.ok(names.indexOf('verify') < names.indexOf('deploy'));
  assert.ok(names.indexOf('deploy') < names.indexOf('record'));

  // The record job records; it holds no permission beyond reading the repository.
  const recordPermissions = /^ {4}permissions:\n((?: {6}[a-z0-9-]+: [a-z]+(?:\n|$))+)/m.exec(sections.record)?.[1];
  assert.equal(recordPermissions, '      contents: read\n');
});

test('the only activation switch in any workflow is ENABLE_BETA_MUTATION', () => {
  const names = new Set();
  for (const name of workflowFiles) {
    for (const match of read(name).matchAll(/\bENABLE_[A-Z0-9_]+\b/g)) names.add(match[0]);
  }
  assert.deepEqual([...names], ['ENABLE_BETA_MUTATION']);

  const release = read(manualEntry);
  assert.match(release, /vars\.ENABLE_BETA_MUTATION/);
  for (const name of workflowFiles.filter((candidate) => candidate !== manualEntry)) {
    assert.doesNotMatch(read(name), /\bENABLE_[A-Z0-9_]+\b/, `${name} must not declare an activation switch`);
  }
});

test('check.yml wires the three called workflows and maps the App secret only on build', () => {
  const check = read(automaticEntry);
  assert.deepEqual(jobNames(check), ['build', 'test', 'browser']);

  const build = jobSection(check, 'build');
  const unitTest = jobSection(check, 'test');
  const browser = jobSection(check, 'browser');
  for (const [name, section] of [['build', build], ['test', unitTest], ['browser', browser]]) {
    assert.ok(section.length > 0, `check.yml must declare the ${name} job`);
  }

  assert.match(build, /^ {4}uses: \.\/\.github\/workflows\/build\.yml$/m);
  assert.match(build, /^ {4}secrets:\n {6}APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}$/m);
  assert.doesNotMatch(build, /secrets: inherit/);

  assert.match(unitTest, /^ {4}needs: \[build\]$/m);
  assert.match(unitTest, /^ {4}uses: \.\/\.github\/workflows\/test\.yml$/m);
  assert.doesNotMatch(unitTest, /secrets:/);

  assert.match(browser, /^ {4}needs: \[test\]$/m);
  assert.match(browser, /^ {4}uses: \.\/\.github\/workflows\/browser\.yml$/m);
  assert.doesNotMatch(browser, /secrets:/);
});

// #188: the deploy job resolves the whole live interface from the Beta `Base`
// stack, which owns both CloudFront distributions and the `ApiBaseUrl` output.
// The retired workload stack read was denied and left the publish with no asset
// sync, no invalidation and no publication record.
test('#188: the release deploy reads the Beta Base stack only and resolves its interface', () => {
  const release = read(manualEntry);
  // Assembled from its parts so this guard does not itself defeat the issue's
  // repository-wide census that the retired stack name has zero occurrences.
  const retiredStack = ['AnyWearWorkloadStack', 'beta'].join('-');
  assert.ok(!release.includes(retiredStack), 'the release path must not name the retired stack');

  const settings = stepSection(release, 'Resolve Beta deployment settings');
  assert.deepEqual(
    [...settings.matchAll(/--stack-name\s+(\S+)/g)].map((match) => match[1]),
    ['AnyWearPlatformStack-beta'],
    'the settings step reads exactly the Beta Base stack',
  );
  assert.match(settings, /require_output ApiBaseUrl|select\(\.OutputKey == "ApiBaseUrl"\)/);
  assert.match(settings, /\/anywear\/beta\/cognito_user_pool_id/);
  assert.match(settings, /\/anywear\/beta\/cognito_client_id/);
  assert.equal([...settings.matchAll(/aws ssm get-parameter/g)].length, 2);
  for (const output of ['bucket', 'distribution', 'api_url', 'pool_id', 'client_id']) {
    assert.ok(
      settings.includes(`echo "${output}=$${output}"`),
      `${output} leaves the settings step as a step output`,
    );
  }
  assert.match(settings, /\} >> "\$GITHUB_OUTPUT"/);
});
