import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const service = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(service, "../..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join(repository, "node_modules/typescript/bin/tsc"), "-p", path.join(service, "tsconfig.json")]);
if (process.platform === "win32") {
  if (!process.env.SystemRoot) throw new Error("SystemRoot is required to locate the Windows ACL compiler.");
  const framework = process.arch === "ia32" ? "Framework" : "Framework64";
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
  run(compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${path.join(service, "dist/windows-permissions.exe")}`,
    path.join(service, "src/windows-permissions.cs")]);
}
