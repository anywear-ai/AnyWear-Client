# Beta web publication

AnyWear-Client exposes two workflow entries: the automatic
[`check.yml`](../.github/workflows/check.yml) and the publication entry
[`release.yml`](../.github/workflows/release.yml), which runs on a merge to `main`
and on a manual dispatch. `release.yml` is the only publication surface. Its
manual `operation` input currently offers exactly one value, `deploy`, and the job
sequence inside it is `build` → `verify` → `deploy` → `record` → `handoff`.

`build.yml`, `test.yml` and `browser.yml` are `workflow_call` implementations of
`check.yml`. They are not entries and have no dispatch surface.

| Entry | Trigger | Manual | Purpose |
| --- | --- | --- | --- |
| `check.yml` | push / pull request to `main` | no | Build, unit tests, mocked browser integration |
| `release.yml` | push to `main`; `workflow_dispatch` (`operation: deploy`) | yes | Build, verify, deploy and record the Beta web client, then dispatch the E2E smoke |

## The declared interface

`VITE_API_BASE_URL`, `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID`
are compiled into the bundle. The `build` job holds no AWS credential, so it
cannot resolve them from CloudFormation or SSM. Two reviewed sources supply them:

- Workflow-level `env` constants: `BETA_API_BASE_URL`,
  `BETA_COGNITO_USER_POOL_ID` and `BETA_COGNITO_CLIENT_ID`. These are the values
  the Beta interface served when this change was reviewed, taken from the
  `client-publication-record-validated` artifact of the last successful
  `release.yml` run (`41311613222`, 2026-11-01), so they are the live interface
  rather than a re-typed guess.
- The three dispatch inputs `api_base_url`, `cognito_user_pool_id` and
  `cognito_client_id`, still declared and still `required: true`, as manual-only
  overrides.

`build`, `verify` and `deploy` each read `${{ inputs.<name> || env.BETA_<NAME> }}`,
so a push needs no input and a manual dispatch behaves exactly as it did before:
the override wins when it is supplied, and the reviewed constant is used otherwise.
The step-level `env:` is deliberate — a job's `env:` block cannot read the `env`
context, so the fallback is written where the expression can resolve it.

| Input | Compiled variable | Reviewed constant |
| --- | --- | --- |
| `api_base_url` | `VITE_API_BASE_URL` | `BETA_API_BASE_URL` |
| `cognito_user_pool_id` | `VITE_COGNITO_USER_POOL_ID` | `BETA_COGNITO_USER_POOL_ID` |
| `cognito_client_id` | `VITE_COGNITO_CLIENT_ID` | `BETA_COGNITO_CLIENT_ID` |

The manual overrides remain part of the dispatch event rather than mutable
configuration the run cannot see. A repository variable would let the interface
change between dispatch and deploy without appearing in the run's record; a
required input cannot be omitted, and the value that was approved is the value the
run carries. The reviewed constants give a merge the same property: changing one
is a reviewed change to `release.yml`, not an owner setting made outside the
repository.

`pnpm build` runs `scripts/write-build-metadata.mjs` in the same environment Vite
compiles, so `dist/build-metadata.json` records **exactly** the values that were
built. The file keeps `source_commit` with its previous value and meaning and
adds the interface values under schema version 2. A missing or malformed
interface value fails the build instead of recording metadata for an interface
that was never compiled.

## Jobs and credentials

| Job | `environment` | `id-token: write` | What it does |
| --- | --- | --- | --- |
| `build` | — | no | Checks out the exact source SHA, installs, builds the assets and `dist/build-metadata.json`, uploads `dist/` as an artifact |
| `verify` | — | no | Publication identity check; recorded interface against the declared interface (dispatch override or reviewed constant); compiled assets contain the recorded values; unit tests; mocked browser tests |
| `deploy` | `beta` | yes | The only credential boundary: OIDC assumption of the dedicated publish role, STS principal check, live interface resolution, mismatch refusal, S3 sync, CloudFront invalidation, publication record |
| `record` | — | no | Validates the publication record, writes the step summary, uploads the validated record artifact |
| `handoff` | — | no | Mints one App token scoped to `AnyWear-E2E` with `actions: write`, skips when this run's URL is already in a pending `beta-qualification.yml` run name, and dispatches one `smoke` |

`deploy` runs `needs: verify`, so no role is assumed and no AWS API is called
before verification completes. `build` and `verify` have no `environment`, no
`id-token: write` and no AWS step. The `verify` job downloads the artifact the
`build` job uploaded and runs the same credential-free identity check again in
`deploy` before the first AWS call, so a tampered artifact cannot reach the
credentialed step.

`handoff` runs `needs: record`, declares no `environment`, requests no `id-token`
and no AWS permission, and holds only `contents: read`. Its dispatch is the job's
last step, so nothing runs after the E2E run is created.

The `verify` identity check pins the original repository and repository id,
`refs/heads/main`, the two entry events (`workflow_dispatch` and a `push` to
`main`), the exact `release.yml` workflow ref, `GITHUB_SHA` equality between
workflow and source, the Beta account (`650880818323`) and region (`ap-east-1`),
the dedicated `beta-client-publish-role` ARN, and the Actions run/attempt
identity. A different value anywhere fails the run before any publication action.

## Live-interface comparison

Before writing anything, `deploy` resolves the live Beta interface:

| Value | Source |
| --- | --- |
| `ClientBucketName`, `ClientDistributionId` | `AnyWearPlatformStack-beta` outputs |
| `ApiBaseUrl` | `AnyWearPlatformStack-beta` outputs, the API distribution's domain |
| user pool id, client id | `/anywear/beta/cognito_user_pool_id`, `/anywear/beta/cognito_client_id` |

The whole table is one `DescribeStacks` read of `AnyWearPlatformStack-beta` — the
Beta `Base` stack that owns both CloudFront distributions — plus the two SSM
parameters; the deploy path reads no other stack.

It compares each value with the interface recorded in
`dist/build-metadata.json` and exits before `aws s3 sync` or the CloudFront
invalidation when any value differs. The comparison is a refusal, not a
warning: a drifted live interface needs a new published build of the new values.

Because a push compiles the reviewed constants, that refusal is also what makes a
recreated stack fail closed. If `AnyWearPlatformStack-beta` is recreated, or a
value it exposes changes, the merge run fails at the refusal naming the differing
key and both values, and the fix is exactly one reviewed change to the `env`
constants in `release.yml`. Nothing is written to the bucket before that check
passes, and no unreviewed value from the live stack is ever compiled into a
bundle.

## Publication record

After the sync and invalidation, `deploy` writes
`publication/publication-record.json` containing the source SHA, run id and
attempt, bucket, distribution, invalidation id, the resolved interface values and
a timestamp, and uploads it as the `client-publication-record` artifact. The
`record` job downloads that artifact, validates the record against the same
repository/workflow/run identity, writes the step summary and uploads the
validated record as `client-publication-record-validated`. `record` has no
environment and no OIDC token; recording cannot acquire a credential.

## Repository configuration

The stage switch was renamed with no compatibility fallback: `release.yml` reads
`vars.ENABLE_BETA_MUTATION` and never `ENABLE_BETA_DEPLOY`. The repository
variable must be renamed out of band; until it is, the `build` job's condition is
false and every job is skipped.

| Beta variable | Value |
| --- | --- |
| `ENABLE_BETA_MUTATION` | `true` to enable publication on a merge and on a manual dispatch; `false` skips the whole chain |
| `AWS_ACCOUNT_ID` | `650880818323` |
| `AWS_REGION` | `ap-east-1` |
| `CLIENT_PUBLISH_ROLE_ARN` | `arn:aws:iam::650880818323:role/beta-client-publish-role` |

Infra owns the dedicated role. It needs `DescribeStacks` on
`AnyWearPlatformStack-beta`, the Beta `Base` stack the deploy path reads,
`GetParameter` on the two Cognito parameters, `ListBucket` and object
`GetObject`/`PutObject`/`DeleteObject` on the existing Client bucket, and
`CreateInvalidation` on its distribution. It cannot deploy CDK/CFN, assume
infrastructure deployment roles or push Service images. Missing role
configuration fails before AWS access; there is no shared-role fallback.

Read back the environment's actual protection rules and branch policy before
activation. Use supported environment protections and a `main` branch policy;
record provider limitations and operational coordination where needed. An
environment named `beta` alone does not prove configured protections. Source
delivery does not provision the role or configure those protections.

## Running a deployment

A merge to `main` is the ordinary entry: the chain starts from the pushed commit,
compiles the reviewed constants, and needs no operator action. To publish a
revision by hand, dispatch `release.yml` from `main` with `operation: deploy` and,
optionally, the three interface overrides. Publication has no migration window
token, issue-comment URL or deadline inputs. Deployment coordination belongs in
the publication record, rather than a permanent dependency on an Issue or receipt.

1. `build` produces the assets and metadata from that exact SHA, and `verify`
   checks publication identity, the declared interface, the compiled assets, the
   unit suite and the mocked browser suite.
2. `deploy` resolves the live interface and refuses on any mismatch. On a match
   it syncs the built assets, requests a CloudFront invalidation and writes the
   publication record.
3. `record` validates the publication record and uploads the validated copy.
4. `handoff` dispatches one E2E `smoke` to `AnyWear-E2E`
   (`trigger=deploy-smoke`, `worker_slot_offset=0`, `dispatched_by` equal to this
   run's URL, and no expected commits) and prints the created run's URL. A re-run
   of the job skips the dispatch when its own run URL is already in a queued or
   in-progress `beta-qualification.yml` run name; a failed run listing dispatches
   anyway and says so. A publication therefore leaves a red run only when its own
   step failed — a red `smoke` is a red E2E run, not a red publication.
5. Read the record artifact and step summary for the source, bucket,
   distribution, invalidation id and resolved interface. Confirm invalidation
   completion and observe the served `build-metadata.json` Client SHA and
   interface values. An upload or invalidation request alone is not runtime
   qualification; `AnyWear-E2E` qualifies the actual deployed Client, Service
   components and Infra tuple.

The `beta-client-publish` concurrency group serializes Client publication, does
not cancel an active upload, and queues up to 100 pending runs (`queue: max`) in
wait order: a newer merge waits for the in-flight publication instead of
cancelling or replacing it. It is local to this repository, independently of
Infra's deployment queue. Coordinate conflicting maintenance/deployment operations
and verify prior jobs/cloud operations finish before changing ownership. Disabling
the stage switch does not revoke a job's existing configuration snapshot or stop
an already-started upload. A retry or recovery uses the ordinary deploy entry and
the same identity/build/live-interface verification; no new scheduling token is
required.

## Migration status

The [revised AnyWear #54 plan](https://github.com/git-malu/AnyWear/issues/54#issuecomment-6059823426)
uses one explicitly authorized Beta maintenance stop, migration and restart. The
initial Infra reconciliation retains the running Client until an independent
Client selection is published. Old `CLIENT_PUBLISH_WINDOW_*` variables are unused
by this workflow and can be removed during authorized configuration
reconciliation. Role provisioning, effective old-authority retirement, actual
independent publication and final E2E remain runtime delivery evidence, separate
from this source change. This entry-consolidation change was neither dispatched
nor deployed.
