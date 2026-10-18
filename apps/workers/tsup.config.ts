import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// ESM bundles for PM2: workspace packages (@sway/*) are bundled from source; npm deps stay external.
// '@prisma/client' is aliased to a shim that loads the generated client from packages/db at runtime
// (pnpm does not link it into apps/workers).
export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/seed-chain.ts', 'src/scripts/open-fan-market.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@sway\//],
  banner: {
    js: "import { createRequire as __swayCreateRequire } from 'node:module'; const require = __swayCreateRequire(import.meta.url);",
  },
  esbuildOptions(o) {
    o.alias = {
      ...(o.alias ?? {}),
      '@prisma/client': fileURLToPath(new URL('../../packages/db/runtime/prisma-client-shim.cjs', import.meta.url)),
    };
  },
});
