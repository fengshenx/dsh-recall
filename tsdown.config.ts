import { defineConfig } from 'tsdown'

/**
 * Bundle the two host entry points to `lib/` (ESM, Node). Type declarations
 * are emitted separately by `tsc` into `lib/types/` (see package.json build).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
})
