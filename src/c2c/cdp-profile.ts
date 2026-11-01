import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { stateFile } from "../config/state-files.js";
import { writeSecureJson } from "../config/paths.js";
import { correlationSchema } from "./protocol.js";
import { CdpSendError } from "./cdp.js";

const ownerSchema = correlationSchema.pick({ hubId: true, workspaceId: true });
const profileSchema = ownerSchema.extend({ profileDirectory: z.string().min(1), executable: z.string().min(1) }).strict();
type Profile = z.infer<typeof profileSchema>;
interface ProfileState {
  sid: string; privateAcl: boolean; roots: number[];
  listeners: Array<{ address: string; port: number; pid: number }>;
}
const metadataScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $inputData.profileDirectory
$private = $acl.AreAccessRulesProtected -and ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid)
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid, 'S-1-5-18')) { $private = $false }
}
$roots = @()
foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'")) {
  if ($proc.ExecutablePath -ine $inputData.executable -or $proc.CommandLine -match '--type=') { continue }
  if ($proc.CommandLine -match '(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))') {
    $value = @($Matches[1], $Matches[2], $Matches[3]) | Where-Object { $_ } | Select-Object -First 1
    if ([IO.Path]::GetFullPath($value) -ieq $inputData.profileDirectory) { $roots += [int]$proc.ProcessId }
  }
}
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $roots } | ForEach-Object {
  @{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
@{ sid = $sid; privateAcl = $private; roots = @($roots); listeners = @($listeners) } | ConvertTo-Json -Depth 4 -Compress
`;

function canonical(value: string) {
  if (!path.isAbsolute(value) || fs.realpathSync.native(value).toLowerCase() !== path.resolve(value).toLowerCase())
    throw new Error("profile-path-conflict");
  return path.resolve(fs.realpathSync.native(value));
}
async function inspect(profile: Profile, signal?: AbortSignal): Promise<ProfileState> {
  if (signal?.aborted) throw new CdpSendError("ASYNC_INTERRUPTED", "not_sent");
  if (process.platform !== "win32" || !process.env.SystemRoot) throw new CdpSendError("ASYNC_CDP_PLATFORM_UNSUPPORTED", "not_sent");
  try {
    canonical(profile.profileDirectory); canonical(profile.executable);
    if (path.basename(profile.executable).toLowerCase() !== "msedge.exe") throw new Error("edge-required");
    const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const environment = { ...process.env };
    // PowerShell 7 module paths inherited from a host break inbox PowerShell 5.1.
    for (const key of Object.keys(environment)) if (key.toLowerCase() === "psmodulepath") delete environment[key];
    return await new Promise<ProfileState>((resolve, reject) => {
      const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(metadataScript, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, signal, env: environment,
      }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(stdout) as ProfileState); } catch { reject(new Error("invalid-profile-metadata")); }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(profile));
    });
  } catch {
    throw new CdpSendError(signal?.aborted ? "ASYNC_INTERRUPTED" : "ASYNC_CDP_PROFILE_UNAVAILABLE", "not_sent");
  }
}

function verify(profile: Profile, state: ProfileState) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(profile.profileDirectory, ".c2c-profile-owner.json"), "utf8"));
    if (!state.privateAcl || marker.version !== 1 || marker.ownerSid !== state.sid || marker.hubId !== profile.hubId ||
        marker.workspaceId !== profile.workspaceId || canonical(marker.profileDirectory) !== canonical(profile.profileDirectory)) throw new Error();
  } catch { throw new CdpSendError("ASYNC_CDP_PROFILE_OWNERSHIP", "not_sent"); }
}
function endpoint(profile: Profile, state: ProfileState) {
  verify(profile, state);
  const [port, route] = fs.readFileSync(path.join(profile.profileDirectory, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
  if (state.roots.length !== 1 || !/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route))
    throw new CdpSendError("ASYNC_CDP_PROFILE_BUSY", "not_sent");
  const listeners = state.listeners.filter(item => item.port === Number(port));
  if (!listeners.length || listeners.some(item => !["127.0.0.1", "::1"].includes(item.address) || !state.roots.includes(item.pid)))
    throw new CdpSendError("ASYNC_CDP_ENDPOINT_STALE", "not_sent");
  return `ws://127.0.0.1:${port}${route}`;
}

/** One-time machine configuration only: never store endpoints, conversations or tickets. */
export async function configureCdpProfile(input: unknown) {
  const profile = profileSchema.parse(input);
  profile.profileDirectory = canonical(profile.profileDirectory); profile.executable = canonical(profile.executable);
  const state = await inspect(profile); verify(profile, state);
  writeSecureJson(stateFile("cdp", `${profile.hubId}.json`), profile);
  return { configured: true };
}

/** Resolve afresh in each controller process; an environment override is optional. */
export async function resolveCdpEndpoint(owner: z.infer<typeof ownerSchema>, signal?: AbortSignal) {
  if (signal?.aborted) throw new CdpSendError("ASYNC_INTERRUPTED", "not_sent");
  if (process.env.C2C_CDP_ENDPOINT) return process.env.C2C_CDP_ENDPOINT;
  let profile: Profile;
  try { profile = profileSchema.parse(JSON.parse(fs.readFileSync(stateFile("cdp", `${ownerSchema.parse(owner).hubId}.json`), "utf8"))); }
  catch { throw new CdpSendError("ASYNC_CDP_PROFILE_REQUIRED", "not_sent"); }
  if (profile.hubId !== owner.hubId || profile.workspaceId !== owner.workspaceId) throw new CdpSendError("ASYNC_CDP_PROFILE_OWNERSHIP", "not_sent");
  let state = await inspect(profile, signal); verify(profile, state);
  if (state.roots.length) return endpoint(profile, state);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); signal?.removeEventListener("abort", aborted); error ? reject(error) : resolve(); };
    const aborted = () => finish(new CdpSendError("ASYNC_INTERRUPTED", "not_sent"));
    const watcher = fs.watch(profile.profileDirectory, (_event, name) => {
      if (String(name).toLowerCase() !== "devtoolsactiveport") return;
      try {
        const text = fs.readFileSync(path.join(profile.profileDirectory, "DevToolsActivePort"), "utf8").trim();
        if (/^\d+\r?\n\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(text)) finish();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(new CdpSendError("ASYNC_CDP_PROFILE_UNAVAILABLE", "not_sent")); }
    });
    const timer = setTimeout(() => finish(new CdpSendError("ASYNC_CDP_START_TIMEOUT", "not_sent")), 30_000);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    const child = spawn(profile.executable, [`--user-data-dir=${profile.profileDirectory}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank"],
      { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => finish(new CdpSendError("ASYNC_CDP_START_FAILED", "not_sent"))); child.unref();
  });
  state = await inspect(profile, signal);
  return endpoint(profile, state);
}
