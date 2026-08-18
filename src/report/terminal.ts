import { formatUnits } from 'viem';

import type { ChainReport, ForensicsReport } from '../types.js';

/* ANSI helpers. No dependency needed for this much. */
const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('36');
const magenta = c('35');

const WIDTH = 76;

export function renderTerminal(report: ForensicsReport): string {
  const out: string[] = [];

  out.push('');
  out.push(bold('  WALLET FORENSICS'));
  out.push(dim(`  generated ${report.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`));
  out.push('');

  // ---- Headline totals ----------------------------------------------------
  const t = report.totals;
  const netPnl = t.realizedPnlUsd + t.unrealizedPnlUsd;

  out.push(rule());
  out.push('');
  out.push(`  ${label('Portfolio (nominal)')}${money(t.portfolioNominalUsd)}`);

  // The headline number: what the portfolio is actually worth on exit.
  const gap = t.portfolioNominalUsd - t.portfolioRealizableUsd;
  if (gap > 1 && t.portfolioNominalUsd > 0) {
    const pct = (gap / t.portfolioNominalUsd) * 100;
    out.push(
      `  ${label('Portfolio (realizable)')}${money(t.portfolioRealizableUsd)}  ` +
        red(`${pct.toFixed(1)}% evaporates on exit`),
    );
  }

  out.push(`  ${label('Realized PnL')}${signed(t.realizedPnlUsd)}`);
  out.push(`  ${label('Unrealized PnL')}${signed(t.unrealizedPnlUsd)}`);
  out.push(`  ${label('Net PnL')}${bold(signed(netPnl))}`);
  out.push(`  ${label('Fees burned')}${red(money(t.feesUsd))}`);
  if (t.mevExtractedUsd > 0) {
    out.push(`  ${label('Lost to MEV')}${red(money(t.mevExtractedUsd))}`);
  }
  out.push('');

  // ---- Top regrets --------------------------------------------------------
  if (report.topRegrets.length > 0) {
    out.push(rule('WHAT COST YOU THE MOST'));
    out.push('');
    for (const [i, regret] of report.topRegrets.slice(0, 6).entries()) {
      const cost = regret.costUsd > 0 ? red(money(regret.costUsd)) : dim('—');
      out.push(`  ${dim(`${i + 1}.`)} ${bold(regret.title)}  ${cost}`);
      out.push(wrap(regret.detail, 5));
      out.push('');
    }
  }

  // ---- Per chain ----------------------------------------------------------
  for (const chain of report.chains) {
    out.push(renderChain(chain));
  }

  return out.join('\n');
}

function renderChain(chain: ChainReport): string {
  const out: string[] = [];
  const name = chain.chain === 'ethereum' ? 'ETHEREUM' : 'SOLANA';

  out.push(rule(name));
  out.push(dim(`  ${chain.address}`));
  out.push('');

  // ---- Activity -----------------------------------------------------------
  const a = chain.activity;
  if (a.totalTxs > 0) {
    const age = a.ageDays !== undefined ? `${a.ageDays.toLocaleString()} days old` : 'age unknown';
    out.push(
      `  ${a.totalTxs.toLocaleString()} transactions · ${age} · ` +
        `${a.uniqueCounterparties.toLocaleString()} counterparties` +
        (a.failedTxs > 0 ? ` · ${red(`${a.failedTxs} failed`)}` : ''),
    );
    if (a.firstSeen) {
      out.push(dim(`  first seen ${a.firstSeen.toISOString().slice(0, 10)}`));
    }
    if (a.topProtocols.length > 0) {
      const top = a.topProtocols
        .slice(0, 4)
        .map((p) => `${p.label} (${p.count})`)
        .join(', ');
      out.push(dim(`  most used: ${top}`));
    }
    out.push('');
  }

  // ---- Fees ---------------------------------------------------------------
  const f = chain.fees;
  if (f.totalNative > 0n) {
    const decimals = chain.chain === 'ethereum' ? 18 : 9;
    const native = Number(formatUnits(f.totalNative, decimals));
    out.push(bold('  Fees'));
    out.push(
      `    ${native.toFixed(chain.chain === 'ethereum' ? 4 : 6)} ${f.nativeSymbol}` +
        (f.totalUsdHistorical !== undefined
          ? ` · ${money(f.totalUsdHistorical)} at the prices you paid`
          : ''),
    );
    if (f.totalUsdAtCurrentPrice !== undefined && f.totalUsdHistorical !== undefined) {
      const delta = f.totalUsdAtCurrentPrice - f.totalUsdHistorical;
      const note =
        delta > 0
          ? `worth ${money(f.totalUsdAtCurrentPrice)} today — ${red(money(delta))} of upside burned`
          : `worth ${money(f.totalUsdAtCurrentPrice)} today`;
      out.push(dim(`    ${note}`));
    }
    if (f.wastedOnFailedUsd) {
      out.push(`    ${red(money(f.wastedOnFailedUsd))} paid for transactions that reverted`);
    }
    out.push('');
  }

  // ---- Exit liquidity -----------------------------------------------------
  const illiquid = chain.liquidity.filter((l) => l.liquidityRatio < 0.95 && l.nominalUsd >= 50);
  if (illiquid.length > 0) {
    out.push(bold('  Exit liquidity') + dim('  (what your bags are really worth)'));
    for (const pos of illiquid.slice(0, 8)) {
      const sym = (pos.symbol ?? short(pos.asset)).padEnd(10).slice(0, 10);
      if (pos.error) {
        out.push(`    ${sym} ${money(pos.nominalUsd).padStart(12)} → ${red('no route')}`);
        continue;
      }
      const ratio = pos.liquidityRatio;
      const paint = ratio < 0.5 ? red : ratio < 0.85 ? yellow : dim;
      out.push(
        `    ${sym} ${money(pos.nominalUsd).padStart(12)} → ${paint(money(pos.realizableUsd).padStart(12))}` +
          dim(`   ${(pos.fullExitImpact * 100).toFixed(1)}% impact`),
      );
    }
    out.push('');
  }

  // ---- Approvals ----------------------------------------------------------
  const risky = chain.approvals.filter((ap) => ap.risk === 'critical' || ap.risk === 'high');
  if (risky.length > 0) {
    out.push(bold('  Risky approvals'));
    for (const ap of risky.slice(0, 8)) {
      const paint = ap.risk === 'critical' ? red : yellow;
      const sym = (ap.symbol ?? short(ap.asset)).padEnd(10).slice(0, 10);
      const amount = ap.allowance === null ? 'UNLIMITED' : 'limited';
      out.push(
        `    ${paint('●')} ${sym} ${amount.padEnd(10)} → ` +
          `${ap.spenderLabel ?? short(ap.spender)}` +
          (ap.atRiskUsd ? dim(`   ${money(ap.atRiskUsd)} exposed`) : ''),
      );
    }
    out.push('');
  }

  // ---- MEV ----------------------------------------------------------------
  if (chain.mev.events.length > 0) {
    out.push(bold('  MEV extraction'));
    out.push(
      `    ${chain.mev.events.length} sandwich${chain.mev.events.length === 1 ? '' : 'es'} detected` +
        (chain.mev.totalExtractedUsd > 0
          ? ` · ${red(money(chain.mev.totalExtractedUsd))} extracted`
          : ''),
    );
    for (const e of chain.mev.events.slice(0, 4)) {
      out.push(
        dim(
          `      block ${e.block}  ${short(e.victimTx)}  ` +
            `${e.extractedUsd > 0 ? money(e.extractedUsd) : 'value unattributed'}  ` +
            `[${e.confidence} confidence]`,
        ),
      );
    }
    out.push('');
  }

  // ---- Top positions ------------------------------------------------------
  const notable = chain.positions
    .filter((p) => Math.abs(p.realizedPnlUsd + p.unrealizedPnlUsd) > 10)
    .slice(0, 8);
  if (notable.length > 0) {
    out.push(bold('  Positions'));
    out.push(
      dim(
        `    ${'asset'.padEnd(10)} ${'realized'.padStart(12)} ${'unrealized'.padStart(12)} ${'holding'.padStart(12)}`,
      ),
    );
    for (const p of notable) {
      const sym = (p.symbol ?? short(p.asset)).padEnd(10).slice(0, 10);
      const held =
        p.openAmount > 0n
          ? Number(formatUnits(p.openAmount, p.decimals)).toLocaleString('en-US', {
              maximumFractionDigits: 4,
            })
          : '—';
      out.push(
        `    ${sym} ${padStartVisible(signed(p.realizedPnlUsd), 12)} ` +
          `${padStartVisible(signed(p.unrealizedPnlUsd), 12)} ${held.padStart(12)}`,
      );
    }
    out.push('');
  }

  // ---- Warnings -----------------------------------------------------------
  if (chain.warnings.length > 0) {
    out.push(dim('  Notes'));
    for (const w of chain.warnings) out.push(wrap(w, 4, dim));
    out.push('');
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ format */

function rule(title?: string): string {
  if (!title) return dim(`  ${'─'.repeat(WIDTH)}`);
  const line = '─'.repeat(Math.max(0, WIDTH - title.length - 3));
  return dim(`  ${'─'} `) + blue(bold(title)) + dim(` ${line}`);
}

function label(text: string): string {
  return dim(text.padEnd(26));
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
  if (!Number.isFinite(n) || n === 0) return dim('$0');
  const body = money(Math.abs(n));
  return n > 0 ? green(`+${body}`) : red(`-${body}`);
}

/**
 * Pad to a visible width, ignoring ANSI escape sequences.
 *
 * `String.padStart` counts escape codes as characters, so colored columns drift
 * out of alignment by exactly the length of their color codes.
 */
function padStartVisible(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return ' '.repeat(Math.max(0, width - visible)) + s;
}

function short(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function wrap(text: string, indent: number, paint: (s: string) => string = (s) => s): string {
  const pad = ' '.repeat(indent);
  const max = WIDTH - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line.length + word.length + 1 > max) {
      lines.push(pad + paint(line));
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(pad + paint(line));
  return lines.join('\n');
}
