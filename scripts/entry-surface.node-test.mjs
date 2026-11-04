import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #163: the repository-side census of the entry face. Client ends this change with
// exactly two entries — one automatic check and one publication entry that runs on
// a merge to `main` and on a manual dispatch — one dispatch surface and one
// activation switch, and the publication chain keeps the only AWS-credential job
// behind the credential-free verify job with a credential-free record job after it
// and a credential-free dispatch job after that. These are source assertions, read
// as text with no YAML dependency, so the next change cannot drift the entry face
// without failing `pnpm run test:run`.

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

/** The top-level `env:` block, ending at the next column-zero mapping key. */
function envSection(workflow) {
  const match = /^env:\n/m.exec(workflow);
  assert.ok(match, 'the workflow must declare a top-level `env:` block');
  const rest = workflow.slice(match.index + match[0].length);
  const next = rest.search(/^[a-z][a-z0-9-]*:\n/m);
  return rest.slice(0, next < 0 ? undefined : next);
}

test('the workflow directory contains exactly the five repository workflows', () => {
  assert.deepEqual(workflowFiles, ['browser.yml', 'build.yml', 'check.yml', 'release.yml', 'test.yml']);
});

test('the repository exposes exactly two entries: one automatic check and one publication entry', () => {
  // An entry is a workflow with a repository event or a dispatch surface. Everything
  // else must be a called workflow, which has no entry identity of its own.
  const entries = workflowFiles.filter((name) => {
    const declared = triggers(read(name));
    return declared.some((trigger) => trigger === 'push' || trigger === 'pull_request' || trigger === 'workflow_dispatch');
  });
  assert.deepEqual(entries, [automaticEntry, manualEntry]);

  // `check.yml` stays the only automatic check: it is the only workflow that runs on
  // pull requests, and the only one whose push event is a check rather than a
  // publication.
  const checks = workflowFiles.filter((name) => triggers(read(name)).includes('pull_request'));
  assert.deepEqual(checks, [automaticEntry]);
  assert.deepEqual(triggers(read(automaticEntry)).sort(), ['pull_request', 'push']);

  for (const name of calledWorkflows) {
    assert.deepEqual(triggers(read(name)), ['workflow_call'], `${name} is a called workflow, not an entry`);
  }
});

test('the publication entry runs on a merge to main as well as on a manual dispatch', () => {
  const release = read(manualEntry);
  assert.deepEqual(triggers(release).sort(), ['push', 'workflow_dispatch']);
  assert.match(onSection(release), /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(onSection(release), /^ {2}workflow_dispatch:$/m);

  const check = read(automaticEntry);
  assert.doesNotMatch(check, /workflow_dispatch/, 'the automatic check has no dispatch surface');
});

test('the dispatch surface is exactly one workflow, release.yml', () => {
  const manual = workflowFiles.filter((name) => triggers(read(name)).includes('workflow_dispatch'));
  assert.deepEqual(manual, [manualEntry]);
  assert.equal([...read(manualEntry).matchAll(/^ {2}workflow_dispatch:$/gm)].length, 1);
});

test('release.yml offers exactly one required choice operation: deploy', () => {
  const release = read(manualEntry);
  const operation = inputBlock(release, 'operation');
  assert.match(operation, /^ {8}type: choice$/m);
  assert.match(operation, /^ {8}required: true$/m);
  assert.match(operation, /^ {8}options: \[deploy\]$/m);
});

test('only deploy holds an environment and an OIDC token, after verify, with credential-free record and handoff', () => {
  const release = read(manualEntry);
  const names = jobNames(release);
  assert.deepEqual(names, ['build', 'verify', 'deploy', 'record', 'handoff']);

  const sections = Object.fromEntries(names.map((name) => {
    const section = jobSection(release, name);
    assert.ok(section.length > 0, `release.yml must declare the ${name} job`);
    return [name, section];
  }));

  // The credential boundary is a single job, and it is the last one before recording.
  assert.deepEqual(names.filter((name) => /^ {4}environment:/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /^ {6}id-token: write$/m.test(sections[name])), ['deploy']);
  assert.deepEqual(names.filter((name) => /configure-aws-credentials/.test(sections[name])), ['deploy']);
  for (const name of ['build', 'verify', 'record', 'handoff']) {
    assert.doesNotMatch(sections[name], /^ {4}environment:/m, `${name} must not declare an environment`);
    assert.doesNotMatch(sections[name], /id-token/, `${name} must not declare an OIDC token`);
    assert.doesNotMatch(sections[name], /configure-aws-credentials/, `${name} must not acquire AWS credentials`);
  }

  assert.match(sections.deploy, /^ {4}environment: beta$/m);
  assert.match(sections.deploy, /^ {6}id-token: write$/m);
  assert.match(sections.deploy, /^ {4}needs: \[verify\]$/m);

  // The chain order is explicit: build -> verify -> deploy -> record -> handoff.
  assert.doesNotMatch(sections.build, /^ {4}needs:/m, 'build is the first job of the chain');
  assert.match(sections.verify, /^ {4}needs: \[build\]$/m);
  assert.match(sections.record, /^ {4}needs: \[deploy\]$/m);
  assert.match(sections.handoff, /^ {4}needs: \[record\]$/m);
  assert.ok(names.indexOf('verify') < names.indexOf('deploy'));
  assert.ok(names.indexOf('deploy') < names.indexOf('record'));
  assert.ok(names.indexOf('record') < names.indexOf('handoff'));

  // record and handoff record and dispatch; neither holds a permission beyond
  // reading the repository.
  for (const name of ['record', 'handoff']) {
    const permissions = /^ {4}permissions:\n((?: {6}[a-z0-9-]+: [a-z]+(?:\n|$))+)/m.exec(sections[name])?.[1];
    assert.equal(permissions, '      contents: read\n', `${name} must hold only \`contents: read\``);
  }
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
test('#188: the deploy job reads the Beta Base stack only and resolves its interface', () => {
  const release = read(manualEntry);
  // Assembled from its parts so this guard does not itself defeat the issue's
  // repository-wide census that the retired stack name has zero occurrences.
  const retiredStack = ['AnyWearWorkloadStack', 'beta'].join('-');
  assert.ok(!release.includes(retiredStack), 'the deploy path must not name the retired stack');

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

// #226: a merge publishes the same interface the manual dispatch used to type. The
// three values are reviewed workflow constants, and each job reads the dispatch
// override or the constant, so a push needs no input and a manual dispatch behaves
// exactly as before.
test('#226: the reviewed Beta interface is a workflow constant the build compiles', () => {
  const release = read(manualEntry);
  assert.deepEqual(
    Object.fromEntries([...envSection(release).matchAll(/^ {2}([A-Z0-9_]+): '([^']*)'$/gm)].map((match) => [match[1], match[2]])),
    {
      BETA_API_BASE_URL: 'https://d1pfqujqt29n11.cloudfront.net',
      BETA_COGNITO_USER_POOL_ID: 'ap-east-1_XqXt4Kw1L',
      BETA_COGNITO_CLIENT_ID: '4jp37atfitq59hmjo404342int',
    },
  );

  const reads = {
    BETA_API_BASE_URL: 'api_base_url',
    BETA_COGNITO_USER_POOL_ID: 'cognito_user_pool_id',
    BETA_COGNITO_CLIENT_ID: 'cognito_client_id',
  };
  const build = stepSection(release, 'Build Beta web client');
  for (const [constant, input] of Object.entries(reads)) {
    const expression = new RegExp(`^ {10}VITE_${constant.replace('BETA_', '')}: \\$\\{\\{ inputs\\.${input} \\|\\| env\\.${constant} \\}\\}$`, 'm');
    assert.match(build, expression, `build must compile the ${constant} constant when no input is given`);
  }

  const verify = stepSection(release, 'Validate publication identity and declared interface');
  for (const [constant, input] of Object.entries(reads)) {
    const expression = new RegExp(`^ {10}DECLARED_${constant.replace('BETA_', '')}: \\$\\{\\{ inputs\\.${input} \\|\\| env\\.${constant} \\}\\}$`, 'm');
    assert.match(verify, expression, `verify must compare the same interface a push compiled`);
  }

  // `deploy` re-checks the declared interface before its first AWS write.
  assert.match(
    jobSection(release, 'deploy'),
    /^ {10}DECLARED_API_BASE_URL: \$\{\{ inputs\.api_base_url \|\| env\.BETA_API_BASE_URL \}\}$/m,
  );

  // The interface is not repository configuration: changing a value is a reviewed
  // change to this workflow, not an owner setting the run cannot see.
  assert.doesNotMatch(release, /vars\.(?:BETA_|API_BASE_URL|COGNITO_)/);
});

test('#226: deploy still refuses a live interface that differs before the first S3 write', () => {
  const deploy = jobSection(read(manualEntry), 'deploy');
  const refusal = deploy.indexOf('      - name: Refuse a live interface that differs from the built interface\n');
  const publish = deploy.indexOf('      - name: Publish static assets\n');
  assert.ok(refusal >= 0, 'deploy must keep the live-interface refusal step');
  assert.ok(publish >= 0, 'deploy must keep the publish step');
  assert.ok(refusal < publish, 'the refusal must run before the first S3 write');
  assert.match(
    stepSection(deploy, 'Refuse a live interface that differs from the built interface'),
    /^ {8}run: node \.github\/scripts\/assert-client-publication\.mjs deploy$/m,
  );
});

test('#226: the handoff dispatches exactly one deploy-smoke and has no step after it', () => {
  const handoff = jobSection(read(manualEntry), 'handoff');
  assert.deepEqual(
    [...handoff.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]),
    [
      'Mint the AnyWear-E2E dispatch token',
      'Check for a smoke run already queued for this publication',
      'Dispatch the post-publication smoke',
    ],
    'the dispatch is the last step',
  );

  // One App token, narrowed to the E2E repository with `actions: write` only.
  const token = stepSection(handoff, 'Mint the AnyWear-E2E dispatch token');
  assert.match(token, /^ {10}repositories: AnyWear-E2E$/m);
  assert.match(token, /^ {10}permission-actions: write$/m);
  assert.match(
    handoff,
    /^ {6}DISPATCHED_BY: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}$/m,
  );

  // The dedupe lists this workflow's queued and in-progress runs and skips when this
  // run's URL already appears in one; a failed listing dispatches anyway.
  const dedupe = stepSection(handoff, 'Check for a smoke run already queued for this publication');
  assert.match(dedupe, /for status in queued in_progress; do/);
  assert.match(dedupe, /repos\/\$\{E2E_OWNER\}\/\$\{E2E_REPOSITORY\}\/actions\/workflows\/\$\{E2E_WORKFLOW\}\/runs\?status=\$\{status\}/);
  assert.match(dedupe, /Skipping the smoke dispatch/);
  assert.match(dedupe, /dispatching the smoke anyway/);

  // The payload is exactly the four fields, `dispatched_by` is this run's URL, and no
  // expected commit is sent. `gh workflow run` cannot return the run, so the REST
  // endpoint is called with `return_run_details`.
  const dispatch = stepSection(handoff, 'Dispatch the post-publication smoke');
  assert.match(dispatch, /repos\/\$\{E2E_OWNER\}\/\$\{E2E_REPOSITORY\}\/actions\/workflows\/\$\{E2E_WORKFLOW\}\/dispatches/);
  assert.match(dispatch, /-F return_run_details=true/);
  assert.match(dispatch, /-f 'inputs\[operation\]=smoke'/);
  assert.match(dispatch, /-f 'inputs\[trigger\]=deploy-smoke'/);
  assert.match(dispatch, /-f 'inputs\[worker_slot_offset\]=0'/);
  assert.match(dispatch, /-f "inputs\[dispatched_by\]=\$\{DISPATCHED_BY\}"/);
  assert.doesNotMatch(dispatch, /expected_/);

  // #226: the dispatch response names the run it created, so the normal path verifies
  // that run by id with one read and no polling. The run title renders after the run
  // appears, so a check that reads it immediately failed in production for a run that
  // existed; the title is read only inside the bounded fallback branch.
  assert.match(dispatch, /run_id="\$\(jq -r '\.workflow_run_id \/\/ empty' <<< "\$response"\)"/);
  assert.match(dispatch, /run_url="\$\(jq -r '\.html_url \/\/ \.run_url \/\/ empty' <<< "\$response"\)"/);

  const fallbackMarker = 'Fallback only when the response carries no `workflow_run_id`';
  const fallbackStart = dispatch.indexOf(fallbackMarker);
  assert.ok(fallbackStart > 0, 'the dispatch step must keep the fallback branch for a response carrying no run id');

  const byId = dispatch.slice(0, fallbackStart);
  assert.match(byId, /^ {10}if \[ -n "\$run_id" \]; then$/m, 'the by-id path is the normal path, taken when the response carries the id');
  assert.match(byId, /actions\/runs\/\$\{run_id\}" --jq '\.id'/);
  assert.match(byId, /\[ "\$created_id" != "\$run_id" \]/, 'the created run id must equal the dispatched id');
  assert.doesNotMatch(byId, /display_title/, 'the normal path must not read the run title');
  assert.doesNotMatch(byId, /sleep/, 'the normal path must not poll');

  // The fallback is a bounded poll: a finite attempt count, a wait between attempts,
  // and a failure only after the attempts are exhausted.
  const fallback = dispatch.slice(fallbackStart);
  assert.match(fallback, /display_title/, 'only the fallback reads the run title');
  assert.match(fallback, /attempts=\d+/);
  assert.match(fallback, /for attempt in \$\(seq 1 "\$attempts"\)/);
  assert.match(fallback, /sleep "\$wait_seconds"/);
  assert.match(fallback, /if \[ "\$attempt" -lt "\$attempts" \]/);
  assert.match(fallback, /\[ -z "\$run_url" \]/);
  assert.match(fallback, /appeared in \$\{attempts\} attempts/);
});

// #226: `verify` runs `pnpm run test:run`, which includes the ambient case in
// `assert-client-version-bump.node-test.mjs`: it calls the real checker with the CI
// environment, and under the `push` trigger the checker resolves `github.event.before`
// from the event payload and reads that commit from this checkout. A depth-1 checkout
// does not contain the revision, so the ambient check fails on a merge with an
// unresolvable base even when the version history itself satisfies the rule. Give
// `verify` the history the check resolves.
test('#226: the verify checkout fetches the history the version-bump check reads', () => {
  const release = read(manualEntry);
  const verify = jobSection(release, 'verify');
  assert.match(verify, /^ {8}run: pnpm run test:run$/m, 'verify must keep running the suite that holds the bump check');

  const checkout = stepSection(verify, 'Checkout');
  assert.match(checkout, /^ {10}fetch-depth: 0$/m, 'the verify checkout must fetch the full history, or the push base revision is absent');
  // `2` is the minimum for a single-commit push and fails for a multi-commit push or
  // a merge commit, and any shallower-than-full fetch can miss the before revision.
  assert.doesNotMatch(checkout, /^ {10}fetch-depth: [1-9]\d*$/m);

  // The called test workflow fetches the same way, for the same check.
  assert.match(stepSection(read('test.yml'), 'Checkout'), /^ {10}fetch-depth: 0$/m);
});
