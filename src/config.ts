/** Environment-driven configuration with sane public defaults. */

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

export const config = {
  eth: {
    rpcUrl: env('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    etherscanKey: env('ETHERSCAN_API_KEY'),
    etherscanBase: 'https://api.etherscan.io/v2/api',
    chainId: 1,
  },
  solana: {
    rpcUrl: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
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

/** Well-known addresses, used to label transactions and score approval risk. */
export const KNOWN_SPENDERS: Record<string, string> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router 2',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Router V5',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Router V6',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x881d40237659c251811cea9c664eef2e7ff4a7de': 'MetaMask Swap Router',
  '0x11111112542d85b3ef69ae05771c2dccff4faa26': '1inch Router V3',
};

/** Known MEV bot and builder addresses. Presence raises detector confidence. */
export const KNOWN_MEV_ACTORS = new Set<string>([
  '0xae2fc483527b8ef99eb5d9b44875f005ba1fae13',
  '0x6b75d8af000000e20b7a7ddf000ba900b4009a80',
  '0x00000000003b3cc22af3ae1eac0440bcee416b40',
  '0xa69babef1ca67a37ffaf7a485dfff3382056e78c',
  '0x000000000dfde7deaf24138722987c9a6991e2d4',
]);

/** CoinGecko ids for the native assets. */
export const NATIVE_COINGECKO_IDS: Record<string, string> = {
  ethereum: 'ethereum',
  solana: 'solana',
};

export const NATIVE_DECIMALS: Record<string, number> = {
  ethereum: 18,
  solana: 9,
};

export const NATIVE_SYMBOLS: Record<string, string> = {
  ethereum: 'ETH',
  solana: 'SOL',
};

/** Sentinel used in place of a contract address for the chain's native asset. */
export const NATIVE_ASSET = 'native';
