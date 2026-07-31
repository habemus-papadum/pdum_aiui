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
  /**
   * What the terminal echoes per accepted character. `"mask"` (the default)
   * writes one `*`, so a paste is visibly *something* and visibly about the
   * right length — the difference between "did that land?" and knowing it
   * did. `"none"` echoes nothing at all.
   */
  echo?: "mask" | "none";
  /**
   * The exact string written before reading, for callers that render their
   * own question block and want the read to continue it (the aiui CLI's
   * `promptSecret` passes its caret). Defaults to `${promptLabel}: `.
   */
  promptText?: string;
}

/**
 * Read one secret value: piped/non-interactive stdin reads one line per call
 * (so several keys can arrive as several lines); a real terminal gets a
 * masked prompt (each character echoes as `*`; Enter submits — an empty line
 * included, which is how callers offer "Enter alone means skip" — backspace
 * edits, Ctrl-C aborts the process with the conventional SIGINT code).
 */
export async function readSecret(
  promptLabel: string,
  options: SecretInputOptions = {},
): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return readPipedLine(stdin);
  }
  return readMaskedLine(stdin, options.stdout ?? process.stdout, {
    promptText: options.promptText ?? `${promptLabel}: `,
    echo: options.echo ?? "mask",
  });
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
const CODE_ESC = 0x1b;
const CODE_SPACE = 0x20; // everything below is a control byte

/**
 * Escape sequences to drop before a chunk is treated as typed characters: an
 * arrow key (`ESC [ A`), and — the one that matters for a KEY prompt — the
 * `ESC [ 200 ~` … `ESC [ 201 ~` wrapper a terminal in bracketed-paste mode
 * puts around a paste. Left in, those bytes would silently become part of the
 * secret. Built with `new RegExp` off a computed ESC so no literal control
 * character sits in the source (see the note above).
 */
const ESC = String.fromCharCode(CODE_ESC);
const ESCAPE_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}.?`, "g");

interface MaskedLineOptions {
  promptText: string;
  echo: "mask" | "none";
}

/**
 * Prompt + read one line from a real terminal, echoing `*` per character.
 *
 * The chunk is processed CHARACTER BY CHARACTER rather than by inspecting its
 * first codepoint: a paste arrives as one large chunk, often with its
 * terminating newline attached, so "is this chunk Enter?" is the wrong
 * question — "does this chunk contain Enter, and where?" is the right one.
 * Anything after that newline is discarded, which is what a single-line
 * prompt should do with a multi-line paste.
 */
function readMaskedLine(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  { promptText, echo }: MaskedLineOptions,
): Promise<string> {
  return new Promise((resolvePromise) => {
    stdout.write(promptText);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (raw: string) => {
      for (const ch of raw.replace(ESCAPE_SEQUENCE, "")) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === "\n" || ch === "\r" || code === CODE_CTRL_D) {
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
        if (ch === "\b" || code === CODE_BACKSPACE) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (echo === "mask") {
              stdout.write("\b \b"); // rub out one mask character
            }
          }
          continue;
        }
        if (code < CODE_SPACE) {
          continue; // any other control byte: not part of a key
        }
        value += ch;
        if (echo === "mask") {
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}
