# AnyWear Client 0.2.2

This is the first published Beta Client binary release: a signed Android APK a
tester can install on a phone. Neither `0.2.0` nor `0.2.1` was published — both
tagged runs stopped before publication — so `0.2.2` is the first downloadable
version. `X.Y.Z` is the release tag's version, and `client_version` 8 is the
protocol version compiled into the web frontend (`client-version.json`).

## Platform availability

- **Windows:** not_published (platform_not_enabled, Windows signing is deferred for this Beta: the pipeline has no Windows signing mechanism that meets the current CA/Browser Forum key-protection requirements).
- **macOS:** not_published (platform_not_enabled, this release declares Android alone in `client-release-platforms.json`; the macOS signing credentials are not provisioned, and the desktop legs are deferred, not retired).
- **Android:** published: a signed APK for direct installation, plus the AAB upload bundle.

## What it contains

- `AnyWear-0.2.2-android.apk`: the signed APK a tester installs directly.
- `AnyWear-0.2.2-android.aab`: the signed Android App Bundle, the upload format
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
- **No earlier published version.** The `client-v0.2.0` and `client-v0.2.1` tags
  exist, but both runs were refused before publication. `0.2.2` is the first
  version a tester can download, and there is nothing to upgrade from.
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
- **Signing is proved by the tagged run.** The pipeline now signs the release
  build type from the materialized keystore and verifies the APK with
  `apksigner` and the AAB with `jarsigner` against that keystore's certificate.
  This version's tagged run is the first execution of that path, and its log is
  the proof the published bytes are signed as expected.

## Download and verify

See [the Client release runbook](../client-release.md) for the download,
checksum, attestation and native signature verification commands.
