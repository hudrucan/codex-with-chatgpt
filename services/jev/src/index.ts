import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { configSchema, credentialsSchema, defaultStateDir, initialize, JevError, lockState, readPrivate, validateStateDir, writePrivate } from "./state.js";
import { admin, serve, start } from "./process.js";
import { provisionTunnel } from "./tunnel.js";
import { verify } from "./verify.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "state-dir": { type: "string", default: defaultStateDir() }, "public-url": { type: "string" }, name: { type: "string" },
    port: { type: "string", default: "49873" }, zone: { type: "string" }, "tunnel-name": { type: "string" },
    infer: { type: "boolean", default: false }, public: { type: "boolean", default: false },
  } });
  if (positionals.length !== 1) throw new JevError("Choose init, start, serve, status, stop, verify, or provision-tunnel.");
  const command = positionals[0];
  if (command === "init") {
    if (!values["public-url"] || !values.name) throw new JevError("init requires --name and --public-url with an independent HTTPS origin.");
    initialize(values["state-dir"], configSchema.parse({ version: 1, service: "jev-mcp", mcpName: values.name, publicUrl: values["public-url"],
      port: Number(values.port) }));
    const plugin = path.join(values["state-dir"], "plugin");
    fs.mkdirSync(plugin, { mode: 0o700 });
    writePrivate(path.join(plugin, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: values.name, version: "1.0.0", description: "Optional TypeSafe Jev probabilistic advice. Invoke only when useful; never a mandatory review." });
    writePrivate(path.join(plugin, "mcp.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [values.name]: { type: "streamable-http", url: `${values["public-url"]}/mcp` } } });
    console.log(JSON.stringify({ status: "initialized", directory: values["state-dir"], plugin }));
    return;
  }
  const directory = validateStateDir(values["state-dir"]);
  const config = readPrivate(path.join(directory, "config.json"), configSchema);
  const credentials = readPrivate(path.join(directory, "credentials.json"), credentialsSchema);
  if (command === "verify") {
    console.log(JSON.stringify(await verify(directory, values.public ? config.publicUrl : `http://127.0.0.1:${config.port}`, credentials.approvalSecret, values.infer), null, 2));
  } else if (command === "provision-tunnel") {
    if (!values.zone || !values["tunnel-name"]) throw new JevError("Provide --zone and --tunnel-name explicitly.");
    const control = path.join(directory, "control");
    if (!fs.existsSync(control)) fs.mkdirSync(control, { mode: 0o700 });
    const unlock = lockState(validateStateDir(control));
    try { console.log(JSON.stringify(await provisionTunnel(directory, config, values.zone, values["tunnel-name"]))); }
    finally { unlock(); }
  } else if (command === "start") {
    console.log(JSON.stringify(await start(directory, config, credentials.approvalSecret)));
  } else if (command === "status" || command === "stop") {
    console.log(JSON.stringify(await admin(directory, config, credentials.approvalSecret, command === "stop")));
  } else if (command === "serve") {
    await serve(directory, config, credentials.approvalSecret);
  } else throw new JevError("Unknown Jev command.");
}

main().catch((error: unknown) => {
  console.error(error instanceof JevError ? error.message : "Jev operation failed. Check configuration, private file permissions, ownership and network access; no automatic retry.");
  process.exitCode = 1;
});
