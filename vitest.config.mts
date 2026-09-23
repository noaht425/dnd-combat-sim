import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tools/nlu/extract_vocab.test.ts is a one-off maintenance script (run
    // by hand when retraining the local command-parsing model, via
    // `npx vitest run --config tools/nlu/vitest.config.mts`), not part of
    // the app's test suite.
    include: ["tests/**/*.test.ts"],
    // the default 5s timeout started flaking on CI (not locally) once the roster
    // crossed ~150 templates — a few tests iterate every template x several levels
    // (schema-valid-at-every-level, scenario sweeps, level ladders) and a shared
    // GitHub Actions runner is slower and noisier than a dev machine. This is
    // generous margin over the observed ~5.4s worst case, not a hang-masking bump.
    testTimeout: 20000,
  },
});
