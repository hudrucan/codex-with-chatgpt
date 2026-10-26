import { z } from "zod";

export const MAX_AUDIT_MS = 600_000;
export const correlationSchema = z.object({
  hubId: z.string().regex(/^hub-[a-f0-9-]{36}$/),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  taskId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  attemptId: z.string().uuid(),
  handoffId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const auditPayloadSchema = z.object({
  status: z.enum(["PASS", "FIX", "BLOCKED", "ERROR"]), complete: z.literal(true),
  summary: z.string().min(1).max(2048),
  findings: z.array(z.object({
    file: z.string().min(1).max(512), line: z.number().int().positive(),
    evidence: z.string().min(1).max(2048), fix: z.string().min(1).max(2048),
  }).strict()).max(20),
}).strict().refine(value => value.status === "FIX" ? value.findings.length > 0 : value.findings.length === 0);
export const callbackTicketSchema = correlationSchema.extend({
  capability: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const callbackSchema = callbackTicketSchema.extend({ result: auditPayloadSchema }).strict()
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 16_384);
export const registerAttemptSchema = correlationSchema.extend({
  timeoutMs: z.number().int().min(1).max(MAX_AUDIT_MS),
}).strict();
export type Correlation = z.infer<typeof correlationSchema>;
export type CallbackTicket = z.infer<typeof callbackTicketSchema>;
export type AuditPayload = z.infer<typeof auditPayloadSchema>;
export type Callback = z.infer<typeof callbackSchema>;
