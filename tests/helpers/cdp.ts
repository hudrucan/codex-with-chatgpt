import vm from "node:vm";
import { vi } from "vitest";

export const chat = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const endpoint = "ws://127.0.0.1:9222/devtools/browser/fixture";

/** Executes the real renderer function against a small DOM/CDP fixture. */
export function cdpFixture() {
  const state = { url: chat, draft: "", composer: true, disabled: false, clicks: 0, fills: 0,
    actions: [] as string[], methods: [] as string[], closedTargets: [] as string[], stall: "", onClick: async (_text: string) => {},
    beforeAction: (_action: string) => {}, afterAction: (_action: string) => {}, completeNavigation: true, afterNavigate: () => {} };
  let socket: FakeSocket;
  let callback = Promise.resolve();
  const editor = { isConnected: true, getClientRects: () => [1], focus: () => {}, get innerText() { return state.draft; } };
  const button = { get disabled() { return state.disabled; }, getClientRects: () => [1],
    click: () => { state.clicks++; callback = state.onClick(state.draft); void callback.catch(() => {}); state.draft = ""; } };
  class FakeSocket extends EventTarget {
    constructor(_endpoint: string) { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    close() { this.dispatchEvent(new Event("close")); }
    send(raw: string) {
      const message = JSON.parse(raw); state.methods.push(message.method);
      void (async () => {
        let result: unknown = {};
        let action: string | undefined;
        if (message.method === "Target.createTarget") result = { targetId: "owned" };
        if (message.method === "Target.attachToTarget") result = { sessionId: "session" };
        if (message.method === "Target.closeTarget") { state.closedTargets.push(message.params.targetId); result = { success: true }; }
        if (message.method === "Page.navigate") {
          result = { loaderId: "navigation" };
          state.url = message.params.url;
          this.emit({ method: "Page.loadEventFired", sessionId: "session" });
          this.emit({ method: "Page.lifecycleEvent", params: { name: "load", loaderId: "blank" }, sessionId: "session" });
          if (state.completeNavigation) this.emit({ method: "Page.lifecycleEvent", params: { name: "load", loaderId: "navigation" }, sessionId: "session" });
        }
        if (message.method === "Runtime.evaluate") {
          const expression = message.params.expression;
          action = /\)\("(ready|fill|send)"/.exec(expression)![1];
          state.actions.push(action); state.beforeAction(action);
          if (state.stall === action) return;
          const url = new URL(state.url);
          const value = await vm.runInNewContext(expression, {
            location: { origin: url.origin, pathname: url.pathname }, setTimeout, clearTimeout, Date,
            document: { documentElement: {}, querySelectorAll: (selector: string) =>
              selector.startsWith("#prompt-textarea") ? state.composer ? [editor] : [] : [button],
            execCommand: (_name: string, _ui: boolean, text: string) => { state.fills++; state.draft = text; return true; } },
            MutationObserver: class { observe() {} disconnect() {} },
          });
          result = { result: { value } };
        }
        this.emit({ id: message.id, result });
        if (message.method === "Page.navigate") state.afterNavigate();
        if (action) state.afterAction(action);
      })();
    }
    emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return { state, disconnect: () => socket.close(), callback: () => callback,
    loaded: () => socket.emit({ method: "Page.lifecycleEvent", params: { name: "load", loaderId: "navigation" }, sessionId: "session" }) };
}
