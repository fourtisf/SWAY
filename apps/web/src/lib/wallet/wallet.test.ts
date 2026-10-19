/** [A] Picker, logos, active-wallet choice, key import parsing, and several wallets in mock mode. */
import { quoteWei } from '@sway/curve';
import { MAX_LINKED_WALLETS, WALLET_APPS } from '@sway/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { getMockApi, getWorld } from '../mock';
import { resolveActive } from './active';
import { burnerAddress, parsePrivateKey } from './burner';
import { appOf, installUrl, loadCatalog, logoFor, pickerEntries, walletName, type PickerEnv, type WalletMeta } from './catalog';
import { mockWallet } from './mock';

const desktop: PickerEnv = { mobile: false, walletConnect: false, browser: 'chrome', legacyInjected: false };

describe('wallet catalog (RainbowKit metadata)', () => {
  it('loads a name and a bundled data: logo for every curated wallet', async () => {
    const apps = await loadCatalog();
    for (const id of WALLET_APPS) {
      expect(apps[id].name.length).toBeGreaterThan(2);
      expect(apps[id].icon, id).toMatch(/^data:image\//);
    }
    expect(apps.metaMask.rdns).toBe('io.metamask');
    expect(apps.rabby.downloadUrls.chrome).toMatch(/^https:\/\/chrome\.google\.com\//);
  });

  it('maps stored connector keys (ids, aliases, rdns) to logos', async () => {
    const apps = await loadCatalog();
    expect(appOf('coinbase', apps)).toBe('coinbaseWallet');
    expect(appOf('io.metamask', apps)).toBe('metaMask');
    expect(logoFor('sway', apps)).toEqual({ kind: 'sway' });
    expect(logoFor(null, apps, [], 'embedded')).toEqual({ kind: 'sway' });
    expect(logoFor('rabby', apps)).toMatchObject({ kind: 'img', name: 'Rabby', src: apps.rabby.icon });
    // An EIP-6963 wallet we don't curate: its announced icon, or a generic mark when it isn't here.
    const det = [{ rdns: 'xyz.frame', name: 'Frame', icon: 'data:image/svg+xml,<svg/>' }];
    expect(logoFor('xyz.frame', apps, det)).toMatchObject({ kind: 'img', src: det[0]!.icon, name: 'Frame' });
    expect(logoFor('xyz.frame', apps)).toMatchObject({ kind: 'generic' });
    expect(walletName('io.rabby', apps)).toBe('Rabby');
  });
});

describe('picker entries', () => {
  const meta = (id: string, rdns: string | null, extra: Partial<WalletMeta> = {}): WalletMeta =>
    ({ id, name: id, rdns, icon: `data:image/png;base64,${id}`, iconBackground: '#fff', downloadUrls: { chrome: `https://chrome/${id}`, ios: `https://ios/${id}`, android: `https://android/${id}`, mobile: `https://m/${id}` }, mobileUri: null, qrUri: null, ...extra }) as WalletMeta;
  const apps = Object.fromEntries(WALLET_APPS.map((id) => [id, meta(id, id === 'metaMask' ? 'io.metamask' : id === 'rabby' ? 'io.rabby' : null)]));

  it('lists detected wallets first with their own icon, without duplicating curated ones', () => {
    const list = pickerEntries(apps, [{ rdns: 'io.metamask', name: 'MetaMask', icon: 'data:announced' }, { rdns: 'xyz.frame', name: 'Frame', icon: null }], desktop);
    expect(list.slice(0, 2).map((e) => [e.connector, e.tag, e.icon])).toEqual([
      ['metaMask', 'Detected', 'data:announced'],
      ['xyz.frame', 'Detected', null],
    ]);
    expect(list.filter((e) => e.connector === 'metaMask')).toHaveLength(1);
    expect(list.map((e) => e.connector)).toEqual(expect.arrayContaining([...WALLET_APPS]));
    expect(list.find((e) => e.connector === 'metaMask')!.action).toEqual({ via: 'injected', rdns: 'io.metamask' });
  });

  it('offers Install without WalletConnect, QR with it, and keeps Coinbase connectable', () => {
    const off = pickerEntries(apps, [], desktop);
    expect(off.find((e) => e.connector === 'rabby')).toMatchObject({ tag: 'Install', action: { via: 'install', url: 'https://chrome/rabby' } });
    expect(off.find((e) => e.connector === 'walletConnect')!.action).toMatchObject({ via: 'disabled' });
    expect(off.find((e) => e.connector === 'coinbaseWallet')!.action).toEqual({ via: 'coinbaseWallet' });
    const on = pickerEntries(apps, [], { ...desktop, walletConnect: true });
    expect(on.find((e) => e.connector === 'walletConnect')!.action).toEqual({ via: 'walletConnect', app: null });
    expect(on.find((e) => e.connector === 'zerion')!.action).toEqual({ via: 'walletConnect', app: 'zerion' });
  });

  it('deep links on mobile through WalletConnect, or sends to the app store without it', () => {
    const mob = pickerEntries(apps, [], { ...desktop, mobile: true, walletConnect: true });
    expect(mob.find((e) => e.connector === 'rainbow')!.action).toEqual({ via: 'walletConnect', app: 'rainbow' });
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    const store = pickerEntries(apps, [], { ...desktop, mobile: true }, iphone);
    expect(store.find((e) => e.connector === 'trust')!.action).toEqual({ via: 'install', url: 'https://ios/trust' });
    expect(installUrl(apps.okx as WalletMeta, { mobile: false, browser: 'other' })).toBe('https://m/okx');
  });

  it('shows a plain browser wallet when window.ethereum exists without EIP-6963', () => {
    const list = pickerEntries(apps, [], { ...desktop, legacyInjected: true });
    expect(list[0]).toMatchObject({ connector: 'injected', tag: 'Detected', action: { via: 'injected', rdns: null } });
  });
});

describe('active wallet', () => {
  const ws = [
    { address: '0xAAA', usable: false },
    { address: '0xbbb', usable: true },
    { address: '0xccc', usable: true },
  ];
  it('keeps the stored choice when usable, else falls back to the first usable wallet', () => {
    expect(resolveActive(ws, '0xccc')!.address).toBe('0xccc');
    expect(resolveActive(ws, '0xaaa')!.address).toBe('0xbbb');
    expect(resolveActive(ws, null)!.address).toBe('0xbbb');
    expect(resolveActive(ws, '0xnope')!.address).toBe('0xbbb');
    expect(resolveActive([{ address: '0xAAA', usable: false }], '0xaaa')!.address).toBe('0xAAA');
    expect(resolveActive([], null)).toBeNull();
  });
});

describe('Sway wallet keys', () => {
  it('accepts a pasted key with or without 0x and spaces, and rejects anything else', () => {
    const pk = generatePrivateKey();
    expect(parsePrivateKey(`  ${pk.slice(2).toUpperCase()}\n`)).toBe(pk.toLowerCase());
    expect(burnerAddress(parsePrivateKey(pk)!)).toBe(privateKeyToAccount(pk).address);
    expect(parsePrivateKey('0x1234')).toBeNull();
    expect(parsePrivateKey('0x' + 'g'.repeat(64))).toBeNull();
    expect(parsePrivateKey('0x' + '0'.repeat(64))).toBeNull();
  });
});

describe('mock mode with several wallets', () => {
  it('links wallets with logos, trades from the second one and sums everything', async () => {
    const api = getMockApi();
    const w = getWorld();
    const me = await api.devLogin({ handle: 'multimock', followers: 1000 });
    const second = privateKeyToAccount(generatePrivateKey()).address;
    const after = await api.walletsLink({ address: second, signature: '0x00', connector: 'rabby' });
    expect(after.wallets!.map((x) => [x.account, x.connector])).toEqual([
      [true, 'sway'],
      [false, 'rabby'],
    ]);
    const before = await api.wallets();
    const cash2 = BigInt(before.wallets[1]!.cashWei);
    expect(cash2 > 0n).toBe(true);

    const p = await api.profile('novareyes');
    const q = quoteWei(BigInt(p.supplyUnits), 'buy', 100n, { level: me.stakingLevel });
    const sw = mockWallet(second, 'external');
    await sw.buy(p.subject, 100n, q.total);
    const p2 = await api.profile('novareyes');
    expect(p2.heldUnits).toBe('100');
    expect(p2.heldBy).toEqual([{ address: second.toLowerCase(), units: '100' }]);
    expect((await api.room('novareyes')).access).toBe('open');
    const wl = await api.wallet();
    expect(wl.holdings).toEqual([expect.objectContaining({ address: second.toLowerCase(), units: '100' })]);
    const paid = cash2 - BigInt(wl.wallets![1]!.cashWei);
    expect(paid > q.total ? paid - q.total : q.total - paid).toBeLessThan(10_000n);
    // The account wallet paid nothing and can't sell keys it doesn't hold.
    expect(wl.wallets![0]!.cashWei).toBe(before.wallets[0]!.cashWei);
    expect(() => w.execTrade('novareyes', 'sell', 100n)).toThrow('More than you hold');

    const renamed = await api.walletsLabel(second, { label: 'Trading' });
    expect(renamed.label).toBe('Trading');
    await expect(api.walletsRemove(me.wallet!.address)).rejects.toMatchObject({ code: 'account_wallet' });
    await api.walletsRemove(second);
    expect((await api.profile('novareyes')).heldUnits).toBe('0');
    expect((await api.room('novareyes')).access).toBe('locked');
  });

  it(`stops at ${MAX_LINKED_WALLETS} linked wallets and funds a chosen wallet`, async () => {
    const api = getMockApi();
    await api.devLogin({ handle: 'manymock', followers: 1000 });
    for (let i = 0; i < MAX_LINKED_WALLETS; i++)
      await api.walletsLink({ address: privateKeyToAccount(generatePrivateKey()).address, signature: '0x00', connector: 'metaMask', kind: 'embedded' });
    await expect(api.walletsLink({ address: privateKeyToAccount(generatePrivateKey()).address, signature: '0x00', connector: 'okx' })).rejects.toMatchObject({ code: 'wallet_limit' });
    const ws = await api.wallets();
    const last = ws.wallets[ws.wallets.length - 1]!;
    expect(last.cashWei).toBe('0');
    await api.faucet({ address: last.address });
    expect(BigInt((await api.wallets()).wallets.at(-1)!.cashWei) > 0n).toBe(true);
    await api.logout();
  });
});
