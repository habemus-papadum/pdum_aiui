/**
 * The masked terminal read, over a fake TTY: what the user SEES (one `*` per
 * character) and what the caller GETS (the exact secret) are different things,
 * and both are asserted here — a mask that leaked into the value, or a paste
 * whose bracketed-paste wrapper became part of the key, would be invisible
 * until a vendor rejected the stored secret.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readSecret } from "./secret-input.ts";

const ESC = String.fromCharCode(0x1b);

/** A stdin that claims to be a TTY and lets a test push keystrokes. */
function fakeTty(): NodeJS.ReadStream & { send: (chunk: string) => void } {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream & {
    send: (chunk: string) => void;
  };
  stream.isTTY = true;
  stream.resume = (() => stream) as NodeJS.ReadStream["resume"];
  stream.pause = (() => stream) as NodeJS.ReadStream["pause"];
  stream.setRawMode = (() => stream) as NodeJS.ReadStream["setRawMode"];
  stream.setEncoding = (() => stream) as NodeJS.ReadStream["setEncoding"];
  stream.send = (chunk: string) => stream.emit("data", chunk);
  return stream;
}

/** A stdout that records everything written to it. */
function fakeStdout(): NodeJS.WriteStream & { written: () => string } {
  const chunks: string[] = [];
  return {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    written: () => chunks.join(""),
  } as unknown as NodeJS.WriteStream & { written: () => string };
}

describe("readSecret at a terminal", () => {
  it("echoes one * per character and returns the typed value", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("OPENAI_API_KEY", { stdin, stdout });
    stdin.send("sk-");
    stdin.send("abc");
    stdin.send("\r");
    expect(await pending).toBe("sk-abc");
    expect(stdout.written()).toBe("OPENAI_API_KEY: ******\n");
  });

  it("takes a whole paste with its trailing newline as one submitted line", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout, promptText: "> " });
    stdin.send("sk-proj-0123456789\n");
    expect(await pending).toBe("sk-proj-0123456789");
    expect(stdout.written()).toBe(`> ${"*".repeat(18)}\n`);
  });

  it("strips a bracketed-paste wrapper and arrow keys instead of storing them", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout });
    stdin.send(`${ESC}[200~sk-live${ESC}[201~`);
    stdin.send(`${ESC}[A`); // an arrow key: not part of the key, not a character
    stdin.send("\r");
    expect(await pending).toBe("sk-live");
    expect(stdout.written().endsWith(`${"*".repeat(7)}\n`)).toBe(true);
  });

  it("backspace edits the value and rubs out one mask character", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout, promptText: "" });
    stdin.send("abX");
    stdin.send(String.fromCharCode(0x7f));
    stdin.send("c");
    stdin.send("\n");
    expect(await pending).toBe("abc");
    expect(stdout.written()).toBe("***\b \b*\n");
  });

  it("backspace on an empty value is a no-op (it can't eat the prompt)", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout, promptText: "" });
    stdin.send(String.fromCharCode(0x7f));
    stdin.send("\r");
    expect(await pending).toBe("");
    expect(stdout.written()).toBe("\n");
  });

  it("Enter alone submits the empty line — how callers offer 'skip'", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout, promptText: "" });
    stdin.send("\r");
    expect(await pending).toBe("");
  });

  it("echo: none writes nothing while still returning the value", async () => {
    const stdin = fakeTty();
    const stdout = fakeStdout();
    const pending = readSecret("KEY", { stdin, stdout, promptText: "", echo: "none" });
    stdin.send("secret");
    stdin.send("\r");
    expect(await pending).toBe("secret");
    expect(stdout.written()).toBe("\n");
  });
});
