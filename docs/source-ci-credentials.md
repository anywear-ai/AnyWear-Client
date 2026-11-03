# CI credentials

Client CI holds two GitHub App installation tokens beyond each workflow's own
`GITHUB_TOKEN`. Each is minted once, in one job, for exactly one repository and one
permission:

| Token site | Repository | Permission | What it is for |
| --- | --- | --- | --- |
| `build.yml` → `build` | `AnyWear-Service-API` | `contents: read` | Fetches the published OpenAPI specification the generated client comes from |
| `release.yml` → `handoff` | `AnyWear-E2E` | `actions: write` | Dispatches the post-publication `smoke` run |

This note records what each token may reach, why, and what happens when one is
unavailable.

## What the source-CI credential is for

Generating the API client is the only step in Client source CI that reads content
from a private repository. `build.yml` runs `pnpm run orval`, which reads
`./api/anywear_openapi.yaml` (`orval.config.ts`), and then fails on
`git diff --exit-code` when the committed generated client does not match that
specification.

`.gitmodules` declares `api` at `https://github.com/git-malu/AnyWear-Service-API.git`,
which is private, so the default checkout credential cannot read it. The `build` job
therefore checks the specification out separately, with the App token:

| Step | What it does |
| --- | --- |
| `Checkout` | The Client repository, with the default `GITHUB_TOKEN`, no submodules |
| `Generate API specification token` | Mints the App token, scoped to one repository and one permission |
| `Checkout API specification` | Fetches `git-malu/AnyWear-Service-API` at the revision `.gitmodules` records, into `api/` |

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
revision that commit names. The node test compares that literal against the revision
the test names, which the maintainer updates with the submodule pointer; it does not
read the gitlink itself, so a submodule bump that changes neither the workflow literal
nor the test's revision passes this suite. `build.yml`'s own `Check codegen
consistency` step is what catches a specification revision the committed generated
client does not match: `pnpm run orval` regenerates the client and `git diff
--exit-code` fails when the result differs.

The Beta Client publication chain, `.github/workflows/release.yml`, holds no
credential in `build`, `verify` or `record`: each uses a plain
`actions/checkout@v4` at the built revision, and only `deploy` assumes its own AWS
role. The one App token the chain mints is the `handoff` token above. The checkout
rules in this note — the full-commit specification pin, the `api` path, the
generated token, the default credential everywhere else — still describe
`build.yml` only, because it is the only site that checks another repository out.

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
