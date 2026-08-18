import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  type PublicClient,
} from 'viem';
import {
  config,
  evmConfig,
  KNOWN_SPENDERS,
  NATIVE_ASSET,
  type Chain,
  type EvmChainConfig,
} from '../config.js';
import { detectSandwiches } from '../analysis/mev.js';
import type { PriceOracle } from '../pricing/index.js';
import type {
  Approval,
  AnalysisOptions,
  MevEvent,
  NormalizedTx,
  TokenBalance,
} from '../types.js';
import { AdapterWarning, type ChainAdapter } from './types.js';

const APPROVAL_EVENT = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** Fee tiers to probe, cheapest liquidity first. */
const FEE_TIERS = [500, 3000, 10000] as const;

/** Anything at or above this is treated as an unlimited approval. */
const UNLIMITED_THRESHOLD = (1n << 255n);

interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  isError?: string;
  txreceipt_status?: string;
  functionName?: string;
  contractAddress?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

export class EvmAdapter implements ChainAdapter {
  readonly chain: Chain;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;

  readonly client: PublicClient;
  private readonly cfg: EvmChainConfig;

  constructor(
    chain: Chain,
    private readonly prices: PriceOracle,
  ) {
    this.cfg = evmConfig(chain);
    this.chain = chain;
    this.nativeSymbol = this.cfg.nativeSymbol;
    this.nativeDecimals = this.cfg.nativeDecimals;

    this.client = createPublicClient({
      chain: this.cfg.viemChain,
      transport: http(this.cfg.rpcUrl, { batch: true, retryCount: 2 }),
    });
  }

  isValidAddress(address: string): boolean {
    return isAddress(address);
  }

  // ---------------------------------------------------------------- history

  async getTransactions(address: string, opts: AnalysisOptions): Promise<NormalizedTx[]> {
    const owner = getAddress(address);
    const [normal, tokens] = await Promise.all([
      this.explorer('txlist', owner),
      this.explorer('tokentx', owner),
    ]);

    const byHash = new Map<string, NormalizedTx>();

    // Pass 1: transactions the address originated or directly received.
    for (const t of normal) {
      const tx = this.toNormalized(t, owner);
      if (opts.since && tx.timestamp < opts.since) continue;

      const value = BigInt(t.value || '0');
      if (value > 0n) {
        const outgoing = t.from.toLowerCase() === owner.toLowerCase();
        tx.transfers.push({
          asset: NATIVE_ASSET,
          symbol: this.nativeSymbol,
          decimals: this.nativeDecimals,
          amount: outgoing ? -value : value,
        });
      }
      byHash.set(tx.id, tx);
    }

    // Pass 2: attach ERC-20 movements. Token transfers can belong to a tx the
    // address did not originate (an airdrop, a contract paying out), so any
    // hash we have not seen yet becomes its own entry.
    for (const t of tokens) {
      const hash = t.hash;
      let tx = byHash.get(hash);
      if (!tx) {
        tx = this.toNormalized(t, owner);
        if (opts.since && tx.timestamp < opts.since) continue;
        // The address didn't originate this, so it paid no fee.
        tx.fee = 0n;
        byHash.set(hash, tx);
      }

      const outgoing = t.from.toLowerCase() === owner.toLowerCase();
      const raw = BigInt(t.value || '0');
      if (raw === 0n) continue;

      tx.transfers.push({
        asset: (t.contractAddress ?? '').toLowerCase(),
        symbol: t.tokenSymbol,
        decimals: Number(t.tokenDecimal ?? 18),
        amount: outgoing ? -raw : raw,
      });
    }

    const all = [...byHash.values()].sort((a, b) => b.block - a.block);
    const capped = all.slice(0, opts.maxTransactions);

    await this.priceFees(capped);
    return capped;
  }

  private toNormalized(t: EtherscanTx, owner: string): NormalizedTx {
    const outgoing = t.from.toLowerCase() === owner.toLowerCase();
    const gasUsed = BigInt(t.gasUsed || '0');
    const gasPrice = BigInt(t.gasPrice || '0');
    const counterparty = outgoing ? t.to : t.from;

    return {
      id: t.hash,
      chain: this.chain,
      timestamp: new Date(Number(t.timeStamp) * 1000),
      block: Number(t.blockNumber),
      outgoing,
      fee: outgoing ? gasUsed * gasPrice : 0n,
      failed: t.isError === '1' || t.txreceipt_status === '0',
      counterparty: counterparty || undefined,
      label: labelFor(t, counterparty),
      transfers: [],
    };
  }

  /** Convert each fee to USD using the ETH price on the day it was paid. */
  private async priceFees(txs: NormalizedTx[]): Promise<void> {
    const days = new Map<string, Date>();
    for (const tx of txs) {
      if (tx.fee === 0n) continue;
      days.set(tx.timestamp.toISOString().slice(0, 10), tx.timestamp);
    }

    const priceByDay = new Map<string, number | undefined>();
    for (const [day, when] of days) {
      priceByDay.set(day, await this.prices.nativePriceOn(this.chain, when));
    }

    for (const tx of txs) {
      if (tx.fee === 0n) continue;
      const price = priceByDay.get(tx.timestamp.toISOString().slice(0, 10));
      if (price === undefined) continue;
      tx.feeUsd = Number(formatUnits(tx.fee, 18)) * price;
    }
  }

  /**
   * Tokens the address currently holds, straight from Blockscout.
   *
   * Deriving candidates from transfer history only sees the explorer's most
   * recent page, so anything bought earlier and simply held goes unnoticed —
   * which is precisely the long-tail position exit-liquidity analysis exists
   * to price. Etherscan puts the equivalent endpoint behind a paid plan, so
   * that path keeps using transfer history.
   */
  private async blockscoutHoldings(
    address: string,
  ): Promise<Array<{ address: string; symbol?: string; decimals: number }>> {
    const url = `${this.cfg.blockscoutBase}?module=account&action=tokenlist&address=${address}`;
    const res = await fetch(url);
    if (!res.ok) throw new AdapterWarning(`blockscout ${res.status} on tokenlist`, 'balances');

    const json = (await res.json()) as { status?: string; result?: unknown };
    if (json.status !== '1' || !Array.isArray(json.result)) return [];

    return (json.result as Array<Record<string, string>>)
      .filter((t) => t.type === 'ERC-20' && BigInt(t.balance || '0') > 0n)
      .map((t) => ({
        address: (t.contractAddress ?? '').toLowerCase(),
        symbol: t.symbol,
        decimals: Number(t.decimals ?? 18),
      }))
      .filter((t) => t.address);
  }

  /**
   * Account history from whichever explorer is available. Etherscan when a key
   * is configured, Blockscout otherwise — the response shapes match, so
   * everything downstream is unaffected.
   */
  private async explorer(action: 'txlist' | 'tokentx', address: string): Promise<EtherscanTx[]> {
    const source = config.eth.historySource;
    const url =
      source === 'etherscan'
        ? `${config.etherscan.base}?chainid=${this.cfg.chainId}` +
          `&module=account&action=${action}&address=${address}` +
          `&startblock=0&endblock=99999999&sort=desc&apikey=${config.etherscan.key}`
        : `${this.cfg.blockscoutBase}?module=account&action=${action}` +
          `&address=${address}&startblock=0&endblock=99999999&sort=desc`;

    const res = await fetch(url);
    if (!res.ok) throw new AdapterWarning(`${source} ${res.status} on ${action}`, 'history');

    const json = (await res.json()) as { status?: string; message?: string; result?: unknown };

    // Both explorers report "no transactions found" with the same status they
    // use for real errors, so an empty result has to be recognised first.
    if (json.status !== '1') {
      if (Array.isArray(json.result) && json.result.length === 0) return [];
      const detail = typeof json.result === 'string' ? json.result : '';
      if (/no transactions found|not found|no records/i.test(`${json.message} ${detail}`)) return [];
      throw new AdapterWarning(
        `${source} ${action}: ${json.message ?? 'request failed'} ${detail.slice(0, 120)}`,
        'history',
      );
    }

    return Array.isArray(json.result) ? (json.result as EtherscanTx[]) : [];
  }

  // --------------------------------------------------------------- balances

  async getBalances(address: string): Promise<TokenBalance[]> {
    const owner = getAddress(address);
    const out: TokenBalance[] = [];

    const nativeRaw = await this.client.getBalance({ address: owner });
    const nativePrice = await this.prices.nativePrice(this.chain);
    out.push({
      asset: NATIVE_ASSET,
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      amount: nativeRaw,
      priceUsd: nativePrice,
      valueUsd: nativePrice ? Number(formatUnits(nativeRaw, 18)) * nativePrice : undefined,
    });

    // The set of tokens the address has ever touched, from transfer history.
    let candidates: Array<{ address: string; symbol?: string; decimals: number }> = [];
    {
      try {
        if (config.eth.historySource === 'blockscout') {
          candidates = await this.blockscoutHoldings(owner);
        }
      } catch {
        // Fall through to deriving candidates from transfer history.
      }
    }

    if (candidates.length === 0) {
      try {
        const tokenTxs = await this.explorer('tokentx', owner);
        const seen = new Map<string, { address: string; symbol?: string; decimals: number }>();
        for (const t of tokenTxs) {
          const addr = (t.contractAddress ?? '').toLowerCase();
          if (!addr || seen.has(addr)) continue;
          seen.set(addr, {
            address: addr,
            symbol: t.tokenSymbol,
            decimals: Number(t.tokenDecimal ?? 18),
          });
        }
        candidates = [...seen.values()];
      } catch {
        // History unavailable; native balance alone still gets reported.
      }
    }

    if (candidates.length === 0) return out;

    // One multicall for every balanceOf. Non-conforming tokens fail
    // individually rather than poisoning the batch.
    const results = await this.client.multicall({
      contracts: candidates.map((c) => ({
        address: getAddress(c.address),
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [owner] as const,
      })),
      allowFailure: true,
    });

    const held: typeof candidates = [];
    const amounts: bigint[] = [];
    results.forEach((r, i) => {
      const c = candidates[i];
      if (!c || r.status !== 'success') return;
      const bal = r.result as bigint;
      if (bal > 0n) {
        held.push(c);
        amounts.push(bal);
      }
    });

    if (held.length === 0) return out;

    const priceMap = await this.prices.tokenPrices(
      this.chain,
      held.map((h) => h.address),
    );

    held.forEach((h, i) => {
      const amount = amounts[i]!;
      const price = priceMap.get(h.address);
      out.push({
        asset: h.address,
        symbol: h.symbol,
        decimals: h.decimals,
        amount,
        priceUsd: price,
        valueUsd: price ? Number(formatUnits(amount, h.decimals)) * price : undefined,
      });
    });

    return out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  }

  // -------------------------------------------------------------- approvals

  async getApprovals(address: string): Promise<Approval[]> {
    const owner = getAddress(address);

    let logs;
    try {
      logs = await this.client.getLogs({
        event: APPROVAL_EVENT,
        args: { owner },
        fromBlock: 0n,
        toBlock: 'latest',
        strict: true,
      });
    } catch (err) {
      throw new AdapterWarning(
        `Approval scan failed — most public RPCs cap eth_getLogs ranges. ` +
          `Use an Alchemy/Infura endpoint for full coverage. (${(err as Error).message.slice(0, 100)})`,
        'approvals',
      );
    }

    // Keep only the most recent Approval per (token, spender) pair; earlier
    // ones have been overwritten on-chain.
    const latest = new Map<string, { token: string; spender: string; block: bigint }>();
    for (const log of logs) {
      if (!log.args.spender || log.blockNumber === null) continue;
      const spender = getAddress(log.args.spender);
      const token = getAddress(log.address);
      const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
      const prev = latest.get(key);
      if (!prev || log.blockNumber > prev.block) {
        latest.set(key, { token, spender, block: log.blockNumber });
      }
    }

    if (latest.size === 0) return [];

    const pairs = [...latest.values()];

    // Read live allowances and balances together — an unlimited approval on a
    // token you no longer hold is not the same risk as one on your main bag.
    const [allowances, balances] = await Promise.all([
      this.client.multicall({
        contracts: pairs.map((p) => ({
          address: p.token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance' as const,
          args: [owner, p.spender as `0x${string}`] as const,
        })),
        allowFailure: true,
      }),
      this.client.multicall({
        contracts: pairs.map((p) => ({
          address: p.token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf' as const,
          args: [owner] as const,
        })),
        allowFailure: true,
      }),
    ]);

    const live: Array<{ p: (typeof pairs)[number]; allowance: bigint; balance: bigint }> = [];
    pairs.forEach((p, i) => {
      const a = allowances[i];
      const b = balances[i];
      if (a?.status !== 'success') return;
      const allowance = a.result as bigint;
      if (allowance === 0n) return; // already revoked
      live.push({
        p,
        allowance,
        balance: b?.status === 'success' ? (b.result as bigint) : 0n,
      });
    });

    if (live.length === 0) return [];

    const [priceMap, meta] = await Promise.all([
      this.prices.tokenPrices(
        this.chain,
        live.map((l) => l.p.token.toLowerCase()),
      ),
      this.client.multicall({
        contracts: live.flatMap((l) => [
          { address: l.p.token as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' as const },
          {
            address: l.p.token as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'decimals' as const,
          },
        ]),
        allowFailure: true,
      }),
    ]);

    return live
      .map(({ p, allowance, balance }, i) => {
        const symbolRes = meta[i * 2];
        const decimalsRes = meta[i * 2 + 1];
        const symbol = symbolRes?.status === 'success' ? (symbolRes.result as string) : undefined;
        const decimals =
          decimalsRes?.status === 'success' ? Number(decimalsRes.result as number) : 18;

        const unlimited = allowance >= UNLIMITED_THRESHOLD;
        const price = priceMap.get(p.token.toLowerCase());

        // What could actually be taken right now: the smaller of the allowance
        // and the balance. An unlimited approval on an empty bag risks nothing
        // today, but it stays dangerous the moment you refill.
        const exposedRaw = unlimited ? balance : allowance < balance ? allowance : balance;
        const atRiskUsd = price
          ? Number(formatUnits(exposedRaw, decimals)) * price
          : undefined;

        const { risk, reasons } = scoreApproval({
          unlimited,
          atRiskUsd,
          spender: p.spender,
        });

        return {
          chain: this.chain,
          asset: p.token,
          symbol,
          spender: p.spender,
          spenderLabel: KNOWN_SPENDERS[p.spender.toLowerCase()],
          allowance: unlimited ? null : allowance,
          atRiskUsd,
          risk,
          riskReasons: reasons,
        };
      })
      .sort((a, b) => (b.atRiskUsd ?? 0) - (a.atRiskUsd ?? 0));
  }

  // -------------------------------------------------------------------- MEV

  async detectMev(
    address: string,
    txs: NormalizedTx[],
    opts: AnalysisOptions,
  ): Promise<MevEvent[]> {
    return detectSandwiches(this.client, this.cfg, getAddress(address), txs, this.prices, opts);
  }

  // ------------------------------------------------------------- liquidity

  async quoteSell(
    asset: string,
    amount: bigint,
    decimals: number,
  ): Promise<{ proceedsUsd: number; priceImpact: number } | null> {
    const wrapped = this.cfg.wrappedNative;
    const nativeDec = this.cfg.nativeDecimals;

    if (asset === NATIVE_ASSET) {
      // The native asset is liquid at any size this tool will encounter.
      const price = await this.prices.nativePrice(this.chain);
      if (!price) return null;
      return { proceedsUsd: Number(formatUnits(amount, nativeDec)) * price, priceImpact: 0 };
    }

    const token = getAddress(asset);
    if (token.toLowerCase() === wrapped.toLowerCase()) {
      const price = await this.prices.nativePrice(this.chain);
      if (!price) return null;
      return { proceedsUsd: Number(formatUnits(amount, nativeDec)) * price, priceImpact: 0 };
    }

    // Chains without a Uniswap V3 deployment cannot be route-quoted here.
    const quoter = this.cfg.quoter;
    if (!quoter) return null;

    const ethPrice = await this.prices.nativePrice(this.chain);
    const spot = (await this.prices.tokenPrices('ethereum', [token.toLowerCase()])).get(
      token.toLowerCase(),
    );
    if (!ethPrice || !spot) return null;

    // Probe each fee tier and keep the best execution.
    let bestOut = 0n;
    for (const fee of FEE_TIERS) {
      try {
        const { result } = await this.client.simulateContract({
          address: quoter,
          abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: token,
              tokenOut: wrapped,
              amountIn: amount,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const out = (result as readonly [bigint, bigint, number, bigint])[0];
        if (out > bestOut) bestOut = out;
      } catch {
        // No pool at this tier, or insufficient liquidity. Try the next.
      }
    }

    if (bestOut === 0n) return null;

    const proceedsUsd = Number(formatUnits(bestOut, nativeDec)) * ethPrice;
    const nominalUsd = Number(formatUnits(amount, decimals)) * spot;
    const priceImpact = nominalUsd > 0 ? Math.max(0, 1 - proceedsUsd / nominalUsd) : 0;

    return { proceedsUsd, priceImpact };
  }
}

/** Heuristic risk scoring for an outstanding approval. */
function scoreApproval(input: {
  unlimited: boolean;
  atRiskUsd?: number;
  spender: string;
}): { risk: Approval['risk']; reasons: string[] } {
  const reasons: string[] = [];
  const known = KNOWN_SPENDERS[input.spender.toLowerCase()];
  const value = input.atRiskUsd ?? 0;

  if (input.unlimited) reasons.push('Unlimited allowance');
  if (!known) reasons.push('Spender is not a recognized protocol');
  if (value > 10_000) reasons.push(`$${Math.round(value).toLocaleString()} currently exposed`);

  let risk: Approval['risk'] = 'low';
  if (input.unlimited && !known && value > 1_000) risk = 'critical';
  else if (input.unlimited && value > 1_000) risk = 'high';
  else if (!known && value > 100) risk = 'high';
  else if (input.unlimited || value > 1_000) risk = 'medium';

  if (reasons.length === 0) reasons.push('Bounded allowance to a known protocol');
  return { risk, reasons };
}

/** Best-effort human label from Etherscan's decoded function name. */
function labelFor(t: EtherscanTx, counterparty: string): string | undefined {
  const known = KNOWN_SPENDERS[counterparty?.toLowerCase() ?? ''];
  const fn = t.functionName?.split('(')[0]?.trim();
  if (known && fn) return `${known}: ${fn}`;
  if (known) return known;
  if (fn) return fn;
  return undefined;
}
