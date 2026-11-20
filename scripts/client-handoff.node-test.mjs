import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  dispatchHandoff,
  findExistingRun,
  handoffTarget,
  infraHandoff,
  publishClientHandoff,
  readRunById,
  runGhApi,
} from './client-handoff.mjs';

const clientRunUrl = 'https://github.com/anywear-ai/AnyWear-Client/actions/runs/4242';
const digest = 'd'.repeat(64);
const infraRunId = 7171;
const infraRunUrl = `https://github.com/anywear-ai/AnyWear-Infra/actions/runs/${infraRunId}`;
const environment = {
  INFRA_OWNER: 'anywear-ai',
  INFRA_REPOSITORY: 'AnyWear-Infra',
  INFRA_WORKFLOW: 'mutate.yml',
  CLIENT_RUN_URL: clientRunUrl,
  CLIENT_RUN_ID: '4242',
  CLIENT_RUN_ATTEMPT: '1',
  CLIENT_BUNDLE_DIGEST: digest,
};

/** Every `gh api` path this program can ask for, as the fake backend keys them. */
const paths = {
  queued: `repos/anywear-ai/AnyWear-Infra/actions/workflows/mutate.yml/runs?status=queued&per_page=100`,
  inProgress: `repos/anywear-ai/AnyWear-Infra/actions/workflows/mutate.yml/runs?status=in_progress&per_page=100`,
  dispatch: 'repos/anywear-ai/AnyWear-Infra/actions/workflows/mutate.yml/dispatches',
  created: (id) => `repos/anywear-ai/AnyWear-Infra/actions/runs/${id}`,
  jobs: (id) => `repos/anywear-ai/AnyWear-Infra/actions/runs/${id}/jobs?per_page=100`,
};

/**
 * The fake `run` seam: a route table from the request's REST path to a response or
 * a function of the call count. Every call is recorded with the path it named, so a
 * test can prove which requests happened and which did not.
 */
function fakeRun(routes) {
  const calls = [];
  const run = async (args) => {
    const target = args[1] === '--method' ? args[3] : args[1];
    calls.push({ args, target });
    const route = routes[target];
    if (route === undefined) throw new Error(`unexpected request: ${args.join(' ')}`);
    if (route instanceof Error) throw route;
    return typeof route === 'function' ? route(calls.length) : route;
  };
  return { run, calls };
}

/** The listing responses for "no Infra run names this Client run yet". */
function emptyListings() {
  return { [paths.queued]: { workflow_runs: [] }, [paths.inProgress]: { workflow_runs: [] } };
}

/** The dispatch response that names the created run. */
function dispatchResponse() {
  return { workflow_run_id: infraRunId, html_url: infraRunUrl };
}

/** One run read-back carrying the id the dispatch named. */
function runResponse(id = infraRunId) {
  return { id, html_url: infraRunUrl, status: 'in_progress', conclusion: null };
}

/** A job list whose `deploy` job is still running. */
function runningJobs() {
  return { total_count: 2, jobs: [{ name: 'preflight', conclusion: 'success' }, { name: 'deploy', conclusion: null }] };
}

/** A job list whose `deploy` job concluded. */
function concludedJobs(conclusion) {
  return { total_count: 2, jobs: [{ name: 'preflight', conclusion: 'success' }, { name: 'deploy', conclusion }] };
}

test('the handoff dispatch names exactly the publish-client payload', async () => {
  assert.equal(infraHandoff.repository, 'AnyWear-Infra');
  assert.equal(infraHandoff.workflow, 'mutate.yml');
  assert.equal(infraHandoff.operation, 'publish-client');
  assert.equal(infraHandoff.deliveryTrigger, 'publish');
  assert.equal(infraHandoff.deployJob, 'deploy');
  assert.equal(infraHandoff.ceilingMs, 150 * 60_000, 'the observation ceiling is 150 minutes inside a 160-minute job');
  assert.equal(infraHandoff.pollIntervalMs, 30_000, 'the poll interval is fixed');

  const { run, calls } = fakeRun({ [paths.dispatch]: dispatchResponse() });
  const created = await dispatchHandoff(run, handoffTarget(environment));
  assert.deepEqual(created, { runId: infraRunId, runUrl: infraRunUrl });
  assert.deepEqual(calls.map((call) => call.args), [[
    'api',
    '--method', 'POST',
    paths.dispatch,
    '-f', 'ref=main',
    '-F', 'return_run_details=true',
    '-f', 'inputs[operation]=publish-client',
    '-f', 'inputs[delivery_trigger]=publish',
    '-f', 'inputs[client_run_id]=4242',
    '-f', 'inputs[client_run_attempt]=1',
    '-f', `inputs[client_bundle_digest]=${digest}`,
    '-f', `inputs[dispatched_by]=${clientRunUrl}`,
  ]]);
});

test('a dispatch that names no run id fails instead of leaving nothing to observe', async () => {
  for (const response of [undefined, {}, { workflow_run_id: 0 }, { workflow_run_id: '7171' }, { workflow_run_id: 1.5 }]) {
    const { run } = fakeRun({ [paths.dispatch]: () => response });
    await assert.rejects(
      () => dispatchHandoff(run, handoffTarget(environment)),
      /the dispatch into AnyWear-Infra named no run id/,
      `expected ${JSON.stringify(response)} to be refused`,
    );
  }
});

test('the created run is read back by id, and a different id is refused', async () => {
  const matched = fakeRun({ [paths.created(infraRunId)]: runResponse() });
  assert.deepEqual(await readRunById(matched.run, handoffTarget(environment), infraRunId), {
    runId: infraRunId,
    runUrl: infraRunUrl,
  });

  const mismatched = fakeRun({ [paths.created(infraRunId)]: runResponse(9999) });
  await assert.rejects(
    () => readRunById(mismatched.run, handoffTarget(environment), infraRunId),
    /the handoff named Infra run 7171, but the runs API returned '9999'/,
  );
});

test('a queued Infra run already naming this Client run is adopted, not duplicated', async () => {
  const existingUrl = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/5151';
  const { run, calls } = fakeRun({
    [paths.queued]: {
      workflow_runs: [
        { id: 1, display_title: 'Beta publish-client: by @someone-else', html_url: 'https://example.invalid/1' },
        { id: 5151, display_title: `Beta publish-client: publish ·  · by ${clientRunUrl}`, html_url: existingUrl },
      ],
    },
    [paths.created(5151)]: { id: 5151, html_url: existingUrl },
    [paths.jobs(5151)]: concludedJobs('success'),
  });
  let summary;
  const result = await publishClientHandoff({
    environment,
    run,
    wait: async () => {},
    now: () => 0,
    log: () => {},
    summary: async (text) => { summary = text; },
  });

  assert.equal(result.runId, 5151);
  assert.equal(result.conclusion, 'success');
  assert.deepEqual(calls.map((call) => call.target), [paths.queued, paths.created(5151), paths.jobs(5151)]);
  assert.equal(calls.some((call) => call.target === paths.dispatch), false, 'a re-run of the job must not dispatch twice');
  assert.match(summary, /Infra run: https:\/\/github\.com\/anywear-ai\/AnyWear-Infra\/actions\/runs\/5151/);
});

test('the dedupe searches both active statuses and matches the Client run URL in the run name', async () => {
  const target = handoffTarget(environment);
  const { run, calls } = fakeRun({
    [paths.queued]: { workflow_runs: [] },
    [paths.inProgress]: { workflow_runs: [{ id: 5152, display_title: `Beta publish-client: publish ·  · by ${clientRunUrl}` }] },
  });
  const { existing, listingFailed } = await findExistingRun(run, target, () => {});
  assert.equal(existing.id, 5152);
  assert.equal(listingFailed, false);
  assert.deepEqual(calls.map((call) => call.target), [paths.queued, paths.inProgress]);

  // A run that names another Client run is not this one's predecessor.
  const other = fakeRun({
    [paths.queued]: { workflow_runs: [{ id: 1, display_title: 'Beta publish-client: publish ·  · by https://github.com/anywear-ai/AnyWear-Client/actions/runs/1' }] },
    [paths.inProgress]: { workflow_runs: [] },
  });
  assert.equal((await findExistingRun(other.run, target, () => {})).existing, undefined);
});

test('a failed listing dispatches anyway and says so', async () => {
  const warnings = [];
  const { run } = fakeRun({
    [paths.queued]: new Error('HTTP 502'),
    [paths.inProgress]: new Error('HTTP 502'),
    [paths.dispatch]: dispatchResponse(),
    [paths.created(infraRunId)]: runResponse(),
    [paths.jobs(infraRunId)]: concludedJobs('success'),
  });
  const result = await publishClientHandoff({
    environment,
    run,
    wait: async () => {},
    now: () => 0,
    log: (message) => warnings.push(message),
    summary: async () => {},
  });

  assert.equal(result.conclusion, 'success');
  assert.deepEqual(warnings.filter((message) => message.startsWith('::warning::')).length, 2);
  assert.match(warnings.join('\n'), /Could not list mutate\.yml runs in AnyWear-Infra \(status=queued\): HTTP 502; dispatching anyway/);
  assert.ok(warnings.some((message) => message.includes(`Dispatched AnyWear-Infra/mutate.yml: ${infraRunUrl}`)));
});

test('a deploy job that concluded success records the run and the conclusion', async () => {
  const { run, calls } = fakeRun({
    ...emptyListings(),
    [paths.dispatch]: dispatchResponse(),
    [paths.created(infraRunId)]: runResponse(),
    [paths.jobs(infraRunId)]: concludedJobs('success'),
  });
  let summary;
  const result = await publishClientHandoff({
    environment,
    run,
    wait: async () => { throw new Error('the observation must not poll after the conclusion'); },
    now: () => 0,
    log: () => {},
    summary: async (text) => { summary = text; },
  });

  assert.deepEqual(result, { runId: infraRunId, runUrl: infraRunUrl, conclusion: 'success', digest });
  assert.deepEqual(calls.map((call) => call.target), [paths.queued, paths.inProgress, paths.dispatch, paths.created(infraRunId), paths.jobs(infraRunId)]);
  assert.match(summary, /Client handoff to AnyWear-Infra/);
  assert.match(summary, new RegExp(`Client bundle digest: \`${digest}\``));
  assert.match(summary, new RegExp(`Infra run: ${infraRunUrl}`));
  assert.match(summary, /Infra deploy conclusion: `success`/);
  assert.match(summary, /handed to the single writer/);
});

test('it polls until the deploy job concludes, and a skipped run is not a publication', async () => {
  let polls = 0;
  const { run } = fakeRun({
    ...emptyListings(),
    [paths.dispatch]: dispatchResponse(),
    [paths.created(infraRunId)]: runResponse(),
    [paths.jobs(infraRunId)]: () => {
      polls += 1;
      return polls < 3 ? runningJobs() : concludedJobs('skipped');
    },
  });
  const waits = [];
  await assert.rejects(
    () => publishClientHandoff({
      environment,
      run,
      wait: async (milliseconds) => { waits.push(milliseconds); },
      now: () => 0,
      log: () => {},
      summary: async () => { throw new Error('a skipped deploy must not be summarised as a handoff'); },
    }),
    new RegExp(`the Infra deploy job was skipped, so the bundle was not published: Infra run ${infraRunUrl}`),
  );
  assert.equal(polls, 3);
  assert.deepEqual(waits, [infraHandoff.pollIntervalMs, infraHandoff.pollIntervalMs]);
});

test('a failed or cancelled deploy job fails the handoff naming the conclusion and the run', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const { run } = fakeRun({
      ...emptyListings(),
      [paths.dispatch]: dispatchResponse(),
      [paths.created(infraRunId)]: runResponse(),
      [paths.jobs(infraRunId)]: concludedJobs(conclusion),
    });
    await assert.rejects(
      () => publishClientHandoff({ environment, run, wait: async () => {}, now: () => 0, log: () => {}, summary: async () => {} }),
      new RegExp(`the Infra deploy job concluded ${conclusion}, so the bundle was not published: Infra run ${infraRunUrl}`),
      `expected ${conclusion} to fail the handoff`,
    );
  }
});

test('a run whose deploy job never concludes fails at the ceiling naming the run', async () => {
  let clock = 0;
  const { run } = fakeRun({
    ...emptyListings(),
    [paths.dispatch]: dispatchResponse(),
    [paths.created(infraRunId)]: runResponse(),
    [paths.jobs(infraRunId)]: runningJobs(),
  });
  await assert.rejects(
    () => publishClientHandoff({
      environment,
      run,
      wait: async (milliseconds) => { clock += milliseconds; },
      now: () => clock,
      log: () => {},
      summary: async () => {},
    }),
    new RegExp(`the Infra deploy job did not conclude within 150 minutes: Infra run ${infraRunUrl} is still running`),
  );
  assert.ok(clock >= infraHandoff.ceilingMs, 'the ceiling is what ends the observation');
});

test('an unreadable job list is retried, then fails naming the run', async () => {
  const warnings = [];
  const { run, calls } = fakeRun({
    ...emptyListings(),
    [paths.dispatch]: dispatchResponse(),
    [paths.created(infraRunId)]: runResponse(),
    [paths.jobs(infraRunId)]: new Error('HTTP 503'),
  });
  await assert.rejects(
    () => publishClientHandoff({
      environment,
      run,
      wait: async () => {},
      now: () => 0,
      log: (message) => warnings.push(message),
      summary: async () => {},
    }),
    new RegExp(`could not read the job list of Infra run ${infraRunUrl} after ${infraHandoff.maxConsecutiveReadFailures} attempts: HTTP 503`),
  );
  const jobCalls = calls.filter((call) => call.target === paths.jobs(infraRunId));
  assert.equal(jobCalls.length, infraHandoff.maxConsecutiveReadFailures);
  assert.equal(warnings.filter((message) => message.startsWith('::warning::')).length, infraHandoff.maxConsecutiveReadFailures - 1);
});

test('a job list that is not a list fails at once rather than polling forever', async () => {
  for (const jobs of [{}, { jobs: 'nope' }, null]) {
    const { run } = fakeRun({
      ...emptyListings(),
      [paths.dispatch]: dispatchResponse(),
      [paths.created(infraRunId)]: runResponse(),
      [paths.jobs(infraRunId)]: jobs,
    });
    await assert.rejects(
      () => publishClientHandoff({ environment, run, wait: async () => {}, now: () => 0, log: () => {}, summary: async () => {} }),
      new RegExp(`the job list of Infra run ${infraRunUrl} carried no jobs`),
      `expected ${JSON.stringify(jobs)} to be refused`,
    );
  }
});

test('the target must be this repository, this workflow and this run\'s identity', async () => {
  const invalid = [
    ['INFRA_OWNER', '', /INFRA_OWNER is not set/],
    ['INFRA_REPOSITORY', 'AnyWear-E2E', /the handoff target is AnyWear-E2E, not AnyWear-Infra/],
    ['INFRA_WORKFLOW', 'beta-qualification.yml', /the handoff target is beta-qualification\.yml, not mutate\.yml/],
    ['CLIENT_RUN_ID', 'main', /CLIENT_RUN_ID and CLIENT_RUN_ATTEMPT must be this Actions run's numeric identity/],
    ['CLIENT_RUN_ATTEMPT', '0', /CLIENT_RUN_ID and CLIENT_RUN_ATTEMPT must be this Actions run's numeric identity/],
    ['CLIENT_BUNDLE_DIGEST', 'not-a-digest', /CLIENT_BUNDLE_DIGEST must be the lowercase hexadecimal SHA-256 of the bundle manifest/],
    ['CLIENT_BUNDLE_DIGEST', 'D'.repeat(64), /CLIENT_BUNDLE_DIGEST must be the lowercase hexadecimal SHA-256 of the bundle manifest/],
    ['CLIENT_BUNDLE_DIGEST', 'd'.repeat(63), /CLIENT_BUNDLE_DIGEST must be the lowercase hexadecimal SHA-256 of the bundle manifest/],
    ['CLIENT_RUN_URL', 'anywear-client-run', /CLIENT_RUN_URL must be this run's absolute URL/],
  ];
  for (const [name, value, expected] of invalid) {
    assert.throws(() => handoffTarget({ ...environment, [name]: value }), expected, `expected ${name}=${value} to be refused`);
  }
  // The valid target carries the run identity through unchanged.
  assert.deepEqual(handoffTarget(environment), {
    owner: 'anywear-ai',
    repository: 'AnyWear-Infra',
    workflow: 'mutate.yml',
    clientRunUrl,
    clientRunId: '4242',
    clientRunAttempt: '1',
    digest,
  });
});

test('the command seam rejects on a failed call and on a non-JSON answer', async () => {
  // `exec` is the seam: it records the command and answers with the runner's own
  // `(error, stdout, stderr)`.
  const execOf = (stdout, stderr = '', error = null) => (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['api', 'repos/x/y']);
    assert.equal(options.encoding, 'utf8');
    callback(error, stdout, stderr);
  };
  assert.deepEqual(await runGhApi(['api', 'repos/x/y'], execOf('{"id":7171}\n')), { id: 7171 });
  assert.equal(await runGhApi(['api', 'repos/x/y'], execOf('\n')), undefined, 'an empty body is not an answer');
  await assert.rejects(
    () => runGhApi(['api', 'repos/x/y'], execOf('', 'gh: Not Found (HTTP 404)', new Error('exit 1'))),
    /gh repos\/x\/y failed: gh: Not Found \(HTTP 404\)/,
  );
  await assert.rejects(
    () => runGhApi(['api', 'repos/x/y'], execOf('not json')),
    /gh repos\/x\/y did not answer with JSON: not json/,
  );
});

test('the workflow CLI fails closed on a missing target without touching the network', () => {
  // No token and no target: the program stops at its own validation, so the wiring
  // is exercised without a dispatch or a read.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./client-handoff.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, GH_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::INFRA_OWNER is not set/);
});
