import type { Command } from "commander";
import { resolveHub } from "../hub/store.js";
import { bindProject, projectInstructions, projectStatus, unbindProject } from "./bindings.js";

export function addProjectCommands(program: Command): void {
  const project = program.command("project").description("Manage Hub-scoped Project memberships; never edits ChatGPT");
  const output = (value: unknown, json: boolean) => process.stdout.write(JSON.stringify(value, null, json ? undefined : 2) + "\n");
  for (const action of ["status", "instructions", "bind", "unbind"] as const) {
    const command = project.command(action)
      .requiredOption("--project-url <url>", "exact ChatGPT Project landing URL")
      .option("--json", "machine-readable output", false);
    if (action === "instructions" || action === "bind") command.option("--workspace <alias-or-id>", "preview/add one registered membership to this Hub's Project block");
    if (action === "unbind") command.requiredOption("--workspace <alias-or-id>", "membership to remove from this Project (exact ID if unregistered)");
    if (action === "bind") command.requiredOption("--instruction-hash <sha256>", "verified hash of this Hub's block; omit --workspace to sync existing memberships");
    command.action((opts: { workspace?: string; projectUrl: string; instructionHash: string; json: boolean }, cmd: Command) => {
      const hub = resolveHub(cmd.optsWithGlobals().hub);
      if (action === "instructions") {
        const result = projectInstructions(hub.hubId, opts.projectUrl, opts.workspace);
        if (opts.json) output(result, true);
        else process.stdout.write(result.instructions + `\n\nInstruction hash: ${result.instructionHash}\n`);
      } else if (action === "status") output(projectStatus(hub.hubId, opts.projectUrl), opts.json);
      else if (action === "bind") output({ acknowledged: true, binding: bindProject(hub.hubId, opts.projectUrl, opts.instructionHash, opts.workspace) }, opts.json);
      else output(unbindProject(hub.hubId, opts.projectUrl, opts.workspace!), opts.json);
    });
  }
}
