import { config, NATIVE_COINGECKO_IDS } from '../config.js';
import type { Chain } from '../types.js';

/**
 * Price oracle backed by CoinGecko.
 *
 * Two things matter here and both are about not getting rate limited:
 *
 *  1. Everything is cached in-process, and historical native prices are cached
 *     by day rather than by timestamp — fee analysis asks for thousands of
 *     prices that collapse into a few hundred distinct days.
 *  2. Token lookups are batched. CoinGecko's contract endpoint accepts up to
 *     ~100 addresses per call, which turns a 300-token wallet into 3 requests.
 *
 * The free tier is ~10-30 calls/minute. A cold run on a busy wallet will still
 * take a while; a warm one is nearly instant.
 */
export class PriceOracle {
  private currentCache = new Map<string, number>();
  private historicalCache = new Map<string, number>();
  private missing = new Set<string>();
  private lastCall = 0;

  constructor(private readonly minIntervalMs = config.pricing.coingeckoKey ? 120 : 2200) {}

  /** Current USD price of a chain's native asset. */
  async nativePrice(chain: Chain): Promise<number | undefined> {
    const id = NATIVE_COINGECKO_IDS[chain];
    if (!id) return undefined;
    return this.priceByIds([id]).then((m) => m.get(id));
  }

  /**
   * USD price of a chain's native asset on a given date.
   *
   * Resolution is one day, which is the right granularity for "what did this
   * fee cost me" and avoids hammering the API for per-block precision that
   * nobody reads.
   */
  async nativePriceOn(chain: Chain, when: Date): Promise<number | undefined> {
    const id = NATIVE_COINGECKO_IDS[chain];
    if (!id) return undefined;

    const day = toDayKey(when);
    const key = `${id}:${day}`;
    if (this.historicalCache.has(key)) return this.historicalCache.get(key);
    if (this.missing.has(key)) return undefined;

    // CoinGecko's /history endpoint wants dd-mm-yyyy.
    const [y, m, d] = day.split('-');
    const url = `${config.pricing.base}/coins/${id}/history?date=${d}-${m}-${y}&localization=false`;

    try {
      const json = await this.fetchJson<{
        market_data?: { current_price?: Record<string, number> };
      }>(url);
      const price = json.market_data?.current_price?.['usd'];
      if (typeof price === 'number') {
        this.historicalCache.set(key, price);
        return price;
      }
    } catch {
      // Fall through to the miss path below.
    }
    this.missing.add(key);
    return undefined;
  }

  /**
   * Current USD prices for a set of token contract addresses on one chain.
   *
   * Unknown tokens are simply absent from the returned map — callers treat a
   * missing price as "unpriceable" rather than zero, which keeps worthless-token
   * noise out of the totals.
   */
  async tokenPrices(chain: Chain, addresses: string[]): Promise<Map<string, number>> {
    const platform = chain === 'ethereum' ? 'ethereum' : 'solana';
    const out = new Map<string, number>();
    const needed: string[] = [];

    for (const raw of addresses) {
      const addr = raw.toLowerCase();
      const key = `${platform}:${addr}`;
      if (this.currentCache.has(key)) {
        out.set(raw, this.currentCache.get(key)!);
      } else if (!this.missing.has(key)) {
        needed.push(raw);
      }
    }

    for (const batch of chunk(needed, 100)) {
      const list = batch.join(',');
      const url =
        `${config.pricing.base}/simple/token_price/${platform}` +
        `?contract_addresses=${encodeURIComponent(list)}&vs_currencies=usd`;

      try {
        const json = await this.fetchJson<Record<string, { usd?: number }>>(url);
        for (const addr of batch) {
          // CoinGecko lowercases EVM keys but preserves Solana mint casing.
          const hit = json[addr] ?? json[addr.toLowerCase()];
          const key = `${platform}:${addr.toLowerCase()}`;
          if (hit?.usd !== undefined) {
            this.currentCache.set(key, hit.usd);
            out.set(addr, hit.usd);
          } else {
            this.missing.add(key);
          }
        }
      } catch {
        for (const addr of batch) this.missing.add(`${platform}:${addr.toLowerCase()}`);
      }
    }

    return out;
  }

  /** Current USD prices for a set of CoinGecko ids. */
  private async priceByIds(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const needed = ids.filter((id) => {
      const key = `id:${id}`;
      if (this.currentCache.has(key)) {
        out.set(id, this.currentCache.get(key)!);
        return false;
      }
      return !this.missing.has(key);
    });

    if (needed.length === 0) return out;

    const url = `${config.pricing.base}/simple/price?ids=${needed.join(',')}&vs_currencies=usd`;
    try {
      const json = await this.fetchJson<Record<string, { usd?: number }>>(url);
      for (const id of needed) {
        const price = json[id]?.usd;
        if (price !== undefined) {
          this.currentCache.set(`id:${id}`, price);
          out.set(id, price);
        } else {
          this.missing.add(`id:${id}`);
        }
      }
    } catch {
      for (const id of needed) this.missing.add(`id:${id}`);
    }
    return out;
  }

  /** Rate-limited fetch with one retry on 429. */
  private async fetchJson<T>(url: string): Promise<T> {
    await this.throttle();

    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.pricing.coingeckoKey) {
      headers['x-cg-pro-api-key'] = config.pricing.coingeckoKey;
    }

    let res = await fetch(url, { headers });
    if (res.status === 429) {
      await sleep(3000);
      res = await fetch(url, { headers });
    }
    if (!res.ok) throw new Error(`CoinGecko ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  private async throttle(): Promise<void> {
    const since = Date.now() - this.lastCall;
    if (since < this.minIntervalMs) await sleep(this.minIntervalMs - since);
    this.lastCall = Date.now();
  }
}

function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // yyyy-mm-dd
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
