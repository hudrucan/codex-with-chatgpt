// Lexical imports for the sandboxed REPL bundle, never global patches or process shims.
export { performance } from "node:perf_hooks";
export { setTimeout, clearTimeout } from "node:timers";
export { URL } from "node:url";
export { Buffer } from "node:buffer";
