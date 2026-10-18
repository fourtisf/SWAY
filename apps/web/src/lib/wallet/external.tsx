'use client';
/**
 * "Use my own wallet": wagmi + RainbowKit (injected wallets; WalletConnect only when
 * ConfigDTO.wallets.walletConnectProjectId is set). Exposes the account as a SwayWallet through
 * useExternalWallet so the rest of the UI never touches wagmi directly. Loaded only in real mode.
 */
import '@rainbow-me/rainbowkit/styles.css';
import { RainbowKitProvider, connectorsForWallets, lightTheme, useConnectModal } from '@rainbow-me/rainbowkit';
import { injectedWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { swayKeysAbi } from '@sway/shared/abi';
import { swayChain, type ConfigDTO } from '@sway/shared';
import { useEffect, useMemo } from 'react';
import type { Address } from 'viem';
import { WagmiProvider, createConfig, http, useAccount, type Config } from 'wagmi';
import { sendTransaction, signMessage, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { useExternalWallet } from './index';
import type { SwayWallet } from './types';

function wagmiWallet(cfg: Config, address: Address, swayKeys: Address | null, chainId: number): SwayWallet {
  const keys = () => {
    if (!swayKeys) throw new Error('SwayKeys is not deployed on this chain yet');
    return swayKeys;
  };
  return {
    address,
    kind: 'external',
    signMessage: (message) => signMessage(cfg, { message, account: address }),
    buy: (subject, units, value) => writeContract(cfg, { address: keys(), abi: swayKeysAbi, functionName: 'buy', args: [subject, units], value, chainId }),
    sell: (subject, units, minProceeds) => writeContract(cfg, { address: keys(), abi: swayKeysAbi, functionName: 'sell', args: [subject, units, minProceeds], chainId }),
    claim: (subjects) => writeContract(cfg, { address: keys(), abi: swayKeysAbi, functionName: 'claim', args: [subjects], chainId }),
    sendEth: (to, value) => sendTransaction(cfg, { to, value, chainId }),
    async waitForReceipt(hash) {
      const r = await waitForTransactionReceipt(cfg, { hash, chainId });
      if (r.status !== 'success') throw new Error('Transaction reverted');
    },
  };
}

function Bridge({ cfg, config }: { cfg: Config; config: ConfigDTO }) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  useEffect(() => {
    useExternalWallet.setState({ openConnect: openConnectModal ?? null, ready: true });
  }, [openConnectModal]);
  useEffect(() => {
    useExternalWallet.setState({ wallet: isConnected && address ? wagmiWallet(cfg, address, config.contracts.swayKeys, config.chainId) : null });
  }, [cfg, address, isConnected, config.contracts.swayKeys, config.chainId]);
  return null;
}

export default function ExternalWalletRoot({ config }: { config: ConfigDTO }) {
  const cfg = useMemo(() => {
    const chain = swayChain({ chainId: config.chainId, rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl, name: config.chainName });
    const projectId = config.wallets.walletConnectProjectId;
    const connectors = connectorsForWallets(
      [{ groupName: projectId ? 'Popular' : 'Installed', wallets: projectId ? [injectedWallet, walletConnectWallet] : [injectedWallet] }],
      { appName: 'Sway', projectId: projectId || 'walletconnect-disabled' },
    );
    return createConfig({ chains: [chain], connectors, transports: { [chain.id]: http(config.rpcUrl) }, ssr: false });
  }, [config]);
  return (
    <WagmiProvider config={cfg}>
      <RainbowKitProvider theme={lightTheme({ accentColor: '#1D9BF0', borderRadius: 'large' })} modalSize="compact">
        <Bridge cfg={cfg} config={config} />
      </RainbowKitProvider>
    </WagmiProvider>
  );
}
