import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { summarizeActivity } from '../src/analysis/activity.js';
import { summarizeFees } from '../src/analysis/fees.js';
import { computePositions } from '../src/analysis/pnl.js';
import { collectRegrets } from '../src/analysis/regrets.js';
import { renderHtml } from '../src/report/html.js';
import { renderTerminal } from '../src/report/terminal.js';
import type {
  ForensicsReport,
  NormalizedTx,
  TokenBalance,
} from '../src/types.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WIF = '0x1111111111111111111111111111111111111111'; // stand-in shitcoin

function tx(partial: Partial<NormalizedTx> & Pick<NormalizedTx, 'id' | 'timestamp'>): NormalizedTx {
  return {
    chain: 'ethereum',
    block: 1,
    outgoing: true,
    fee: 0n,
    failed: false,
    transfers: [],
    ...partial,
  };
}

describe('cost basis inference', () => {
  test('anchors a swap on its stablecoin leg', () => {
    // Bought 100 WIF for 1000 USDC, then sold 50 WIF for 200 USDC.
    // Basis for 100 units is $1000, so selling half releases $500 of basis
    // against $200 of proceeds — a $300 realized loss.
    const txs: NormalizedTx[] = [
      tx({
        id: '0xbuy',
        timestamp: new Date('2024-01-01'),
        block: 100,
        transfers: [
          { asset: USDC, symbol: 'USDC', decimals: 6, amount: -1_000_000_000n },
          { asset: WIF, symbol: 'WIF', decimals: 18, amount: 100n * 10n ** 18n },
        ],
      }),
      tx({
        id: '0xsell',
        timestamp: new Date('2024-02-01'),
        block: 200,
        transfers: [
          { asset: WIF, symbol: 'WIF', decimals: 18, amount: -50n * 10n ** 18n },
          { asset: USDC, symbol: 'USDC', decimals: 6, amount: 200_000_000n },
        ],
      }),
    ];

    const balances: TokenBalance[] = [
      {
        asset: WIF,
        symbol: 'WIF',
        decimals: 18,
        amount: 50n * 10n ** 18n,
        priceUsd: 4,
        valueUsd: 200,
      },
    ];

    const { positions } = computePositions('ethereum', txs, balances, new Map());
    const wif = positions.find((p) => p.asset === WIF);

    assert.ok(wif, 'expected a WIF position');
    assert.equal(wif.buys, 1);
    assert.equal(wif.sells, 1);
    assert.equal(Math.round(wif.realizedPnlUsd), -300);
    // $500 of basis remains against a $200 mark.
    assert.equal(Math.round(wif.unrealizedPnlUsd), -300);
  });

  test('anchors on the native leg when no stablecoin is present', () => {
    // Bought 10 WIF for 1 ETH on a day ETH was $2000.
    const txs: NormalizedTx[] = [
      tx({
        id: '0xnative',
        timestamp: new Date('2024-03-01'),
        transfers: [
          { asset: 'native', symbol: 'ETH', decimals: 18, amount: -1n * 10n ** 18n },
          { asset: WIF, symbol: 'WIF', decimals: 18, amount: 10n * 10n ** 18n },
        ],
      }),
    ];

    const prices = new Map([['2024-03-01', 2000]]);
    const { positions } = computePositions('ethereum', txs, [], prices);
    const wif = positions.find((p) => p.asset === WIF);

    assert.ok(wif);
    assert.equal(Math.round(wif.costBasisUsd), 2000);
  });

  test('counts transfers it cannot value instead of guessing', () => {
    // An airdrop: tokens in, nothing out. No anchor exists.
    const txs: NormalizedTx[] = [
      tx({
        id: '0xdrop',
        timestamp: new Date('2024-04-01'),
        transfers: [{ asset: WIF, symbol: 'WIF', decimals: 18, amount: 500n * 10n ** 18n }],
      }),
    ];

    const { positions, unvaluedTransfers } = computePositions('ethereum', txs, [], new Map());
    assert.equal(unvaluedTransfers, 1);
    const wif = positions.find((p) => p.asset === WIF);
    assert.equal(wif?.costBasisUsd, 0, 'unvalued acquisition must not invent a basis');
  });

  test('does not treat stablecoins as positions', () => {
    const txs: NormalizedTx[] = [
      tx({
        id: '0xswap',
        timestamp: new Date('2024-01-01'),
        transfers: [
          { asset: USDC, symbol: 'USDC', decimals: 6, amount: -500_000_000n },
          { asset: WIF, symbol: 'WIF', decimals: 18, amount: 1n * 10n ** 18n },
        ],
      }),
    ];

    const { positions } = computePositions('ethereum', txs, [], new Map());
    assert.equal(
      positions.find((p) => p.asset === USDC),
      undefined,
      'USDC is the numeraire, not a position',
    );
  });
});

describe('fees', () => {
  test('separates historical cost from current value and flags reverted spend', () => {
    const txs: NormalizedTx[] = [
      tx({
        id: '0xa',
        timestamp: new Date('2021-05-01'),
        fee: 10n ** 18n, // 1 ETH
        feeUsd: 3000,
      }),
      tx({
        id: '0xb',
        timestamp: new Date('2021-06-01'),
        fee: 5n * 10n ** 17n, // 0.5 ETH
        feeUsd: 1200,
        failed: true,
      }),
    ];

    const fees = summarizeFees('ethereum', txs, 4000);

    assert.equal(fees.totalNative, 15n * 10n ** 17n);
    assert.equal(fees.totalUsdHistorical, 4200);
    assert.equal(fees.totalUsdAtCurrentPrice, 6000); // 1.5 ETH at $4000
    assert.equal(fees.wastedOnFailedUsd, 1200);
    assert.equal(fees.mostExpensiveTx?.id, '0xa');
  });
});

describe('activity', () => {
  test('summarizes age, failures and protocol usage', () => {
    const txs: NormalizedTx[] = [
      tx({
        id: '0x1',
        timestamp: new Date('2020-01-01'),
        counterparty: '0xAAA',
        label: 'Uniswap V3 Router: swap',
      }),
      tx({
        id: '0x2',
        timestamp: new Date('2024-01-01'),
        counterparty: '0xBBB',
        label: 'Uniswap V3 Router: approve',
        failed: true,
      }),
      tx({ id: '0x3', timestamp: new Date('2024-01-01'), counterparty: '0xAAA' }),
    ];

    const a = summarizeActivity('ethereum', '0xme', txs);

    assert.equal(a.totalTxs, 3);
    assert.equal(a.failedTxs, 1);
    assert.equal(a.uniqueCounterparties, 2);
    assert.equal(a.firstSeen?.toISOString().slice(0, 10), '2020-01-01');
    assert.equal(a.topProtocols[0]?.label, 'Uniswap V3 Router');
    assert.equal(a.topProtocols[0]?.count, 2);
    assert.equal(a.busiestDay?.date, '2024-01-01');
  });
});

describe('regrets', () => {
  test('ranks by dollar cost across categories', () => {
    const regrets = collectRegrets({
      positions: [
        {
          asset: WIF,
          symbol: 'WIF',
          decimals: 18,
          openAmount: 0n,
          costBasisUsd: 0,
          realizedPnlUsd: -450,
          unrealizedPnlUsd: 0,
          buys: 1,
          sells: 1,
        },
      ],
      mev: [
        {
          victimTx: '0xvictim',
          block: 100,
          timestamp: new Date('2024-01-01'),
          kind: 'sandwich',
          extractedUsd: 120,
          confidence: 'high',
        },
      ],
      approvals: [
        {
          chain: 'ethereum',
          asset: USDC,
          symbol: 'USDC',
          spender: '0xsketchy',
          allowance: null,
          atRiskUsd: 25_000,
          risk: 'critical',
          riskReasons: ['Unlimited allowance'],
        },
      ],
      liquidity: [
        {
          asset: WIF,
          symbol: 'WIF',
          nominalUsd: 5000,
          realizableUsd: 900,
          maxExitUnder5Pct: 100,
          fullExitImpact: 0.82,
          liquidityRatio: 0.18,
        },
      ],
      fees: {
        chain: 'ethereum',
        totalNative: 0n,
        nativeSymbol: 'ETH',
        wastedOnFailedUsd: 60,
      },
      txs: [tx({ id: '0xf', timestamp: new Date('2024-01-01'), failed: true })],
    });

    // Strictly descending by cost.
    const costs = regrets.map((r) => r.costUsd);
    assert.deepEqual([...costs].sort((a, b) => b - a), costs);

    // The unlimited approval ($25k at risk) outranks the illiquid bag ($4.1k gap).
    assert.equal(regrets[0]?.kind, 'stale-approval');
    assert.equal(regrets[1]?.kind, 'illiquid-bag');

    const kinds = regrets.map((r) => r.kind);
    assert.ok(kinds.includes('worst-trade'));
    assert.ok(kinds.includes('mev-victim'));
    assert.ok(kinds.includes('failed-tx-burn'));
  });
});

describe('renderers', () => {
  const report: ForensicsReport = {
    generatedAt: new Date('2024-06-01T12:00:00Z'),
    chains: [
      {
        chain: 'ethereum',
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        activity: {
          address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          chain: 'ethereum',
          firstSeen: new Date('2017-01-01'),
          ageDays: 2700,
          totalTxs: 1200,
          failedTxs: 14,
          uniqueCounterparties: 300,
          topProtocols: [{ label: 'Uniswap V3 Router', count: 88 }],
        },
        fees: {
          chain: 'ethereum',
          totalNative: 3n * 10n ** 18n,
          nativeSymbol: 'ETH',
          totalUsdHistorical: 7400,
          totalUsdAtCurrentPrice: 12000,
          wastedOnFailedUsd: 310,
        },
        positions: [
          {
            asset: WIF,
            symbol: 'WIF',
            decimals: 18,
            openAmount: 50n * 10n ** 18n,
            costBasisUsd: 500,
            realizedPnlUsd: -300,
            unrealizedPnlUsd: 120,
            buys: 2,
            sells: 1,
          },
        ],
        balances: [],
        approvals: [
          {
            chain: 'ethereum',
            asset: USDC,
            symbol: 'USDC',
            spender: '0xsketchy',
            allowance: null,
            atRiskUsd: 25_000,
            risk: 'critical',
            riskReasons: ['Unlimited allowance'],
          },
        ],
        mev: {
          events: [
            {
              victimTx: '0xvictim',
              block: 100,
              timestamp: new Date('2024-01-01'),
              kind: 'sandwich',
              extractedUsd: 120,
              confidence: 'high',
            },
          ],
          totalExtractedUsd: 120,
        },
        liquidity: [
          {
            asset: WIF,
            symbol: 'WIF',
            nominalUsd: 5000,
            realizableUsd: 900,
            maxExitUnder5Pct: 100,
            fullExitImpact: 0.82,
            liquidityRatio: 0.18,
          },
        ],
        regrets: [
          {
            kind: 'illiquid-bag',
            title: 'Illiquid position: WIF',
            detail: 'Shows as $5,000 but would realize $900.',
            costUsd: 4100,
          },
        ],
        warnings: ['example warning'],
      },
    ],
    totals: {
      realizedPnlUsd: -300,
      unrealizedPnlUsd: 120,
      feesUsd: 7400,
      mevExtractedUsd: 120,
      portfolioNominalUsd: 5000,
      portfolioRealizableUsd: 900,
    },
    topRegrets: [
      {
        kind: 'illiquid-bag',
        title: 'Illiquid position: WIF',
        detail: 'Shows as $5,000 but would realize $900.',
        costUsd: 4100,
      },
    ],
  };

  test('terminal renderer produces the headline numbers', () => {
    const out = renderTerminal(report);
    assert.match(out, /WALLET FORENSICS/);
    assert.match(out, /\$5,000/);
    assert.match(out, /evaporates on exit/);
    assert.match(out, /Illiquid position: WIF/);
    assert.match(out, /sandwich/i);
  });

  test('html renderer is self-contained and escapes content', () => {
    const html = renderHtml(report);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.doesNotMatch(html, /<script/i, 'report must not ship scripts');
    assert.doesNotMatch(
      html,
      /https?:\/\/(?!www\.w3\.org)/,
      'report must not reference external resources',
    );
    assert.match(html, /Illiquid position: WIF/);
  });

  test('html escaping neutralizes injected markup', () => {
    const evil = structuredClone(report);
    evil.topRegrets[0]!.title = '<img src=x onerror=alert(1)>';
    const html = renderHtml(evil);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
});
