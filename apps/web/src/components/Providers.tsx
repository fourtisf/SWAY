'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import { ApiRequestError } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { useConfig } from '@/lib/queries';

// wagmi + RainbowKit only load in real mode.
const ExternalWalletRoot = dynamic(() => import('@/lib/wallet/external'), { ssr: false });

function ExternalWallets() {
  const cfg = useConfig().data;
  return cfg ? <ExternalWalletRoot config={cfg} /> : null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: MOCK ? 0 : 15_000,
            refetchOnWindowFocus: !MOCK,
            retry: (n, e) => !(e instanceof ApiRequestError && e.status >= 400 && e.status < 500) && n < 2,
            retryDelay: (n) => Math.min(10_000, 1000 * 2 ** n),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      {children}
      {!MOCK && <ExternalWallets />}
    </QueryClientProvider>
  );
}
