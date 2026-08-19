import { stablesFor } from '../config.js';
import { computePositions as coreComputePositions } from '../core/analysis.mjs';
import type { Chain, NormalizedTx, Position, TokenBalance, TokenTransfer } from '../types.js';

/*
 * Stablecoins act as the numeraire for cost-basis inference. If one side of a
 * swap is a dollar, we know exactly what the other side cost. The per-chain
 * lists live in config.ts alongside the rest of each chain setup.
 */
/**
 * Weighted-average-cost position tracking.
 *
 * The hard part of on-chain PnL is not the accounting, it is knowing what
 * anything was worth at the moment it moved. Fetching a historical price for
 * every token on every day is thousands of API calls and most long-tail tokens
 * have no price history at all.
 *
 * So instead we infer value from the transaction itself. A swap has two sides;
 * if either side is a stablecoin or the chain's native asset, that side tells
 * us the dollar value of the whole trade, and we attribute it to the other
 * side. This covers the overwhelming majority of real trades and needs one
 * price lookup per day rather than per token per day.
 *
 * Transfers we cannot value (an airdrop of an unknown token, a transfer between
 * the user's own wallets) get a zero cost basis and are flagged rather than
 * guessed at.
 */
/**
 * Typed adapter over the shared analysis core.
 *
 * The algorithm lives in src/core/analysis.mjs, vendored from the skill repo,
 * so the two implementations cannot drift apart again. This file's job is to
 * keep the strongly typed signature the rest of the codebase already uses, and
 * to translate the two field names that differ between the two sides.
 */
export function computePositions(
  chain: Chain,
  txs: NormalizedTx[],
  balances: TokenBalance[],
  nativePriceByDay: Map<string, number>,
): { positions: Position[]; unvaluedTransfers: number } {
  const { positions, unvalued } = coreComputePositions(
    {
      // The core calls it `ts`; this codebase calls it `timestamp`.
      txs: txs.map((t) => ({ ...t, ts: t.timestamp })),
      balances,
      stables: stablesFor(chain),
    },
    nativePriceByDay,
  );

  return { positions: positions as Position[], unvaluedTransfers: unvalued };
}
