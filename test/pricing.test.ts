import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

/* The oracle reads the cache directory from the environment at construction,
 * so it has to be pointed somewhere disposable before the module is loaded. */
let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-pricing-'));
  process.env['WALLET_FORENSICS_CACHE_DIR'] = dir;
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['WALLET_FORENSICS_CACHE_DIR'];
});

const { PriceOracle } = await import('../src/pricing/index.js');

/* ─────────────────────────────────────────────────────── fetch stub ── */

interface Call {
  url: string;
}
let calls: Call[] = [];
let handler: (url: string) => unknown;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  handler = () => ({});
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });
    const body = handler(url);
    if (body === undefined) {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const llamaHits = () => calls.filter((c) => c.url.includes('coins.llama.fi')).length;
const geckoHits = () => calls.filter((c) => c.url.includes('coingecko')).length;

/** No throttle in tests; the interval is real seconds otherwise. */
const oracle = (opts: { noCache?: boolean } = {}) => new PriceOracle(0, opts);

/* ────────────────────────────────────────────── historical pricing ── */

describe('historical prices', () => {
  test('a day that has ended is fetched once, then served from memory', async () => {
    handler = () => ({ market_data: { current_price: { usd: 2500 } } });
    const p = oracle({ noCache: true });

    const a = await p.nativePriceOn('ethereum', new Date('2024-05-01'));
    const b = await p.nativePriceOn('ethereum', new Date('2024-05-01'));

    assert.equal(a, 2500);
    assert.equal(b, 2500);
    assert.equal(geckoHits(), 1, 'the second lookup must not hit the network');
  });

  test('resolution is one day, so two timestamps on the same date share a lookup', async () => {
    handler = () => ({ market_data: { current_price: { usd: 2500 } } });
    const p = oracle({ noCache: true });

    await p.nativePriceOn('ethereum', new Date('2024-05-01T01:00:00Z'));
    await p.nativePriceOn('ethereum', new Date('2024-05-01T23:00:00Z'));

    assert.equal(geckoHits(), 1);
  });

  test('a price survives to a fresh oracle through the disk cache', async () => {
    handler = () => ({ market_data: { current_price: { usd: 1234 } } });
    const first = oracle();
    await first.nativePriceOn('ethereum', new Date('2024-06-01'));
    first.flush();

    calls = [];
    const second = oracle();
    const price = await second.nativePriceOn('ethereum', new Date('2024-06-01'));

    assert.equal(price, 1234);
    assert.equal(calls.length, 0, 'a cached day costs no request at all');
    assert.equal(second.cacheStats().hits, 1);
  });

  test('a day with no data is remembered as absent rather than re-asked', async () => {
    // CoinGecko answers, but with nothing. Re-asking costs a throttled request
    // and returns nothing again.
    handler = () => ({ market_data: {} });
    const first = oracle();
    assert.equal(await first.nativePriceOn('ethereum', new Date('2020-01-01')), undefined);
    first.flush();

    calls = [];
    const second = oracle();
    assert.equal(await second.nativePriceOn('ethereum', new Date('2020-01-01')), undefined);
    assert.equal(calls.length, 0, 'the recorded absence is reused');
  });

  test('a failed request is not cached, so it can succeed later', async () => {
    // An absence is a fact about the data; a failure is a fact about the
    // network. Caching the second would make one bad minute permanent.
    handler = () => undefined; // non-ok response
    const first = oracle();
    assert.equal(await first.nativePriceOn('ethereum', new Date('2024-07-01')), undefined);
    first.flush();

    calls = [];
    handler = () => ({ market_data: { current_price: { usd: 999 } } });
    const second = oracle();
    assert.equal(await second.nativePriceOn('ethereum', new Date('2024-07-01')), 999);
    assert.ok(calls.length > 0, 'the failure must not have been recorded as an absence');
  });

  test('--no-cache reads and writes nothing', async () => {
    handler = () => ({ market_data: { current_price: { usd: 4242 } } });
    const p = oracle({ noCache: true });
    await p.nativePriceOn('ethereum', new Date('2024-08-01'));
    p.flush();

    calls = [];
    const other = oracle({ noCache: true });
    await other.nativePriceOn('ethereum', new Date('2024-08-01'));
    assert.ok(calls.length > 0, 'nothing was persisted to read back');
    assert.equal(other.cacheStats().disabled, true);
  });
});

/* ───────────────────────────────────────────────── token pricing ── */

describe('token prices', () => {
  const llamaBody = (addrs: string[]) => ({
    coins: Object.fromEntries(
      addrs.map((a) => [`ethereum:${a}`, { price: 1.0, symbol: 'X', decimals: 6, confidence: 0.99 }]),
    ),
  });

  test('DefiLlama is tried first, and one request covers many tokens', async () => {
    handler = (url) => (url.includes('llama') ? llamaBody([USDC, DAI]) : {});
    const p = oracle({ noCache: true });

    const out = await p.tokenPrices('ethereum', [USDC, DAI]);

    assert.equal(out.get(USDC), 1.0);
    assert.equal(out.get(DAI), 1.0);
    assert.equal(llamaHits(), 1, 'both tokens in a single batched request');
    assert.equal(geckoHits(), 0, 'no per-token fallback was needed');
  });

  test('what DefiLlama cannot price falls through to CoinGecko', async () => {
    handler = (url) => {
      if (url.includes('llama')) return llamaBody([USDC]); // DAI omitted
      return { [DAI]: { usd: 0.99 } };
    };
    const p = oracle({ noCache: true });

    const out = await p.tokenPrices('ethereum', [USDC, DAI]);

    assert.equal(out.get(USDC), 1.0, 'from llama');
    assert.equal(out.get(DAI), 0.99, 'from the fallback');
    assert.equal(geckoHits(), 1);
  });

  test('an unpriceable token is absent, never zero', async () => {
    // A missing price must not become a $0 valuation; downstream treats absent
    // as unknown and zero as a fact.
    handler = () => ({ coins: {} });
    const p = oracle({ noCache: true });

    const out = await p.tokenPrices('ethereum', [USDC]);

    assert.equal(out.has(USDC), false);
    assert.equal(out.get(USDC), undefined);
  });

  test('a long tail of unpriceable tokens does not become a throttled crawl', async () => {
    // Unkeyed CoinGecko refuses multi-address requests, so the fallback is one
    // call per token. It is capped; the rest stay unpriced rather than costing
    // an hour.
    const many = Array.from({ length: 200 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    handler = (url) => (url.includes('llama') ? { coins: {} } : {});
    const p = oracle({ noCache: true });

    await p.tokenPrices('ethereum', many);

    assert.ok(geckoHits() <= 25, `fallback ran ${geckoHits()} times, expected a cap of 25`);
  });

  test('a token asked for twice is fetched once', async () => {
    handler = (url) => (url.includes('llama') ? llamaBody([USDC]) : {});
    const p = oracle({ noCache: true });

    await p.tokenPrices('ethereum', [USDC]);
    const before = calls.length;
    await p.tokenPrices('ethereum', [USDC]);

    assert.equal(calls.length, before, 'the second call is served from memory');
  });

  test('a token that failed to price is not retried within the run', async () => {
    handler = () => ({ coins: {} });
    const p = oracle({ noCache: true });

    await p.tokenPrices('ethereum', [USDC]);
    const before = calls.length;
    await p.tokenPrices('ethereum', [USDC]);

    assert.equal(calls.length, before);
  });

  test('an empty request makes no call at all', async () => {
    const p = oracle({ noCache: true });
    const out = await p.tokenPrices('ethereum', []);
    assert.equal(out.size, 0);
    assert.equal(calls.length, 0);
  });
});

/* ──────────────────────────────────────────────────── spot prices ── */

describe('spot prices', () => {
  test('the native asset is priced by its CoinGecko id', async () => {
    handler = () => ({ ethereum: { usd: 3000 } });
    const p = oracle({ noCache: true });
    assert.equal(await p.nativePrice('ethereum'), 3000);
  });

  test('L2s settle in ETH, so they price against the same id', async () => {
    handler = () => ({ ethereum: { usd: 3000 } });
    const p = oracle({ noCache: true });

    assert.equal(await p.nativePrice('base'), 3000);
    const before = calls.length;
    assert.equal(await p.nativePrice('arbitrum'), 3000);
    assert.equal(calls.length, before, 'the shared id is only fetched once');
  });

  test('polygon has its own native asset', async () => {
    handler = () => ({ 'matic-network': { usd: 0.42 } });
    const p = oracle({ noCache: true });
    assert.equal(await p.nativePrice('polygon'), 0.42);
  });

  test('spot prices are never written to disk', async () => {
    // A stale spot price is a wrong number presented confidently, which is the
    // failure this whole tool exists to avoid.
    handler = () => ({ ethereum: { usd: 3000 } });
    const p = oracle();
    await p.nativePrice('ethereum');
    p.flush();

    calls = [];
    const other = oracle();
    await other.nativePrice('ethereum');
    assert.ok(calls.length > 0, 'a spot price must be re-fetched, not remembered');
  });

  test('an unpriceable asset returns undefined rather than throwing', async () => {
    handler = () => ({});
    const p = oracle({ noCache: true });
    assert.equal(await p.nativePrice('ethereum'), undefined);
  });
});
