import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["server/**/*.test.ts", "client/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
