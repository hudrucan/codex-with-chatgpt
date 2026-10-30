import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrowserSendError, createBrowserSender, type SendTab } from "../../src/c2c/browser.js";

const project = `https://chatgpt.com/g/g-p-${"a".repeat(32)}-test`;
const conversation = `${project}/c/12345678-abcd`;
const handoff = "[C2C Handoff]\nOriginal Unicode handoff: 🪟";
const request = () => ({ ticket: {
  hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "abcdef012345", taskId: "authorized-task",
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", handoffId: createHash("sha256").update(handoff).digest("hex"), capability: "a".repeat(64),
}, remainingMs: 5000, expiresAt: Date.now() + 5000 });
const next = () => ({ ...request(), ticket: { ...request().ticket, attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });

function fixture(initial = conversation) {
  let url = initial, draft = "";
  const press = vi.fn(async () => { draft = ""; });
  const fill = vi.fn(async (value: string) => { draft = value; });
  const innerText = vi.fn(async () => draft), readUrl = vi.fn(async () => url);
  const tab: SendTab = { id: "selected", url: readUrl,
    playwright: { getByRole: vi.fn(() => ({ innerText, fill, press })) } };
  const selected = vi.fn(async () => tab);
  return { tab, browser: { tabs: { selected } }, selected, press, fill, innerText, readUrl,
    navigate: (value: string) => { url = value; }, draft: (value: string) => { draft = value; } };
}

it.each([conversation, "https://chatgpt.com/c/12345678-abcd"])("pins selected thread %s and sends the retained handoff once", async url => {
  const f = fixture(url), sender = await createBrowserSender(f.browser, "Observed composer"), prepared = request();
  await expect(sender.send(prepared, handoff)).resolves.toEqual({ attemptId: prepared.ticket.attemptId, sent: true });
  expect(f.fill).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`${handoff}\n\nC2C_CALLBACK ${JSON.stringify(prepared.ticket)}\n`));
  expect(f.press).toHaveBeenCalledExactlyOnceWith("Enter");
  expect(f.selected).toHaveBeenCalledTimes(1);
  expect(f.readUrl).toHaveBeenCalledTimes(4); // Binding, pre-fill, pre-Enter, delivery confirmation.
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "sent" });
  await expect(sender.send(next(), handoff)).resolves.toMatchObject({ sent: true });
  expect(f.press).toHaveBeenCalledTimes(2);
});

it.each([
  `${project}/project`, `${project}/c/local-chatgpt%3A1234`, "https://chatgpt.com/", "not a URL",
  conversation.replace("https:", "http:"), conversation.replace("chatgpt.com", "example.com"),
  conversation.replace("chatgpt.com", "chatgpt.com.example.com"), conversation.replace("chatgpt.com", "chatgpt.com:8443"),
  conversation.replace("chatgpt.com", "user:password@chatgpt.com"), `${conversation}?query=1`, `${conversation}#fragment`,
])("requires an existing conversation instead of navigating from %s", async url => {
  const f = fixture(url);
  await expect(createBrowserSender(f.browser, "Observed composer")).rejects.toThrow("ASYNC_THREAD_REQUIRED");
  expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
});

it("fails closed without a selected tab", async () => {
  await expect(createBrowserSender(undefined, "Composer")).rejects.toThrow("ASYNC_THREAD_REQUIRED");
  await expect(createBrowserSender({ tabs: { selected: async () => undefined } }, "Composer")).rejects.toThrow("ASYNC_THREAD_REQUIRED");
});

it.each(["draft", "handoff", "ticket hash", "timeout", "expired envelope", "fill", "press", "navigation"])(
  "stops permanently after %s with safe delivery metadata", async phase => {
    const f = fixture(), sender = await createBrowserSender(f.browser, "Composer"), prepared = request();
    const secret = "private transport detail";
    if (phase === "draft") f.draft("user text");
    if (phase === "ticket hash") prepared.ticket.handoffId = "0".repeat(64);
    if (phase === "timeout") prepared.remainingMs = 0;
    if (phase === "expired envelope") prepared.expiresAt = Date.now() - 1;
    if (phase === "fill") f.fill.mockRejectedValueOnce(new Error(secret));
    if (phase === "press") f.press.mockRejectedValueOnce(new Error(secret));
    if (phase === "navigation") f.press.mockImplementationOnce(async () => { f.navigate("https://chatgpt.com/c/abcdef"); });
    const delivery = ["press", "navigation"].includes(phase) ? "uncertain" : "not_sent";
    const error = await sender.send(prepared, phase === "handoff" ? handoff + "changed" : handoff).catch(error => error);
    expect(error).toBeInstanceOf(BrowserSendError); expect(error.delivery).toBe(delivery);
    expect(JSON.stringify(error)).not.toContain(secret);
    await expect(sender.send(next(), handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "not_sent" });
    await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery });
    expect(f.press).toHaveBeenCalledTimes(delivery === "uncertain" ? 1 : 0);
  },
);

it.each(["before send", "during draft read", "during fill"])("rejects changed thread %s before Enter", async phase => {
  const f = fixture(), sender = await createBrowserSender(f.browser, "Composer");
  const navigate = () => f.navigate("https://chatgpt.com/c/abcdef");
  if (phase === "before send") navigate();
  if (phase === "during draft read") f.innerText.mockImplementationOnce(async () => { navigate(); return ""; });
  if (phase === "during fill") f.fill.mockImplementationOnce(async () => { navigate(); });
  await expect(sender.send(request(), handoff)).rejects.toMatchObject({ message: "ASYNC_THREAD_CHANGED", delivery: "not_sent" });
  expect(f.press).not.toHaveBeenCalled();
  expect(f.fill).toHaveBeenCalledTimes(phase === "during fill" ? 1 : 0);
});

it("consumes the sender synchronously before any await to prevent concurrent delivery", async () => {
  const f = fixture(), sender = await createBrowserSender(f.browser, "Composer"), prepared = request();
  const sending = sender.send(prepared, handoff);
  await expect(sender.send(next(), handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  await sending;
  await expect(sender.send(prepared, handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(1);
});
