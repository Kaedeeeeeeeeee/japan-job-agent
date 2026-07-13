import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
