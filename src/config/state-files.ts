import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./paths.js";
/** Reject links at every existing path component before accessing local state. */
export function stateFile(directory: string, name: string): string {
  if (!/^[a-z-]+$/.test(directory) || !/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error("STATE_PATH_INVALID: Invalid state path.");
  const base = path.resolve(getStateDir());
  const target = path.join(base, directory, name);
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error("STATE_PATH_INVALID: Refusing a state symlink.");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
  return target;
}
