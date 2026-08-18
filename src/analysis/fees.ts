import { nativeDecimals, nativeSymbol } from '../config.js';
import type { Chain, FeeSummary, NormalizedTx } from '../types.js';

/**
 * Total transaction costs over an address's lifetime.
 *
 * Two numbers are reported because they answer different questions:
 *
 *   totalUsdHistorical      — what it actually cost you, at the prices you paid
 *   totalUsdAtCurrentPrice  — what that same native currency is worth today
 *
 * The gap between them is usually the more interesting figure. Someone who
 * burned 4 ETH on gas in 2021 spent roughly $12k at the time, but they also gave
 * up an asset worth something quite different now.
 */
export function summarizeFees(
  chain: Chain,
  txs: NormalizedTx[],
  currentNativePrice?: number,
): FeeSummary {
  const decimals = nativeDecimals(chain);
  const symbol = nativeSymbol(chain);

  let totalNative = 0n;
  let totalUsd = 0;
  let pricedCount = 0;
  let wastedOnFailed = 0;
  let mostExpensive: FeeSummary['mostExpensiveTx'];

  for (const tx of txs) {
    if (tx.fee === 0n) continue;
    totalNative += tx.fee;

    if (tx.feeUsd !== undefined) {
      totalUsd += tx.feeUsd;
      pricedCount++;

      if (tx.failed) wastedOnFailed += tx.feeUsd;

      if (!mostExpensive || tx.feeUsd > mostExpensive.usd) {
        mostExpensive = { id: tx.id, usd: tx.feeUsd, timestamp: tx.timestamp };
      }
    }
  }

  const nativeFloat = Number(totalNative) / 10 ** decimals;

  return {
    chain,
    totalNative,
    nativeSymbol: symbol,
    totalUsdHistorical: pricedCount > 0 ? totalUsd : undefined,
    totalUsdAtCurrentPrice: currentNativePrice ? nativeFloat * currentNativePrice : undefined,
    wastedOnFailedUsd: wastedOnFailed > 0 ? wastedOnFailed : undefined,
    averageUsdPerTx: pricedCount > 0 ? totalUsd / pricedCount : undefined,
    mostExpensiveTx: mostExpensive,
  };
}
