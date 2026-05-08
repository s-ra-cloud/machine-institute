import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
