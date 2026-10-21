'use client';
/** [A] Wallet actions: switch, copy, rename, remove, make the account wallet, claim per wallet, test funds, import a Sway wallet key. */
import { weiToEth } from '@sway/curve';
import { shortAddress, type Address, type EarningsDTO, type MeDTO } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage, getApi, isAuthRequired } from './api';
import { MOCK } from './env';
import { useFormat } from './format';
import { invalidateMoney, qk, useConfig, useMe } from './queries';
import { closeModal, openModal, toast } from './store';
import { keyringChanged, linkWallet, useMemberWallets, type MemberWallet } from './wallet';
import { setActiveChoice } from './wallet/active';
import { burnerAddress, burnerWalletCached, parsePrivateKey, saveBurnerKey } from './wallet/burner';
import { mockWallet } from './wallet/mock';

const fail = (e: unknown) => {
  if (!isAuthRequired(e)) toast(errorMessage(e));
};

/** Opens the connect modal for a wallet that isn't usable here (or to add one). */
export function openConnectWallet(address?: string) {
  openModal({ type: 'wallets', purpose: 'reconnect', address });
}

export function copyAddress(address: string) {
  navigator.clipboard?.writeText(address).catch(() => null);
  toast('Address copied');
}

export function useWalletActions() {
  const qc = useQueryClient();
  const me = useMe().data ?? null;
  const cfg = useConfig().data;
  const F = useFormat();
  const { wallets, setActive } = useMemberWallets();

  /** After a link/unlink: new MeDTO in the cache, balances refetched. */
  const applied = async (next: MeDTO) => {
    qc.setQueryData(qk.me, next);
    await invalidateMoney(qc);
  };

  return {
    wallets,

    async linked(next: MeDTO, address: string, name: string) {
      if (me) setActiveChoice(me.user.id, address);
      await applied(next);
      toast(`${name} added`);
    },

    activate(w: MemberWallet) {
      if (!w.usable) return openConnectWallet(w.address);
      setActive(w.address);
      toast(`Using ${w.name} ${shortAddress(w.address)}`);
    },

    async rename(address: string, label: string) {
      try {
        await getApi().walletsLabel(address, { label: label.trim() || null });
        await applied((await getApi().me())!);
        closeModal();
        toast(label.trim() ? 'Wallet renamed' : 'Name cleared');
      } catch (e) {
        fail(e);
      }
    },

    async remove(address: string) {
      try {
        const next = await getApi().walletsRemove(address);
        await applied(next);
        closeModal();
        toast('Wallet removed');
      } catch (e) {
        fail(e);
      }
    },

    async makeAccount(address: string) {
      try {
        const next = await getApi().walletsMakeAccount(address);
        if (me) setActiveChoice(me.user.id, address);
        await applied(next);
        closeModal();
        toast('That’s your account wallet now');
      } catch (e) {
        fail(e);
      }
    },

    /** SwayKeys.claim(subjects) from one wallet (earnings are per address). */
    async claim(w: MemberWallet, e: EarningsDTO, quiet = false): Promise<boolean> {
      if (!w.wallet) {
        openConnectWallet(w.address);
        return false;
      }
      try {
        const hash = await w.wallet.claim(e.claimSubjects as Address[]);
        await w.wallet.waitForReceipt(hash);
        if (!quiet) toast(`Claimed ${F.$(weiToEth(e.totalWei))}`);
        await invalidateMoney(qc);
        // "Claimed so far" comes from the indexer: refresh once it has the Claim event.
        if (!MOCK)
          void (async () => {
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 1000));
              await invalidateMoney(qc);
            }
          })();
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },

    /** Local chains: $100 of test ETH into one of the member's wallets. */
    async testFunds(address: string) {
      try {
        const { txHash } = await getApi().faucet({ address: address as Address });
        const w = wallets.find((x) => x.address.toLowerCase() === address.toLowerCase());
        if (!MOCK && w?.wallet) await w.wallet.waitForReceipt(txHash as `0x${string}`).catch(() => null);
        toast(MOCK ? 'Added $100 in demo funds' : 'Added test funds from the faucet');
        await invalidateMoney(qc);
      } catch (e) {
        fail(e);
      }
    },

    /**
     * Restores a Sway wallet from its private key into this browser. A key of one of your wallets just becomes
     * usable here; any other key is added as a new wallet (signed with that key).
     */
    async importKey(raw: string): Promise<boolean> {
      if (!me) return false;
      const pk = parsePrivateKey(raw);
      if (!pk) {
        toast('That isn’t a private key (64 hex characters)');
        return false;
      }
      const address = burnerAddress(pk);
      const mine = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
      if (mine && mine.kind === 'external') {
        toast(`That key belongs to your ${mine.name}. Connect it through the wallet app instead.`);
        return false;
      }
      try {
        saveBurnerKey(me.user.id, pk);
        keyringChanged();
        if (!mine) {
          if (!MOCK && cfg?.wallets.embedded !== 'burner') throw new Error('Sway wallets can’t be imported on this server');
          const sw = MOCK ? mockWallet(address, 'embedded') : burnerWalletCached(pk, cfg!);
          await applied(await linkWallet(sw, { as: 'linked', connector: 'sway' }));
        }
        setActiveChoice(me.user.id, address);
        closeModal();
        toast(mine ? 'Sway wallet restored in this browser' : 'Sway wallet imported');
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
  };
}
