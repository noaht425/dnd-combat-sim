import { defineConfig } from "vitest/config";

// separate config for tools/nlu's one-off maintenance script, kept out of
// the app's default `npx vitest run` (see ../../vitest.config.mts). Run with:
//   npx vitest run --config tools/nlu/vitest.config.mts
// include is relative to the CWD the command is run from (repo root), not
// this config file's own directory.
export default defineConfig({
  test: {
    include: ["tools/nlu/*.test.ts"],
  },
});
