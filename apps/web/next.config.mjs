import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo keeps one .env at the root (see .env.example). Load it here so API_URL and any NEXT_PUBLIC_*
 * values set there reach the web app. Variables already in the environment win.
 */
const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, '../../.env');
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const API_URL = process.env.API_URL || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Internal packages ship TypeScript source.
  transpilePackages: ['@sway/curve', '@sway/scoring', '@sway/shared'],
  // e2e builds into its own folder so it never clobbers a real build.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: { buildActivity: false },
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  webpack(config) {
    // Optional deps of WalletConnect / MetaMask SDK that are never used in the browser.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    config.resolve.fallback = { ...config.resolve.fallback, '@react-native-async-storage/async-storage': false };
    // @coinbase/cdp-sdk (pulled in by RainbowKit -> wagmi connectors -> @base-org/account) imports its optional
    // x402 peers. They are never used in the browser and are not installed.
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(['@x402/core', '@x402/evm', '@x402/svm', '@x402/extensions', '@x402/express', '@x402/fetch'].map((m) => [m, false])),
    };
    return config;
  },
};

export default nextConfig;
