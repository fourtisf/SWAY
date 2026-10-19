'use client';
/**
 * Wallet apps through wagmi connectors (real mode only): every EIP-6963 browser wallet (multiInjectedProvider-
 * Discovery), a plain window.ethereum fallback, the Coinbase Wallet SDK, and WalletConnect when
 * ConfigDTO.wallets.walletConnectProjectId is set. Sway draws its own connect modal (components/wallet), so no
 * RainbowKit UI is mounted. Several connections can be live at once; each connected account is published to
 * useExternalWallet as a SwayWallet bound to its connector, so the UI never touches wagmi directly.
 */
import { swayKeysAbi } from '@sway/shared/abi';
import { swayChain, type ConfigDTO } from '@sway/shared';
import { useEffect, useMemo } from 'react';
import type { Address } from 'viem';
import { WagmiProvider, createConfig, http, useAccount, useConnections, useConnectors, type Config, type Connector } from 'wagmi';
import { connect, getConnections, sendTransaction, signMessage, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { useExternalWallet, type ConnectAction, type ExternalApi } from './index';
import type { SwayWallet } from './types';

function wagmiWallet(cfg: Config, address: Address, connector: Connector, swayKeys: Address | null, chainId: number): SwayWallet {
  const keys = () => {
    if (!swayKeys) throw new Error('SwayKeys is not deployed on this chain yet');
    return swayKeys;
  };
  // Writes need the wallet on the Sway chain: switch (or add) it first, as the wallet app asks.
  const onChain = async () => {
    const c = getConnections(cfg).find((x) => x.connector.uid === connector.uid);
    if (c && c.chainId !== chainId) await switchChain(cfg, { chainId, connector });
  };
  const base = { account: address, connector, chainId } as const;
  return {
    address,
    kind: 'external',
    signMessage: (message) => signMessage(cfg, { message, account: address, connector }),
    buy: async (subject, units, value) => {
      await onChain();
      return writeContract(cfg, { ...base, address: keys(), abi: swayKeysAbi, functionName: 'buy', args: [subject, units], value });
    },
    sell: async (subject, units, minProceeds) => {
      await onChain();
      return writeContract(cfg, { ...base, address: keys(), abi: swayKeysAbi, functionName: 'sell', args: [subject, units, minProceeds] });
    },
    claim: async (subjects) => {
      await onChain();
      return writeContract(cfg, { ...base, address: keys(), abi: swayKeysAbi, functionName: 'claim', args: [subjects] });
    },
    sendEth: async (to, value) => {
      await onChain();
      return sendTransaction(cfg, { ...base, to, value });
    },
    writeContract: async (call) => {
      await onChain();
      return writeContract(cfg, { ...base, ...call } as never);
    },
    async waitForReceipt(hash) {
      const r = await waitForTransactionReceipt(cfg, { hash, chainId });
      if (r.status !== 'success') throw new Error('Transaction reverted');
    },
  };
}

const walletCache = new Map<string, SwayWallet>();
function walletFor(cfg: Config, address: Address, connector: Connector, config: ConfigDTO): SwayWallet {
  const k = `${connector.uid}:${address.toLowerCase()}:${config.chainId}:${config.contracts.swayKeys}`;
  let w = walletCache.get(k);
  if (!w) walletCache.set(k, (w = wagmiWallet(cfg, address, connector, config.contracts.swayKeys, config.chainId)));
  return w;
}

function makeApi(cfg: Config, config: ConfigDTO): ExternalApi {
  const find = (a: ConnectAction): Connector | undefined => {
    const all = cfg.connectors;
    if (a.via === 'injected') return (a.rdns ? all.find((c) => c.id === a.rdns) : undefined) ?? all.find((c) => c.id === 'injected');
    if (a.via === 'coinbaseWallet') return all.find((c) => c.id === 'coinbaseWalletSDK' || c.type === 'coinbaseWallet');
    return all.find((c) => c.id === 'walletConnect');
  };
  return {
    async connect(a, onUri) {
      const connector = find(a);
      if (!connector) throw new Error(a.via === 'walletConnect' ? 'WalletConnect isn’t set up on this server' : 'That wallet isn’t available in this browser');
      const onMessage = (m: { type: string; data?: unknown }) => {
        if (m.type === 'display_uri' && typeof m.data === 'string') onUri?.(m.data);
      };
      connector.emitter.on('message', onMessage);
      try {
        let accounts: readonly Address[];
        let chainId: number;
        try {
          ({ accounts, chainId } = await connect(cfg, { connector }));
        } catch (e) {
          // Already connected through this app: use the account it has selected now.
          const live = getConnections(cfg).find((c) => c.connector.uid === connector.uid);
          if (!live || (e as Error)?.name !== 'ConnectorAlreadyConnectedError') throw e;
          ({ accounts, chainId } = live);
        }
        const address = accounts[0];
        if (!address) throw new Error('The wallet didn’t share an account');
        return { address, chainId, wallet: walletFor(cfg, address, connector, config) };
      } finally {
        connector.emitter.off('message', onMessage);
      }
    },
    async switchChain(address) {
      const c = getConnections(cfg).find((x) => x.accounts.some((a) => a.toLowerCase() === address.toLowerCase()));
      await switchChain(cfg, { chainId: config.chainId, ...(c ? { connector: c.connector } : {}) });
    },
    chainOf(address) {
      return getConnections(cfg).find((x) => x.accounts.some((a) => a.toLowerCase() === address.toLowerCase()))?.chainId ?? null;
    },
  };
}

function Bridge({ cfg, config }: { cfg: Config; config: ConfigDTO }) {
  const connections = useConnections();
  const connectors = useConnectors();
  const { status } = useAccount();
  useEffect(() => {
    const wallets = connections.flatMap((c) => c.accounts.map((a) => walletFor(cfg, a, c.connector, config)));
    useExternalWallet.setState({ wallets, wallet: wallets[0] ?? null });
  }, [cfg, config, connections]);
  useEffect(() => {
    useExternalWallet.setState({
      detected: connectors
        .filter((c) => c.type === 'injected' && c.id !== 'injected')
        .map((c) => ({ rdns: c.id, name: c.name, icon: c.icon ?? null })),
      api: makeApi(cfg, config),
    });
  }, [cfg, config, connectors]);
  useEffect(() => {
    // Until wagmi has restored last session's connections, "not connected" isn't known yet.
    if (status !== 'reconnecting' && status !== 'connecting') useExternalWallet.setState({ ready: true });
  }, [status]);
  return null;
}

export default function ExternalWalletRoot({ config }: { config: ConfigDTO }) {
  const cfg = useMemo(() => {
    const chain = swayChain({ chainId: config.chainId, rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl, name: config.chainName });
    const projectId = config.wallets.walletConnectProjectId;
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://sway.fam';
    return createConfig({
      chains: [chain],
      connectors: [
        injected({ shimDisconnect: true }),
        coinbaseWallet({ appName: 'Sway' }),
        ...(projectId
          ? [walletConnect({ projectId, showQrModal: false, metadata: { name: 'Sway', description: 'Your X reach, as a market', url: origin, icons: [`${origin}/icon.svg`] } })]
          : []),
      ],
      multiInjectedProviderDiscovery: true,
      transports: { [chain.id]: http(config.rpcUrl) },
      ssr: false,
      pollingInterval: 1000,
    });
  }, [config]);
  return (
    <WagmiProvider config={cfg}>
      <Bridge cfg={cfg} config={config} />
    </WagmiProvider>
  );
}
