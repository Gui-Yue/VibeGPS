import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "packages/**", ".vibegps/**", "node_modules/**"]
  }
});
