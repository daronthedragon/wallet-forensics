import { arbitrum, base, mainnet, optimism, polygon, type Chain as ViemChain } from 'viem/chains';

/** Environment-driven configuration with sane public defaults. */

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

/** Every chain this tool can analyze. */
export type Chain = 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'solana';

/** Sentinel used in place of a contract address for the chain's native asset. */
export const NATIVE_ASSET = 'native';

/**
 * Per-chain configuration.
 *
 * Adding an EVM chain means filling in one of these entries — the adapter,
 * analysis, and reporting layers all read from here rather than hardcoding
 * mainnet. Etherscan's V2 API is a single endpoint keyed by chainId, so one
 * API key covers every chain in this table.
 */
export interface EvmChainConfig {
  chain: Chain;
  label: string;
  chainId: number;
  viemChain: ViemChain;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** CoinGecko id used to price the native asset. */
  coingeckoId: string;
  /** CoinGecko platform slug used to price tokens by contract address. */
  coingeckoPlatform: string;
  /** DefiLlama chain key. Its price API batches and needs no key. */
  llamaChain: string;
  /** Uniswap V3 QuoterV2, for exit-liquidity simulation. Omit if not deployed. */
  quoter?: `0x${string}`;
  /** Wrapped native token — the quote currency for sell simulations. */
  wrappedNative: `0x${string}`;
  /** Blockscout API base for this chain, used when no Etherscan key is set. */
  blockscoutBase: string;
  /** Stablecoins used as the cost-basis numeraire, mapped to their decimals. */
  stables: Record<string, number>;
  explorer: string;
}

/** Uniswap's canonical QuoterV2, deployed at the same address on most chains. */
const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;

export const EVM_CHAINS: Record<Exclude<Chain, 'solana'>, EvmChainConfig> = {
  ethereum: {
    chain: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    viemChain: mainnet,
    rpcUrl: env('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    coingeckoId: 'ethereum',
    coingeckoPlatform: 'ethereum',
    llamaChain: 'ethereum',
    quoter: UNISWAP_QUOTER_V2,
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    stables: {
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
      '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
    },
    blockscoutBase: 'https://eth.blockscout.com/api',
    explorer: 'https://etherscan.io',
  },

  base: {
    chain: 'base',
    label: 'Base',
    chainId: 8453,
    viemChain: base,
    rpcUrl: env('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    coingeckoId: 'ethereum',
    coingeckoPlatform: 'base',
    llamaChain: 'base',
    // Base has its own QuoterV2 deployment rather than the shared address.
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    stables: {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18, // DAI
    },
    blockscoutBase: 'https://base.blockscout.com/api',
    explorer: 'https://basescan.org',
  },

  arbitrum: {
    chain: 'arbitrum',
    label: 'Arbitrum',
    chainId: 42161,
    viemChain: arbitrum,
    rpcUrl: env('ARBITRUM_RPC_URL', 'https://arbitrum-one-rpc.publicnode.com'),
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    coingeckoId: 'ethereum',
    coingeckoPlatform: 'arbitrum-one',
    llamaChain: 'arbitrum',
    quoter: UNISWAP_QUOTER_V2,
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    stables: {
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6, // USDT
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18, // DAI
    },
    blockscoutBase: 'https://arbitrum.blockscout.com/api',
    explorer: 'https://arbiscan.io',
  },

  optimism: {
    chain: 'optimism',
    label: 'Optimism',
    chainId: 10,
    viemChain: optimism,
    rpcUrl: env('OPTIMISM_RPC_URL', 'https://optimism-rpc.publicnode.com'),
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    coingeckoId: 'ethereum',
    coingeckoPlatform: 'optimistic-ethereum',
    llamaChain: 'optimism',
    quoter: UNISWAP_QUOTER_V2,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    stables: {
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 6, // USDC
      '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 6, // USDT
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18, // DAI
    },
    blockscoutBase: 'https://optimism.blockscout.com/api',
    explorer: 'https://optimistic.etherscan.io',
  },

  polygon: {
    chain: 'polygon',
    label: 'Polygon',
    chainId: 137,
    viemChain: polygon,
    rpcUrl: env('POLYGON_RPC_URL', 'https://polygon-bor-rpc.publicnode.com'),
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    coingeckoId: 'matic-network',
    coingeckoPlatform: 'polygon-pos',
    llamaChain: 'polygon',
    quoter: UNISWAP_QUOTER_V2,
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    stables: {
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6, // USDC
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6, // USDT
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 18, // DAI
    },
    blockscoutBase: 'https://polygon.blockscout.com/api',
    explorer: 'https://polygonscan.com',
  },
};

export const SOLANA_CONFIG = {
  chain: 'solana' as const,
  label: 'Solana',
  rpcUrl: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  coingeckoId: 'solana',
  coingeckoPlatform: 'solana',
  llamaChain: 'solana',
  explorer: 'https://solscan.io',
  stables: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  } as Record<string, number>,
};

export const config = {
  eth: {
    /**
     * Which explorer supplies account history. Etherscan needs a key but is
     * more complete; Blockscout needs none, which keeps the tool usable with
     * no configuration at all.
     */
    get historySource(): 'etherscan' | 'blockscout' {
      return env('ETHERSCAN_API_KEY') ? 'etherscan' : 'blockscout';
    },
  },
  etherscan: {
    key: env('ETHERSCAN_API_KEY'),
    /** V2 is a single multichain endpoint; the chain is selected by chainid. */
    base: 'https://api.etherscan.io/v2/api',
  },
  pricing: {
    coingeckoKey: env('COINGECKO_API_KEY'),
    get base(): string {
      return env('COINGECKO_API_KEY')
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3';
    },
  },
  jupiter: {
    quoteUrl: env('JUPITER_QUOTE_URL', 'https://lite-api.jup.ag/swap/v1/quote'),
  },
} as const;

/* ------------------------------------------------------------------ lookups */

export function isEvmChain(chain: Chain): chain is Exclude<Chain, 'solana'> {
  return chain !== 'solana';
}

export function evmConfig(chain: Chain): EvmChainConfig {
  if (!isEvmChain(chain)) throw new Error(`${chain} is not an EVM chain`);
  return EVM_CHAINS[chain];
}

export const ALL_EVM_CHAINS = Object.keys(EVM_CHAINS) as Array<Exclude<Chain, 'solana'>>;

export const ALL_CHAINS: Chain[] = [...ALL_EVM_CHAINS, 'solana'];

export function chainLabel(chain: Chain): string {
  return chain === 'solana' ? SOLANA_CONFIG.label : EVM_CHAINS[chain].label;
}

export function nativeSymbol(chain: Chain): string {
  return chain === 'solana' ? SOLANA_CONFIG.nativeSymbol : EVM_CHAINS[chain].nativeSymbol;
}

export function nativeDecimals(chain: Chain): number {
  return chain === 'solana' ? SOLANA_CONFIG.nativeDecimals : EVM_CHAINS[chain].nativeDecimals;
}

export function coingeckoId(chain: Chain): string {
  return chain === 'solana' ? SOLANA_CONFIG.coingeckoId : EVM_CHAINS[chain].coingeckoId;
}

export function llamaChain(chain: Chain): string {
  return chain === 'solana' ? SOLANA_CONFIG.llamaChain : EVM_CHAINS[chain].llamaChain;
}

export function coingeckoPlatform(chain: Chain): string {
  return chain === 'solana' ? SOLANA_CONFIG.coingeckoPlatform : EVM_CHAINS[chain].coingeckoPlatform;
}

export function stablesFor(chain: Chain): Record<string, number> {
  return chain === 'solana' ? SOLANA_CONFIG.stables : EVM_CHAINS[chain].stables;
}

/* ------------------------------------------------------- known addresses */

/** Well-known spenders, used to label transactions and score approval risk. */
export const KNOWN_SPENDERS: Record<string, string> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router 2',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router 2',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 Router (Base)',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Router V5',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Router V6',
  '0x11111112542d85b3ef69ae05771c2dccff4faa26': '1inch Router V3',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0x881d40237659c251811cea9c664eef2e7ff4a7de': 'MetaMask Swap Router',
};

/** Known MEV bot and builder addresses. Presence raises detector confidence. */
export const KNOWN_MEV_ACTORS = new Set<string>([
  '0xae2fc483527b8ef99eb5d9b44875f005ba1fae13',
  '0x6b75d8af000000e20b7a7ddf000ba900b4009a80',
  '0x00000000003b3cc22af3ae1eac0440bcee416b40',
  '0xa69babef1ca67a37ffaf7a485dfff3382056e78c',
  '0x000000000dfde7deaf24138722987c9a6991e2d4',
]);
