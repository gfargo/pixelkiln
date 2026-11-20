import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Many tests start the real CLI through tsx. Each cold start takes about
    // half a second alone, but with every test file running in parallel on a
    // loaded machine one test can take more than vitest's default 5s and fail
    // although nothing is wrong (#302). 30s leaves room for that, and a test
    // that hangs still fails.
    testTimeout: 30_000,
  },
})
