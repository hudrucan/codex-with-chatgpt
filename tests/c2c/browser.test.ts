import { expect, it, vi } from "vitest";
import { createBrowserSender, type SendTab } from "../../src/c2c/browser.js";

const project = `https://chatgpt.com/g/g-p-${"a".repeat(32)}-test`;
const conversation = `${project}/c/12345678-abcd`;
function fixture(initial = conversation) {
  let url = initial, draft = "", failPress = false;
  const press = vi.fn(async () => { if (failPress) throw new Error("connection lost after keypress"); draft = ""; });
  const fill = vi.fn(async (value: string) => { draft = value; });
  const tab: SendTab = { id: "selected", url: async () => url,
    playwright: { getByRole: () => ({ innerText: async () => draft, fill, press }) } };
  return { tab, press, fill, navigate: (value: string) => { url = value; },
    draft: (value: string) => { draft = value; }, fail: () => { failPress = true; } };
}
const request = { attemptId: "one", message: "handoff with callback ticket", remainingMs: 1000, expiresAt: Date.now() + 60_000 };

it("trusts the selected thread without Hub/Project resolution", async () => {
  const f = fixture(), resolve = vi.fn(async () => { throw new Error("must not resolve"); });
  const sender = await createBrowserSender({ tabs: { selected: async () => f.tab } },
    { composerName: "Observed composer", openProjectThread: async () => { throw new Error("must not open"); } }, resolve);
  await sender.send(request);
  expect(resolve).not.toHaveBeenCalled(); expect(f.press).toHaveBeenCalledExactlyOnceWith("Enter");
  await expect(sender.send(request)).rejects.toThrow("ASYNC_SEND_TERMINAL");
  expect(f.press).toHaveBeenCalledTimes(1);
});

it("uses the supplied owner-scoped resolver only to open a new Project thread", async () => {
  const f = fixture(project), resolve = vi.fn(async () => project), open = vi.fn(async (_url: string) => f.tab);
  const sender = await createBrowserSender({ tabs: { selected: async () => undefined } },
    { composerName: "Observed composer", openProjectThread: open }, resolve);
  await sender.send(request);
  expect(resolve).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledExactlyOnceWith(project);
  f.navigate(conversation); await sender.send({ ...request, attemptId: "two" });
  expect(f.press).toHaveBeenCalledTimes(2);
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
