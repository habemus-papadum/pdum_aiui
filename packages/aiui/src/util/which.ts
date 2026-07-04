import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Return true if `command` resolves to an executable on the PATH.
 *
 * A dependency-free `which`: it scans each PATH entry for an executable file
 * (honouring `PATHEXT` on Windows). This is the first of what will be several
 * environment checks the launcher runs before shelling out to `claude`.
 */
export function commandExists(command: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext), constants.X_OK);
        return true;
      } catch {
        // Not executable here — keep scanning.
      }
    }
  }
  return false;
}
