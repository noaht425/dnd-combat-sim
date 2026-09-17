import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tools/nlu/extract_vocab.test.ts is a one-off maintenance script (run
    // by hand when retraining the local command-parsing model, via
    // `npx vitest run --config tools/nlu/vitest.config.mts`), not part of
    // the app's test suite.
    include: ["tests/**/*.test.ts"],
  },
});
