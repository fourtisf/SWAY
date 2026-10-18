'use client';
import { makeFormat, type Format } from '@sway/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getApi } from './api';
import { DEFAULT_ETH_USD, MOCK } from './env';
import { useConfig } from './queries';
import { useUI } from './store';

/**
 * ETH/USD for display: live `price` socket messages first, then GET /api/price (refreshed every 60s as a
 * fallback while the socket is down), then ConfigDTO.ethUsd.
 */
export function useEthUsd(): number {
  const live = useUI((s) => s.ethUsd);
  const cfg = useConfig().data;
  const polled = useQuery({ queryKey: ['price'], queryFn: () => getApi().price(), enabled: !MOCK, refetchInterval: 60_000, staleTime: 55_000 }).data;
  return live ?? polled?.ethUsd ?? cfg?.ethUsd ?? DEFAULT_ETH_USD;
}

export function useFormat(): Format {
  const ethUsd = useEthUsd();
  return useMemo(() => makeFormat(ethUsd), [ethUsd]);
}
