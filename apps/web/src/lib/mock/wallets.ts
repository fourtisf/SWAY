/**
 * [A] Mock mode for several wallets per member: the account wallet (any connector) plus up to
 * MAX_LINKED_WALLETS linked wallets, each with its own simulated balance, keys and holder earnings.
 */
import { MAX_LINKED_WALLETS, WALLET_LABEL_MAX, type Address, type LinkWalletBody, type WalletLinkBody } from '@sway/shared';
import { ApiRequestError, notifyAuthRequired, type SwayApi } from '../api';
import { ETH_USD } from './seed';
import { MockWorld } from './state';

type SwayApiWallets = Pick<SwayApi, 'wallets' | 'walletsNonce' | 'walletsLink' | 'walletsLabel' | 'walletsRemove'>;

const err = (status: number, code: string, message: string) => new ApiRequestError(status, code, message);

function needUser(w: MockWorld) {
  if (!w.user) {
    notifyAuthRequired();
    throw err(401, 'auth_required', 'Connect X first');
  }
  return w.user;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Wallet routes on the mock world (spread into getMockApi()). */
export function walletsMockApi(w: MockWorld): SwayApiWallets {
  const nonceMessage = (addr?: string) =>
    `Sway wants you to add this wallet to @${w.user?.handle ?? 'you'}.\n\nAddress: ${addr ?? '{address}'}\nNonce: mock`;
  return {
    async wallets() {
      needUser(w);
      return { wallets: w.walletBalances(), maxLinked: MAX_LINKED_WALLETS };
    },
    async walletsNonce(body) {
      needUser(w);
      return { nonce: 'mock', message: nonceMessage(body?.address) };
    },
    async walletsLink(body: LinkWalletBody) {
      const u = needUser(w);
      if (same(body.address, u.wallet)) throw err(409, 'wallet_is_account', 'This is already your account wallet');
      const existing = w.linkedOf(body.address);
      if (!existing) {
        if (w.linked.length >= MAX_LINKED_WALLETS)
          throw err(409, 'wallet_limit', `You can add up to ${MAX_LINKED_WALLETS} wallets. Remove one to add another.`);
        w.linked.push({
          address: body.address.toLowerCase() as Address,
          kind: body.kind ?? 'external',
          connector: body.connector,
          label: body.label?.trim() || null,
          createdAt: Date.now(),
          // A fresh Sway wallet starts empty; a connected wallet app brings its own (simulated) balance.
          eth: body.kind === 'embedded' ? 0 : MockWorld.demoBalance(body.address),
          holdings: {},
          earnedHolder: 0,
          claimed: 0,
        });
      }
      return w.me()!;
    },
    async walletsLabel(address, { label }) {
      needUser(w);
      const l = w.linkedOf(address);
      if (!l) {
        if (w.user && same(address, w.user.wallet)) throw err(409, 'account_wallet', 'Your account wallet keeps its name');
        throw err(404, 'wallet_not_found', 'That wallet is not one of yours');
      }
      const t = (label ?? '').trim();
      if (t.length > WALLET_LABEL_MAX) throw err(400, 'bad_request', `Names are at most ${WALLET_LABEL_MAX} characters`);
      l.label = t || null;
      return w.walletInfos().find((x) => same(x.address, address))!;
    },
    async walletsRemove(address) {
      needUser(w);
      const i = w.linked.findIndex((l) => same(l.address, address));
      if (i < 0) {
        if (w.user && same(address, w.user.wallet)) throw err(409, 'account_wallet', 'Your account wallet can’t be removed');
        throw err(404, 'wallet_not_found', 'That wallet is not one of yours');
      }
      // Its keys stay in that wallet; they no longer count for the member.
      const l = w.linked[i]!;
      for (const [h, k] of Object.entries(l.holdings)) w.holdings[h] = Math.max(0, +((w.holdings[h] || 0) - k).toFixed(2));
      w.linked.splice(i, 1);
      return w.me()!;
    },
  };
}

/** Account-wallet link with a connector: onboarding's "Connect a wallet" makes it the account wallet. */
export function mockAccountLink(w: MockWorld, body: WalletLinkBody) {
  const u = needUser(w);
  if (body.address && !same(body.address, u.wallet)) {
    u.wallet = body.address.toLowerCase() as Address;
    w.account = { connector: body.connector ?? (body.kind === 'embedded' ? 'sway' : 'injected'), kind: body.kind, createdAt: Date.now() };
  } else if (body.connector) w.account.connector = body.connector;
  return w.me()!;
}

/** Dev faucet into any of the member's wallets ($100 of demo ETH). */
export function mockFaucet(w: MockWorld, address?: string) {
  needUser(w);
  const l = address ? w.linkedOf(address) : undefined;
  if (address && !l && !same(address, w.user!.wallet)) throw err(404, 'wallet_not_found', 'That wallet is not one of yours');
  if (l) l.eth += 100 / ETH_USD;
  else w.eth += 100 / ETH_USD;
  w.log('Deposit', 100 / ETH_USD);
}
