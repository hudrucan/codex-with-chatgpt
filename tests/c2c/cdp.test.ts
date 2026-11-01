import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createCdpSender, conversationUrl } from "../../src/c2c/cdp.js";
import { cdpFixture, chat, endpoint } from "../helpers/cdp.js";

const handoff = "[C2C Handoff]\nRepo/revision: fixture.\nChanges: none.\nValidation: fixture.\nRisks: none.";
const request = () => ({ ticket: {
  hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "abcdef012345", taskId: "cdp-task",
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", handoffId: createHash("sha256").update(handoff).digest("hex"), capability: "a".repeat(64),
}, remainingMs: 5000, expiresAt: Date.now() + 5000 });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([chat, chat + "/", chat.split("/").at(-1)!,
  "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-project/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])(
  "accepts only explicit conversation input: %s", input => expect(conversationUrl(input)).toBe(input.endsWith("/") ? chat : input.startsWith("https:") ? input : chat));
it.each(["", "https://chatgpt.com/", chat + "?x=1", chat + "#x", chat.replace("chatgpt.com", "other.com"), "not-an-id"])(
  "rejects invalid target before opening CDP: %s", async input => {
    const construct = vi.fn(); vi.stubGlobal("WebSocket", construct);
    await expect(createCdpSender(input, endpoint)).rejects.toMatchObject({ delivery: "not_sent", message: "ASYNC_THREAD_REQUIRED" });
    expect(construct).not.toHaveBeenCalled();
  });
it.each(["", endpoint.replace("127.0.0.1", "example.com"), endpoint + "?token=secret"])("rejects unsafe endpoint", async value => {
  await expect(createCdpSender(chat, value)).rejects.toMatchObject({ delivery: "not_sent", message: "ASYNC_CDP_ENDPOINT_REQUIRED" });
});

it("pins one explicit tab, fills/clicks once, preserves the complete envelope and blocks replay", async () => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint), prepared = request();
  let submitted = ""; state.onClick = async text => { submitted = text; };
  try {
    await expect(sender.send(prepared, handoff)).resolves.toMatchObject({ sent: true });
    expect(state.actions).toEqual(["ready", "fill", "send"]);
    expect(state.fills).toBe(1); expect(state.clicks).toBe(1);
    expect(state.methods).not.toContain("Target.getTargets");
    expect(JSON.parse(submitted.split("C2C_CALLBACK ")[1].split("\n")[0])).toEqual(prepared.ticket);
    await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "sent" });
    expect(state.clicks).toBe(1);
  } finally { await sender.close(); }
});

it("waits for the requested navigation loader instead of a blank-page load", async () => {
  const { state, loaded } = cdpFixture(); state.completeNavigation = false;
  const navigated = new Promise<void>(resolve => { state.afterNavigate = resolve; });
  const creating = createCdpSender(chat, endpoint);
  await navigated;
  expect(state.actions).toEqual([]);
  loaded();
  const sender = await creating;
  expect(state.actions).toEqual(["ready"]); await sender.close();
});

it.each(["draft", "route", "handoff", "expiry", "draft changed"])("fails closed without a click for %s", async phase => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint), prepared = request();
  if (phase === "draft") state.draft = "User draft";
  if (phase === "route") state.url = chat.replace("aaaaaaaa", "bbbbbbbb");
  if (phase === "expiry") prepared.expiresAt = Date.now() - 1;
  if (phase === "draft changed") state.beforeAction = action => { if (action === "send") state.draft = "User edit"; };
  try {
    await expect(sender.send(prepared, phase === "handoff" ? handoff + "changed" : handoff)).rejects.toHaveProperty("delivery", phase === "draft changed" ? "uncertain" : "not_sent");
    expect(state.clicks).toBe(0);
    if (phase === "draft") expect(state.draft).toBe("User draft");
  } finally { await sender.close(); }
});

it("retains the pin across FIX and accepts a different target only in a new sender", async () => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint);
  await sender.send(request(), handoff);
  const next = request(); next.ticket.attemptId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  state.url = chat.replace("aaaaaaaa", "bbbbbbbb");
  await expect(sender.send(next, handoff)).rejects.toMatchObject({ message: "ASYNC_THREAD_CHANGED", delivery: "not_sent" });
  await sender.close();
  const second = await createCdpSender(state.url, endpoint);
  await second.send(next, handoff); await second.close();
  expect(state.clicks).toBe(2);
});

it("bounds a lost send response by the attempt deadline and never retries", async () => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint), prepared = request();
  vi.useFakeTimers(); state.stall = "send"; prepared.remainingMs = 50;
  const sending = expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_TIMEOUT", delivery: "uncertain" });
  await vi.advanceTimersByTimeAsync(51); await sending;
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "uncertain" });
  expect(state.actions.filter(value => value === "send")).toHaveLength(1);
  await expect(sender.close({ completed: true })).resolves.toEqual({ targetClosed: false });
  expect(state.closedTargets).toEqual([]);
});

it("does not leave a disabled send armed for a later mutation", async () => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint);
  state.disabled = true;
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ message: "ASYNC_COMPOSER_UNAVAILABLE", delivery: "uncertain" });
  state.disabled = false;
  expect(state.clicks).toBe(0); await sender.close();
});

it.each(["idle", "completed", "unconfirmed", "user draft"])("cleans only its safe owned target on task exit: %s", async phase => {
  const { state } = cdpFixture(), sender = await createCdpSender(chat, endpoint);
  if (phase !== "idle") await sender.send(request(), handoff);
  if (phase === "user draft") state.draft = "User draft after callback";
  const closing = sender.close({ completed: phase !== "unconfirmed" });
  expect(sender.close({ completed: true })).toBe(closing);
  const safe = phase === "idle" || phase === "completed";
  await expect(closing).resolves.toEqual({ targetClosed: safe });
  expect(state.closedTargets).toEqual(safe ? ["owned"] : []);
  if (phase === "user draft") expect(state.draft).toBe("User draft after callback");
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL" });
});

it("fails closed on login redirects and preserves pre-existing drafts before prepare", async () => {
  const { state } = cdpFixture();
  state.beforeAction = () => { state.url = "https://chatgpt.com/auth/login"; };
  await expect(createCdpSender(chat, endpoint)).rejects.toMatchObject({ message: "ASYNC_THREAD_CHANGED", delivery: "not_sent" });
  state.beforeAction = () => {}; state.draft = "Existing user draft";
  await expect(createCdpSender(chat, endpoint)).rejects.toMatchObject({ message: "ASYNC_DRAFT_PRESENT", delivery: "not_sent" });
  expect(state.draft).toBe("Existing user draft"); expect(state.fills).toBe(0);
});
