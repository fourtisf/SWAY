// PM2 process file for the Hostinger VPS: `pm2 start deploy/ecosystem.config.cjs` from the repo root
// after `pnpm install --frozen-lockfile && pnpm db:deploy && pnpm build`. Env comes from the root .env.
module.exports = {
  apps: [
    {
      name: 'sway-api',
      cwd: 'apps/api',
      script: 'dist/main.js',
      node_args: '--env-file=../../.env',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
    },
    {
      // One process is enough; a second one stands by (the indexer holds a Redis lock).
      name: 'sway-workers',
      cwd: 'apps/workers',
      script: 'dist/main.js',
      node_args: '--env-file=../../.env',
      instances: 1,
      max_memory_restart: '512M',
    },
    {
      name: 'sway-web',
      cwd: 'apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      env: { NODE_ENV: 'production' },
    },
  ],
};
