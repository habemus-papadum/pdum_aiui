# Signing and notarizing a desktop application

This spike takes the existing [Electron Stack](../electron-stack/README.md)
through the direct-download distribution lane. Its reusable part is a small
notarization runner for any signed DMG. Developer identity and service credentials
belong to the team/machine; application identity, native code and entitlements
belong to each application.

For day-to-day commands and the meaning of each credential, use the
[Apple development cheat sheet](../../docs/macOS-noterization-cheat-sheet/README.md).

**Current result:** the Electron app, its bundled Node/Python and the DMG have
been signed with the Developer ID Application identity already installed on this
Mac. Recursive signature verification and the signed DMG's relocation/backend
smoke test passed. Apple accepted the DMG under submission
`61ddedce-09b2-4937-99c3-81fdcf2274b1`. The DMG's ticket is stapled and validated,
and Gatekeeper's DMG assessment passed. Apple's log reports Ready for distribution
with no issues.

Before notarization, Gatekeeper assessed this correctly signed app as
`source=Unnotarized Developer ID`. This demonstrates that valid code signing and
Gatekeeper's normal distribution acceptance are different steps.

A repeat `npm run package:signed` on this Mac took **108.48 seconds** with cached
runtime downloads. That includes frontend/main/preload builds, runtime relocation
checks, Express dependency staging, Electron packaging, nested signing and signed
DMG creation. It is an end-to-end local build measurement, not isolated signing
time. Certificate and credential creation time are excluded. The upload took
**16.215 seconds**. Acceptance was first observed **94.389 seconds after Apple's
recorded upload completion**, so that is an observation bound rather than the
exact server processing duration. The whole automatic path was roughly four
minutes including the local build, upload, observed processing and stapling; the
stages were run separately during this spike.

## Setup shared across applications

The machine already had both an Apple Development identity and a Developer ID
Application identity. The latter is used for direct distribution. A Developer ID
identity includes the certificate and its usable private key. No new certificate
was needed, and the existing identity successfully signed this application's
independent runtimes.

```sh
security find-identity -v -p codesigning
xcrun notarytool --version
```

Signing succeeded with the installed Command Line Tools. Full Xcode was not
needed for this command-line path. There was no App Store upload or review.

Notarization authenticates independently of the signing certificate. An Xcode
account being signed in does not provide a `notarytool` profile automatically.
Use either an Apple Account app-specific password or an App Store Connect API key,
stored once in Keychain under a reusable profile name. The runner never accepts
passwords or private-key contents as CLI options.

For the app-specific password path, generate a password at
[Apple Account](https://account.apple.com), then run this in your own Terminal:

```sh
xcrun notarytool store-credentials aiui-notary \
  --apple-id YOUR_APPLE_ID \
  --team-id YOUR_TEAM_ID
```

Enter the app-specific password at the tool's secure prompt. It validates the
credentials before storing them. Use the team on the Developer ID certificate;
the Apple Account must have access to that team. The profile is shared across
apps rather than being one password/profile per app. Passwords and API keys stay
outside the repository. Keychain access on another machine or CI is a separate
machine setup step. `store-credentials --sync` is an optional explicit iCloud
Keychain choice; this spike does not change the user's synchronization policy.
[Electron credential options](https://github.com/electron/notarize#usage-with-keychain-credentials)

## Configuration per application

For this ordinary desktop app, the configuration consists of:

- A stable bundle ID (`internal.aiui.electron-stack`) and product name.
- Which native executables/libraries ship with it and where they are packaged.
- Hardened runtime and the entitlements the code actually needs. This spike uses
  `com.apple.security.cs.allow-jit`, with no App Sandbox or `get-task-allow`.
- Which team/identity/profile the build uses. The same team identity/profile can
  be reused for other apps.
- A target architecture and distribution artifact. This run is macOS arm64.

The signing build made no per-app App Store Connect record, provisioning profile
or new certificate. Restricted Apple capabilities can require additional portal
and provisioning work; this app uses none of those capabilities. Camera,
microphone, Accessibility and other OS permission flows remain independent of
notarization.

The previous config passed the complete certificate display name to
electron-builder. It rejected the `Developer ID Application:` prefix. The config
now strips that prefix, accepting both the full display name and the name/team
form. The build log then selected the intended Developer ID identity.

The native-file inventory includes executables, `.dylib` and Python extension
modules, not only files with executable-looking suffixes. The packager signs
nested code before the outer app. Every staged file must be finalized before
signing; mutable app data belongs outside the bundle. Python bytecode generation
is already disabled by the service supervisor.

## Build the signed artifact

From `experiments/electron-stack`:

```sh
ELECTRON_STACK_SIGN=1 \
ELECTRON_STACK_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
CSC_IDENTITY_AUTO_DISCOVERY=true npm run package:signed

npm run test:dmg
```

Keep `ELECTRON_STACK_NOTARIZE` unset for this spike's separated workflow. Its
generic runner submits the finished DMG once, after local signing/runtime tests.
The builder's alternative notarization flag integrates app notarization into its
own packaging flow; do not use both paths for the same build.

The signed app's `Identifier`, team, runtime flag and secure timestamp were
verified. Both standalone Node and Python now carry the same Developer ID team
as the app. `codesign --verify --deep --strict` passed. The signed DMG was mounted
read-only, its app copied into a fresh directory, and the volume detached. The
copied app exercised all three backend buttons with `PATH=/nonexistent`, including
verified bundled Node/Python paths and process shutdown. Its remote Worker fixture
runs outside the application; the real deployed endpoint is still a placeholder.

## Submit once and resume by ID

From the repository root:

```sh
node experiments/macos-notarization/notary.mjs preflight \
  --app 'experiments/electron-stack/artifacts/mac-arm64/Electron Stack Spike.app' \
  --dmg 'experiments/electron-stack/artifacts/Electron Stack Spike-0.21.0+dev-arm64.dmg'

node experiments/macos-notarization/notary.mjs submit \
  --dmg 'experiments/electron-stack/artifacts/Electron Stack Spike-0.21.0+dev-arm64.dmg' \
  --profile aiui-notary

node experiments/macos-notarization/notary.mjs status --id SUBMISSION_ID
node experiments/macos-notarization/notary.mjs log --id SUBMISSION_ID
node experiments/macos-notarization/notary.mjs finish --id SUBMISSION_ID
```

The preflight verifies the DMG signature and image integrity, plus the app's
recursive signature when supplied. It does not substitute for Apple's analysis.
Submission uploads the image and returns without waiting for Apple's verdict.
The runner stores a receipt in ignored `artifacts/`: ID, profile name, artifact
path/hash, upload duration, timestamps and observed status. There are no passwords
in the receipt. `--state` selects a different receipt directory.

Repeating submit with the same bytes/profile reuses the receipt instead of
creating another submission. Rebuilding or resigning changes bytes and needs a
new submission. Do not overwrite an image whose submission is still processing.
This simple deduplication assumes one submission runner per artifact/state folder;
it is not a cross-process transaction lock. Separate release builds need their
own immutable output directories, just as agent development needs isolated state.

If Apple returns Invalid, fetch its diagnostic log and fix the specific named
code/signature. If it remains In Progress, query the existing ID later. Killing
the local waiting process does not cancel Apple's processing, and duplicate
uploads do not solve that wait.

`finish` requires Accepted status and checks that the local DMG hash still matches
the submitted artifact. It staples the ticket, validates the staple and assesses
the DMG's primary signature with Gatekeeper. The receipt records the post-staple
hash because stapling intentionally changes the image bytes. Retrying finish
can validate an already-finished image without uploading it again. Transport or
process interruption between upload and receipt storage can require recovering
the ID from `notarytool history`; local atomic receipt writes do not make Apple's
upload and the local filesystem one transaction.

## Friction and remaining acceptance checks

Certificate/private-key and notarization credential setup are shared account and
machine costs. A normal new app mostly supplies its bundle identity, packaged code
and entitlement policy. Native libraries and special Apple capabilities are the
parts likely to create app-specific signing work. No claim about notarization
acceptance can be made from local signing success alone.

Apple documents most notarizations completing within five minutes and 98 percent
within fifteen minutes. First or deeper-analysis submissions can take hours or
days. The runner separates upload time from later observed completion rather than
treating a long hold as a build failure.
[Apple workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[Apple's 2026 explanation of longer holds](https://developer.apple.com/forums/thread/821976)

After acceptance/stapling, test the exact download on a fresh Mac/VM through
Safari and Finder, install into Applications, exercise local compute and the
deployed Worker, and quit/relaunch. An offline initial launch can test ticket
availability; reconnect before testing the remote backend. This recipient test is
distinct from the automated local relocation test.
[Apple's distribution test procedure](https://developer.apple.com/forums/thread/130560)

The useful reusable components are the native-code inventory/signing policy,
credential-profile convention, immutable artifact/receipt, asynchronous submit
and resume commands, and separate local-runtime versus recipient-trust tests.

## Verification record

- Valid Developer ID identity discovered and successfully used; no private-key
  export or certificate creation.
- App, standalone Node/Python and DMG carry the intended team and secure
  timestamps; executable targets have hardened runtime. Recursive app signature
  verification passed.
- The copied signed DMG app passed its backend smoke test without system runtimes.
- Generic runner help and actual signed artifact preflight passed; Biome passed.
- The initial missing-Keychain-profile error was resolved by the user's one-time
  profile setup. Submission, status, diagnostic log, stapling and DMG assessment
  then succeeded against Apple's actual service. No credential was put in code.
- Submission ID `61ddedce-09b2-4937-99c3-81fdcf2274b1` was Accepted; Apple's log
  has `statusCode: 0`, `statusSummary: Ready for distribution` and `issues: null`.
  Its ticket includes the application, Electron helpers/frameworks, bundled
  Node/Python and additional native Python libraries.
- The final stapled DMG SHA-256 is
  `8bc516c36740acc86240782a363fc14c2c8f381acaf534b925f1a996f530b62b`.
  Stapling changes artifact bytes; publish checksums/update metadata only after
  this step. The before/after hashes and timestamps live in the ignored receipt.
- The final stapled DMG's copied app passed the backend smoke test again; the app
  is assessed as `Notarized Developer ID`. Re-running submit reused the same
  receipt without another upload, and re-running finish passed. The DMG blockmap
  was regenerated from the final stapled bytes.
- A clean recipient installation on another Mac remains a separate manual check.
