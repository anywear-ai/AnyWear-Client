# AnyWear Client 0.1.0

First tagged Client binary release. `X.Y.Z` is the release tag's version and
`client_version` 8 is the protocol version compiled into the web frontend
(`client-version.json`).

## Platform availability

- **Windows:** x64 NSIS installer, OV-signed and verified with `Get-AuthenticodeSignature`.
- **macOS:** universal disk image, Developer ID-signed, notarized and stapled,
  verified with `codesign -vvv --strict` and `spctl -a`.
- **Android:** `not_published (platform_not_enabled, pending #279)`. The
  `package-android` job ships its contract in this release pipeline, but the
  Android project (`src-tauri/gen/android`) does not exist yet, so no APK or AAB
  is produced. The first Android artifact is accepted under #280.

## What it contains

- `AnyWear-<X.Y.Z>-windows-x64-setup.exe` and `AnyWear-<X.Y.Z>-macos-universal.dmg`
  when the matching platform is enabled.
- `build-metadata.json`: schema 3, unchanged; records `source_commit`,
  `built_at`, `client_version` and the compiled interface triple. It carries no
  `X.Y.Z` field.
- `RELEASE-NOTES.md`: this snapshot, attached as an immutable release asset.
- `SHA256SUMS`: GNU coreutils text-mode checksums for every asset above.
- `SHA256SUMS.sigstore.json`: one Sigstore bundle whose subjects are every
  artifact listed in `SHA256SUMS`.

## Known issues

- **No SmartScreen reputation yet.** The Windows installer is signed with an OV
  certificate, which does not accumulate SmartScreen reputation the way an EV
  certificate does. Early downloads may show a warning until reputation builds.
- **First run has no updater.** This release does not ship an auto-updater or a
  store channel; a new version is a new download.
- **No native qualification record.** The release is built from a tag on `main`
  after green source checks, but no automated native client qualification record
  exists (ADR 0036 §9). The published binaries are not qualified evidence for a
  Promotion gate.
- **Windows and macOS signing is only observed on this first tagged run.** The
  landing change can assert the verification commands and the job dependency,
  not a `Valid` result; the first run with certificates is what proves it.
- **Android is not in this release.** Its packaging contract is in place but the
  project is produced by #279.

## Download and verify

See [the Client release runbook](../client-release.md) for the download,
checksum, attestation and native signature verification commands.
