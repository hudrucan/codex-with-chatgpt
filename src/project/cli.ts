import type { Command } from "commander";
import { resolveHub } from "../hub/store.js";
import { bindProject, projectInstructions, projectStatus, unbindProject } from "./bindings.js";

export function addProjectCommands(program: Command): void {
  const project = program.command("project").description("Acknowledge optional ChatGPT Project bindings; never edits ChatGPT");
  const output = (value: unknown, json: boolean) => {
    process.stdout.write(JSON.stringify(value, null, json ? undefined : 2) + "\n");
  };
  for (const action of ["status", "instructions", "bind", "unbind"] as const) {
    const command = project.command(action)
      .requiredOption("--workspace <alias-or-id>", "registered workspace selector (exact ID for stale unbind/status)")
      .option("--json", "machine-readable output", false);
    if (action === "bind") command
      .description("Acknowledge exact instructions and successful MCP verification in the selected Project")
      .requiredOption("--project-url <url>", "verified ChatGPT Project landing URL")
      .requiredOption("--instruction-hash <sha256>", "current generated instruction hash verified through visible UI");
    command.action((opts: { workspace: string; projectUrl: string; instructionHash: string; json: boolean }, cmd: Command) => {
      const hub = resolveHub(cmd.optsWithGlobals().hub);
      if (action === "instructions") {
        const result = projectInstructions(hub.hubId, opts.workspace);
        if (opts.json) output(result, true);
        else process.stdout.write(result.instructions + `\n\nInstruction hash: ${result.instructionHash}\n`);
      } else if (action === "status") output(projectStatus(hub.hubId, opts.workspace), opts.json);
      else if (action === "bind") output({ acknowledged: true, binding: bindProject(hub.hubId, opts.workspace, opts.projectUrl, opts.instructionHash) }, opts.json);
      else output(unbindProject(hub.hubId, opts.workspace), opts.json);
    });
  }
}
