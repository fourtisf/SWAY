import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// One ESM file for PM2: workspace packages (@sway/*) are bundled from source; npm deps stay external.
// '@prisma/client' is not bundled either: it is aliased to a shim that loads the generated client from
// packages/db at runtime (pnpm does not link it into apps/api).
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@sway\//],
  external: ['pino-pretty'],
  banner: { js: "import { createRequire as __swayCreateRequire } from 'node:module'; const require = __swayCreateRequire(import.meta.url);" },
  esbuildOptions(o) {
    o.alias = { ...(o.alias ?? {}), '@prisma/client': fileURLToPath(new URL('./build/prisma-client-shim.cjs', import.meta.url)) };
  },
});
