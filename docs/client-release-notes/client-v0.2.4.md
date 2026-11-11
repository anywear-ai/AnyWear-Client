# AnyWear Client 0.2.4

This is the first published Beta Client binary release that GitHub protects as
immutable. It carries the same application code as `0.2.3`; the only reason it
exists is that repository release immutability was enabled after `0.2.3` was
published, and GitHub applies that setting only to releases published afterwards.
`0.2.0`, `0.2.1` and `0.2.2` were tagged and never published. `X.Y.Z` is the
release tag's version, and `client_version` 8 is the protocol version compiled
into the web frontend (`client-version.json`).

## Platform availability

- **Windows:** not_published (platform_not_enabled, Windows signing is deferred for this Beta: the pipeline has no Windows signing mechanism that meets the current CA/Browser Forum key-protection requirements).
- **macOS:** not_published (platform_not_enabled, this release declares Android alone in `client-release-platforms.json`; the macOS signing credentials are not provisioned, and the desktop legs are deferred, not retired).
- **Android:** published: a signed APK for direct installation, plus the AAB upload bundle.

## What it contains

- `AnyWear-0.2.4-android.apk`: the signed APK a tester installs directly.
- `AnyWear-0.2.4-android.aab`: the signed Android App Bundle, the upload format
  for a store channel; it is not itself installable.
- `build-metadata.json`: schema 3; records `source_commit`, `built_at`,
  `client_version` and the compiled interface triple. It carries no `X.Y.Z` field,
  and it is the same file packed into the app.
- `RELEASE-NOTES.md`: this snapshot, attached as an immutable release asset.
- `SHA256SUMS`: GNU coreutils text-mode checksums for every asset above.
- `SHA256SUMS.sigstore.json`: one Sigstore bundle whose subjects are every
  artifact listed in `SHA256SUMS`.

Both packages are signed with the upload keystore the release job materializes,
and that job checks each package's signer certificate against the keystore
before anything is assembled or published.

## Changes in this release

The application code is unchanged from `0.2.3`, so the changes below are the same
ones that version carried. `0.2.4` differs from `0.2.3` only in the repository's
release protection, not in what the app does.

- **Capture entries per platform** (#302): the web and desktop clients show a
  single upload entry, while the Android client keeps the camera and library
  entries.
- **Mirror history** (#298): a completed try-on shows its settled state in the
  history card instead of staying Pending.
- **Base-photo deletion** (#299): the delete action asks for confirmation in the
  card and reports a refusal instead of appearing to remove nothing.
- **Dashboard navigation** (#301): returning to the Dashboard no longer leaves
  the navigation hidden while the page loads.

Windows and macOS stay in the pipeline's design: their asset names, package jobs
and signature checks remain, and a later release declares them by changing
`client-release-platforms.json` rather than the pipeline.

## Known issues

- **Android-only release.** Windows and macOS are `not_published (platform_not_enabled)`
  for this Beta: Windows signing is deferred for the key-protection reason above,
  and the macOS signing credentials are not provisioned. There is no desktop
  installer for this version.
- **Why this version exists.** `0.2.3` published the same application code but
  was mutable, because repository release immutability was enabled only after it
  was published; GitHub cannot make an already-published release immutable. The
  tags `0.2.0`, `0.2.1` and `0.2.2` produced no published release at all.
- **Sideloading warning.** The APK is installed outside a store, so Android asks
  for the "install unknown apps" permission and Play Protect may warn. Grant it
  only for bytes that match `SHA256SUMS`.
- **The AAB is not directly installable.** It is the upload bundle for a store
  channel, published beside the APK for completeness. Install the APK.
- **No auto-updater or store channel.** This release ships no auto-updater and no
  Play Store listing; a new version is a new download from a new release page.
- **No native qualification record.** The release is built from a tag on `main`
  after green source checks, but no automated native client qualification record
  exists (ADR 0036 §9). The published binaries are not qualified evidence for a
  Promotion gate.
- **Signing is proved by the tagged run.** The pipeline signs the release build
  type from the materialized keystore and verifies the APK with `apksigner` and
  the AAB with `jarsigner` against that keystore's certificate. This version's
  tagged run is the proof for these bytes.

## Download and verify

See [the Client release runbook](../client-release.md) for the download,
checksum, attestation and native signature verification commands.
