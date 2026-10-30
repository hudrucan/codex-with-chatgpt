import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { callbackLocal } from "./callback-client.js";
import { sourceFingerprint } from "./source.js";
import { Workspace } from "../workspace/manager.js";
import { auditPayloadSchema, correlationSchema, MAX_AUDIT_MS, type CallbackTicket } from "./protocol.js";

export const sessionOptionsSchema = correlationSchema.pick({ hubId: true, workspaceId: true, taskId: true }).extend({
  workspaceRoot: z.string().min(1),
  timeoutMs: z.number().int().positive().max(MAX_AUDIT_MS).default(MAX_AUDIT_MS),
}).strict();
export type SessionOptions = z.infer<typeof sessionOptionsSchema>;

/** One independently authorized task per terminal process; failed delivery cannot resume. */
export class AuditSession {
  private audits = 0;
  private busy = false;
  private stopped = false;
  private verified = false;
  private source?: string;
  private completedAttempt?: { ticket: CallbackTicket; deadline: number };
  private pending?: { ticket: CallbackTicket; deadline: number; abort: AbortController; timer: ReturnType<typeof setTimeout> };
  readonly options: SessionOptions;

  constructor(input: unknown) {
    this.options = sessionOptionsSchema.parse(input);
    if (new Workspace(this.options.workspaceRoot).id !== this.options.workspaceId)
      throw new Error("ASYNC_SOURCE_WORKSPACE_MISMATCH");
  }

  async prepare(handoff: string) {
    if (this.stopped || this.busy || this.pending || this.audits >= 3 ||
        (this.audits > 0 && !this.verified)) throw new Error("ASYNC_AUDIT_LIMIT");
    if (!handoff.startsWith("[C2C Handoff]\n") || Buffer.byteLength(handoff) > 48 * 1024) throw new Error("ASYNC_HANDOFF_REQUIRED");
    this.busy = true;
    const abort = new AbortController(), deadline = performance.now() + this.options.timeoutMs;
    const expiresAt = Date.now() + this.options.timeoutMs;
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs);
    try {
      // Anchor the handoff before registration; any drift through delivery/wait
      // invalidates the callback instead of adopting a later source snapshot.
      this.source = this.fingerprint();
      if (performance.now() >= deadline) throw new Error("ASYNC_TIMEOUT");
      const { hubId, workspaceId, taskId } = this.options;
      const ticket = await callbackLocal("register", { hubId, workspaceId, taskId, attemptId: randomUUID(),
        handoffId: createHash("sha256").update(handoff).digest("hex"),
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), previousAttempt: this.completedAttempt?.ticket }, abort.signal) as CallbackTicket;
      this.pending = { ticket, deadline, abort, timer };
      if (this.stopped) throw new Error("ASYNC_INTERRUPTED");
      if (abort.signal.aborted || performance.now() >= deadline) throw new Error("ASYNC_TIMEOUT");
      this.audits++; this.verified = false; this.completedAttempt = undefined;
      return { ticket, expiresAt, remainingMs: Math.max(0, Math.floor(deadline - performance.now())) };
    } catch (error) {
      clearTimeout(timer); abort.abort(); await this.close(); throw error;
    } finally { this.busy = false; }
  }

  /** The controller opens one HTTP event wait immediately after emitting the ticket. */
  async wait() {
    const pending = this.pending;
    if (this.stopped || this.busy || !pending) throw new Error("ASYNC_NOT_PENDING");
    this.busy = true;
    try {
      const result = auditPayloadSchema.parse(await callbackLocal("wait", pending.ticket, pending.abort.signal));
      if (pending.abort.signal.aborted || performance.now() >= pending.deadline) throw new Error("ASYNC_TIMEOUT");
      if (this.stopped) throw new Error("ASYNC_INTERRUPTED");
      this.assertSource();
      if (performance.now() >= pending.deadline) throw new Error("ASYNC_TIMEOUT");
      const { capability: _capability, ...identity } = pending.ticket;
      clearTimeout(pending.timer); this.pending = undefined;
      if (result.status !== "FIX" || this.audits >= 3) this.stopped = true;
      else this.completedAttempt = pending;
      return { ...identity, ...result, canContinue: !this.stopped };
    } catch (error) {
      const expired = performance.now() >= pending.deadline, interrupted = this.stopped;
      await this.close();
      throw expired ? new Error("ASYNC_TIMEOUT") : interrupted ? new Error("ASYNC_INTERRUPTED") : error;
    } finally { this.busy = false; }
  }

  async verifySourceForFix() {
    if (this.stopped || this.busy || this.pending || !this.completedAttempt || this.verified)
      throw new Error("ASYNC_FIX_NOT_AVAILABLE");
    this.busy = true;
    try {
      // Close the completed ticket while checking live Hub ownership/permission.
      // A restart, revoked registration or expired capability prevents editing.
      await callbackLocal("cancel", this.completedAttempt.ticket);
      if (this.stopped || performance.now() >= this.completedAttempt.deadline) throw new Error("ASYNC_FIX_NOT_AVAILABLE");
      this.assertSource();
      if (performance.now() >= this.completedAttempt.deadline) throw new Error("ASYNC_FIX_NOT_AVAILABLE");
      this.verified = true;
      return { canAutoFix: true };
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

  private fingerprint() { return sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId); }
  private assertSource() {
    if (this.fingerprint() !== this.source) throw new Error("ASYNC_SOURCE_DRIFT");
  }
}
