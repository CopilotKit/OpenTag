import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "@copilotkit/channels",
    },
  },
  test: {
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
  },
});
