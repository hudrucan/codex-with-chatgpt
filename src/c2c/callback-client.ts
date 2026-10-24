import { readRuntimeState } from "../bridge/runtime.js";
import { auditPayloadSchema, callbackTicketSchema, registerAttemptSchema, MAX_AUDIT_MS } from "./protocol.js";

/** One loopback request per operation; wait is an event, never an inbox poll. */
export async function callbackLocal(operation: "register" | "wait" | "cancel", input: unknown): Promise<unknown> {
  const parsed = (operation === "register" ? registerAttemptSchema : callbackTicketSchema).parse(input);
  const runtime = readRuntimeState(parsed.hubId);
  if (!runtime) throw new Error("ASYNC_CALLBACK_RUNTIME_UNAVAILABLE");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}/admin/c2c/${operation}`, {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${runtime.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(parsed), signal: AbortSignal.timeout(operation === "wait" ? MAX_AUDIT_MS + 2000 : 5000),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    throw new Error(`ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE${typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? `: ${code}` : ""}`);
  }
  if (response.status === 404) throw new Error("ASYNC_CALLBACK_RUNTIME_UNAVAILABLE");
  const result = await response.json() as { ok: boolean; value?: unknown; error?: string };
  if (!response.ok || result.ok !== true) throw new Error(result.error ?? "ASYNC_CALLBACK_RUNTIME_UNAVAILABLE");
  if (operation === "register") return callbackTicketSchema.parse(result.value);
  if (operation === "wait") return auditPayloadSchema.parse(result.value);
  return null;
}
