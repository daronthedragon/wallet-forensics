import type { ActivitySummary, Chain, NormalizedTx } from '../types.js';

/** Headline activity statistics for an address. */
export function summarizeActivity(
  chain: Chain,
  address: string,
  txs: NormalizedTx[],
): ActivitySummary {
  if (txs.length === 0) {
    return {
      address,
      chain,
      totalTxs: 0,
      failedTxs: 0,
      uniqueCounterparties: 0,
      topProtocols: [],
    };
  }

  const times = txs.map((t) => t.timestamp.getTime()).filter((t) => t > 0);
  const firstSeen = times.length ? new Date(Math.min(...times)) : undefined;
  const lastSeen = times.length ? new Date(Math.max(...times)) : undefined;

  const counterparties = new Set<string>();
  const protocolCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  let failed = 0;

  for (const tx of txs) {
    if (tx.failed) failed++;
    if (tx.counterparty) counterparties.add(tx.counterparty.toLowerCase());

    if (tx.label) {
      // Collapse "Uniswap V3 Router: swapExactTokensForTokens" to the protocol.
      const protocol = tx.label.split(':')[0]!.trim();
      protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
    }

    if (tx.timestamp.getTime() > 0) {
      const day = tx.timestamp.toISOString().slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }
  }

  const topProtocols = [...protocolCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  let busiestDay: ActivitySummary['busiestDay'];
  for (const [date, count] of dayCounts) {
    if (!busiestDay || count > busiestDay.count) busiestDay = { date, count };
  }

  const ageDays = firstSeen
    ? Math.floor((Date.now() - firstSeen.getTime()) / 86_400_000)
    : undefined;

  return {
    address,
    chain,
    firstSeen,
    lastSeen,
    ageDays,
    totalTxs: txs.length,
    failedTxs: failed,
    uniqueCounterparties: counterparties.size,
    topProtocols,
    busiestDay,
  };
}
