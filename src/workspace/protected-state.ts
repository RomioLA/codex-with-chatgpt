import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Local permission, OAuth, and runtime state are never remote file capabilities. */
export function isProtectedStatePath(absolutePath: string): boolean {
  const root = getStateDir();
  if (contains(root, absolutePath)) return true;
  let current = root;
  const suffix: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) return true;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      // Also protect state reached through an alias, including a not-yet-created
      // state directory below an existing junction. Unverifiable roots fail closed.
      return contains(path.join(fs.realpathSync.native(current), ...suffix), absolutePath);
    } catch { return true; }
  }
}
