import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../../src/workspace/manager.js";
import { readWorkspaceImage } from "../../src/workspace/media.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

const previousState = process.env.C2C_STATE_DIR;
let root: string;
let state: string;
let outside: string;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
beforeEach(() => { root = makeTmpDir("image-read"); state = isolateStateDir(); outside = makeTmpDir("outside-image"); });
afterEach(() => {
  [root, state, outside].forEach(cleanup);
  if (previousState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previousState;
});

describe("read-only workspace images", () => {
  it("reads a valid supported image without writing or importing anything", async () => {
    fs.writeFileSync(path.join(root, "pixel.png"), png);
    const before = fs.readdirSync(root);
    const result = await readWorkspaceImage(new Workspace(root), "pixel.png");
    expect(result).toMatchObject({ path: "pixel.png", mimeType: "image/png", sizeBytes: png.length });
    expect(Buffer.from(result.data, "base64")).toEqual(png);
    expect(fs.readdirSync(root)).toEqual(before);
  });

  it("refuses path escapes, symlink escapes and sensitive image paths", async () => {
    fs.writeFileSync(path.join(outside, "secret.png"), png);
    write(root, ".c2cignore", "private.png\n");
    fs.writeFileSync(path.join(root, "private.png"), png);
    const workspace = new Workspace(root);
    await expect(readWorkspaceImage(workspace, path.join(outside, "secret.png"))).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(readWorkspaceImage(workspace, "private.png")).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(root, "escape.png"));
      await expect(readWorkspaceImage(workspace, "escape.png")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    }
  });

  it("rejects invalid signatures, active SVG and oversized images", async () => {
    write(root, "fake.png", "not an image");
    write(root, "active.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    write(root, "external.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private"/></svg>');
    const large = path.join(root, "large.png");
    fs.writeFileSync(large, png); fs.truncateSync(large, 10 * 1024 * 1024 + 1);
    const workspace = new Workspace(root);
    for (const file of ["fake.png", "active.svg", "external.svg"]) {
      await expect(readWorkspaceImage(workspace, file)).rejects.toMatchObject({ code: "BINARY_FILE" });
    }
    await expect(readWorkspaceImage(workspace, "large.png")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
