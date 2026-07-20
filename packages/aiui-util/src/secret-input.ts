/**
 * Secret input that never touches argv or shell history (promoted from
 * `exploration/os-vault`): piped stdin for scripting, a raw-mode masked
 * prompt at a real terminal — the same technique npm's own password prompts
 * use. The value is a program-internal string handed straight to the vault,
 * never round-tripped through a shell.
 */

export interface SecretInputOptions {
  /** Injectable streams for tests; default the real process stdio. */
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Read one secret value: piped/non-interactive stdin reads one line per call
 * (so several keys can arrive as several lines); a real terminal gets a
 * masked prompt (keystrokes unechoed; Enter submits, backspace edits, Ctrl-C
 * aborts the process with the conventional SIGINT code).
 */
export async function readSecret(
  promptLabel: string,
  options: SecretInputOptions = {},
): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return readPipedLine(stdin);
  }
  return readMaskedLine(promptLabel, stdin, options.stdout ?? process.stdout);
}

const pipedBuffers = new WeakMap<NodeJS.ReadStream, { lines: string[]; index: number }>();

/**
 * Buffer the whole of stdin once and serve one line per call. Deliberately
 * NOT `readline.Interface#question()` in a loop — that breaks for a second
 * line: readline auto-closes as soon as the piped stream hits EOF (which for
 * `printf 'a\nb\n' | …` is right after the first delivery), and the next
 * `question()` throws `ERR_USE_AFTER_CLOSE` (observed live in the spike).
 */
async function readPipedLine(stdin: NodeJS.ReadStream): Promise<string> {
  let buffered = pipedBuffers.get(stdin);
  if (buffered === undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk as Buffer);
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop(); // trailing "\n" → no phantom empty line
    }
    buffered = { lines, index: 0 };
    pipedBuffers.set(stdin, buffered);
  }
  const line = buffered.lines[buffered.index] ?? "";
  buffered.index++;
  return line;
}

// Control-byte codepoints, compared numerically rather than embedded as
// literal control characters — invisible bytes in source are easy to mangle
// silently and hard to review in a diff.
const CODE_CTRL_C = 0x03; // ETX — abort
const CODE_CTRL_D = 0x04; // EOT — submit (same as Enter)
const CODE_BACKSPACE = 0x7f; // DEL — most terminals send this for ⌫

/** Prompt + read one line from a real terminal with keystrokes masked. */
function readMaskedLine(
  promptLabel: string,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<string> {
  return new Promise((resolvePromise) => {
    stdout.write(`${promptLabel} (input hidden): `);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      const code = chunk.codePointAt(0);
      if (chunk === "\n" || chunk === "\r" || code === CODE_CTRL_D) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolvePromise(value);
        return;
      }
      if (code === CODE_CTRL_C) {
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\n");
        process.exit(130); // conventional SIGINT exit code
      }
      if (chunk === "\b" || code === CODE_BACKSPACE) {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    stdin.on("data", onData);
  });
}
