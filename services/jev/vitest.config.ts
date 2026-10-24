import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["services/jev/tests/**/*.test.ts"], testTimeout: 15_000 },
});
