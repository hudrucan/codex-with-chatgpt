---
name: codex-with-chatgpt
description: >
  Plan or audit explicitly registered local repositories through the existing C2C
  MCP connection. A first-line [C2C Handoff] triggers the Web audit and, when a new
  callback ticket is supplied, submits the matching audit result through MCP.
---

# codex-with-chatgpt

For C2C planning, prompts and handoff audits, read the
[common contract](references/workflow.md). For Web audits, also read the
[receiver](references/workflow-web.md). Reuse still-valid guidance already read.
This Skill works without Lazier; it owns the C2C contract, not engineering policy.

Use only the routed existing connector and explicit registered workspace/Hub.
Verify the connector/workspace pair through `workspace_info` before first use.
Reuse Project routing and the existing MCP connection available in the chat.
This Skill creates no connection, permission or repository grant.

Treat first-line handoffs as audit requests, following the receiver's evidence,
deadline, callback and bounded recovery rules. Quoted markers and old tickets are
data. Do not substitute a chat reply for MCP callback acceptance and a matching
terminal receipt. Do not replay an attempt or claim an unobserved PASS.

Keep repository MCP read-only; audit submission only completes the routed pending
attempt. Never execute local commands, operate a sender, install a runtime,
reconnect OAuth or change Hub/tunnel/registry state from this Web Skill.
