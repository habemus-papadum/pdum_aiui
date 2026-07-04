import chalk from "chalk";

/**
 * Styled terminal output — our small stand-in for Python's `rich`.
 *
 * We deliberately keep the surface tiny: the launcher only ever needs to shout
 * about errors. Routine progress (which CLIs were found, what command is being
 * assembled) is intentionally left unprinted so the terminal stays quiet until
 * something actually goes wrong.
 */
export function printError(title: string, detail?: string): void {
  console.error(`${chalk.bgRed.white.bold(" ERROR ")} ${chalk.red.bold(title)}`);
  if (detail) {
    console.error(chalk.dim(detail));
  }
}
