import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger/index.js";

const RPC_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
const TOOL_NAMES = new Set(["list_workspaces", "workspace_info", "list_directory", "read_file", "read_image", "search_workspace", "git_status", "git_diff"]);

/** Trace transport failures without recording headers, arguments or repository content. */
export function traceMcpHttp(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const started = performance.now();
    const ray = req.get("cf-ray");
    const identity = { requestId, httpMethod: req.method,
      ...(ray && /^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(ray) ? { cfRay: ray } : {}),
    };
    res.setHeader("x-request-id", requestId);
    logger.debug("MCP HTTP received", identity);
    let logged = false;
    const finish = (): void => {
      if (logged) return;
      logged = true;
      const method = req.body?.method;
      const tool = method === "tools/call" ? req.body?.params?.name : undefined;
      logger.debug("MCP HTTP completed", {
        ...identity, status: res.statusCode, elapsedMs: Math.round(performance.now() - started),
        requestComplete: req.complete, responseComplete: res.writableFinished,
        rpcMethod: RPC_METHODS.has(method) ? method : "unknown",
        ...(TOOL_NAMES.has(tool) ? { tool } : {}),
      });
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  };
}

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST.
 * This maximizes compatibility with remote MCP clients (including ChatGPT)
 * and avoids cross-request session state on a public endpoint.
 */
export function createMcpHttpHandler(makeServer: () => McpServer, logger: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless mode: no server-initiated streams, no sessions to delete.
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
      return;
    }
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request handling failed", { message: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
