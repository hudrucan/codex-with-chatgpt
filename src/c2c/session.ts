import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { callbackLocal } from "./callback-client.js";
import { localAccess } from "./local.js";
import { auditPayloadSchema, correlationSchema, MAX_AUDIT_MS, type AuditPayload, type CallbackTicket } from "./protocol.js";

export const sessionOptionsSchema = correlationSchema.pick({ hubId: true, workspaceId: true, taskId: true }).extend({
  async: z.literal(true), workspaceRoot: z.string().min(1),
  timeoutMs: z.number().int().positive().max(MAX_AUDIT_MS).default(MAX_AUDIT_MS),
}).strict();
export type SessionOptions = z.infer<typeof sessionOptionsSchema>;

/** Task-local state lives only in this bounded terminal process; a claim cannot resume it. */
export class AuditSession {
  private audits = 0;
  private busy = false;
  private stopped = false;
  private verified = false;
  private source?: string;
  private result?: AuditPayload;
  private completedAttempt?: { ticket: CallbackTicket; deadline: number };
  private pending?: { ticket: CallbackTicket; deadline: number; abort: AbortController; timer: ReturnType<typeof setTimeout> };
  readonly options: SessionOptions;

  constructor(input: unknown) {
    this.options = sessionOptionsSchema.parse(input);
    this.fingerprint();
  }

  async submit(handoff: string, fixed = false) {
    if (this.stopped || this.busy || this.pending || this.audits >= 3 ||
        (this.audits > 0 && (!fixed || this.result?.status !== "FIX" || !this.verified)) ||
        (this.audits === 0 && fixed)) throw new Error("ASYNC_AUDIT_LIMIT");
    if (!handoff.startsWith("[C2C Handoff]\n") || Buffer.byteLength(handoff) > 48 * 1024) throw new Error("ASYNC_HANDOFF_REQUIRED");
    this.busy = true;
    const abort = new AbortController(), deadline = performance.now() + this.options.timeoutMs;
    const expiresAt = Date.now() + this.options.timeoutMs;
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs);
    try {
      this.source = this.fingerprint();
      const { hubId, workspaceId, taskId } = this.options;
      const ticket = await callbackLocal("register", { hubId, workspaceId, taskId, attemptId: randomUUID(),
        handoffId: createHash("sha256").update(handoff).digest("hex"),
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }, abort.signal) as CallbackTicket;
      this.pending = { ticket, deadline, abort, timer };
      if (this.stopped || abort.signal.aborted) throw new Error("ASYNC_TIMEOUT");
      // Prove transport/ownership before claiming or allowing browser delivery.
      if (this.audits === 0) localAccess.claimTask(taskId);
      this.assertSource();
      this.audits++; this.result = undefined; this.verified = false;
      return { attemptId: ticket.attemptId, expiresAt, remainingMs: Math.max(0, Math.floor(deadline - performance.now())),
        message: `${handoff}\n\nC2C_CALLBACK ${JSON.stringify(ticket)}\n\n` +
          "Audit this handoff through the routed C2C MCP and explicit workspace. " +
          "Complete this attempt only by calling submit_audit_result with every C2C_CALLBACK field unchanged and result: " +
          "{status:PASS|FIX|BLOCKED|ERROR,complete:true,summary,findings}. " +
          "FIX requires findings with file, positive line, evidence and fix; other statuses use findings:[]. " +
          "Use BLOCKED for missing evidence/authorization and ERROR for MCP failure; do not retry or expand scope. " +
          "The capability is short-lived and only authorizes this result; do not copy it elsewhere. " +
          "Do not commit, push or rollout. A chat reply cannot complete this attempt." };
    } catch (error) {
      clearTimeout(timer); abort.abort(); await this.close(); throw error;
    } finally { this.busy = false; }
  }

  /** Called once after the browser send succeeds; this is one HTTP event wait, not polling. */
  async sent(attemptId: string) {
    const pending = this.pending;
    if (this.stopped || this.busy || !pending || pending.ticket.attemptId !== attemptId) throw new Error("ASYNC_NOT_SENT");
    this.busy = true;
    try {
      this.assertSource();
      const result = auditPayloadSchema.parse(await callbackLocal("wait", pending.ticket, pending.abort.signal));
      if (pending.abort.signal.aborted || performance.now() >= pending.deadline) throw new Error("ASYNC_TIMEOUT");
      if (this.stopped) throw new Error("ASYNC_INTERRUPTED");
      this.assertSource();
      this.result = result;
      this.completedAttempt = pending;
      const { capability: _capability, ...identity } = pending.ticket;
      clearTimeout(pending.timer); this.pending = undefined;
      if (result.status !== "FIX" || this.audits >= 3) this.stopped = true;
      return { ...identity, ...result, canAutoFix: false, canContinue: !this.stopped };
    } catch (error) {
      const expired = performance.now() >= pending.deadline;
      await this.close();
      throw expired ? new Error("ASYNC_TIMEOUT") : error;
    } finally { this.busy = false; }
  }

  async verifySourceForFix() {
    if (this.stopped || this.busy || this.pending || this.result?.status !== "FIX" || this.audits >= 3)
      throw new Error("ASYNC_FIX_NOT_AVAILABLE");
    this.busy = true;
    try {
      this.assertSource();
      // Close the completed ticket while checking live Hub ownership/permission.
      // A restart, revoked registration or expired capability prevents editing.
      await callbackLocal("cancel", this.completedAttempt!.ticket);
      if (this.stopped || performance.now() >= this.completedAttempt!.deadline) throw new Error("ASYNC_FIX_NOT_AVAILABLE");
      this.assertSource(); this.verified = true;
      return { ...this.result, canAutoFix: true };
    } catch (error) { this.stopped = true; throw error; }
    finally { this.busy = false; }
  }

  async close() {
    this.stopped = true; this.verified = false;
    const pending = this.pending; this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer); pending.abort.abort();
    // Best-effort invalidation never retries a handoff or hides the original failure.
    await callbackLocal("cancel", pending.ticket).catch(() => {});
  }

  private fingerprint() { return localAccess.sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId); }
  private assertSource() {
    if (this.fingerprint() !== this.source) throw new Error("ASYNC_SOURCE_DRIFT");
  }
}
