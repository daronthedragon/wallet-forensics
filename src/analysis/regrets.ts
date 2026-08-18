import type {
  Approval,
  ExitLiquidity,
  FeeSummary,
  MevEvent,
  NormalizedTx,
  Position,
  Regret,
} from '../types.js';

/**
 * Rank the expensive mistakes.
 *
 * Everything above this point produces neutral measurements. This module makes
 * the judgment call about what counts as a mistake and what it cost, which is
 * the part a reader actually remembers.
 *
 * Ranking is strictly by dollar cost, deliberately. A $12,000 unlimited approval
 * to an unknown contract outranks a $400 bad trade even though the trade already
 * happened and the approval is only a risk — because the approval can still take
 * the twelve thousand.
 */
export function collectRegrets(input: {
  positions: Position[];
  mev: MevEvent[];
  approvals: Approval[];
  liquidity: ExitLiquidity[];
  fees: FeeSummary;
  txs: NormalizedTx[];
}): Regret[] {
  const regrets: Regret[] = [];

  // --- Worst realized trade -------------------------------------------------
  const losers = input.positions
    .filter((p) => p.realizedPnlUsd < 0)
    .sort((a, b) => a.realizedPnlUsd - b.realizedPnlUsd);

  const worst = losers[0];
  if (worst && worst.realizedPnlUsd < -50) {
    regrets.push({
      kind: 'worst-trade',
      title: `Worst realized loss: ${worst.symbol ?? shorten(worst.asset)}`,
      detail:
        `Closed out ${worst.sells} sale${worst.sells === 1 ? '' : 's'} for a realized loss of ` +
        `${usd(Math.abs(worst.realizedPnlUsd))}.`,
      costUsd: Math.abs(worst.realizedPnlUsd),
      reference: worst.asset,
      timestamp: worst.lastActivity,
    });
  }

  // --- MEV extraction -------------------------------------------------------
  const totalMev = input.mev.reduce((sum, e) => sum + e.extractedUsd, 0);
  if (totalMev > 0) {
    const biggest = [...input.mev].sort((a, b) => b.extractedUsd - a.extractedUsd)[0]!;
    regrets.push({
      kind: 'mev-victim',
      title: `Sandwiched ${input.mev.length} time${input.mev.length === 1 ? '' : 's'}`,
      detail:
        `${usd(totalMev)} extracted by MEV bots. Largest single hit: ${usd(biggest.extractedUsd)} ` +
        `in block ${biggest.block}.`,
      costUsd: totalMev,
      reference: biggest.victimTx,
      timestamp: biggest.timestamp,
    });
  } else if (input.mev.length > 0) {
    // Detected structurally but value could not be attributed.
    regrets.push({
      kind: 'mev-victim',
      title: `Sandwiched ${input.mev.length} time${input.mev.length === 1 ? '' : 's'}`,
      detail:
        `Bracketing transactions detected around your swaps. Extracted value could not be ` +
        `attributed automatically — inspect the linked transactions.`,
      costUsd: 0,
      reference: input.mev[0]!.victimTx,
      timestamp: input.mev[0]!.timestamp,
    });
  }

  // --- Fees burned on reverted transactions ---------------------------------
  const failedCount = input.txs.filter((t) => t.failed).length;
  if (input.fees.wastedOnFailedUsd && input.fees.wastedOnFailedUsd > 10) {
    regrets.push({
      kind: 'failed-tx-burn',
      title: `${failedCount} failed transaction${failedCount === 1 ? '' : 's'}`,
      detail:
        `${usd(input.fees.wastedOnFailedUsd)} in fees paid for transactions that reverted. ` +
        `The network charges you for the attempt either way.`,
      costUsd: input.fees.wastedOnFailedUsd,
    });
  }

  // --- Dangerous standing approvals ----------------------------------------
  for (const approval of input.approvals.filter(
    (a) => a.risk === 'critical' || (a.risk === 'high' && (a.atRiskUsd ?? 0) > 1_000),
  )) {
    regrets.push({
      kind: 'stale-approval',
      title: `${approval.allowance === null ? 'Unlimited' : 'Large'} approval: ${approval.symbol ?? shorten(approval.asset)}`,
      detail:
        `${approval.spenderLabel ?? shorten(approval.spender)} can move ` +
        `${usd(approval.atRiskUsd ?? 0)} of your ${approval.symbol ?? 'tokens'} right now. ` +
        approval.riskReasons.join('. ') +
        '.',
      costUsd: approval.atRiskUsd ?? 0,
      reference: approval.spender,
    });
  }

  // --- Positions that cannot actually be exited ----------------------------
  for (const pos of input.liquidity) {
    if (pos.liquidityRatio >= 0.9) continue;
    if (pos.nominalUsd < 100) continue;

    const gap = pos.nominalUsd - pos.realizableUsd;
    regrets.push({
      kind: 'illiquid-bag',
      title: `Illiquid position: ${pos.symbol ?? shorten(pos.asset)}`,
      detail: pos.error
        ? `Shows as ${usd(pos.nominalUsd)} but no sell route exists. This may be unsellable.`
        : `Shows as ${usd(pos.nominalUsd)} but would realize ${usd(pos.realizableUsd)} — ` +
          `${Math.round(pos.fullExitImpact * 100)}% price impact to exit. ` +
          `Only ${usd(pos.maxExitUnder5Pct)} can be sold cleanly.`,
      costUsd: gap,
      reference: pos.asset,
    });
  }

  return regrets.sort((a, b) => b.costUsd - a.costUsd);
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
