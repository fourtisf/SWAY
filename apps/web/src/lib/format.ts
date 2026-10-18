'use client';
import { makeFormat, type Format } from '@sway/shared';
import { useMemo } from 'react';
import { DEFAULT_ETH_USD } from './env';
import { useConfig } from './queries';
import { useUI } from './store';

/** makeFormat(ethUsd) with ethUsd from /api/config, overridden by live `price` socket messages. */
export function useEthUsd(): number {
  const live = useUI((s) => s.ethUsd);
  const cfg = useConfig().data;
  return live ?? cfg?.ethUsd ?? DEFAULT_ETH_USD;
}

export function useFormat(): Format {
  const ethUsd = useEthUsd();
  return useMemo(() => makeFormat(ethUsd), [ethUsd]);
}
