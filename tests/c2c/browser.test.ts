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
  expect(f.readUrl).toHaveBeenCalledTimes(5); // Binding/composer verification, pre-fill, pre-Enter, confirmation.
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

it.each(["selection", "URL", "composer"])("reports stale %s access before prepare without attempting recovery", async phase => {
  const f = fixture(), stale = new Error("browser.user is unavailable.");
  if (phase === "selection") f.selected.mockRejectedValue(stale);
  if (phase === "URL") f.readUrl.mockRejectedValue(stale);
  if (phase === "composer") f.innerText.mockRejectedValue(stale);
  const bind = vi.fn(async () => f.browser);
  await expect(createBrowserSender(bind, "Composer")).rejects.toMatchObject({
    message: "ASYNC_BROWSER_BINDING_STALE", delivery: "not_sent",
  });
  expect(bind).toHaveBeenCalledTimes(1);
  expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
});

it.each(["draft", "missing composer", "changed thread"])("checks %s before the caller can prepare", async phase => {
  const f = fixture();
  if (phase === "draft") f.draft("keep my draft");
  if (phase === "missing composer") f.innerText.mockRejectedValue(new Error("private locator details"));
  if (phase === "changed thread") f.innerText.mockImplementationOnce(async () => {
    f.navigate("https://chatgpt.com/c/abcdef"); return "";
  });
  await expect(createBrowserSender(f.browser, "Composer")).rejects.toMatchObject({
    message: { draft: "ASYNC_DRAFT_PRESENT", "missing composer": "ASYNC_COMPOSER_UNAVAILABLE", "changed thread": "ASYNC_THREAD_CHANGED" }[phase],
    delivery: "not_sent",
  });
  expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
  if (phase === "draft") expect(await f.innerText()).toBe("keep my draft");
});

it("rebinds the same tab across turns while retaining duplicate-send protection", async () => {
  const old = fixture(), fresh = fixture();
  let current = old.browser;
  const bind = vi.fn(async () => current);
  const sender = await createBrowserSender(bind, "Composer"), prepared = request();
  await sender.send(prepared, handoff);
  // A later host turn exposes the same tab through new handles; the old ones no longer work.
  old.readUrl.mockRejectedValue(new Error("browser.user is unavailable"));
  old.innerText.mockRejectedValue(new Error("browser.user is unavailable"));
  current = fresh.browser;
  await sender.verifyBinding();
  await expect(sender.send(prepared, handoff)).rejects.toMatchObject({ message: "ASYNC_SEND_TERMINAL", delivery: "sent" });
  await expect(sender.send(next(), handoff)).resolves.toMatchObject({ sent: true });
  expect(bind).toHaveBeenCalledTimes(2);
  expect(old.press).toHaveBeenCalledTimes(1); expect(fresh.press).toHaveBeenCalledTimes(1);
});

it.each(["tab", "conversation", "project route", "browser"])("rejects a changed %s during rebind without touching its draft", async phase => {
  const f = fixture(), other = fixture();
  let browser = { ...f.browser, browserId: "owned-browser" };
  const sender = await createBrowserSender(async () => browser, "Composer");
  other.draft("keep other tab draft");
  if (phase === "tab") other.tab.id = "other-tab";
  if (phase === "conversation") other.navigate("https://chatgpt.com/c/abcdef");
  if (phase === "project route") other.navigate("https://chatgpt.com/c/12345678-abcd");
  browser = { ...other.browser, browserId: phase === "browser" ? "other-browser" : "owned-browser" };
  await expect(sender.verifyBinding()).rejects.toMatchObject({ message: "ASYNC_THREAD_CHANGED", delivery: "not_sent" });
  await expect(sender.send(request(), handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(other.innerText).not.toHaveBeenCalled();
  expect(await other.innerText()).toBe("keep other tab draft");
  expect(f.fill).not.toHaveBeenCalled(); expect(other.fill).not.toHaveBeenCalled();
  expect(f.press).not.toHaveBeenCalled(); expect(other.press).not.toHaveBeenCalled();
});

it.each(["stale", "missing browser", "failed host recovery", "draft"])("stops on %s before the next prepare without another bind or send", async phase => {
  const f = fixture();
  const bind = vi.fn<() => Promise<typeof f.browser | undefined>>().mockResolvedValue(f.browser);
  const sender = await createBrowserSender(bind, "Composer");
  if (phase === "stale") f.readUrl.mockRejectedValue(new Error("browser.user is unavailable"));
  if (phase === "missing browser") bind.mockResolvedValue(undefined);
  if (phase === "failed host recovery") bind.mockRejectedValue(new Error("private host recovery failure"));
  if (phase === "draft") f.draft("keep my new draft");
  const code = { stale: "ASYNC_BROWSER_BINDING_STALE", "missing browser": "ASYNC_THREAD_REQUIRED", "failed host recovery": "ASYNC_BROWSER_UNAVAILABLE", draft: "ASYNC_DRAFT_PRESENT" }[phase];
  await expect(sender.verifyBinding()).rejects.toMatchObject({ message: code, delivery: "not_sent" });
  await expect(sender.verifyBinding()).rejects.toThrow("ASYNC_SEND_TERMINAL");
  await expect(sender.send(request(), handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(bind).toHaveBeenCalledTimes(2);
  expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
  if (phase === "draft") expect(await f.innerText()).toBe("keep my new draft");
});

it("blocks sending and a second rebind while fresh handles are being verified", async () => {
  const f = fixture(), sender = await createBrowserSender(async () => f.browser, "Composer");
  let release!: (value: string) => void;
  f.innerText.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const verifying = sender.verifyBinding();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(sender.send(request(), handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  await expect(sender.verifyBinding()).rejects.toThrow("ASYNC_SEND_TERMINAL");
  release(""); await verifying;
  await sender.send(request(), handoff);
  expect(f.press).toHaveBeenCalledTimes(1);
});

it("never rebinds or recovers while a send is active or after an uncertain delivery", async () => {
  const f = fixture(), bind = vi.fn(async () => f.browser);
  const sender = await createBrowserSender(bind, "Composer");
  f.press.mockRejectedValueOnce(new Error("browser.user is unavailable"));
  const sending = sender.send(request(), handoff);
  await expect(sender.verifyBinding()).rejects.toThrow("ASYNC_SEND_TERMINAL");
  await expect(sending).rejects.toMatchObject({ delivery: "uncertain" });
  await expect(sender.verifyBinding()).rejects.toThrow("ASYNC_SEND_TERMINAL");
  await expect(sender.send(next(), handoff)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(bind).toHaveBeenCalledTimes(1); expect(f.press).toHaveBeenCalledTimes(1);
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
