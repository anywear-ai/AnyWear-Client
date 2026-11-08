# AnyWear Client 0.2.0

First Beta Client binary release with an installable Android artifact. `X.Y.Z` is
the release tag's version and `client_version` 8 is the protocol version compiled
into the web frontend (`client-version.json`).

## Platform availability

- **Windows:** not_published (platform_not_enabled, Windows signing is deferred for this Beta: the pipeline has no Windows signing mechanism that meets the current CA/Browser Forum key-protection requirements).
- **macOS:** not_published (platform_not_enabled, macOS signing credentials are not provisioned for this Beta; the desktop legs are deferred, not retired).
- **Android:** published: a signed APK for direct installation, plus the AAB upload bundle.

## What it contains

- `AnyWear-0.2.0-android.apk`: the signed APK a tester installs directly.
- `AnyWear-0.2.0-android.aab`: the signed Android App Bundle, the upload format
  for a store channel; it is not itself installable.
- `build-metadata.json`: schema 3, unchanged; records `source_commit`, `built_at`,
  `client_version` and the compiled interface triple. It carries no `X.Y.Z` field,
  and it is the same file packed into the app.
- `RELEASE-NOTES.md`: this snapshot, attached as an immutable release asset.
- `SHA256SUMS`: GNU coreutils text-mode checksums for every asset above.
- `SHA256SUMS.sigstore.json`: one Sigstore bundle whose subjects are every
  artifact listed in `SHA256SUMS`.

Windows and macOS stay in the pipeline's design: their asset names, package jobs
and signature checks remain, and a later release declares them by changing
`client-release-platforms.json` rather than the pipeline.

## Known issues

- **Android-only release.** Windows and macOS are `not_published (platform_not_enabled)`
  for this Beta: Windows signing is deferred for the key-protection reason above,
  and the macOS signing credentials are not provisioned. There is no desktop
  installer for this version.
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
- **Signing is proved by the tagged run.** The landing change can assert the
  signing and verification commands, the job dependency and the keystore
  materialization, not an `apksigner verify` result on the built bytes. The first
  tagged run with the four `ANDROID_*` secrets is what proves the APK and the AAB
  are signed and verify.

## Download and verify

See [the Client release runbook](../client-release.md) for the download,
checksum, attestation and native signature verification commands.
