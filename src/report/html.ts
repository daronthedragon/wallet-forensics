import { formatUnits } from 'viem';

import { chainLabel, nativeDecimals } from '../config.js';
import type { ChainReport, ForensicsReport } from '../types.js';

/**
 * Render a self-contained HTML report.
 *
 * No external requests: styles are inline, there are no fonts to fetch and no
 * scripts. The file works offline, opens straight from disk, and can be handed
 * to anyone.
 */
export function renderHtml(report: ForensicsReport): string {
  const t = report.totals;
  const netPnl = t.realizedPnlUsd + t.unrealizedPnlUsd;
  const evaporation =
    t.portfolioNominalUsd > 0
      ? ((t.portfolioNominalUsd - t.portfolioRealizableUsd) / t.portfolioNominalUsd) * 100
      : 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wallet Forensics</title>
<style>
  :root {
    --bg: #ffffff;
    --surface: #f7f7f8;
    --border: #e4e4e7;
    --text: #18181b;
    --muted: #71717a;
    --accent: #4f46e5;
    --pos: #15803d;
    --neg: #b91c1c;
    --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b0b0e;
      --surface: #141418;
      --border: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #818cf8;
      --pos: #4ade80;
      --neg: #f87171;
      --warn: #fbbf24;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b0b0e; --surface: #141418; --border: #27272a; --text: #fafafa;
    --muted: #a1a1aa; --accent: #818cf8; --pos: #4ade80; --neg: #f87171; --warn: #fbbf24;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2.5rem 1.25rem 5rem;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 {
    font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 2.5rem 0 .85rem; font-weight: 600;
  }
  .sub { color: var(--muted); font-size: .85rem; margin: 0 0 2rem; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: .75rem; }
  .stat {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: .9rem 1rem;
  }
  .stat .k { font-size: .72rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .stat .v { font-size: 1.35rem; font-weight: 600; margin-top: .2rem; letter-spacing: -.02em; }
  .stat .n { font-size: .75rem; color: var(--muted); margin-top: .15rem; }

  .pos { color: var(--pos); } .neg { color: var(--neg); } .warn { color: var(--warn); }

  .regret {
    border-left: 3px solid var(--neg); background: var(--surface);
    padding: .75rem 1rem; border-radius: 0 8px 8px 0; margin-bottom: .6rem;
  }
  .regret .t { font-weight: 600; display: flex; justify-content: space-between; gap: 1rem; }
  .regret .d { color: var(--muted); font-size: .87rem; margin-top: .2rem; }

  .tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th {
    text-align: left; font-weight: 500; color: var(--muted); font-size: .72rem;
    text-transform: uppercase; letter-spacing: .05em; padding: .6rem .9rem;
    border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  td { padding: .55rem .9rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  .bar { height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; min-width: 60px; }
  .bar > i { display: block; height: 100%; background: var(--neg); }

  .pill {
    display: inline-block; padding: .1rem .45rem; border-radius: 5px;
    font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  }
  .pill.critical { background: color-mix(in srgb, var(--neg) 18%, transparent); color: var(--neg); }
  .pill.high { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }

  .chain { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border); }
  .addr { font-size: .8rem; color: var(--muted); word-break: break-all; }
  .notes { color: var(--muted); font-size: .82rem; }
  .notes li { margin-bottom: .35rem; }
  footer { margin-top: 3.5rem; color: var(--muted); font-size: .78rem; }
</style>
</head>
<body>
<div class="wrap">

  <h1>Wallet Forensics</h1>
  <p class="sub">Generated ${esc(report.generatedAt.toISOString().replace('T', ' ').slice(0, 19))} UTC</p>

  <div class="grid">
    ${stat('Portfolio (nominal)', money(t.portfolioNominalUsd))}
    ${stat(
      'Portfolio (realizable)',
      money(t.portfolioRealizableUsd),
      evaporation > 1 ? `${evaporation.toFixed(1)}% evaporates on exit` : undefined,
      evaporation > 5 ? 'neg' : undefined,
    )}
    ${stat('Net PnL', signed(netPnl), undefined, netPnl >= 0 ? 'pos' : 'neg')}
    ${stat('Fees burned', money(t.feesUsd), undefined, 'neg')}
    ${t.mevExtractedUsd > 0 ? stat('Lost to MEV', money(t.mevExtractedUsd), undefined, 'neg') : ''}
  </div>

  ${
    report.topRegrets.length > 0
      ? `<h2>What cost you the most</h2>
  ${report.topRegrets
    .slice(0, 8)
    .map(
      (r) => `<div class="regret">
    <div class="t"><span>${esc(r.title)}</span><span class="neg mono">${r.costUsd > 0 ? esc(money(r.costUsd)) : '—'}</span></div>
    <div class="d">${esc(r.detail)}</div>
  </div>`,
    )
    .join('\n  ')}`
      : ''
  }

  ${report.chains.map(renderChain).join('\n')}

  <footer>
    Generated by <strong>wallet-forensics</strong>. Cost basis is inferred from stablecoin and
    native-asset legs; transfers with neither are excluded from PnL rather than estimated.
    Exit liquidity comes from live routing quotes and moves with the market.
    Not financial advice.
  </footer>

</div>
</body>
</html>`;
}

function renderChain(chain: ChainReport): string {
  const name = chainLabel(chain.chain);
  const decimals = nativeDecimals(chain.chain);
  const parts: string[] = [];

  parts.push(`<div class="chain">
  <h1 style="font-size:1.15rem">${name}</h1>
  <p class="addr mono">${esc(chain.address)}</p>`);

  // Activity
  const a = chain.activity;
  if (a.totalTxs > 0) {
    parts.push(`<div class="grid" style="margin-top:1rem">
    ${stat('Transactions', a.totalTxs.toLocaleString(), a.failedTxs > 0 ? `${a.failedTxs} failed` : undefined)}
    ${stat('Wallet age', a.ageDays !== undefined ? `${a.ageDays.toLocaleString()}d` : '—', a.firstSeen ? `since ${a.firstSeen.toISOString().slice(0, 10)}` : undefined)}
    ${stat('Counterparties', a.uniqueCounterparties.toLocaleString())}
    ${stat(
      'Fees',
      `${Number(formatUnits(chain.fees.totalNative, decimals)).toFixed(4)} ${chain.fees.nativeSymbol}`,
      chain.fees.totalUsdHistorical !== undefined ? money(chain.fees.totalUsdHistorical) : undefined,
    )}
  </div>`);
  }

  // Exit liquidity
  const illiquid = chain.liquidity.filter((l) => l.liquidityRatio < 0.95 && l.nominalUsd >= 50);
  if (illiquid.length > 0) {
    parts.push(`<h2>Exit liquidity</h2>
  <div class="tablewrap"><table>
    <thead><tr>
      <th>Asset</th><th class="num">Shows as</th><th class="num">Really worth</th>
      <th class="num">Impact</th><th style="width:110px">Gap</th>
    </tr></thead>
    <tbody>
    ${illiquid
      .slice(0, 12)
      .map((l) => {
        const lost = Math.min(100, Math.max(0, (1 - l.liquidityRatio) * 100));
        return `<tr>
      <td class="mono">${esc(l.symbol ?? short(l.asset))}</td>
      <td class="num mono">${esc(money(l.nominalUsd))}</td>
      <td class="num mono ${l.liquidityRatio < 0.5 ? 'neg' : 'warn'}">${l.error ? 'no route' : esc(money(l.realizableUsd))}</td>
      <td class="num mono">${l.error ? '—' : `${(l.fullExitImpact * 100).toFixed(1)}%`}</td>
      <td><div class="bar"><i style="width:${lost.toFixed(0)}%"></i></div></td>
    </tr>`;
      })
      .join('\n    ')}
    </tbody>
  </table></div>`);
  }

  // Approvals
  const risky = chain.approvals.filter((ap) => ap.risk === 'critical' || ap.risk === 'high');
  if (risky.length > 0) {
    parts.push(`<h2>Risky approvals</h2>
  <div class="tablewrap"><table>
    <thead><tr>
      <th>Risk</th><th>Asset</th><th>Allowance</th><th>Spender</th><th class="num">Exposed</th>
    </tr></thead>
    <tbody>
    ${risky
      .slice(0, 15)
      .map(
        (ap) => `<tr>
      <td><span class="pill ${ap.risk}">${ap.risk}</span></td>
      <td class="mono">${esc(ap.symbol ?? short(ap.asset))}</td>
      <td>${ap.allowance === null ? '<span class="neg">Unlimited</span>' : 'Limited'}</td>
      <td class="mono">${esc(ap.spenderLabel ?? short(ap.spender))}</td>
      <td class="num mono">${ap.atRiskUsd ? esc(money(ap.atRiskUsd)) : '—'}</td>
    </tr>`,
      )
      .join('\n    ')}
    </tbody>
  </table></div>`);
  }

  // MEV
  if (chain.mev.events.length > 0) {
    parts.push(`<h2>MEV extraction</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Block</th><th>Your transaction</th><th>Attacker</th><th class="num">Extracted</th><th>Confidence</th></tr></thead>
    <tbody>
    ${chain.mev.events
      .slice(0, 15)
      .map(
        (e) => `<tr>
      <td class="mono">${e.block}</td>
      <td class="mono">${esc(short(e.victimTx))}</td>
      <td class="mono">${esc(short(e.attacker ?? '—'))}</td>
      <td class="num mono neg">${e.extractedUsd > 0 ? esc(money(e.extractedUsd)) : '—'}</td>
      <td>${e.confidence}</td>
    </tr>`,
      )
      .join('\n    ')}
    </tbody>
  </table></div>`);
  }

  // Positions
  const notable = chain.positions
    .filter((p) => Math.abs(p.realizedPnlUsd + p.unrealizedPnlUsd) > 10)
    .slice(0, 20);
  if (notable.length > 0) {
    parts.push(`<h2>Positions</h2>
  <div class="tablewrap"><table>
    <thead><tr>
      <th>Asset</th><th class="num">Realized</th><th class="num">Unrealized</th>
      <th class="num">Holding</th><th class="num">Trades</th>
    </tr></thead>
    <tbody>
    ${notable
      .map(
        (p) => `<tr>
      <td class="mono">${esc(p.symbol ?? short(p.asset))}</td>
      <td class="num mono ${p.realizedPnlUsd >= 0 ? 'pos' : 'neg'}">${esc(signed(p.realizedPnlUsd))}</td>
      <td class="num mono ${p.unrealizedPnlUsd >= 0 ? 'pos' : 'neg'}">${esc(signed(p.unrealizedPnlUsd))}</td>
      <td class="num mono">${p.openAmount > 0n ? esc(Number(formatUnits(p.openAmount, p.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })) : '—'}</td>
      <td class="num mono">${p.buys + p.sells}</td>
    </tr>`,
      )
      .join('\n    ')}
    </tbody>
  </table></div>`);
  }

  if (chain.warnings.length > 0) {
    parts.push(`<h2>Notes</h2>
  <ul class="notes">${chain.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`);
  }

  parts.push('</div>');
  return parts.join('\n  ');
}

function stat(k: string, v: string, note?: string, cls?: string): string {
  return `<div class="stat">
      <div class="k">${esc(k)}</div>
      <div class="v ${cls ?? ''}">${esc(v)}</div>
      ${note ? `<div class="n">${esc(note)}</div>` : ''}
    </div>`;
}

function money(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${n.toFixed(4)}`;
}

function signed(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return `${n > 0 ? '+' : '-'}${money(Math.abs(n))}`;
}

function short(s: string): string {
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
