import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/seed-chain.ts', 'src/scripts/open-fan-market.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace packages (TS source); keep Prisma's generated client external.
  noExternal: [/^@sway\//],
  external: ['@prisma/client', '.prisma/client'],
});
