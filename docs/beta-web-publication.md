# Beta web publication

AnyWear-Client exposes four workflow entries: `check.yml`, `release.yml`,
`client-release.yml` and `client-beta-apk.yml`; the [README](../README.md#workflow-entries)
carries their trigger, manual and purpose table. This runbook covers the Beta web
path: the automatic check [`check.yml`](../.github/workflows/check.yml) and the
handoff entry [`release.yml`](../.github/workflows/release.yml).

`build.yml`, `test.yml`, `browser.yml` and `tauri-smoke.yml` are `workflow_call`
implementations of `check.yml`. They are not entries and have no dispatch surface.

| Entry | Trigger | Manual | Purpose |
| --- | --- | --- | --- |
| `check.yml` | push / pull request to `main` | no | Build, unit tests, mocked browser integration |
| `release.yml` | push to `main`; `workflow_dispatch` (`operation: deploy`) | yes | Build, verify and hand the Beta web bundle to `AnyWear-Infra`, which publishes it |

## What a green Client run means

A green `release.yml` run means **the bundle was handed to the writer**, not that
Beta serves it. Under the single-writer model
([ADR 0033](https://github.com/anywear-ai/AnyWear-Meta/blob/main/architecture/ADR/0033-deploy-chain-and-release-chain.md)
§9) `AnyWear-Infra` is the only writer of Beta's served tuple:

| Step | Who performs it |
| --- | --- |
| Build the assets, the build metadata and the bundle manifest | Client `build` |
| Verify identity, declared interface, compiled assets and the manifest | Client `verify` |
| Dispatch `AnyWear-Infra` `.github/workflows/mutate.yml` (`operation=publish-client`) and read the created run back | Client `handoff` |
| Live-interface refusal, S3 sync, CloudFront invalidation, publication record | `AnyWear-Infra` `deploy` |
| Post-publication `smoke` qualification, held inside the same Infra run | `AnyWear-Infra` `qualify-hold` → `AnyWear-E2E` |
| The verdict | The Infra run, not the Client run |

The Client holds **no AWS credential anywhere**: no `environment:`, no
`id-token: write`, no role, no AWS CLI. The one credential the publication chain
mints is an App token narrowed to `AnyWear-Infra` with `actions: write`.

```mermaid
sequenceDiagram
    participant C as Client release.yml
    participant I as AnyWear-Infra mutate.yml
    participant E as AnyWear-E2E
    C->>C: build (assets, build-metadata.json, bundle-manifest.json)
    C->>C: verify (identity, declared interface, assets, manifest digest)
    C->>I: dispatch operation=publish-client, client_run_id/attempt, client_bundle_digest, dispatched_by
    I->>I: deploy — verify the bundle, refuse a drifted live interface, sync, invalidate, record
    I->>E: smoke (trigger=deploy-smoke), held to terminal
    C->>I: poll the run's jobs until the deploy job concludes
    Note over C: success = handed over; skipped/failure/cancelled = handoff failed, naming the Infra run
```

## The declared interface

`VITE_API_BASE_URL`, `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID`
are compiled into the bundle. The `build` job holds no AWS credential, so it
cannot resolve them from CloudFormation or SSM. Two reviewed sources supply them:

- Workflow-level `env` constants: `BETA_API_BASE_URL`,
  `BETA_COGNITO_USER_POOL_ID` and `BETA_COGNITO_CLIENT_ID`.
- The three dispatch inputs `api_base_url`, `cognito_user_pool_id` and
  `cognito_client_id`, still declared and still `required: true`, as manual-only
  overrides.

`build` and `verify` read `${{ inputs.<name> || env.BETA_<NAME> }}`, so a push
needs no input and a manual dispatch behaves exactly as before: the override wins
when it is supplied, and the reviewed constant is used otherwise. The step-level
`env:` is deliberate — a job's `env:` block cannot read the `env` context, so the
fallback is written where the expression can resolve it.

| Input | Compiled variable | Reviewed constant |
| --- | --- | --- |
| `api_base_url` | `VITE_API_BASE_URL` | `BETA_API_BASE_URL` |
| `cognito_user_pool_id` | `VITE_COGNITO_USER_POOL_ID` | `BETA_COGNITO_USER_POOL_ID` |
| `cognito_client_id` | `VITE_COGNITO_CLIENT_ID` | `BETA_COGNITO_CLIENT_ID` |

The manual overrides remain part of the dispatch event rather than mutable
configuration the run cannot see. A repository variable would let the interface
change between dispatch and handoff without appearing in the run's record; a
required input cannot be omitted, and the value that was approved is the value the
run carries. The reviewed constants give a merge the same property: changing one
is a reviewed change to `release.yml`, not an owner setting made outside the
repository.

`pnpm build` runs `scripts/write-build-metadata.mjs` in the same environment Vite
compiles, so `dist/build-metadata.json` records **exactly** the values that were
built. A missing or malformed interface value fails the build instead of recording
metadata for an interface that was never compiled.

## The bundle manifest and the digest

`build` runs `scripts/write-bundle-manifest.mjs` after `pnpm build` and before the
`client-dist` upload, so the manifest travels inside the uploaded artifact. It
records:

| Field | Value |
| --- | --- |
| `schema_version` | `1` |
| `component` | `AnyWear-Client` |
| `source_commit` | the run's `github.sha`, which `build-metadata.json` also records |
| `client_version` | the `client_version` from `dist/build-metadata.json` |
| `interface` | the three values above, from the same environment the build compiled |
| `assets` | every other built file as `{path, sha256, bytes}`, sorted by path |

The manifest excludes itself, records no timestamp and is written with a fixed
layout, so the same built tree always produces the same bytes. The SHA-256 of the
manifest file is the `client_bundle_digest`: `build` publishes it as a job output,
`verify` recomputes it from the downloaded artifact, and `handoff` sends it to
Infra.

## Jobs and credentials

| Job | `environment` | `id-token: write` | What it does |
| --- | --- | --- | --- |
| `build` | — | no | Checks out the exact source SHA, installs, builds the assets, `dist/build-metadata.json` and `dist/bundle-manifest.json`, uploads `dist/` as `client-dist`, and publishes the manifest digest as its job output |
| `verify` | — | no | Identity and declared-interface checks, the compiled assets contain the recorded values, the manifest matches `build-metadata.json` and the asset inventory it names, the manifest digest equals the published one, then `pnpm run test:run` and the mocked browser suite |
| `handoff` | — | no | Mints one App token for `AnyWear-Infra` (`actions: write`), dispatches `mutate.yml` (`operation=publish-client`) with `return_run_details: true`, reads the created run back by id, and polls its job list until the Infra `deploy` job concludes |

`handoff` runs `needs: [build, verify]`, so nothing leaves the repository before
verification completes. It has `timeout-minutes: 160` around a 150-minute
observation ceiling, so the ceiling fires first and the step still reports what it
saw. It declares no `environment`, requests no `id-token` and holds no AWS
permission; its only credential is the one App token, and its dispatch-and-observe
step is the job's last step.

The `verify` identity check pins the original repository and repository id,
`refs/heads/main`, the two entry events (`workflow_dispatch` and a `push` to
`main`), the exact `release.yml` workflow ref, `GITHUB_SHA` equality between
workflow and source, the Actions run/attempt identity, and the stage switch. A
different value anywhere fails the run before the handoff.

## The handoff

`scripts/client-handoff.mjs` is the declared node program behind the `handoff`
job. It sends exactly these inputs:

| Input | Value |
| --- | --- |
| `operation` | `publish-client` |
| `delivery_trigger` | `publish` |
| `client_run_id` | `${{ github.run_id }}` |
| `client_run_attempt` | `${{ github.run_attempt }}` |
| `client_bundle_digest` | the `build` job output above |
| `dispatched_by` | this Client run's URL |

Then it reads the created run back:

1. **Dedupe.** Before dispatching, it lists the `mutate.yml` runs that are `queued`
   and `in_progress` and looks for this Client run's URL in their display titles —
   the receiver renders `dispatched_by` into the run name, exactly as the retired
   E2E dispatch relied on. A match is adopted instead of dispatching a second time,
   so a re-run of `handoff` does not duplicate the publication. A failed listing
   dispatches anyway and says so: a duplicate wastes a slot, a skipped one hides
   what this Client run built.
2. **Dispatch.** A response that names no run id is a failure, never a silent skip.
3. **Read-back by id.** The id the dispatch returned must be the id the runs API
   returns.
4. **Observe the `deploy` job.** It polls the run's job list on a fixed 30-second
   interval until the `deploy` job's conclusion is non-null, under the 150-minute
   ceiling.
   - `success` → the run URL and the conclusion are written to the step summary and
     the job succeeds. It does **not** wait for Infra's `qualify-hold`; Infra owns
     that verdict.
   - `skipped` → the handoff fails, naming the Infra run URL: a skipped run is not a
     publication.
   - `failure`, `cancelled` or any other conclusion → the handoff fails, naming the
     Infra run URL and the conclusion.
   - No conclusion before the ceiling → the handoff fails, naming the run URL.

A failed observation reports the run it was watching, so the operator opens the
Infra run rather than re-running the Client chain.

## Running a handoff

A merge to `main` is the ordinary entry: the chain starts from the pushed commit,
compiles the reviewed constants, and needs no operator action. To hand a revision
over by hand, dispatch `release.yml` from `main` with `operation: deploy` and,
optionally, the three interface overrides.

1. `build` produces the assets, the metadata and the manifest from that exact SHA,
   and publishes the manifest digest.
2. `verify` checks the publication identity, the declared interface, the compiled
   assets, the manifest and the digest, then runs the unit suite and the mocked
   browser suite.
3. `handoff` dispatches the Infra `publish-client` run and observes its `deploy`
   job, recording the Infra run URL and the conclusion in the step summary.
4. Open the Infra run. It owns the live-interface refusal, the S3 sync, the
   CloudFront invalidation, the publication record and the held post-publication
   `smoke`. A red `smoke`, or a red `qualify-hold`, is a red Infra run and says
   nothing about the Client run that handed the bundle over.

The `beta-client-publish` concurrency group serializes Client build-and-handoff
runs, does not cancel an active handoff, and queues up to 100 pending runs
(`queue: max`) in wait order: a newer merge waits for the in-flight handoff instead
of cancelling or replacing it. It is local to this repository; `AnyWear-Infra`'s
`anywear-infra-runtime` group serializes the publication itself. A retry or
recovery uses the ordinary entry and the same identity/interface/manifest
verification; no new scheduling token is required.

## Repository configuration

The stage switch is repository-scoped and has no compatibility fallback:
`release.yml` reads `vars.ENABLE_BETA_MUTATION` and never `ENABLE_BETA_DEPLOY`.
While the variable is absent or not `true`, the `build` job's condition is false
and every job is skipped.

| Beta variable | Value |
| --- | --- |
| `ENABLE_BETA_MUTATION` | `true` to enable the handoff on a merge and on a manual dispatch; `false` skips the whole chain |
| `APP_ID` | the GitHub App id both App-token sites mint with |

The publication credentials are no longer this repository's: `AnyWear-Infra`'s
`beta` environment holds the AWS principal that performs the write, and the nine
signing secrets belong to the two binary packaging workflows
([CI credentials](source-ci-credentials.md)). The retired publish-role ARN, the
account and region variables it was asserted against, and the old
`CLIENT_PUBLISH_WINDOW_*` variables are read by no job here and can be removed
during an authorized configuration reconciliation.

## Source versus deployed state

This runbook documents source. It does not claim a delivered publication: the
`publish-client` operation in `AnyWear-Infra` is a separate delivery, and the
effective deployed trust of the AWS role that performs the write needs its own #54
evidence before the first `publish-client` run. A Client run that hands a bundle
over successfully still proves nothing about the served tuple until the Infra run
concludes and its held `smoke` reports.
