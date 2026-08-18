import { EvmAdapter } from './adapters/evm.js';
import { SolanaAdapter } from './adapters/solana.js';
import { AdapterWarning, type ChainAdapter } from './adapters/types.js';
import { summarizeActivity } from './analysis/activity.js';
import { summarizeFees } from './analysis/fees.js';
import { computeExitLiquidity } from './analysis/liquidity.js';
import { computePositions } from './analysis/pnl.js';
import { collectRegrets } from './analysis/regrets.js';
import { PriceOracle } from './pricing/index.js';
import type {
  AnalysisOptions,
  Chain,
  ChainReport,
  ForensicsReport,
  NormalizedTx,
} from './types.js';

export const DEFAULT_OPTIONS: AnalysisOptions = {
  maxTransactions: 3000,
  skipMev: false,
  skipLiquidity: false,
  verbose: false,
};

/** Build an adapter for a chain. */
export function adapterFor(chain: Chain, prices: PriceOracle): ChainAdapter {
  switch (chain) {
    case 'ethereum':
      return new EvmAdapter(prices);
    case 'solana':
      return new SolanaAdapter(prices);
  }
}

/**
 * Detect which chains an address string could belong to.
 *
 * EVM addresses are unambiguous. A base58 string of the right length is almost
 * certainly Solana, though the check is syntactic — an address that has never
 * been used looks identical to one that has.
 */
export function detectChains(address: string): Chain[] {
  const chains: Chain[] = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) chains.push('ethereum');
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) chains.push('solana');
  return chains;
}

/** Run the full pipeline for one address on one chain. */
export async function analyzeChain(
  chain: Chain,
  address: string,
  prices: PriceOracle,
  opts: AnalysisOptions,
): Promise<ChainReport> {
  const adapter = adapterFor(chain, prices);
  const warnings: string[] = [];

  const log = (msg: string) => {
    if (opts.verbose) process.stderr.write(`  ${msg}\n`);
  };

  // --- History --------------------------------------------------------------
  let txs: NormalizedTx[] = [];
  log('fetching transaction history…');
  try {
    txs = await adapter.getTransactions(address, opts);
    log(`${txs.length} transactions`);
  } catch (err) {
    warnings.push(describe(err, 'history'));
  }

  // --- Balances -------------------------------------------------------------
  log('reading balances…');
  let balances: Awaited<ReturnType<ChainAdapter['getBalances']>> = [];
  try {
    balances = await adapter.getBalances(address);
    log(`${balances.length} assets held`);
  } catch (err) {
    warnings.push(describe(err, 'balances'));
  }

  // --- Approvals ------------------------------------------------------------
  log('scanning approvals…');
  let approvals: Awaited<ReturnType<ChainAdapter['getApprovals']>> = [];
  try {
    approvals = await adapter.getApprovals(address, txs);
    log(`${approvals.length} outstanding approvals`);
  } catch (err) {
    warnings.push(describe(err, 'approvals'));
  }

  // --- MEV ------------------------------------------------------------------
  let mevEvents: Awaited<ReturnType<ChainAdapter['detectMev']>> = [];
  if (!opts.skipMev && txs.length > 0) {
    log('checking for sandwich attacks…');
    try {
      mevEvents = await adapter.detectMev(address, txs, opts);
      log(`${mevEvents.length} sandwiches detected`);
    } catch (err) {
      warnings.push(describe(err, 'mev'));
    }
  }

  // --- Positions ------------------------------------------------------------
  log('reconstructing cost basis…');
  const nativePriceByDay = await buildNativePriceMap(chain, txs, prices);
  const { positions, unvaluedTransfers } = computePositions(
    chain,
    txs,
    balances,
    nativePriceByDay,
  );
  if (unvaluedTransfers > 0) {
    warnings.push(
      `${unvaluedTransfers} transfers could not be valued (no stablecoin or native leg to ` +
        `anchor against). Those movements are excluded from PnL rather than guessed at.`,
    );
  }

  // --- Exit liquidity -------------------------------------------------------
  let liquidity: Awaited<ReturnType<typeof computeExitLiquidity>> = [];
  if (!opts.skipLiquidity && balances.length > 0) {
    log('quoting exit liquidity…');
    try {
      liquidity = await computeExitLiquidity(adapter, balances);
    } catch (err) {
      warnings.push(describe(err, 'liquidity'));
    }
  }

  // --- Summaries ------------------------------------------------------------
  const currentNative = await prices.nativePrice(chain);
  const fees = summarizeFees(chain, txs, currentNative);
  const activity = summarizeActivity(chain, address, txs);

  const regrets = collectRegrets({
    positions,
    mev: mevEvents,
    approvals,
    liquidity,
    fees,
    txs,
  });

  return {
    chain,
    address,
    activity,
    fees,
    positions,
    balances,
    approvals,
    mev: {
      events: mevEvents,
      totalExtractedUsd: mevEvents.reduce((s, e) => s + e.extractedUsd, 0),
    },
    liquidity,
    regrets,
    warnings,
  };
}

/** Run the pipeline across every requested chain and combine the results. */
export async function analyze(
  targets: Array<{ chain: Chain; address: string }>,
  opts: AnalysisOptions = DEFAULT_OPTIONS,
): Promise<ForensicsReport> {
  const prices = new PriceOracle();
  const chains: ChainReport[] = [];

  for (const target of targets) {
    if (opts.verbose) {
      process.stderr.write(`\n${target.chain} — ${target.address}\n`);
    }
    chains.push(await analyzeChain(target.chain, target.address, prices, opts));
  }

  const totals = {
    realizedPnlUsd: sum(chains, (c) => sum(c.positions, (p) => p.realizedPnlUsd)),
    unrealizedPnlUsd: sum(chains, (c) => sum(c.positions, (p) => p.unrealizedPnlUsd)),
    feesUsd: sum(chains, (c) => c.fees.totalUsdHistorical ?? 0),
    mevExtractedUsd: sum(chains, (c) => c.mev.totalExtractedUsd),
    portfolioNominalUsd: sum(chains, (c) => sum(c.balances, (b) => b.valueUsd ?? 0)),
    portfolioRealizableUsd: sum(chains, (c) => {
      // Positions we route-quoted use the real number; anything too small to
      // quote falls back to nominal, which is fine at that size.
      const quoted = new Map(c.liquidity.map((l) => [l.asset, l.realizableUsd]));
      return sum(c.balances, (b) => quoted.get(b.asset) ?? b.valueUsd ?? 0);
    }),
  };

  const topRegrets = chains
    .flatMap((c) => c.regrets)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);

  return {
    generatedAt: new Date(),
    chains,
    totals,
    topRegrets,
  };
}

/** One native price lookup per distinct day in the history. */
async function buildNativePriceMap(
  chain: Chain,
  txs: NormalizedTx[],
  prices: PriceOracle,
): Promise<Map<string, number>> {
  const days = new Map<string, Date>();
  for (const tx of txs) {
    if (tx.timestamp.getTime() === 0) continue;
    days.set(tx.timestamp.toISOString().slice(0, 10), tx.timestamp);
  }

  const map = new Map<string, number>();
  for (const [day, when] of days) {
    const price = await prices.nativePriceOn(chain, when);
    if (price !== undefined) map.set(day, price);
  }
  return map;
}

function describe(err: unknown, stage: string): string {
  if (err instanceof AdapterWarning) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `${stage}: ${message.slice(0, 200)}`;
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return items.reduce((acc, item) => acc + (pick(item) || 0), 0);
}
