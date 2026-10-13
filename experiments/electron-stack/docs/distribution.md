# Distributing the Electron stack

An Electron bundle can contain the static frontend, an independent Node runtime running Express, and a Python runtime running the Python service. The deployed Cloudflare Worker stays remote. Adding Rust or C++ later uses the same executable-and-resources contract. Both the web-wrapper and desktop-native modes can ship this way.

The original spike verified unsigned packaging. The follow-up [macOS notarization spike](../../macos-notarization/README.md) verified Developer ID signing, signed runtime execution, Apple's notarization acceptance, and DMG ticket stapling/validation. A clean recipient installation is a separate acceptance test.

## macOS direct downloads

You can distribute a DMG directly from your own download link. Neither the Mac App Store nor TestFlight is needed. Electron explicitly supports direct installer distribution. [Electron distribution overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)

There are three useful build lanes:

| Lane | Signing/notarization | Recipient experience |
| --- | --- | --- |
| Source development | Installed Electron runtime; no release submission | Fast local development; does not exercise downloaded-app Gatekeeper checks |
| Internal test artifact | Local/ad-hoc or Developer ID signing; notarization omitted | Gatekeeper may block a downloaded build; a permitted recipient can explicitly override for that app |
| Routine colleague distribution | Developer ID Application signing, hardened runtime, notarization, stapled ticket | Normal first-download confirmation and any actual capability permission prompts |

Internal use does **not** exempt downloaded software from Gatekeeper's defaults. Apple says macOS Catalina and later expects notarization. Where allowed, the recipient first tries opening the app, then uses **System Settings → Privacy & Security → Open Anyway**, and confirms the subsequent prompt. Managed machines can restrict these choices. An override is a workable deliberate internal-testing lane, not a guarantee that every unsigned build or every nested executable will run. [Apple's current Gatekeeper and override instructions](https://support.apple.com/en-us/102445)

Signing alone identifies the developer; notarization adds Apple's automated scan and ticket. This is not App Review, and it can be scripted. Use Developer ID Application for the direct-download `.app`, not an App Store distribution identity. Apple's submission requirements include signatures on distributed executables, hardened runtime, secure timestamps, and no release `get-task-allow` entitlement. Use `notarytool`, not the retired `altool`. Stapling makes the notarization ticket available with the artifact. [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

The practical release sequence is:

1. Build frontend/main/preload, and stage the target runtimes and backend code.
2. Sign native components inside-out, then sign the outer app.
3. Create the intended distribution artifact; submit using the packaging tool's notarization integration or `notarytool`; staple the applicable app/DMG ticket(s).
4. Verify signatures and tickets, and test the **downloaded** artifact on another Mac before distributing its link.

Use automation so agents keep using source development and hidden tests; only artifacts intended for colleagues need the distribution lane. Electron's tooling supports integrated signing and notarization, with credentials supplied through a keychain profile or environment rather than checked-in secrets. [Electron signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Forge signing integration](https://www.electronforge.io/guides/code-signing/code-signing-macos)

## Bundled runtimes are nested code

A Python installation is more than `python3`: include its standard library, extension modules, shared libraries, and your dependencies. A separate Node runtime needs its backend JS and any native addons built for that **Node** runtime. Do not copy a developer virtualenv blindly: absolute paths, symlinks, and libraries from the build machine can make it nonportable. Build/stage a relocatable target runtime and test it after moving the packaged app.

Put executable trees outside `app.asar`, and resolve them through `process.resourcesPath`. External Python and Node cannot use Electron's special ASAR filesystem support. `extraResources` is intended for these native executables and data. Preserve executable permissions. Keep logs, databases, caches, and other mutable data outside the signed app, in per-user/per-instance storage. [electron-builder application contents](https://www.electron.build/v26/docs/contents/), [Electron ASAR limitations](https://github.com/electron/electron/blob/main/docs/tutorial/asar-archives.md)

On macOS, inventory native code by file type, not only extension: Node, Python, `.dylib`, Python native `.so` modules, `.node` addons, and future native services all need attention. Sign native leaves before containers; copying or changing them after signing can invalidate the outer signature. Apple discourages using `codesign --deep` to sign the whole app; recursive **verification** is appropriate. Do not assume a downloaded runtime's original signature is sufficient for the final app's library-validation behavior. [Apple nested code and signing order](https://developer.apple.com/library/archive/technotes/tn2206/_index.html), [Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)

The packager must explicitly cover extra executables. For electron-builder, `mac.binaries` identifies additional code to sign; custom signing can handle a runtime tree. Use file-specific entitlements rather than assigning every executable the renderer's permissions. [electron-builder macOS configuration](https://www.electron.build/v26/docs/mac/)

## Permissions are a separate layer

Direct-download notarization requires **Hardened Runtime**; it does not require **App Sandbox**. A conventional directly distributed Electron app can spawn bundled processes without adopting the App Store sandbox. App Sandbox is an optional additional restriction for this distribution model. Chromium's renderer sandbox and Electron's context isolation are separate again; keeping them enabled does not prevent the main process from running backends. [Apple distribution capabilities](https://developer.apple.com/documentation/Xcode/preparing-your-app-for-distribution)

Electron/Node use JIT compilation, so their signing entitlements must support the chosen runtime. Python's native libraries and scientific packages may require additional signing work; apply runtime exceptions only to components that need them. The generic backend launcher does not eliminate this per-runtime packaging responsibility.

Notarization does not pre-grant camera, microphone, screen recording, Accessibility, automation, or protected-file access. Add capability-specific declarations and requests when a feature actually needs them. For example, Electron's camera/microphone request API requires appropriate `Info.plist` usage descriptions. Keep test permission state separate from production identities where practical. [Electron media permission API](https://github.com/electron/electron/blob/main/docs/api/system-preferences.md)

For this local-compute application, listen on loopback and allocate ephemeral ports. Exposing a backend to the LAN is a separate feature, with firewall/network implications, not a consequence of bundling it into Electron. No elevated installer or privileged system daemon is needed by this spike's architecture.

## Linux and architecture

Start with separate macOS `arm64` and `x64` artifacts, each containing matching runtimes and native dependencies. A universal Electron shell does not automatically make Python, Node, or native extensions universal. Universal packaging needs a deliberate complete runtime layout for both architectures and testing on both. [electron-builder architecture support](https://www.electron.build/v26/docs/mac/)

Linux supports AppImage, deb/rpm, archives, and sandboxed formats such as Flatpak/Snap. Bundling language runtimes removes the user's Python/Node installation requirement; it does not remove the host's desktop libraries, display server, kernel, or libc compatibility requirements. AppImage is a distribution format, not a guarantee of zero host dependencies. Build on a defined compatible Linux baseline and test your supported distributions. Sandboxed formats need their own filesystem/network/process policy work. [electron-builder Linux targets and dependencies](https://www.electron.build/v26/docs/linux/)

Recommended first delivery: per-architecture macOS DMGs with Developer ID signing/notarization for routine recipients; a Linux AppImage or deb for a defined Linux baseline. Retain the fast local-artifact lane for trusted testers, and state its manual Gatekeeper requirement explicitly. The runtime staging, service protocol, lifecycle, and frontend routing remain shared across delivery formats.
