# CI credentials

Client CI holds two GitHub App installation tokens beyond each workflow's own
`GITHUB_TOKEN`. Each is minted once, in one job, for exactly one repository and one
permission:

| Token site | Repository | Permission | What it is for |
| --- | --- | --- | --- |
| `build.yml` → `build` | `AnyWear-Service-API` | `contents: read` | Fetches the published OpenAPI specification the generated client comes from |
| `release.yml` → `handoff` | `AnyWear-E2E` | `actions: write` | Dispatches the post-publication `smoke` run |

The two packaging entries add nine repository-scoped signing secrets — private key
material and the passwords and alias that accompany it — and no external GitHub App
token. The four `ANDROID_*` secrets are read at two `workflow:job` sites, one per
packaging workflow; the other five at one job each in `client-release.yml` (§ [Signing secrets](#signing-secrets)).

This note records what each credential may reach, why, and what happens when one is
unavailable.

## What the source-CI credential is for

Generating the API client is the only step in Client source CI that reads content
from a private repository. `build.yml` runs `pnpm run orval`, which reads
`./api/anywear_openapi.yaml` (`orval.config.ts`), and then fails on
`git diff --exit-code` when the committed generated client does not match that
specification.

`.gitmodules` declares `api` at `https://github.com/anywear-ai/AnyWear-Service-API.git`,
which is private, so the default checkout credential cannot read it. The `build` job
therefore checks the specification out separately, with the App token:

| Step | What it does |
| --- | --- |
| `Checkout` | The Client repository, with the default `GITHUB_TOKEN`, no submodules |
| `Generate API specification token` | Mints the App token, scoped to one repository and one permission |
| `Checkout API specification` | Fetches `${{ github.repository_owner }}/AnyWear-Service-API` at the full commit SHA its own `ref:` pins, into `api/`; `.gitmodules` supplies only `path` and `url` and cannot carry a commit, so the revision comes from the workflow, not from that file |

`rust-check`, `test` and `browser` read no repository content: `cargo check` compiles
`src-tauri`, `pnpm run test:run` and `pnpm run test:browser` read the committed
generated client under `src/api/`, and the browser scenarios mock the Service, image
and identity boundaries. Those three jobs hold no App credential and fetch no
submodules, so they cannot leak one.

## The boundary

The source-CI token step requests:

- `repositories: AnyWear-Service-API` — an explicit allowlist, resolved against
  `owner: ${{ github.repository_owner }}`. Without `repositories`, the action mints a
  token that reaches **every** repository the App installation grants.
- `permission-contents: read` — the only permission asked for. Contents read covers
  `git fetch` of that repository and nothing else. No Actions, Attestations, Pull
  requests or write grant is requested.

The release handoff token step requests:

- `repositories: AnyWear-E2E` — the same explicit allowlist, naming the one
  repository whose `beta-qualification.yml` receives the dispatch.
- `permission-actions: write` — the one permission that can start a run in that
  repository, and nothing else. It cannot read or write source, releases, packages
  or pull requests.

Neither step carries an undeclared key. The boundary treats each site's `with:` set
as closed, because an input the allowlist does not name can widen the installation
token beyond what the review saw.

Both owner-bearing values in the source-CI path are relative: the token step resolves
`repositories: AnyWear-Service-API` against `owner: ${{ github.repository_owner }}`,
and the specification checkout names
`${{ github.repository_owner }}/AnyWear-Service-API`. A run therefore fetches the
specification from whichever account owns this repository at the time, before and
after it moves to `anywear-ai`; only `.gitmodules` names the durable new owner.

The source-CI site is pinned to
`actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349` (v2.2.2)
and the handoff site to
`actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510` (v3.3.0).
Both pins are commits, not the moving `v2`/`v3` tags, so neither credential-bearing
step can change under its workflow. The v3 line of the action still declares and
accepts `app-id` (deprecated in favour of `client-id`), which is why the handoff
site reuses `vars.APP_ID` instead of needing a second repository variable.

`scripts/source-ci-credential-boundary.mjs` holds both allowlists and validates the
workflows against them. `scripts/source-ci-credential-boundary.node-test.mjs` runs
the validator on the checked-in workflows and on mutated copies that widen either
credential; it pins both sites, so a token step in any other job fails the suite and
so does removing one of the two. Both run in `pnpm run test:run`; no network, App
installation or Service call is involved, apart from each pinned action's own
published metadata.

The specification checkout pins its revision by full commit, so it fetches exactly the
revision that commit names. The node test reads the `api` gitlink from the index with
`readSubmoduleRevision` and compares the workflow's `ref` literal against it, so a
submodule bump that leaves the workflow literal behind fails this suite. `build.yml`'s
own `Check codegen consistency` step is what catches a specification revision the
committed generated client does not match: `pnpm run orval` regenerates the client and
`git diff --exit-code` fails when the result differs.

The Beta Client publication chain, `.github/workflows/release.yml`, holds no
credential in `build`, `verify` or `record`: each uses a plain
`actions/checkout@v4` at the built revision, and only `deploy` assumes its own AWS
role. The one App token the chain mints is the `handoff` token above. The checkout
rules in this note — the full-commit specification pin, the `api` path, the
generated token, the default credential everywhere else — still describe
`build.yml` only, because it is the only site that checks another repository out.

## Signing secrets

`.github/workflows/client-release.yml` publishes signed platform binaries and
`.github/workflows/client-beta-apk.yml` publishes a signed Beta APK. The nine
repository-scoped secrets are read at these sites:

| Secret | Platform | Form | Only referencing `workflow:job` sites |
| --- | --- | --- | --- |
| `WINDOWS_CERTIFICATE` | Windows | base64-encoded OV code-signing `.pfx` (not an admitted mechanism; see below) | `client-release.yml:package-windows` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows | `.pfx` export password | `client-release.yml:package-windows` |
| `APPLE_CERTIFICATE` | macOS | base64-encoded Developer ID Application `.p12` | `client-release.yml:package-macos` |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | `.p12` password | `client-release.yml:package-macos` |
| `APPLE_API_KEY_P8` | macOS | base64-encoded App Store Connect API `.p8` | `client-release.yml:package-macos` |
| `ANDROID_KEY_BASE64` | Android | base64-encoded upload keystore | `client-release.yml:package-android` and `client-beta-apk.yml:package-beta-apk` |
| `ANDROID_KEYSTORE_PASSWORD` | Android | keystore password | `client-release.yml:package-android` and `client-beta-apk.yml:package-beta-apk` |
| `ANDROID_KEY_ALIAS` | Android | key alias | `client-release.yml:package-android` and `client-beta-apk.yml:package-beta-apk` |
| `ANDROID_KEY_PASSWORD` | Android | key password | `client-release.yml:package-android` and `client-beta-apk.yml:package-beta-apk` |

These nine are the signing class defined by
[ADR-0004](https://github.com/anywear-ai/AnyWear-Meta/blob/main/architecture/ADR/0004-oidc-ssm-cross-repo-secrets.md)
§5. Each is consumed by a packaging job in one of two runs — the tag release run or
the merge-triggered Beta APK run — never by a running service, so each is a
repository-scoped GitHub secret and not an AWS Secrets Manager value.
[ADR-0036](https://github.com/anywear-ai/AnyWear-Meta/blob/main/architecture/ADR/0036-client-release-pipeline.md#5-repository-scoped-signing-secrets-public-constants-and-windows-ov-signing)
§5 is the placement decision; this note records the names, forms and jobs.

The Windows `.pfx` is the name the job reads, not a mechanism this pipeline may
publish from. Since 2023-06-01 the CA/Browser Forum *Code Signing Baseline
Requirements* require a code-signing subscriber's private key to be generated,
stored and used in a hardware module, a cloud key-protection service or a signing
service, and `Import-PfxCertificate` imports a key exported out of exactly that
boundary, so `WINDOWS_CERTIFICATE` cannot satisfy the requirement. Windows is
`not_published (platform_not_enabled)` for the Beta; the leg, its signature check
and its fail-closed probe stay in the workflow for a later release to declare.

Nothing else is a secret. `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`,
`APPLE_API_ISSUER`, `APPLE_API_KEY`, the Windows timestamp URL and the three
`BETA_*` interface constants are reviewed workflow constants, exactly like the
interface constants in `release.yml`. The macOS ephemeral keychain password is
generated per run with `openssl rand -hex 32` and is never configured.

The boundary has two enforcement sites, and each binds only the actors it can bind.
**In source**, because GitHub scopes a repository secret to the repository, not to a
job — any job that references a secret receives it —
`scripts/source-ci-credential-boundary.mjs` exports a closed `signingSites` table — a
`workflow:job` key → the secret names that site may reference, four keys across
`client-release.yml` and `client-beta-apk.yml` — and now also pins the ordering and
the shape: every site in that table must name the `credential-boundary` job in
`needs:`, and each of `check.yml`, `client-release.yml` and `client-beta-apk.yml`
must declare that job with exactly its three steps, under the reported check name
`Credential Boundary` that a required-check entry pins, with no `needs:`, `if:`,
`secrets.` or `environment:` on the job and no `if:` or `continue-on-error:` on any
of its steps — so no signing site starts before the guard job, which re-runs this
file's own test, has passed, and a failed boundary test cannot leave that check
green.

**On the platform**, the control is the #293 operator action that a repository
administrator or organisation owner applies, not a fact in force: three branch
rulesets, one on `refs/heads/main` in `AnyWear-Client`, `AnyWear-E2E` and
`AnyWear-Infra`, each requiring one approving review dismissed on a new push and
the latest push to be approved by someone other than the pusher
(`require_last_push_approval: true`), and refusing force-push and deletion; plus a
`refs/tags/client-v*` tag ruleset. The checklist and the exact request bodies live
on `anywear-ai/AnyWear#293` under `### Execution plan` steps 4–6, and this identity
cannot perform them: ADR-0035 denies `anywear-agent[bot]` `Administration`. The
required-check entry is the last of those steps, and it pins `Credential Boundary`
only once the guard job is on `main`, which is after this pull request merges.

A non-administrator checks the platform half with reads that need no
`Administration` grant: `gh api /repos/anywear-ai/{repo}/rules/branches/main` for
each of `AnyWear-Client`, `AnyWear-E2E` and `AnyWear-Infra`;
`gh api /repos/anywear-ai/AnyWear-Client/rulesets` and
`gh api /repos/anywear-ai/AnyWear-Client/rulesets/{ruleset_id}`;
`gh api /repos/anywear-ai/AnyWear-Client/tags/protection`; and
`gh api /repos/anywear-ai/AnyWear-Client/commits/{sha}/check-runs` for the check
name the ruleset pins. An empty answer is the finding, not a missing read: at this
commit the first answers `[]` for each of the three repositories, `rulesets`
answers `[]`, and `tags/protection` answers `404`, which is the evidence that only
the source half is in force.

The limit is the same for both: they bind actors who cannot change the requirement. A
repository administrator or organisation owner can disable the rule or act under its
bypass list, and no GitHub mechanism requires an approving review on a tag, so the tag
ruleset restricts *who may create, move or delete* `refs/tags/client-v*` rather than
requiring a review of it. `AnyWear-Service` is deliberately outside this control by
the recorded decision on #293, so a reader should not infer that every repository
carries it. The table's rules fail `pnpm run test:run` when:

- a signing name appears in any job other than its four named `workflow:job` sites,
  in a `with:` or an `env:` value — Tauri reads `APPLE_*` and the Windows
  certificate through the environment, so `env:` is scanned like `with:` — and the
  site key carries its workflow, so a same-named job elsewhere is refused;
- a job declares a write permission outside the named job that holds it: only
  `client-release.yml:publish` and `client-beta-apk.yml:publish-beta-prerelease`
  hold `contents: write`; only `client-release.yml:assemble` holds `id-token: write`
  and `attestations: write`, and `release.yml:deploy` keeps its `id-token: write`;
- a job declares a job-level `environment:` — the packaging entries hold no GitHub
  Environment, so no job may declare one;
- a step `uses:` names a cloud-credential action (`aws-actions/`, `azure/`,
  `google-github-actions/`, or `hashicorp/vault-action`), a job-level `uses:`
  appears at all, or a step `with:` passes a cloud-credential input — the packaging
  entries hold no cloud principal; adopting a cloud signing mechanism amends
  ADR-0036 §5 and the guard's signing table in the same delivery;
- a `vars.` reference is role-shaped (a name with `ROLE` or `ARN` as a whole
  segment), a computed `vars[...]` name cannot be resolved, or a recorded value
  contains an `arn:aws…:` value — the packaging entries name no cloud role or
  principal;
- a `run:` body invokes a cloud CLI (`aws`, `gcloud`, `az`, `sam`, `cdk`,
  `terraform`, `pulumi`, `eksctl`), directly or behind a bare `sudo`, `pnpm exec`
  or `npx` wrapper token (not a wrapper carrying its own options, such as
  `sudo -E aws …`, `npx --yes aws …` or `pnpm exec --silent aws …`, and not an
  `env FOO=1 aws …` prefix), or after `&` or inside `$()` where the substitution
  closes on the same body line — the packaging entries run no cloud CLI.

These four packaging-entry rules read both packaging workflows, `client-release.yml`
and `client-beta-apk.yml`; `release.yml` is the web-publication entry, which declares
its own `environment:` and assumes its own AWS role, so none of the four applies.

`tokenSites` stays at exactly two: the tagged binary publication mints no App
token, dispatches nothing and runs no cloud CLI. `preflight` references no secret at
all, so a missing signing credential cannot fail it; each platform job checks its
own names as its first step and fails closed with
`::error::<SECRET_NAME> is not configured; a <platform> release artifact cannot be produced`
before compiling. The declared set is not a secret either: `client-release-platforms.json`
at the tagged revision is its single source, `preflight` reads it once, and a
platform it does not declare has its job skipped, so that platform's secrets are
never required. An unsigned installer is never uploaded to a released page.

## Caller secret mapping

`check.yml`, the automatic entry, passes the one secret to the one workflow that
declares it:

```yaml
  build:
    uses: ./.github/workflows/build.yml
    secrets:
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}

  test:
    uses: ./.github/workflows/test.yml

  browser:
    uses: ./.github/workflows/browser.yml
```

`secrets: inherit` is deliberately not used. A caller that inherits hands every secret
it can see to the called workflow, including secrets added later that have nothing to
do with the specification, and it cannot be reviewed against the called workflow's
declared secrets. `test.yml` and `browser.yml` declare no secret at all, because no
step in them uses one.

## When a credential is unavailable

Both token sites read the same repository secret, `APP_PRIVATE_KEY`, which resolves
to an empty value on events that do not receive repository secrets:

- **Fork pull requests.** `pull_request` workflows from a fork run with a read-only
  `GITHUB_TOKEN` and no secrets. `Generate API specification token` fails with
  `[@octokit/auth-app] privateKey option is required`, before any API call or
  checkout of the specification.
- **Dependabot pull requests.** For the same reason, unless the secret is explicitly
  made available to Dependabot.
- **A repository or organisation without the secret configured**, including a fresh
  clone of this repository into another account.

Those paths fail loudly at the token step. They are not worked around: the private
specification cannot be fetched with the default credential, `pnpm run orval` cannot
run without it, and handing untrusted source a wider credential to make CI pass is
exactly what this boundary prevents. To run the Client checks on such a revision, run
them locally where the submodule is already initialised.

The handoff site fails the same way: a publication run whose `APP_PRIVATE_KEY` is
empty fails at `Mint the AnyWear-E2E dispatch token` and never reaches the dispatch,
so a publication without a credential leaves no smoke run and no E2E run that
pretends one was dispatched.

`vars.APP_ID` is a repository variable. Context availability for variables on
fork-triggered runs is documented less clearly than it is for secrets, and this
repository has no fork run to observe; the outcome is fail-closed either way, since an
empty `app-id` is also a required-input failure.

## App installation scope

The App installation's effective grants were not inspectable with the account used to
audit this change: `gh api /installation/repositories` and `gh api /user/installations`
both answer 403 to a user token, and `gh api /app/installations` answers 401 without an
App JWT. A restricted token request cannot exceed the installation — GitHub cannot
grant an installation token access to a repository or a permission the installation was
not granted — so the request above is a subset of whatever the installation holds.

What that does **not** establish is the installation's own repository selection and
permission set, and therefore the residual excess, if any, on repositories these
workflows no longer name. To check it in the GitHub UI, read the App's installation
under the organisation's settings and compare its repository selection with the two
repositories named above. One installation fact is evidenced from CI itself: the
trusted `main` run on `7b92ace` minted a token and fetched the private
`AnyWear-Service-API` revision successfully, so the installation covers that
repository. The `handoff` site has not been exercised yet: this change dispatches
nothing, so its first merge is what proves the installation also covers
`AnyWear-E2E` with `actions: write`.
