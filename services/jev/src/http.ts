import express, { type ErrorRequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { JevOAuth, SCOPE } from "./auth.js";
import { Evaluator, inputSchema, MODEL, MAX_INPUT_BYTES } from "./evaluate.js";
import { type Config, JevError } from "./state.js";
import { timingSafeEqual } from "node:crypto";

export function createMcpServer(evaluator: Evaluator, name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" }, {
    instructions: "Optional probabilistic advice only. Default to skipping Jev. Invoke explicitly or conditionally when useful; never require reviews or call on every task. Send only deliberately selected, nonsecret state. You remain responsible for correctness, security, constraints and decisions. Failure or uncertainty means abstain and continue the main workflow.",
  });
  server.registerTool("evaluate", {
    title: "Optional Jev evaluation",
    description: "Send bounded state and batched noul (truth probability), choice (alternatives), or score (ordered rubric) questions to paid TypeSafe jev-1.14.0. Returns structured probabilities, model and usage. Advisory only; never authorizes actions. Use only when requested or conditionally useful. Do not send secrets or automatically read repository content. On failure or ambiguity abstain; continue without Jev.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const result = await evaluator.evaluate(input, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof JevError ? error.message : "Evaluation unavailable; abstain and continue without Jev." }] };
    }
  });
  return server;
}

export function createApp(config: Config, directory: string, approvalSecret: string, apiKey: string, request: typeof fetch = fetch,
  runtime?: { instanceId: string; stop: () => void }) {
  const app = express();
  app.disable("x-powered-by");
  const local = `http://127.0.0.1:${config.port}`;
  const publicHost = new URL(config.publicUrl).hostname;
  const oauth = new JevOAuth(directory, config.publicUrl, approvalSecret, config.port);
  const evaluator = new Evaluator(directory, config, apiKey, request);
  let rateWindow = 0;
  let requests = 0;
  app.use((req, res, next) => {
    // Same-origin form POSTs need a non-opaque Origin for the consent check.
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (!["127.0.0.1", publicHost].includes(req.hostname) || (req.get("origin") && ![config.publicUrl, local].includes(req.get("origin")!))) {
      res.status(403).send("Untrusted host or origin."); return;
    }
    const window = Math.floor(Date.now() / 60_000);
    if (window !== rateWindow) { rateWindow = window; requests = 0; }
    if (++requests > 300) { res.status(429).send("Jev request rate limit reached."); return; }
    next();
  });
  app.get("/health", (_req, res) => { res.json({ service: "jev-mcp", model: MODEL, status: "ok" }); });
  app.use("/admin", (req, res, next) => {
    const supplied = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${approvalSecret}`);
    if (req.hostname !== "127.0.0.1" || req.get("cf-connecting-ip") || req.get("x-forwarded-for")
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).send("Local Jev admin authentication required."); return;
    }
    next();
  });
  app.get("/admin/info", (_req, res) => { res.json({ service: "jev-mcp", name: config.mcpName, instanceId: runtime?.instanceId, pid: process.pid, port: config.port }); });
  app.post("/admin/shutdown", (_req, res) => { res.json({ stopping: true }); setImmediate(() => runtime?.stop()); });
  const router = (origin: string) => mcpAuthRouter({ provider: oauth, issuerUrl: new URL(origin),
    resourceServerUrl: new URL(`${origin}/mcp`), scopesSupported: [SCOPE], resourceName: "Jev advisory evaluation",
    // A single-user service uses global endpoint limits rather than trusting proxy IP headers.
    authorizationOptions: { rateLimit: { keyGenerator: () => "jev" } },
    tokenOptions: { rateLimit: { keyGenerator: () => "jev" } },
    clientRegistrationOptions: { rateLimit: { keyGenerator: () => "jev" } },
    revocationOptions: { rateLimit: { keyGenerator: () => "jev" } },
  });
  const localAuth = router(local);
  const publicAuth = router(config.publicUrl);
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.post("/approve", (req, res) => { oauth.approve(req, res); });
  app.use((req, res, next) => (req.hostname === "127.0.0.1" ? localAuth : publicAuth)(req, res, next));
  app.use("/mcp", (req, res, next) => requireBearerAuth({ verifier: oauth, requiredScopes: [SCOPE],
    resourceMetadataUrl: `${req.hostname === "127.0.0.1" ? local : config.publicUrl}/.well-known/oauth-protected-resource/mcp` })(req, res, next));
  app.use("/mcp", (req, res, next) => {
    const expected = `${req.hostname === "127.0.0.1" ? local : config.publicUrl}/mcp`;
    if (req.auth?.resource?.href !== expected) { res.status(401).json({ error: "invalid_token" }); return; }
    next();
  }, express.json({ limit: "24kb" }));
  app.all("/mcp", async (req, res) => {
    if (req.method !== "POST") { res.status(405).set("Allow", "POST").send("Use POST for stateless Streamable HTTP."); return; }
    if (req.body?.method === "tools/call") {
      const serialized = JSON.stringify(req.body.params?.arguments ?? {});
      // Bound recursion before the SDK applies recursive JSON schemas.
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (const c of serialized) {
        if (escaped) { escaped = false; continue; }
        if (c === "\\" && quoted) { escaped = true; continue; }
        if (c === '"') quoted = !quoted;
        if (!quoted && (c === "{" || c === "[")) depth++;
        if (!quoted && (c === "}" || c === "]")) depth--;
        if (depth > 14) { res.status(400).json({ error: "input_too_deep" }); return; }
      }
      if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) { res.status(413).json({ error: "input_too_large" }); return; }
    }
    const server = createMcpServer(evaluator, config.mcpName);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed" }); }
  });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: "invalid_request" });
  };
  app.use(errorHandler);
  return app;
}
