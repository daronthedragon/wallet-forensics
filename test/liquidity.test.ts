import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { computeExitLiquidity } from '../src/analysis/liquidity.js';
import { collectRegrets } from '../src/analysis/regrets.js';
import type { ChainAdapter, QuoteResult } from '../src/adapters/types.js';
import type { TokenBalance } from '../src/types.js';

const TOKEN = '0x2222222222222222222222222222222222222222';

function balance(over: Partial<TokenBalance> = {}): TokenBalance {
  return {
    asset: TOKEN,
    symbol: 'BAGS',
    decimals: 18,
    amount: 1000n * 10n ** 18n,
    valueUsd: 5_000,
    ...over,
  };
}

/** An adapter that answers quoteSell with whatever the test dictates. */
function adapterReturning(result: QuoteResult): ChainAdapter {
  return {
    chain: 'ethereum',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    isValidAddress: () => true,
    getTransactions: async () => [],
    getBalances: async () => [],
    getApprovals: async () => [],
    detectMev: async () => [],
    quoteSell: async () => result,
  } as unknown as ChainAdapter;
}

describe('exit liquidity: a refused route is a finding, a missing quote is not', () => {
  test('a refused route reports the position as unsellable', async () => {
    const out = await computeExitLiquidity(adapterReturning({ ok: false, reason: 'no-route' }), [
      balance(),
    ]);

    assert.equal(out.length, 1);
    const pos = out[0]!;
    assert.equal(pos.quoted, false);
    assert.equal(pos.realizableUsd, 0, 'nothing can be realised');
    assert.equal(pos.liquidityRatio, 0);
    assert.equal(pos.fullExitImpact, 1);
    assert.match(pos.error ?? '', /unsellable/);
  });

  for (const reason of ['no-price', 'unsupported'] as const) {
    test(`"${reason}" does not invent a loss`, async () => {
      const out = await computeExitLiquidity(adapterReturning({ ok: false, reason }), [balance()]);
      const pos = out[0]!;

      // The distinction that matters: we did not measure this, so we must not
      // report it as measured at zero.
      assert.equal(pos.quoted, false, 'no quote was obtained');
      assert.equal(pos.realizableUsd, 5_000, 'falls back to nominal, not zero');
      assert.equal(pos.liquidityRatio, 1, 'no evaporation is claimed');
      assert.equal(pos.fullExitImpact, 0);
      assert.match(pos.error ?? '', /Quote unavailable/);
    });
  }

  test('a successful quote is used verbatim', async () => {
    const out = await computeExitLiquidity(
      adapterReturning({ ok: true, proceedsUsd: 2_000, priceImpact: 0.6 }),
      [balance()],
    );
    const pos = out[0]!;

    assert.equal(pos.quoted, true);
    assert.equal(pos.realizableUsd, 2_000);
    assert.equal(pos.liquidityRatio, 0.4);
  });
});

describe('unmeasured positions stay out of the findings', () => {
  const regretsFor = (liquidity: Awaited<ReturnType<typeof computeExitLiquidity>>) =>
    collectRegrets({
      positions: [],
      mev: [],
      approvals: [],
      liquidity,
      fees: { totalNative: 0n, totalUsdHistorical: 0, totalUsdToday: 0, wastedUsd: 0 } as never,
      txs: [],
    });

  test('a position we could not quote is not ranked as a regret', async () => {
    const liquidity = await computeExitLiquidity(
      adapterReturning({ ok: false, reason: 'no-price' }),
      [balance()],
    );
    const regrets = regretsFor(liquidity);

    assert.equal(
      regrets.filter((r) => /Illiquid position/.test(r.title)).length,
      0,
      'a rate limit must never surface as an illiquid-position finding',
    );
  });

  test('a genuinely unsellable position is ranked', async () => {
    const liquidity = await computeExitLiquidity(
      adapterReturning({ ok: false, reason: 'no-route' }),
      [balance()],
    );
    const regrets = regretsFor(liquidity);

    assert.ok(
      regrets.some((r) => /Illiquid position/.test(r.title)),
      'a refused route is a real finding and should be reported',
    );
  });
});
