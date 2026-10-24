import { afterEach, expect, it, vi } from "vitest";
import { createBrowserSender, type SendTab } from "../../src/c2c/browser.js";

const projectBase = `https://chatgpt.com/g/g-p-${"a".repeat(32)}-test`;
const project = `${projectBase}/project`;
const conversation = `${projectBase}/c/12345678-abcd`;
function fixture(initial = conversation) {
  let url = initial, draft = "", failPress = false;
  const press = vi.fn(async () => {
    if (failPress) throw new Error("connection lost after keypress");
    draft = "";
    url = url.replace(/\/project\/?$/, "/c/12345678-abcd");
  });
  const fill = vi.fn(async (value: string) => { draft = value; });
  const tab: SendTab = { id: "selected", url: async () => url,
    playwright: { getByRole: () => ({ innerText: async () => draft, fill, press }) } };
  return { tab, press, fill, navigate: (value: string) => { url = value; },
    draft: (value: string) => { draft = value; }, fail: () => { failPress = true; } };
}
const request = { attemptId: "one", message: "handoff with callback ticket", remainingMs: 1000, expiresAt: Date.now() + 60_000 };
afterEach(() => { vi.useRealTimers(); });

it.each([conversation, "https://chatgpt.com/c/12345678-abcd"])("trusts the selected thread %s without Hub/Project resolution", async url => {
  const f = fixture(url), resolve = vi.fn(async () => { throw new Error("must not resolve"); });
  const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
    { composerName: "Observed composer", openProjectThread: async () => { throw new Error("must not open"); } }, resolve);
  await sender.send(request);
  expect(resolve).not.toHaveBeenCalled(); expect(f.press).toHaveBeenCalledExactlyOnceWith("Enter");
  await expect(sender.send(request)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(1);
});

it.each([project, `${project}/`, `https://chatgpt.com/g/g-p-${"a".repeat(32)}/project`])("opens the canonical Project landing URL %s through the owner-scoped resolver", async url => {
  const f = fixture(url), resolve = vi.fn(async () => url), open = vi.fn(async (_url: string) => f.tab);
  const sender = await createBrowserSender({ tabs: { selected: async () => undefined } },
    { composerName: "Observed composer", openProjectThread: open }, resolve);
  await sender.send(request);
  expect(resolve).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledExactlyOnceWith(url);
  await expect(sender.send(request)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  f.navigate(conversation); await sender.send({ ...request, attemptId: "two" });
  expect(f.press).toHaveBeenCalledTimes(2);
});

it.each([
  projectBase, conversation, "not a URL",
  project.replace("https:", "http:"), project.replace("chatgpt.com", "example.com"),
  project.replace("chatgpt.com", "chatgpt.com.example.com"), project.replace("chatgpt.com", "chatgpt.com:8443"),
  project.replace("chatgpt.com", "user:password@chatgpt.com"),
  `${project}?query=1`, `${project}#fragment`, `${project}/settings`,
  project.replace("a".repeat(32), "a".repeat(31)),
  project.replace("/project", "/other/../project"),
])("rejects a foreign or invalid Project URL %s before opening or sending", async url => {
  const f = fixture(), open = vi.fn(async () => f.tab);
  await expect(createBrowserSender({ tabs: { selected: async () => undefined } },
    { composerName: "Observed composer", openProjectThread: open }, async () => url)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled(); expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
});

it.each([
  conversation.replace("a".repeat(32), "b".repeat(32)),
  conversation.replace("chatgpt.com", "example.com"),
])("rejects navigation to a foreign thread %s after opening the Project", async url => {
  const f = fixture(project);
  const sender = await createBrowserSender({ tabs: { selected: async () => undefined } },
    { composerName: "Observed composer", openProjectThread: async () => f.tab }, async () => project);
  f.navigate(url);
  await expect(sender.send(request)).rejects.toThrow("ASYNC_PROJECT_MISMATCH");
  await expect(sender.send({ ...request, attemptId: "two" })).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.fill).not.toHaveBeenCalled(); expect(f.press).not.toHaveBeenCalled();
});

it.each(["uncertain", "draft", "thread", "timeout", "expired envelope"])("stops permanently after %s without sending twice", async kind => {
  const f = fixture();
  const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
    { composerName: "Observed composer", openProjectThread: async () => f.tab }, async () => project);
  if (kind === "uncertain") f.fail();
  if (kind === "draft") f.draft("user text");
  if (kind === "thread") f.navigate("https://chatgpt.com/c/different");
  await expect(sender.send({ ...request, remainingMs: kind === "timeout" ? 0 : 1000,
    expiresAt: kind === "expired envelope" ? Date.now() - 1 : request.expiresAt })).rejects.toThrow();
  await expect(sender.send({ ...request, attemptId: "new" })).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(kind === "uncertain" ? 1 : 0);
});

const localConversation = `${projectBase}/c/local-chatgpt%3Ae8af3401-76ec-4f63-b875-af2295a87db8`;

it.each([localConversation, localConversation.replace(projectBase, "https://chatgpt.com"), project])(
  "waits for the same Project conversation after transient navigation to %s without double-send", async transient => {
    vi.useFakeTimers();
    const f = fixture(project);
    f.press.mockImplementation(async () => {
      f.navigate(transient);
      setTimeout(() => f.navigate(conversation), 250);
    });
    const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
      { composerName: "Observed composer", openProjectThread: async () => f.tab }, async () => project);
    const sending = sender.send({ ...request, expiresAt: Date.now() + 1000 });
    await expect(sender.send({ ...request, attemptId: "concurrent" })).rejects.toThrow("ASYNC_SEND_TERMINAL");
    let sent = false;
    void sending.then(() => { sent = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(sending).resolves.toEqual({ attemptId: "one", sent: true });
    await expect(sender.send(request)).rejects.toThrow("ASYNC_SEND_TERMINAL");
    expect(f.press).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { remainingMs: 50, expiresIn: 60_000, timeout: 50, destination: localConversation },
  { remainingMs: 60_000, expiresIn: 50, timeout: 50, destination: localConversation },
  { remainingMs: 60_000, expiresIn: 60_000, timeout: 10_000, destination: localConversation },
  { remainingMs: 60_000, expiresIn: 60_000, timeout: 10_000, destination: project },
])("times out unresolved cold-path navigation within $timeout ms", async ({ remainingMs, expiresIn, timeout, destination }) => {
  vi.useFakeTimers();
  const f = fixture(project);
  f.press.mockImplementation(async () => { f.navigate(destination); });
  const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
    { composerName: "Observed composer", openProjectThread: async () => f.tab }, async () => project);
  const sending = expect(sender.send({ ...request, remainingMs, expiresAt: Date.now() + expiresIn })).rejects.toThrow("ASYNC_TIMEOUT");
  await vi.advanceTimersByTimeAsync(timeout);
  await sending;
  await expect(sender.send({ ...request, attemptId: "new" })).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(1);
});

it.each([
  conversation.replace("a".repeat(32), "b".repeat(32)),
  localConversation.replace("a".repeat(32), "b".repeat(32)),
  localConversation.replace("chatgpt.com", "example.com"),
  `${localConversation}?query=1`, `${localConversation}#fragment`,
  localConversation.replace("chatgpt.com", "user:password@chatgpt.com"),
  "https://chatgpt.com/c/12345678-abcd",
])("rejects foreign or invalid navigation after a transient URL to %s", async destination => {
  vi.useFakeTimers();
  const f = fixture(project);
  f.press.mockImplementation(async () => {
    f.navigate(localConversation);
    setTimeout(() => f.navigate(destination), 100);
  });
  const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
    { composerName: "Observed composer", openProjectThread: async () => f.tab }, async () => project);
  const sending = expect(sender.send({ ...request, expiresAt: Date.now() + 1000 })).rejects.toThrow("ASYNC_PROJECT_MISMATCH");
  await vi.advanceTimersByTimeAsync(100);
  await sending;
  await expect(sender.send({ ...request, attemptId: "new" })).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(1);
});
