/*
 * VENDORED — do not edit here.
 *
 * Upstream: https://github.com/daronthedragon/wallet-forensics-skill
 *           core/prices.mjs
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
 * Batched token pricing.
 *
 * CoinGecko's unkeyed tier rejects any request carrying more than one contract
 * address, so pricing a wallet's holdings costs one throttled request per
 * token. An address that has been airdropped spam for years holds thousands of
 * them, which is hours of wall clock for a number nobody waits around for.
 *
 * DefiLlama's coins API takes many addresses per request and needs no key, so
 * the same work becomes tens of requests instead of thousands. It also returns
 * the symbol and decimals, which saves a separate metadata lookup.
 *
 * No imports: `fetch` is a global in the versions of Node this targets, which
 * keeps this file usable in a repo that must stay dependency-free.
 */

/** Addresses per request. DefiLlama accepts long queries; this stays under
 *  common URL length limits with room for the chain prefix on each entry. */
const BATCH = 100;

const ENDPOINT = 'https://coins.llama.fi/prices/current/';

/**
 * Prices below this confidence are discarded.
 *
 * DefiLlama reports how sure it is. A thin, manipulated or barely-traded pool
 * can produce a confident-looking number that is not a price anyone could
 * transact at, and this tool's whole argument is against reporting those.
 */
const MIN_CONFIDENCE = 0.7;

/**
 * @param {string} llamaChain  DefiLlama chain key, e.g. "ethereum", "base".
 * @param {string[]} addresses  Contract addresses or Solana mints.
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<Map<string, {price: number, symbol?: string, decimals?: number}>>}
 *   Only addresses that were priced appear. A missing entry means unpriced,
 *   which callers must treat as unknown rather than zero.
 */
export async function fetchLlamaTokenPrices(llamaChain, addresses, opts = {}) {
  const out = new Map();
  if (!llamaChain || addresses.length === 0) return out;

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // Preserve the caller's casing for the returned keys: Solana mints are
  // case-sensitive, while EVM addresses are not.
  const byLower = new Map(addresses.map((a) => [a.toLowerCase(), a]));
  const unique = [...byLower.values()];

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const query = batch.map((a) => `${llamaChain}:${a}`).join(',');

    let json;
    try {
      const res = await doFetch(ENDPOINT + encodeURIComponent(query), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue; // a failed batch is unpriced, not zero
      json = await res.json();
    } catch {
      continue;
    }

    const coins = json?.coins;
    if (!coins || typeof coins !== 'object') continue;

    for (const [key, info] of Object.entries(coins)) {
      if (!info || typeof info.price !== 'number') continue;
      if (typeof info.confidence === 'number' && info.confidence < MIN_CONFIDENCE) continue;

      const addr = key.slice(key.indexOf(':') + 1);
      const original = byLower.get(addr.toLowerCase()) ?? addr;
      out.set(original, {
        price: info.price,
        symbol: typeof info.symbol === 'string' ? info.symbol : undefined,
        decimals: typeof info.decimals === 'number' ? info.decimals : undefined,
      });
    }
  }

  return out;
}

/** Requests this many addresses will take, for progress reporting. */
export function llamaBatchCount(n) {
  return Math.ceil(n / BATCH);
}
