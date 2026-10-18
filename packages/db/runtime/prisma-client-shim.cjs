// Bundled in place of '@prisma/client' by apps/api and apps/workers (see their tsup.config.ts). pnpm keeps
// @prisma/client and its generated client next to packages/db, so resolve it from there instead of from dist/.
// `require` here is the banner's createRequire(import.meta.url); names are computed so esbuild leaves them.
const { createRequire } = require('node:module');
const PRISMA = ['@prisma', 'client'].join('/');
const DB = ['@sway', 'db'].join('/');
let fromDb = null;
try {
  fromDb = createRequire(require.resolve(DB));
} catch {
  /* fall back to normal resolution */
}
module.exports = fromDb ? fromDb(PRISMA) : require(PRISMA);
