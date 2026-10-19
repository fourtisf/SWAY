/** [B] Share card metadata: X unfurls /card/:handle with the OG image next to this file. */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { makeFormat } from '@sway/shared';
import { fetchCard, siteUrl } from '@/lib/card-server';

export async function generateMetadata({ params }: { params: { handle: string } }): Promise<Metadata> {
  const c = await fetchCard(params.handle);
  const F = makeFormat(3420);
  const title = c ? `${c.name} (@${c.handle}) on Sway` : 'Sway card';
  const description = c
    ? `Sway score ${c.score}/100 · reach value ${F.usd(c.reachValue)} · ${c.tier}. Buy a key to join the room.`
    : 'Every X account gets a public reach score and a creator-key market on Robinhood Chain.';
  const url = `/card/${c?.handle ?? params.handle}`;
  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: 'Sway', type: 'profile' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default function CardLayout({ children }: { children: ReactNode }) {
  return children;
}
