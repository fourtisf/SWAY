import type { Config } from 'tailwindcss';

/**
 * The prototype's CSS (src/app/globals.css) is the source of truth for every existing screen. Tailwind is
 * for new UI only, so preflight is off (the prototype ships its own reset) and the colour tokens below
 * mirror the :root variables.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: '#FFFFFF',
        bg2: '#F7F9F9',
        bg3: '#EFF3F4',
        line: '#EFF3F4',
        line2: '#CFD9DE',
        tx: '#0F1419',
        tx2: '#536471',
        tx3: '#536471',
        blue: '#1D9BF0',
        pink: '#F91880',
        aqua: '#00BA7C',
        red: '#F4212E',
        warn: '#A35F00',
        gold: '#E2B719',
        purple: '#7856FF',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { pill: '9999px' },
    },
  },
  plugins: [],
};

export default config;
