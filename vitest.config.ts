import { defineConfig } from 'vitest/config'

// The default `node` environment on purpose: the SDK reaches for
// `sessionStorage`, `location` and `document` lazily through `src/browser.ts`,
// so the unit tests install a small fake instead of a whole DOM
// implementation. That keeps the dependency list short and makes every global
// the SDK touches explicit in the test setup.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
