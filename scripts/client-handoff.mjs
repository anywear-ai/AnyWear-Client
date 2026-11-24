// The Client handoff: dispatch the built bundle to `AnyWear-Infra` and read the
// created Infra run back until its `deploy` job concludes.
//
// `AnyWear-Infra` is the single writer of Beta's served tuple (ADR 0033 §9). This
// repository builds, verifies and hands the bundle over; it holds no AWS credential
// and performs no publication. `release.yml`'s `handoff` job mints one App token
// narrowed to `AnyWear-Infra` with `actions: write` only and runs this program with
// that token as `GH_TOKEN`.
//
// The program does four things, in order:
//
//   1. Skip the dispatch when an Infra run of this workflow is already queued or in
//      progress with this Client run's URL in its display title — the run-name the
//      receiver renders carries `dispatched_by`, so a re-run of `handoff` adopts its
//      own predecessor instead of dispatching twice. A failed listing dispatches
//      anyway and says so: a duplicate run wastes a slot, a skipped one hides what
//      this Client run built.
//   2. Dispatch `mutate.yml` on `ref=main` with `return_run_details: true` and
//      exactly the six `publish-client` inputs. A dispatch that names no run id is
//      a failure, never a silent skip.
//   3. Read that run back by id through the shared created-run module
//      (`scripts/created-run-read.mjs`), which owns the by-id path, retries a `404`
//      against the same id, and requires the id the dispatch returned.
//   4. Poll the run's job list on a fixed interval until the `deploy` job's
//      conclusion is non-null, under a bounded ceiling. A `success` records the Infra
//      run URL and the conclusion in the step summary and succeeds; `skipped` fails
//      naming the run, because a skipped run published nothing; `failure` or
//      `cancelled` fails naming the run and the conclusion. A run that has already
//      completed without succeeding is not polled: its job list is read once, so the
//      handoff reports the publication when the `deploy` job succeeded and fails at
//      once naming the run's conclusion when the job did not. It does not wait for
//      Infra's `qualify-hold`, which owns that verdict.
//
// The `run`, `wait`, `now`, `log` and `summary` dependencies are injected so the node
// tests drive every branch without a network call, a clock or a real run.

import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { completedWithoutSuccess, readCreatedRunById } from './created-run-read.mjs';

/** The dispatch target and its fixed bounds. */
export const infraHandoff = {
  // The repository whose workflow performs the publication. The owner comes from
  // the run (`INFRA_OWNER`), so the handoff follows the repository's owner.
  repository: 'AnyWear-Infra',
  workflow: 'mutate.yml',
  ref: 'main',
  // `mutate.yml`'s `deploy` job declares no `name:`, so the jobs API reports the job
  // id as `name`. This is the id the read-back matches.
  deployJob: 'deploy',
  // The dispatch payload, exactly. `publish-client` is the publication operation and
  // `delivery_trigger=publish` is the Client chain's trigger, which `mutate.yml`
  // validates against its per-operation menu.
  operation: 'publish-client',
  deliveryTrigger: 'publish',
  // A fixed poll interval, a 150-minute ceiling and its own 160-minute job timeout,
  // so the observation's deadline always fires before the job's and the handoff
  // records what it saw.
  pollIntervalMs: 30_000,
  ceilingMs: 150 * 60_000,
  // A transient job-list failure is retried; this many in a row end the observation
  // with an error naming the run instead of an unbounded wait.
  maxConsecutiveReadFailures: 10,
};

const runIdPattern = /^[1-9]\d*$/;
const digestPattern = /^[0-9a-f]{64}$/;

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} is not set, so the Client handoff cannot name what it dispatches`);
  }
  return value;
}

/** The validated handoff target: where to dispatch and what to name this Client run. */
export function handoffTarget(environment = process.env) {
  const target = {
    owner: requireEnvironment(environment, 'INFRA_OWNER'),
    repository: requireEnvironment(environment, 'INFRA_REPOSITORY'),
    workflow: requireEnvironment(environment, 'INFRA_WORKFLOW'),
    clientRunUrl: requireEnvironment(environment, 'CLIENT_RUN_URL'),
    clientRunId: requireEnvironment(environment, 'CLIENT_RUN_ID'),
    clientRunAttempt: requireEnvironment(environment, 'CLIENT_RUN_ATTEMPT'),
    digest: requireEnvironment(environment, 'CLIENT_BUNDLE_DIGEST'),
  };
  if (target.repository !== infraHandoff.repository) {
    throw new Error(`the handoff target is ${target.repository}, not ${infraHandoff.repository}`);
  }
  if (target.workflow !== infraHandoff.workflow) {
    throw new Error(`the handoff target is ${target.workflow}, not ${infraHandoff.workflow}`);
  }
  if (!runIdPattern.test(target.clientRunId) || !runIdPattern.test(target.clientRunAttempt)) {
    throw new Error('CLIENT_RUN_ID and CLIENT_RUN_ATTEMPT must be this Actions run\'s numeric identity');
  }
  if (!digestPattern.test(target.digest)) {
    throw new Error('CLIENT_BUNDLE_DIGEST must be the lowercase hexadecimal SHA-256 of the bundle manifest');
  }
  if (!/^https:\/\/[^\s]+$/.test(target.clientRunUrl)) {
    throw new Error('CLIENT_RUN_URL must be this run\'s absolute URL');
  }
  return target;
}

/**
 * `gh api` as the command seam: `run(args)` resolves the parsed JSON body, and
 * rejects with the command's own message so a failure is never read as an empty
 * result. `exec` is injectable so a test can observe the exact argv.
 */
export function runGhApi(args, exec = execFile) {
  return new Promise((resolveRun, rejectRun) => {
    exec('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`gh ${args[1] ?? ''} failed: ${`${stderr}${stdout}`.trim() || error.message}`));
        return;
      }
      const text = `${stdout}`.trim();
      if (text === '') {
        resolveRun(undefined);
        return;
      }
      try {
        resolveRun(JSON.parse(text));
      } catch {
        rejectRun(new Error(`gh ${args[1] ?? ''} did not answer with JSON: ${text.slice(0, 200)}`));
      }
    });
  });
}

/**
 * The active (queued and in-progress) runs of the Infra workflow whose display title
 * names this Client run, and whether any listing failed. A listing failure is
 * reported, not swallowed: the caller dispatches anyway and says so.
 */
export async function findExistingRun(run, target, log = console.log) {
  let listingFailed = false;
  for (const status of ['queued', 'in_progress']) {
    let listing;
    try {
      listing = await run([
        'api',
        `repos/${target.owner}/${target.repository}/actions/workflows/${target.workflow}/runs?status=${status}&per_page=100`,
      ]);
    } catch (error) {
      listingFailed = true;
      log(`::warning::Could not list ${target.workflow} runs in ${target.repository} (status=${status}): ${error.message}; dispatching anyway`);
      continue;
    }
    if (!Array.isArray(listing?.workflow_runs)) {
      listingFailed = true;
      log(`::warning::The ${target.workflow} run listing in ${target.repository} (status=${status}) carried no workflow_runs; dispatching anyway`);
      continue;
    }
    const existing = listing.workflow_runs.find((candidate) => typeof candidate?.display_title === 'string'
      && candidate.display_title.includes(target.clientRunUrl));
    if (existing !== undefined) return { existing, listingFailed };
  }
  return { existing: undefined, listingFailed };
}

/**
 * The dispatch, with the payload the Infra workflow declares. `return_run_details`
 * is what names the created run, and a response without a run id fails here rather
 * than leaving the handoff with nothing to observe.
 */
export async function dispatchHandoff(run, target) {
  const response = await run([
    'api',
    '--method', 'POST',
    `repos/${target.owner}/${target.repository}/actions/workflows/${target.workflow}/dispatches`,
    '-f', `ref=${infraHandoff.ref}`,
    '-F', 'return_run_details=true',
    '-f', `inputs[operation]=${infraHandoff.operation}`,
    '-f', `inputs[delivery_trigger]=${infraHandoff.deliveryTrigger}`,
    '-f', `inputs[client_run_id]=${target.clientRunId}`,
    '-f', `inputs[client_run_attempt]=${target.clientRunAttempt}`,
    '-f', `inputs[client_bundle_digest]=${target.digest}`,
    '-f', `inputs[dispatched_by]=${target.clientRunUrl}`,
  ]);
  const runId = response?.workflow_run_id;
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`the dispatch into ${target.repository} named no run id, so no Infra run can be read back`);
  }
  return { runId, runUrl: typeof response?.html_url === 'string' ? response.html_url : undefined };
}

/** The browsable URL of a run in the dispatch target, from the target and the id. */
function createdRunUrl(target, runId) {
  return `https://github.com/${target.owner}/${target.repository}/actions/runs/${runId}`;
}

/**
 * The created run, read back by id through the shared module, which owns the by-id
 * path, the bounded `404` retry, the identity check and the failure message. The
 * run's own conclusion is returned, so a run that already completed without
 * succeeding is judged on its `deploy` job instead of being polled to the ceiling.
 * `wait` and `log` are injected so a test drives the retry without a clock or a
 * real run; both default inside the module.
 */
export async function readRunById(run, target, runId, { wait, log } = {}) {
  const body = await readCreatedRunById({
    read: async (path) => run(['api', path]),
    repository: `${target.owner}/${target.repository}`,
    runId,
    runUrl: createdRunUrl(target, runId),
    label: 'the created Infra run',
    requireSuccess: false,
    wait,
    log,
  });
  return {
    runId,
    runUrl: typeof body.html_url === 'string' && body.html_url !== '' ? body.html_url : createdRunUrl(target, runId),
    terminalNonSuccess: completedWithoutSuccess(body),
    conclusion: typeof body.conclusion === 'string' ? body.conclusion : null,
  };
}

/**
 * The `deploy` job's conclusion for a run that has already completed without
 * succeeding. The run cannot change any more, so its job list is read once: the
 * handoff reports the publication when the job succeeded, and otherwise fails at
 * once naming the run and the conclusion instead of holding the job for 150
 * minutes. A job list that cannot be read, that is not a list, or that names no
 * `deploy` job is a failure here, because the handoff cannot prove publication.
 */
async function readConcludedDeployJob({ run, target, runId, runUrl, runConclusion }) {
  const unusable = (why) => new Error(`the Infra run ${runUrl} concluded ${runConclusion}, ${why}`);
  let jobs;
  try {
    jobs = await run(['api', `repos/${target.owner}/${target.repository}/actions/runs/${runId}/jobs?per_page=100`]);
  } catch (error) {
    throw unusable(`but its job list could not be read: ${error.message}`);
  }
  if (!Array.isArray(jobs?.jobs)) {
    throw unusable(`but its job list carried no jobs, so the Infra ${infraHandoff.deployJob} job cannot be named`);
  }
  const deploy = jobs.jobs.find((job) => job?.name === infraHandoff.deployJob);
  if (deploy === undefined) {
    throw unusable(`and names no Infra ${infraHandoff.deployJob} job, so the bundle was not published`);
  }
  if (deploy.conclusion === null || deploy.conclusion === undefined) {
    throw unusable(`and its Infra ${infraHandoff.deployJob} job carries no conclusion, so the bundle was not published`);
  }
  return deploy.conclusion;
}

/**
 * Poll the run's job list until the `deploy` job's conclusion is non-null, and return
 * it. The read itself is bounded: a listed job set without a `deploy` entry keeps
 * polling, a job list that is not a list fails at once, and consecutive read
 * failures end the observation citing the run. The ceiling is measured from the call,
 * so a run that never concludes fails instead of holding the job to its timeout.
 */
export async function waitForDeployConclusion({ run, wait, now, target, runId, runUrl, log = console.log }) {
  const deadline = now() + infraHandoff.ceilingMs;
  let consecutiveFailures = 0;
  for (;;) {
    let jobs;
    try {
      jobs = await run(['api', `repos/${target.owner}/${target.repository}/actions/runs/${runId}/jobs?per_page=100`]);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= infraHandoff.maxConsecutiveReadFailures) {
        throw new Error(`could not read the job list of Infra run ${runUrl} after ${consecutiveFailures} attempts: ${error.message}`);
      }
      log(`::warning::Could not read the job list of Infra run ${runUrl} (attempt ${consecutiveFailures}): ${error.message}`);
      jobs = undefined;
    }
    if (jobs !== undefined) {
      if (!Array.isArray(jobs?.jobs)) {
        throw new Error(`the job list of Infra run ${runUrl} carried no jobs`);
      }
      const deploy = jobs.jobs.find((job) => job?.name === infraHandoff.deployJob);
      if (deploy !== undefined && deploy.conclusion !== null && deploy.conclusion !== undefined) {
        return deploy.conclusion;
      }
    }
    if (now() >= deadline) {
      throw new Error(`the Infra ${infraHandoff.deployJob} job did not conclude within ${Math.round(infraHandoff.ceilingMs / 60_000)} minutes: Infra run ${runUrl} is still ${jobs === undefined ? 'unreadable' : 'running'}`);
    }
    await wait(infraHandoff.pollIntervalMs);
  }
}

/** The step summary of a successful handoff: the Infra run and the conclusion. */
export function handoffSummary({ target, runUrl, conclusion }) {
  return [
    '### Client handoff to AnyWear-Infra',
    '',
    `- Client run: ${target.clientRunUrl}`,
    `- Client bundle digest: \`${target.digest}\``,
    `- Infra run: ${runUrl}`,
    `- Infra ${infraHandoff.deployJob} conclusion: \`${conclusion}\``,
    '',
    'A green Client run means the bundle was handed to the single writer; the publication and the post-publication `smoke` belong to the Infra run.',
    '',
  ].join('\n');
}

/**
 * Dispatch, read back and observe one handoff. Returns the observed facts; throws
 * with a message naming the Infra run whenever the handoff could not prove that the
 * Infra `deploy` job ran and succeeded.
 */
export async function publishClientHandoff(options = {}) {
  const {
    environment = process.env,
    run = runGhApi,
    wait = (milliseconds) => new Promise((resolveWait) => { setTimeout(resolveWait, milliseconds); }),
    now = Date.now,
    log = (message) => console.log(message),
    summary = async (text) => {
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text, 'utf8');
    },
  } = options;

  const target = handoffTarget(environment);
  log(`Handing Client run ${target.clientRunUrl} to ${target.repository}/${target.workflow} (operation=${infraHandoff.operation}, bundle sha256 ${target.digest})`);

  const { existing } = await findExistingRun(run, target, log);
  let created;
  if (existing !== undefined) {
    if (!Number.isSafeInteger(existing.id) || existing.id <= 0) {
      throw new Error(`the existing ${target.workflow} run titled with this Client run carries no run id`);
    }
    log(`Skipping the dispatch: ${target.repository} run ${existing.html_url ?? existing.id} is already queued for this Client run`);
    created = { runId: existing.id, runUrl: typeof existing.html_url === 'string' ? existing.html_url : undefined };
  } else {
    created = await dispatchHandoff(run, target);
    log(`Dispatched ${target.repository}/${target.workflow}: ${created.runUrl ?? `run ${created.runId}`}`);
  }

  const { runUrl, terminalNonSuccess, conclusion: runConclusion } = await readRunById(run, target, created.runId, { wait, log });
  const conclusion = terminalNonSuccess
    ? await readConcludedDeployJob({ run, target, runId: created.runId, runUrl, runConclusion })
    : await waitForDeployConclusion({ run, wait, now, target, runId: created.runId, runUrl, log });
  if (conclusion !== 'success') {
    if (conclusion === 'skipped') {
      throw new Error(`the Infra ${infraHandoff.deployJob} job was skipped, so the bundle was not published: Infra run ${runUrl}`);
    }
    throw new Error(`the Infra ${infraHandoff.deployJob} job concluded ${conclusion}, so the bundle was not published: Infra run ${runUrl}`);
  }

  await summary(handoffSummary({ target, runUrl, conclusion }));
  log(`The Infra ${infraHandoff.deployJob} job concluded ${conclusion}: ${runUrl}`);
  return { runId: created.runId, runUrl, conclusion, digest: target.digest };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    await publishClientHandoff();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
