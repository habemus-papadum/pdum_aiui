#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dmg: { type: "string" },
    app: { type: "string" },
    profile: { type: "string" },
    id: { type: "string" },
    state: { type: "string", default: join(root, "artifacts") },
    help: { type: "boolean", default: false },
  },
});
const command = positionals[0];
if (values.help || !command) {
  console.log(`Usage: node notary.mjs <preflight|submit|status|log|finish> [options]
  preflight --dmg FILE [--app APP]
  submit    --dmg FILE --profile KEYCHAIN_PROFILE [--app APP]
  status    --id SUBMISSION_ID
  log       --id SUBMISSION_ID
  finish    --id SUBMISSION_ID
  --state DIRECTORY  Override local receipt storage

Credentials stay in Keychain. Submission is asynchronous. Status/finish reuse the
receipt; submit reuses an existing receipt for identical bytes and profile.
finish staples only an Accepted submission and checks that the image was not rebuilt.`);
} else {
  if (process.platform !== "darwin") throw new Error("This workflow requires macOS");
  const state = resolve(values.state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const sha256 = async (filename) => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(filename)) hash.update(bytes);
    return hash.digest("hex");
  };
  const apple = async (args) => {
    const { stdout } = await run("/usr/bin/xcrun", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  };
  const save = async (receipt) => {
    const filename = join(state, `${receipt.id}.json`);
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, filename);
  };
  const preflight = async (dmg) => {
    await run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
    await run("/usr/bin/hdiutil", ["verify", dmg]);
    if (values.app)
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(values.app)]);
  };
  const query = async (receipt) => {
    const info = JSON.parse(
      await apple([
        "notarytool",
        "info",
        receipt.id,
        "--keychain-profile",
        receipt.profile,
        "--output-format",
        "json",
      ]),
    );
    receipt.status = info.status;
    receipt.checkedAt = new Date().toISOString();
    receipt.apple = info;
    await save(receipt);
    return receipt;
  };
  if (command === "preflight") {
    if (!values.dmg) throw new Error("Provide --dmg");
    const dmg = resolve(values.dmg);
    await preflight(dmg);
    console.log(JSON.stringify({ dmg, sha256: await sha256(dmg), signaturesAndImage: "valid" }));
  } else if (command === "submit") {
    if (!values.dmg || !values.profile) throw new Error("Provide --dmg and --profile");
    const dmg = resolve(values.dmg);
    await preflight(dmg);
    const digest = await sha256(dmg);
    let existing;
    for (const filename of (await readdir(state)).filter((name) =>
      /^[\da-f-]{36}\.json$/i.test(name),
    )) {
      const receipt = JSON.parse(await readFile(join(state, filename), "utf8"));
      if (
        [receipt.sha256, receipt.stapledSha256].includes(digest) &&
        receipt.profile === values.profile
      )
        existing = receipt;
    }
    if (existing) {
      existing.dmg = dmg;
      console.log(JSON.stringify({ reused: true, receipt: await query(existing) }, null, 2));
    } else {
      const started = Date.now();
      console.log("Uploading signed image to Apple's notary service...");
      const result = JSON.parse(
        await apple([
          "notarytool",
          "submit",
          dmg,
          "--keychain-profile",
          values.profile,
          "--output-format",
          "json",
          "--no-wait",
        ]),
      );
      const receipt = {
        id: result.id,
        dmg,
        profile: values.profile,
        sha256: digest,
        submittedAt: new Date().toISOString(),
        uploadSeconds: (Date.now() - started) / 1000,
        status: "Submitted",
        apple: result,
      };
      if (!/^[\da-f-]{36}$/i.test(receipt.id))
        throw new Error("Apple did not return a submission ID");
      await save(receipt);
      console.log(JSON.stringify(receipt, null, 2));
    }
  } else if (["status", "log", "finish"].includes(command)) {
    if (!values.id || !/^[\da-f-]{36}$/i.test(values.id)) throw new Error("Provide --id UUID");
    const receipt = JSON.parse(await readFile(join(state, `${values.id}.json`), "utf8"));
    if (command === "log") {
      const logPath = join(state, `${receipt.id}.log.json`);
      await apple([
        "notarytool",
        "log",
        receipt.id,
        "--keychain-profile",
        receipt.profile,
        logPath,
      ]);
      console.log(`Apple's diagnostic log: ${logPath}`);
    } else {
      await query(receipt);
      if (command === "finish") {
        if (receipt.status !== "Accepted")
          throw new Error(
            `Submission is ${receipt.status}; check status later or retrieve its log`,
          );
        const current = await sha256(receipt.dmg);
        if (![receipt.sha256, receipt.stapledSha256].includes(current))
          throw new Error("The DMG changed after submission; do not staple a rebuilt artifact");
        if (!receipt.stapledSha256) await apple(["stapler", "staple", receipt.dmg]);
        await apple(["stapler", "validate", receipt.dmg]);
        await run("/usr/sbin/spctl", [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          receipt.dmg,
        ]);
        receipt.stapledSha256 = await sha256(receipt.dmg);
        receipt.finishedAt ??= new Date().toISOString();
        await save(receipt);
      }
      console.log(JSON.stringify(receipt, null, 2));
    }
  } else throw new Error(`Unknown command: ${command}`);
}
