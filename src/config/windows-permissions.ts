import path from "node:path";
import { spawnSync } from "node:child_process";

/** Create an empty file with a protected owner-only DACL before writing secrets. */
export function createPrivateWindowsFile(file: string): void {
  if (!process.env.SystemRoot) throw new Error("STATE_ACL_UNAVAILABLE");
  // Windows PowerShell uses the inbox .NET Framework FileStream ACL constructor.
  // No path or credential is interpolated into executable script text or argv.
  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  $path = [Console]::In.ReadToEnd()
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
  $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew,
    [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
    4096, [IO.FileOptions]::None, $acl)
  $stream.Dispose()
} catch { exit 1 }
`;
  const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    input: file, encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("STATE_ACL_UNAVAILABLE");
}
