// PM2 process file for the VPS: `pm2 startOrReload deploy/ecosystem.config.cjs` from the repo root (deploy/update.sh
// does it after install, migrate and build). Env comes from the root .env.
// Paths are absolute: PM2 resolves node_args from its own working directory, not the app's cwd.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = `--env-file=${path.join(ROOT, '.env')}`;
// Production mode: JSON logs, and dev sign-in stays off even if DEV_AUTH is set.
const env = { NODE_ENV: 'production' };

module.exports = {
  apps: [
    {
      name: 'sway-api',
      cwd: path.join(ROOT, 'apps/api'),
      script: path.join(ROOT, 'apps/api/dist/main.js'),
      node_args: ENV_FILE,
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env,
    },
    {
      // One process is enough; a second one stands by (the indexer holds a Redis lock).
      name: 'sway-workers',
      cwd: path.join(ROOT, 'apps/workers'),
      script: path.join(ROOT, 'apps/workers/dist/main.js'),
      node_args: ENV_FILE,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env,
    },
    {
      name: 'sway-web',
      cwd: path.join(ROOT, 'apps/web'),
      script: path.join(ROOT, 'apps/web/node_modules/next/dist/bin/next'),
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      env,
    },
  ],
};
