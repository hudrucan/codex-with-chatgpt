import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createHttpSender, HttpPreparationError, HttpSendError, type HttpConversation, type PreparedHttpRequest } from "../../src/c2c/http.js";

const conversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const handoff = "[C2C Handoff]\nNo code changes.";
const request = () => ({ ticket: {
  hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "abcdef012345", taskId: "http-task",
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", handoffId: createHash("sha256").update(handoff).digest("hex"), capability: "a".repeat(64),
}, remainingMs: 5000, expiresAt: Date.now() + 5000 });

function fixture() {
  let snapshot: HttpConversation = { conversationId, parentMessageId: "parent", messages: [] };
  let message = "";
  const release = vi.fn(async (_signal: AbortSignal) => ({ aborted: true as const, browserStopped: true as const }));
  const prepare = vi.fn(async (text: string): Promise<PreparedHttpRequest> => {
    message = text;
    return { url: "https://chatgpt.com/backend-api/f/conversation", headers: { authorization: "Bearer test-only" },
      body: JSON.stringify({ action: "next", conversation_id: conversationId, parent_message_id: "parent",
        messages: [{ id: "message", author: { role: "user" }, content: { parts: [text] } }] }), release };
  });
  const readConversation = vi.fn(async () => snapshot);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    snapshot = { conversationId, parentMessageId: "assistant", messages: [{ id: "message", role: "user", text: message }] };
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const options = { transport: "http" as const, hubId: request().ticket.hubId, workspaceId: request().ticket.workspaceId,
    conversationId, readConversation, prepare, fetch };
  return { options, prepare, release, fetch, readConversation, snapshot: (value: Partial<HttpConversation>) => { snapshot = { ...snapshot, ...value }; } };
}

it("requires explicit HTTP opt-in, pins identity, releases preparation and confirms persisted delivery", async () => {
  const f = fixture(), prepared = request();
  const sender = await createHttpSender(f.options);
  expect(await sender.send(prepared, handoff)).toEqual({ attemptId: prepared.ticket.attemptId, sent: true });
  expect(f.prepare.mock.calls[0][0]).toContain(`C2C_CALLBACK ${JSON.stringify(prepared.ticket)}`);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.release.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]);
  expect(f.fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery: "sent", message: "ASYNC_SEND_TERMINAL" });
});

it.each(["wrong identity", "stale parent", "callback mismatch", "handoff mismatch", "expired", "auth expiry"])("does not send on %s", async kind => {
  const f = fixture(), sender = await createHttpSender(f.options), prepared = request();
  if (kind === "wrong identity") f.snapshot({ conversationId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" });
  if (kind === "stale parent") f.snapshot({ parentMessageId: "changed" });
  if (kind === "callback mismatch") prepared.ticket.workspaceId = "bbbbbbbbbbbb";
  if (kind === "handoff mismatch") prepared.ticket.handoffId = "b".repeat(64);
  if (kind === "expired") prepared.expiresAt = Date.now() - 1;
  if (kind === "auth expiry") f.readConversation.mockRejectedValue(new HttpSendError("ASYNC_HTTP_AUTH_REQUIRED", "not_sent"));
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery: "not_sent" });
  expect(f.fetch).not.toHaveBeenCalled();
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL" });
});

it.each(["URL", "conversation", "parent", "text"])("rejects a prepared packet with a changed %s", async field => {
  const f = fixture(), original = f.options.prepare;
  f.options.prepare = vi.fn(async text => {
    const packet = await original(text), body = JSON.parse(packet.body);
    if (field === "URL") packet.url = "https://example.com/credential-collector";
    if (field === "conversation") body.conversation_id = "other";
    if (field === "parent") body.parent_message_id = "other";
    if (field === "text") body.messages[0].content.parts = ["changed"];
    packet.body = JSON.stringify(body); return packet;
  });
  const sender = await createHttpSender(f.options);
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ delivery: "not_sent", message: "ASYNC_HTTP_REQUEST_INVALID" });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});

it.each(["network", "401", "403", "challenge", "missing message", "lost body"])("never retries an ambiguous or rejected POST: %s", async kind => {
  const f = fixture();
  if (kind === "network") f.fetch.mockRejectedValue(new Error("secret transport details"));
  if (kind === "401" || kind === "403") f.fetch.mockResolvedValue(new Response(null, { status: Number(kind) }));
  if (kind === "challenge") f.fetch.mockResolvedValue(new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } }));
  if (kind === "missing message") f.fetch.mockResolvedValue(new Response("data: [DONE]\n\n"));
  if (kind === "lost body") f.fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private")); } })));
  const sender = await createHttpSender(f.options), prepared = request();
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery: "uncertain" });
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "uncertain" });
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("stops uncertain if release fails before aborting an armed browser POST", async () => {
  const f = fixture(); f.release.mockRejectedValue(new Error("private session"));
  const sender = await createHttpSender(f.options), prepared = request();
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_HTTP_RELEASE_UNCONFIRMED", delivery: "uncertain" });
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "uncertain" });
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
});

it.each([false, true])("requires an explicit abort guarantee when preparation throws (confirmed=%s)", async confirmed => {
  const f = fixture();
  let armed = false;
  f.prepare.mockImplementation(async () => {
    armed = true;
    if (confirmed) { armed = false; throw new HttpPreparationError(); }
    throw new Error("failed after arming; private transport details");
  });
  const sender = await createHttpSender(f.options), prepared = request();
  const delivery = confirmed ? "not_sent" : "uncertain";
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery,
    message: confirmed ? "ASYNC_HTTP_PREPARATION_FAILED" : "ASYNC_HTTP_PREPARATION_UNCONFIRMED" });
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery, message: "ASYNC_SEND_TERMINAL" });
  expect(armed).toBe(!confirmed);
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});

it("bounds a hanging release by the attempt deadline and ignores a late acknowledgement", async () => {
  const f = fixture();
  let confirm!: (value: { aborted: true; browserStopped: true }) => void;
  f.release.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  const sender = await createHttpSender(f.options), prepared = request();
  prepared.remainingMs = 50; prepared.expiresAt = Date.now() + 50;
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery: "uncertain", message: "ASYNC_HTTP_RELEASE_UNCONFIRMED" });
  expect(f.release.mock.calls[0][0].aborted).toBe(true);
  confirm({ aborted: true, browserStopped: true });
  await Promise.resolve();
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ delivery: "uncertain", message: "ASYNC_SEND_TERMINAL" });
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
});

it.each([undefined, { aborted: true, browserStopped: false }])("requires an explicit completed release confirmation: %j", async confirmation => {
  const f = fixture(); f.release.mockResolvedValue(confirmation as never);
  const sender = await createHttpSender(f.options);
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ message: "ASYNC_HTTP_RELEASE_UNCONFIRMED", delivery: "uncertain" });
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
});

it("does not report not_sent when cleanup of an invalid staged packet fails", async () => {
  const f = fixture(), original = f.options.prepare;
  f.options.prepare = vi.fn(async text => ({ ...await original(text), url: "https://example.com/invalid" }));
  f.release.mockRejectedValue(new Error("abort not acknowledged"));
  const sender = await createHttpSender(f.options);
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ message: "ASYNC_HTTP_RELEASE_UNCONFIRMED", delivery: "uncertain" });
  expect(f.release).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects opt-out configuration and wrong identity before controller registration", async () => {
  const f = fixture();
  await expect(createHttpSender({ ...f.options, transport: "browser" as "http" })).rejects.toThrow("ASYNC_HTTP_CONFIGURATION_REQUIRED");
  f.snapshot({ conversationId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" });
  await expect(createHttpSender(f.options)).rejects.toThrow("ASYNC_THREAD_CHANGED");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});
