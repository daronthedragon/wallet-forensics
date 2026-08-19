import type { ChainAdapter } from '../adapters/types.js';
import { NATIVE_ASSET } from '../config.js';
import type { ExitLiquidity, TokenBalance } from '../types.js';

/** Positions below this nominal value are not worth the quote calls. */
const MIN_POSITION_USD = 25;

/** Cap on how many positions we route-quote, largest first. */
const MAX_POSITIONS = 15;

/** The impact threshold that defines a "clean" exit. */
const CLEAN_EXIT_IMPACT = 0.05;

/**
 * Answer the question portfolio trackers refuse to ask: if you tried to sell
 * this, what would you actually get?
 *
 * Every tracker reports `balance x spot price`. For anything outside the top
 * few hundred tokens that number is fiction — spot price comes from the last
 * trade, which may have been for $40 against a pool holding $3,000. Selling a
 * $50,000 position into that pool does not yield $50,000.
 *
 * We route-quote the real sale and report the gap.
 */
export async function computeExitLiquidity(
  adapter: ChainAdapter,
  balances: TokenBalance[],
): Promise<ExitLiquidity[]> {
  const candidates = balances
    .filter((b) => (b.valueUsd ?? 0) >= MIN_POSITION_USD)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .slice(0, MAX_POSITIONS);

  const out: ExitLiquidity[] = [];

  for (const bal of candidates) {
    const nominalUsd = bal.valueUsd ?? 0;

    // The native asset is liquid at any size this tool will encounter.
    if (bal.asset === NATIVE_ASSET) {
      out.push({
        asset: bal.asset,
        symbol: bal.symbol,
        nominalUsd,
        realizableUsd: nominalUsd,
        maxExitUnder5Pct: nominalUsd,
        fullExitImpact: 0,
        liquidityRatio: 1,
        quoted: true,
      });
      continue;
    }

    const full = await adapter.quoteSell(bal.asset, bal.amount, bal.decimals);
    if (!full.ok) {
      // Only a refused route says anything about the position. Being unable to
      // price it, or the chain having no quoter, are gaps on our side — and
      // recording them as zero would invent a total loss that we never
      // measured, then report it as a finding.
      const REASONS: Record<typeof full.reason, string> = {
        'no-route': 'No route found — this position may be unsellable',
        'no-price': 'Quote unavailable — the token could not be priced',
        unsupported: 'Quote unavailable — no router configured for this chain',
      };
      const refused = full.reason === 'no-route';
      out.push({
        asset: bal.asset,
        symbol: bal.symbol,
        nominalUsd,
        realizableUsd: refused ? 0 : nominalUsd,
        maxExitUnder5Pct: 0,
        fullExitImpact: refused ? 1 : 0,
        liquidityRatio: refused ? 0 : 1,
        quoted: false,
        error: REASONS[full.reason],
      });
      continue;
    }

    const maxClean =
      full.priceImpact <= CLEAN_EXIT_IMPACT
        ? full.proceedsUsd
        : await findCleanExitSize(adapter, bal, nominalUsd);

    out.push({
      asset: bal.asset,
      symbol: bal.symbol,
      nominalUsd,
      realizableUsd: full.proceedsUsd,
      maxExitUnder5Pct: maxClean,
      fullExitImpact: full.priceImpact,
      liquidityRatio: nominalUsd > 0 ? full.proceedsUsd / nominalUsd : 0,
      quoted: true,
    });
  }

  return out.sort((a, b) => a.liquidityRatio - b.liquidityRatio);
}

/**
 * Binary search for the largest sale that stays under the impact threshold.
 *
 * Six iterations gets within ~1.5% of the true boundary, which is well inside
 * the noise of the underlying quotes and keeps the call count sane.
 */
async function findCleanExitSize(
  adapter: ChainAdapter,
  bal: TokenBalance,
  nominalUsd: number,
): Promise<number> {
  let lo = 0n;
  let hi = bal.amount;
  let best = 0;

  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) break;

    const quote = await adapter.quoteSell(bal.asset, mid, bal.decimals);
    if (quote.ok && quote.priceImpact <= CLEAN_EXIT_IMPACT) {
      best = quote.proceedsUsd;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  void nominalUsd;
  return best;
}
