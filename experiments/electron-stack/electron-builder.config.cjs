const fs = require("node:fs");
const path = require("node:path");

const signing = process.env.ELECTRON_STACK_SIGN === "1";
const notarizing = process.env.ELECTRON_STACK_NOTARIZE === "1";
if (notarizing && !signing) throw new Error("Notarization requires ELECTRON_STACK_SIGN=1");
if (signing && !process.env.ELECTRON_STACK_SIGN_IDENTITY) {
  throw new Error("Set ELECTRON_STACK_SIGN_IDENTITY to your Developer ID Application identity");
}

// Read the CI-managed version without editing any source manifest.
const { version } = require("../../package.json");

function nativeFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...nativeFiles(filename));
    else if (entry.isFile()) {
      const fd = fs.openSync(filename, "r");
      try {
        const magic = Buffer.alloc(4);
        fs.readSync(fd, magic, 0, 4, 0);
        // Mach-O thin/fat binaries, including Python extension modules and dylibs.
        if (
          [
            "feedface",
            "cefaedfe",
            "feedfacf",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(magic.toString("hex"))
        )
          found.push(filename);
      } finally {
        fs.closeSync(fd);
      }
    }
    // Preserve runtime symlinks; sign their real targets once.
  }
  return found;
}

const binaries = ["node", "python"]
  .flatMap((runtime) => {
    const root = path.join(__dirname, "vendor", runtime);
    return nativeFiles(root).map(
      (filename) =>
        `Contents/Resources/runtimes/${runtime}/${path.relative(root, filename).split(path.sep).join("/")}`,
    );
  })
  .sort((a, b) => b.split("/").length - a.split("/").length);

module.exports = {
  appId: "internal.aiui.electron-stack",
  productName: "Electron Stack Spike",
  directories: { output: "artifacts" },
  extraMetadata: { version, main: "out/main/index.cjs" },
  files: ["out/**", "package.json", "!node_modules/**"],
  asar: true,
  npmRebuild: false,
  extraResources: [
    { from: "app-config.json", to: "app-config.json" },
    { from: "vendor/node", to: "runtimes/node", filter: ["bin/node", "LICENSE"] },
    {
      from: "vendor/python",
      to: "runtimes/python",
      filter: ["**/*", "!**/__pycache__/**", "!**/*.pyc"],
    },
    { from: "vendor/manifest.json", to: "runtimes/manifest.json" },
    { from: "backends/express", to: "backends/express" },
    { from: "backends/python", to: "backends/python" },
    { from: "vendor/express/node_modules", to: "backends/express/node_modules" },
    { from: "infrastructure/ready.py", to: "infrastructure/ready.py" },
    { from: "infrastructure/ready.mjs", to: "infrastructure/ready.mjs" },
  ],
  mac: {
    target: ["dmg"],
    identity: signing
      ? process.env.ELECTRON_STACK_SIGN_IDENTITY.replace(/^Developer ID Application:\s*/, "")
      : null,
    // An unsigned build must not opt into hardened runtime. The distribution lane does.
    hardenedRuntime: signing,
    entitlements: "entitlements.plist",
    entitlementsInherit: "entitlements.plist",
    binaries: signing ? binaries : [],
    notarize: notarizing,
  },
  dmg: { sign: signing },
  linux: { target: ["AppImage"], category: "Development" },
  publish: null,
};
