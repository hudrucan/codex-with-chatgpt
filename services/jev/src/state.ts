import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export class JevError extends Error {}

export const configSchema = z.preprocess((value) => {
  // Ignore only obsolete quota fields so existing deployments need no migration.
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["dailyAttempts", "dailyReservedTokens"].includes(key)));
}, z.object({
  version: z.literal(1), service: z.literal("jev-mcp"),
  mcpName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  publicUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  }),
  port: z.number().int().min(1024).max(65535),
}).strict());
export type Config = z.infer<typeof configSchema>;
export const credentialsSchema = z.object({
  approvalSecret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const apiKeySchema = z.string().min(1).max(4096).regex(/^\S+$/);

const repository = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
function within(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertExternal(directory: string): void {
  for (let current = directory;; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) throw new JevError("Keep Jev runtime state outside Git repositories.");
    if (current === path.dirname(current)) break;
  }
}

export function defaultStateDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "jev-mcp");
}

export function privateFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new JevError("Private files must be owned by this user, mode 0600, and not symlinks.");
  }
}

export function readPrivate<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  privateFile(file);
  if (fs.statSync(file).size > 262_144) throw new JevError("Private state exceeds its size limit.");
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new JevError("Invalid Jev state; repair it explicitly before restarting.");
  return parsed.data;
}

export function writePrivate(file: string, value: unknown): void {
  if (fs.existsSync(file)) privateFile(file);
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

export function validateStateDir(directory: string): string {
  const stat = fs.lstatSync(directory);
  const canonical = fs.realpathSync(directory);
  assertExternal(canonical);
  const c2c = path.join(os.homedir(), "Library", "Application Support", "codex-with-chatgpt");
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
    || within(repository, canonical) || within(c2c, canonical)) {
    throw new JevError("Use a private Jev directory outside repositories and C2C state.");
  }
  return canonical;
}

export function initialize(directory: string, config: Config): void {
  configSchema.parse(config);
  assertExternal(path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)));
  const credentials = credentialsSchema.parse({
    approvalSecret: randomBytes(32).toString("hex"),
  });
  // Exclusive creation never adopts an existing directory or C2C identity.
  fs.mkdirSync(directory, { mode: 0o700 });
  validateStateDir(directory);
  writePrivate(path.join(directory, "config.json"), config);
  writePrivate(path.join(directory, "credentials.json"), credentials);
  writePrivate(path.join(directory, "oauth.json"), { version: 1, service: "jev-mcp", clients: [], tokens: [] });
}

export function lockState(directory: string): () => void {
  const lock = path.join(directory, "runtime.lock");
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch { throw new JevError("Jev state is locked. Stop its process or verify a stale lock before removing it."); }
  fs.writeFileSync(fd, String(process.pid));
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
