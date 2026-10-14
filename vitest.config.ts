import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["server/**/*.test.ts", "client/**/*.test.ts"],
    environment: "node",
    // Route suites import the full server graph (routes.ts) inside beforeAll and
    // a few suites spawn real subprocesses. Alone they finish in ~1 s, but with
    // every worker transforming files at once they routinely exceed the 10 s /
    // 5 s defaults in this container. The limits only bound genuine hangs.
    hookTimeout: 90_000,
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
