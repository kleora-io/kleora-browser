import { defineConfig } from 'tsup'

// ESM only: the browser package depends on nothing at runtime and targets
// evergreen browsers. No CJS build: a bundler is the
// only consumer, and shipping a second format would only invite a dual
// -package hazard around the error classes' `instanceof` checks.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
