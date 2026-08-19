/*
 * VENDORED — do not edit here.
 *
 * Upstream: https://github.com/daronthedragon/wallet-forensics-skill
 *           core/analysis.mjs
 *
 * The skill must stay installable by cloning it alone, so it cannot depend on
 * a package published from this repo. Copying the file and gating on drift is
 * therefore the honest arrangement: CI fetches upstream and fails if the two
 * differ, which is the check that was missing when these implementations
 * silently diverged.
 *
 * To change this logic: edit it upstream, then re-run scripts/sync-core.sh.
 */
/**
 * Shared analysis core.
 *
 * These are the pure functions — money in, money out, no I/O — that both the
 * TypeScript implementation and the zero-dependency skill depend on. They live
 * in one file because keeping two copies in step by hand already failed once:
 * a fix landed in TypeScript that distinguished "the quote was refused" from
 * "no market exists", and the JavaScript copy kept reporting both as a total
 * loss for a while afterwards.
 *
 * Rules for anything added here:
 *   - No imports. This file is vendored into a repo that must stay
 *     dependency-free, and copied verbatim into one that type-checks it.
 *   - No config objects with repo-specific field names. Take the two or three
 *     values actually needed, so neither caller has to reshape its own config.
 *   - Types via JSDoc, so `tsc --checkJs` can verify this from the TypeScript
 *     side without a build step on the JavaScript side.
 */

/** Sentinel used in place of a contract address for a chain's native asset. */
export const NATIVE_ASSET = 'native';

/**
 * @typedef {Object} Numeraire
 * @property {string} wrappedNative   Wrapped native token address.
 * @property {number} nativeDecimals  Decimals of the native asset.
 * @property {Record<string, number>} stables  Stablecoin address -> decimals.
 */

export const usd = (n) =>
  !Number.isFinite(n)
    ? '$0'
    : Math.abs(n) >= 1000
      ? `$${Math.round(n).toLocaleString('en-US')}`
      : `$${n.toFixed(2)}`;

export const short = (s) => (s && s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

export function wrap(text, indent, width = 74) {
  const pad = ' '.repeat(indent);
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(pad + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(pad + line);
  return lines.join('\n');
}

export function isSwapShaped(tx) {
  let sent = false;
  let received = false;
  for (const t of tx.transfers) {
    if (t.amount < 0n) sent = true;
    if (t.amount > 0n) received = true;
  }
  return sent && received;
}

export function poolsTouched(logs, actor) {
  const a = actor.toLowerCase();
  const pools = new Set();
  for (const l of logs) {
    if (l.from === a) pools.add(l.to);
    if (l.to === a) pools.add(l.from);
  }
  return pools;
}

/**
 * @param {Array<{token:string,from:string,to:string,value:bigint}>} frontLogs
 * @param {Array<{token:string,from:string,to:string,value:bigint}>} backLogs
 * @param {string} attacker
 * @param {Numeraire} numeraire
 * @param {number} [nativePrice]
 * @returns {number} USD extracted, or 0 when the flow cannot be measured.
 */
export function estimateMevProfit(frontLogs, backLogs, attacker, numeraire, nativePrice) {
  const a = attacker.toLowerCase();
  const net = (token, decimals) => {
    let delta = 0n;
    for (const l of [...frontLogs, ...backLogs]) {
      if (l.token !== token) continue;
      if (l.to === a) delta += l.value;
      if (l.from === a) delta -= l.value;
    }
    return Number(delta) / 10 ** decimals;
  };

  const wrappedGain = net(numeraire.wrappedNative.toLowerCase(), numeraire.nativeDecimals);
  if (wrappedGain > 0 && nativePrice) return wrappedGain * nativePrice;

  for (const [stable, decimals] of Object.entries(numeraire.stables)) {
    const gain = net(stable.toLowerCase(), decimals);
    if (gain > 0) return gain;
  }
  return 0;
}

/**
 * Weighted-average cost basis, with each trade valued from its stablecoin
 * or native leg. See the methodology reference for why, and where it fails.
 *
 * @param {{txs: any[], balances: any[], stables: Record<string, number>}} input
 * @param {Map<string, number>} nativePriceByDay  yyyy-mm-dd -> native USD price
 * @returns {{positions: any[], unvalued: number}}
 */
export function computePositions(input, nativePriceByDay) {
  const stables = input.stables ?? {};
  const isStable = (a) => a?.toLowerCase() in stables || a in stables;
  const positions = new Map();
  let unvalued = 0;

  const ordered = [...input.txs].sort((a, b) => a.ts - b.ts);

  for (const tx of ordered) {
    if (tx.failed || !tx.transfers.length) continue;
    const nativePrice = nativePriceByDay.get(tx.ts.toISOString().slice(0, 10));

    // Anchor: a stablecoin leg gives the dollar value outright; failing that,
    // the native leg priced at that day's rate.
    let anchor;
    for (const t of tx.transfers) {
      if (!isStable(t.asset)) continue;
      const d = stables[t.asset?.toLowerCase()] ?? stables[t.asset] ?? t.decimals;
      const usd = Math.abs(Number(t.amount)) / 10 ** d;
      if (usd > 0) {
        anchor = { usd, legs: tx.transfers.filter((x) => !isStable(x.asset) && x.amount !== 0n).length };
        break;
      }
    }
    if (!anchor && nativePrice !== undefined) {
      for (const t of tx.transfers) {
        if (t.asset !== NATIVE_ASSET) continue;
        const usd = (Math.abs(Number(t.amount)) / 10 ** t.decimals) * nativePrice;
        if (usd > 0) {
          anchor = {
            usd,
            legs: tx.transfers.filter((x) => x.asset !== NATIVE_ASSET && !isStable(x.asset) && x.amount !== 0n).length,
          };
          break;
        }
      }
    }

    for (const t of tx.transfers) {
      if (t.amount === 0n || isStable(t.asset)) continue;

      const pos = positions.get(t.asset) ?? {
        asset: t.asset,
        symbol: t.symbol,
        decimals: t.decimals,
        openAmount: 0n,
        costBasisUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        buys: 0,
        sells: 0,
      };
      if (t.symbol && !pos.symbol) pos.symbol = t.symbol;

      const legValue = anchor ? anchor.usd / Math.max(1, anchor.legs) : undefined;
      if (legValue === undefined) unvalued++;

      if (t.amount > 0n) {
        pos.openAmount += t.amount;
        pos.costBasisUsd += legValue ?? 0;
        pos.buys++;
      } else {
        const sold = -t.amount;
        if (pos.openAmount > 0n) {
          const fraction = Math.min(1, Number(sold) / Number(pos.openAmount));
          const released = pos.costBasisUsd * fraction;
          pos.costBasisUsd -= released;
          pos.openAmount -= sold;
          if (pos.openAmount < 0n) pos.openAmount = 0n;
          if (legValue !== undefined) pos.realizedPnlUsd += legValue - released;
        } else if (legValue !== undefined) {
          // Sold something never seen acquired — airdrop, bridge, or history
          // older than the fetched window. Treat proceeds as pure gain.
          pos.realizedPnlUsd += legValue;
        }
        pos.sells++;
      }
      positions.set(t.asset, pos);
    }
  }

  // Mark to market. Absence from `balances` means zero only if we actually
  // have balance data — otherwise a failed balance fetch would erase everything.
  const haveBalances = input.balances.length > 0;
  const byAsset = new Map(input.balances.map((b) => [b.asset, b]));
  for (const pos of positions.values()) {
    const bal = byAsset.get(pos.asset);
    if (!bal) {
      if (haveBalances) {
        pos.openAmount = 0n;
        pos.unrealizedPnlUsd = 0;
      }
      continue;
    }
    pos.openAmount = bal.amount;
    if (bal.valueUsd !== undefined) pos.unrealizedPnlUsd = bal.valueUsd - pos.costBasisUsd;
  }

  const list = [...positions.values()].filter(
    (p) => p.buys + p.sells > 0 && (p.openAmount > 0n || p.realizedPnlUsd !== 0 || p.costBasisUsd > 0),
  );
  list.sort(
    (a, b) =>
      Math.abs(b.realizedPnlUsd + b.unrealizedPnlUsd) - Math.abs(a.realizedPnlUsd + a.unrealizedPnlUsd),
  );
  return { positions: list, unvalued };
}

export function collectRegrets(chain) {
  const out = [];

  const worst = chain.positions.filter((p) => p.realizedPnlUsd < -50).sort((a, b) => a.realizedPnlUsd - b.realizedPnlUsd)[0];
  if (worst) {
    out.push({
      kind: 'worst-trade',
      title: `Worst realized loss: ${worst.symbol ?? short(worst.asset)}`,
      detail: `Realized a loss of ${usd(Math.abs(worst.realizedPnlUsd))} across ${worst.sells} sale(s).`,
      costUsd: Math.abs(worst.realizedPnlUsd),
    });
  }

  if (chain.fees.wastedOnFailedUsd > 10) {
    out.push({
      kind: 'failed-tx-burn',
      title: `${chain.activity.failedTxs} failed transaction(s)`,
      detail: `${usd(chain.fees.wastedOnFailedUsd)} in fees paid for transactions that reverted.`,
      costUsd: chain.fees.wastedOnFailedUsd,
    });
  }

  const mevTotal = chain.mev.totalExtractedUsd;
  if (chain.mev.events.length) {
    const biggest = chain.mev.events[0];
    out.push({
      kind: 'mev-victim',
      title: `Sandwiched ${chain.mev.events.length} time(s)`,
      detail: mevTotal > 0
        ? `${usd(mevTotal)} extracted by MEV bots. Largest single hit ${usd(biggest.extractedUsd)} in block ${biggest.block}.`
        : `Bracketing transactions detected around your swaps, but the extracted value could not be attributed automatically.`,
      costUsd: mevTotal,
    });
  }

  for (const a of chain.approvals.filter((x) => x.risk === 'critical' || (x.risk === 'high' && (x.atRiskUsd ?? 0) > 1000))) {
    out.push({
      kind: 'stale-approval',
      title: `${a.allowance === null ? 'Unlimited' : 'Large'} approval: ${a.symbol ?? short(a.asset)}`,
      detail: `${a.spenderLabel ?? short(a.spender)} can move ${usd(a.atRiskUsd ?? 0)} right now. ${a.riskReasons.join('. ')}.`,
      costUsd: a.atRiskUsd ?? 0,
    });
  }

  for (const l of chain.liquidity) {
    // An unanswered quote is not evidence of a loss, so it is never ranked as
    // one. It still shows in the liquidity table with its reason attached.
    if (l.quoted === false && l.liquidityRatio === undefined) continue;
    if ((l.liquidityRatio ?? 1) >= 0.9 || (l.nominalUsd ?? 0) < 100) continue;
    out.push({
      kind: 'illiquid-bag',
      title: `Illiquid position: ${l.symbol ?? short(l.asset)}`,
      detail: l.error
        ? `Shows as ${usd(l.nominalUsd)} but no sell route exists. This may be unsellable.`
        : `Shows as ${usd(l.nominalUsd)} but would realize ${usd(l.realizableUsd)} — ${Math.round(l.fullExitImpact * 100)}% price impact to exit.`,
      costUsd: (l.nominalUsd ?? 0) - (l.realizableUsd ?? 0),
    });
  }

  return out.sort((a, b) => b.costUsd - a.costUsd);
}
