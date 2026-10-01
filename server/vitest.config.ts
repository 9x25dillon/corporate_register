import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Postgres contract tests share one database; keep files sequential.
    fileParallelism: false
  }
});
