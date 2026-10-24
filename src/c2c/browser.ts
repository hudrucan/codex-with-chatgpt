// Structural subset of the supported in-app browser API. No network or result reader.
interface Composer {
  innerText(): Promise<string>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
}
export interface SendTab {
  id: string;
  url(): Promise<string | undefined>;
  playwright: { getByRole(role: string, options: { name: string; exact: boolean }): Composer };
}
interface Browser { tabs: { selected(): Promise<SendTab | undefined> } }
interface SendUI { composerName: string; openProjectThread(projectUrl: string): Promise<SendTab> }

function thread(value: string | undefined) {
  if (!value) return;
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || url.search || url.hash || url.username || url.password) return;
  return url.pathname.match(/^(?:\/g\/g-p-[a-f0-9]{32}(?:-[a-z0-9-]+)?)?\/c\/([a-f0-9-]+)\/?$/)?.[1];
}

/** Trust an existing selected conversation; resolve the owner-scoped Project only on the cold path. */
export async function createBrowserSender(browser: Browser, ui: SendUI, resolveProject: () => Promise<string>) {
  let tab = await browser.tabs.selected(), identity = tab && thread(await tab.url());
  let projectUrl: string | undefined, projectPath: string | undefined;
  if (!identity) {
    projectUrl = await resolveProject();
    const url = new URL(projectUrl);
    projectPath = url.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?\/project\/?$/)?.[1];
    if (url.origin !== "https://chatgpt.com" || !projectPath || url.search || url.hash || url.username || url.password || projectUrl !== url.href)
      throw new Error("ASYNC_PROJECT_MISMATCH");
    tab = await ui.openProjectThread(projectUrl);
  }
  const selected = tab!;
  const used = new Set<string>();
  let stopped = false;
  const assertThread = async (allowPending = false) => {
    const value = await selected.url(), current = thread(value);
    if (identity) {
      if (current !== identity) throw new Error("ASYNC_THREAD_CHANGED");
    } else if (projectUrl) {
      const url = value && new URL(value), path = url && url.pathname;
      if (current && (path?.startsWith(`/g/${projectPath}-`) || path?.startsWith(`/g/${projectPath}/`))) identity = current;
      else if (value !== projectUrl) {
        const pending = path && path.match(/^\/(?:g\/(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?\/)?c\/local-chatgpt%3A[a-f0-9-]+\/?$/);
        if (!allowPending || !url || url.origin !== "https://chatgpt.com" || url.search || url.hash || url.username || url.password ||
            !pending || (pending[1] && pending[1] !== projectPath)) throw new Error("ASYNC_PROJECT_MISMATCH");
      }
    }
    return !!identity;
  };
  await assertThread();
  return {
    async send(request: { attemptId: string; message: string; remainingMs: number; expiresAt: number }) {
      if (stopped || used.has(request.attemptId)) throw new Error("ASYNC_SEND_TERMINAL");
      // Even an interrupted fill/press consumes this sender: no uncertain-send retry.
      used.add(request.attemptId); stopped = true;
      if (!Number.isFinite(request.expiresAt) || !Number.isFinite(request.remainingMs)) throw new Error("ASYNC_TIMEOUT");
      const deadline = performance.now() + Math.min(request.remainingMs, request.expiresAt - Date.now());
      const check = async (allowPending = false, limit = deadline) => {
        if (performance.now() >= limit) throw new Error("ASYNC_TIMEOUT");
        const ready = await assertThread(allowPending);
        if (performance.now() >= limit) throw new Error("ASYNC_TIMEOUT");
        return ready;
      };
      await check();
      const composer = selected.playwright.getByRole("textbox", { name: ui.composerName, exact: true });
      if ((await composer.innerText()).trim()) throw new Error("ASYNC_DRAFT_PRESENT");
      await check(); await composer.fill(request.message);
      await check(); await composer.press("Enter");
      // ChatGPT may publish a local URL before assigning the Project conversation ID.
      const navigationDeadline = Math.min(deadline, performance.now() + 10_000);
      while (!await check(true, navigationDeadline)) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, navigationDeadline - performance.now())));
      }
      stopped = false;
      return { attemptId: request.attemptId, sent: true };
    },
  };
}
