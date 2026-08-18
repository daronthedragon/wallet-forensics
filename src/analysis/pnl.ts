import { NATIVE_ASSET } from '../config.js';
import type { Chain, NormalizedTx, Position, TokenBalance, TokenTransfer } from '../types.js';

/**
 * Stablecoins act as the numeraire for cost-basis inference. If one side of a
 * swap is a dollar, we know exactly what the other side cost.
 */
const STABLES: Record<Chain, Record<string, number>> = {
  ethereum: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
    '0x4fabb145d64652a948d72533023f6e7a623c7c53': 18, // BUSD
  },
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  },
};

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
export function computePositions(
  chain: Chain,
  txs: NormalizedTx[],
  balances: TokenBalance[],
  nativePriceByDay: Map<string, number>,
): { positions: Position[]; unvaluedTransfers: number } {
  const stables = STABLES[chain];
  const positions = new Map<string, Position>();
  let unvaluedTransfers = 0;

  // Oldest first — cost basis is inherently chronological.
  const ordered = [...txs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const tx of ordered) {
    if (tx.failed || tx.transfers.length === 0) continue;

    const day = tx.timestamp.toISOString().slice(0, 10);
    const nativePrice = nativePriceByDay.get(day);
    const anchor = valueAnchor(tx.transfers, stables, nativePrice);

    for (const transfer of tx.transfers) {
      if (transfer.amount === 0n) continue;
      if (isStable(transfer.asset, stables)) continue; // dollars are not a position

      const pos = positions.get(transfer.asset) ?? {
        asset: transfer.asset,
        symbol: transfer.symbol,
        decimals: transfer.decimals,
        openAmount: 0n,
        costBasisUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        buys: 0,
        sells: 0,
        firstAcquired: undefined,
        lastActivity: undefined,
      };

      if (transfer.symbol && !pos.symbol) pos.symbol = transfer.symbol;
      pos.lastActivity = tx.timestamp;

      const units = Math.abs(Number(transfer.amount)) / 10 ** transfer.decimals;

      // Value this leg. When several legs share one anchor, split it by the
      // number of non-stable legs so a multi-hop swap doesn't double-count.
      const legValue = anchor
        ? anchor.usd / Math.max(1, anchor.oppositeLegs)
        : undefined;

      if (legValue === undefined) unvaluedTransfers++;

      if (transfer.amount > 0n) {
        // Acquisition.
        pos.openAmount += transfer.amount;
        pos.costBasisUsd += legValue ?? 0;
        pos.buys++;
        pos.firstAcquired ??= tx.timestamp;
      } else {
        // Disposal. Realize against the weighted-average basis.
        const sold = -transfer.amount;
        const heldBefore = pos.openAmount;

        if (heldBefore > 0n) {
          const fraction = Number(sold) / Number(heldBefore);
          const clamped = Math.min(1, fraction);
          const basisReleased = pos.costBasisUsd * clamped;

          pos.costBasisUsd -= basisReleased;
          pos.openAmount -= sold;
          if (pos.openAmount < 0n) pos.openAmount = 0n;

          if (legValue !== undefined) {
            pos.realizedPnlUsd += legValue - basisReleased;
          }
        } else {
          // Selling something we never saw acquired — an airdrop, a bridge in,
          // or history that predates our window. Treat proceeds as pure gain.
          if (legValue !== undefined) pos.realizedPnlUsd += legValue;
        }
        pos.sells++;
      }

      void units;
      positions.set(transfer.asset, pos);
    }
  }

  // Mark open positions to market using current balances.
  //
  // An asset missing from `balances` means the holding is zero — but only when
  // we actually have balance data. If the balance fetch failed upstream we get
  // an empty array, and treating that as "you hold nothing" would silently
  // erase every reconstructed position.
  const haveBalanceData = balances.length > 0;
  const balanceByAsset = new Map(balances.map((b) => [b.asset, b]));

  for (const pos of positions.values()) {
    const bal = balanceByAsset.get(pos.asset);
    if (!bal) {
      if (haveBalanceData) {
        pos.openAmount = 0n;
        pos.unrealizedPnlUsd = 0;
      }
      continue;
    }

    // Trust the live balance over our reconstruction — it accounts for
    // transfers that fell outside the fetched window.
    pos.openAmount = bal.amount;

    if (bal.valueUsd !== undefined) {
      pos.unrealizedPnlUsd = bal.valueUsd - pos.costBasisUsd;
    }
  }

  const result = [...positions.values()].filter(
    (p) =>
      p.buys + p.sells > 0 &&
      (p.openAmount > 0n || p.realizedPnlUsd !== 0 || p.costBasisUsd > 0),
  );

  result.sort(
    (a, b) =>
      Math.abs(b.realizedPnlUsd + b.unrealizedPnlUsd) -
      Math.abs(a.realizedPnlUsd + a.unrealizedPnlUsd),
  );

  return { positions: result, unvaluedTransfers };
}

/**
 * Find the dollar value of a transaction by looking for a leg we can price
 * directly, and count how many legs that value should be attributed to.
 */
function valueAnchor(
  transfers: TokenTransfer[],
  stables: Record<string, number>,
  nativePrice?: number,
): { usd: number; oppositeLegs: number } | undefined {
  // A stablecoin leg is the strongest anchor: it is the dollar value outright.
  for (const t of transfers) {
    if (!isStable(t.asset, stables)) continue;
    const decimals = stables[t.asset.toLowerCase()] ?? t.decimals;
    const usd = Math.abs(Number(t.amount)) / 10 ** decimals;
    if (usd > 0) {
      const opposite = transfers.filter(
        (x) => !isStable(x.asset, stables) && x.amount !== 0n,
      ).length;
      return { usd, oppositeLegs: Math.max(1, opposite) };
    }
  }

  // Otherwise the native asset, priced at that day's rate.
  if (nativePrice !== undefined) {
    for (const t of transfers) {
      if (t.asset !== NATIVE_ASSET) continue;
      const usd = (Math.abs(Number(t.amount)) / 10 ** t.decimals) * nativePrice;
      if (usd > 0) {
        const opposite = transfers.filter(
          (x) => x.asset !== NATIVE_ASSET && !isStable(x.asset, stables) && x.amount !== 0n,
        ).length;
        return { usd, oppositeLegs: Math.max(1, opposite) };
      }
    }
  }

  return undefined;
}

function isStable(asset: string, stables: Record<string, number>): boolean {
  return asset.toLowerCase() in stables || asset in stables;
}
