'use client';
/** A wallet's logo: Sway's bar mark for the Sway wallet, the wallet app's own logo otherwise. */
import type { CSSProperties } from 'react';
import { logoFor, useWalletCatalog, type Logo as LogoT } from '@/lib/wallet/catalog';
import { useExternalWallet } from '@/lib/wallet';
import { Icon, Logo } from '../icons';

export function LogoBox({ logo, size = 40, title }: { logo: LogoT; size?: number; title?: string }) {
  const style: CSSProperties = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  if (logo.kind === 'sway')
    return (
      <span className="wlogo sway" style={style} title={title ?? 'Sway wallet'}>
        <Logo size={Math.round(size * 0.52)} />
      </span>
    );
  if (logo.kind === 'img')
    return (
      <span className="wlogo" style={{ ...style, background: logo.bg }} title={title ?? logo.name}>
        <img src={logo.src} alt={logo.name} draggable={false} />
      </span>
    );
  return (
    <span className="wlogo gen" style={style} title={title ?? logo.name}>
      <Icon name="wallet" size={Math.round(size * 0.5)} />
    </span>
  );
}

/** Logo for a stored connector key ('sway', a wallet app id or an EIP-6963 rdns). */
export function WalletLogo({ connector, kind, size = 40 }: { connector: string | null | undefined; kind?: 'embedded' | 'external'; size?: number }) {
  const apps = useWalletCatalog();
  const detected = useExternalWallet((s) => s.detected);
  return <LogoBox logo={logoFor(connector, apps, detected, kind)} size={size} />;
}
