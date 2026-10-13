# Bundling backend runtimes

The packaged app starts Express with a standalone Node executable and Python with a standalone Python installation. Neither needs a developer's PATH, Homebrew, virtual environment, or system Python. Electron's own Node remains reserved for its main process.

From this experiment's directory:

```sh
node scripts/stage-runtimes.mjs
node scripts/stage-runtimes.mjs --check
```

The staging script pins Node **24.21.0** and Python **3.13** from Astral's **20261009** release (currently **3.13.16**). It selects the current machine's macOS/Linux and arm64/x64 target. Node archives come from the [official versioned distribution](https://nodejs.org/dist/v24.21.0/); their SHA-256 hashes come from that release's `SHASUMS256.txt`. Python uses the matching `install_only_stripped` archive and the SHA-256 digest in the [pinned GitHub release metadata](https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20261009). Missing hashes and checksum mismatches fail staging before extraction.

```text
vendor/
  manifest.json
  node/
    bin/node
    ... complete official Node distribution, including license ...
  python/
    bin/python3
    lib/... standard library and native extensions ...
    ... complete standalone installation ...
```

The manifest records runtime versions, target architecture, source URLs, checksum sources, and archive hashes. Do not commit `vendor`. It is a build input copied outside Electron's ASAR archive into application resources, where child processes can execute it. Preserve executable bits, Python symlinks, and runtime libraries. Native executables and shared libraries also belong in the macOS signing process.

The staged Node distribution includes npm and headers. On the tested macOS arm64 host, the staging trees occupy approximately **199 MB for Node** and **66 MB for Python**, before Electron and application code. The builder copies only Node's `bin/node` and license into the application; npm and headers stay in staging. It copies the Python runtime tree, including its standard library and extensions. Artifact sizes therefore differ from these staging sizes.

## Relocation and cache

Staging extracts both runtimes into a temporary directory, moves that directory, then executes the runtimes with a scrubbed environment. Python must find its installation beneath the moved tree and successfully import `ssl`, `sqlite3`, and `ctypes`; Node must match its recorded version. Only after validation does staging replace `vendor`, and it checks the final location again. This was exercised on macOS arm64. The script supports Linux and Intel macOS selection, but those hosts were not tested in this spike.

Artifacts and pinned release metadata are cached at `~/.cache/electron-stack/runtimes`; `ELECTRON_RUNTIME_CACHE` overrides the location. Subsequent runs verify cached archive hashes again. These options are useful in build jobs:

```sh
node scripts/stage-runtimes.mjs --offline # no network; fails if cache incomplete
node scripts/stage-runtimes.mjs --check   # smoke-test installed vendor tree
```

The checksum verifies downloaded bytes against publisher-provided metadata over HTTPS. This spike does not independently authenticate Node's signed checksum file or perform signature-chain verification. `--check` verifies runtime behavior and versions, not the integrity of every already-extracted file. Keep the pinned inputs and checksum metadata under stricter release control if stronger supply-chain guarantees are needed.

## Packaging other languages and Python dependencies

Use the same pattern for Rust or C++: stage a host-target executable and any runtime libraries into resources, launch it as a child process, and use the same readiness report and shutdown protocol. A runnable executable cannot live solely inside ASAR. Build each OS/architecture separately; a macOS arm64 Python executable cannot run in a Linux or Intel macOS artifact. This script deliberately does not pretend to cross-build or produce universal binaries.

The sample Python backend uses the standard library. For a real backend, install pinned dependencies into the staged interpreter's `site-packages` during the build, before signing, rather than depending on the recipient's virtualenv. Native wheels must match the bundled Python and target platform. Avoid relocated virtualenv console-script launchers with absolute build-machine shebangs; launch modules with the bundled interpreter (`python3 -m your_backend`) instead.

Standalone Python still depends on ordinary OS libraries. On Linux this script chooses GNU libc builds, not Alpine/musl builds. Pick and test the supported OS baseline before shipping; "self-contained" here means bundling language runtimes and application dependencies, not replacing the OS. Astral explains the target choices and installation archives in its [running-distributions documentation](https://github.com/astral-sh/python-build-standalone/blob/main/docs/running.rst).

The Cloudflare backend remains remote in a distributed application. Its development emulator is tooling and is not included as a production runtime. Shipping a local Worker emulator would be a different product and packaging decision.
