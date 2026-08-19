/*
 * VENDORED — do not edit here.
 *
 * Upstream: https://github.com/daronthedragon/wallet-forensics-skill
 *           core/cache.mjs
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
 * On-disk cache for responses that are safe to reuse.
 *
 * The point is not general speed, it is that the unkeyed CoinGecko tier allows
 * roughly one call every 2.2 seconds, and a wallet with three years of history
 * asks for a price on several hundred distinct days. That is the wall-clock
 * cost of the whole run, paid again on every invocation, for data that cannot
 * change.
 *
 * What may be cached is decided by whether the answer is still true later:
 *
 *   forever    a historical daily price, a token's symbol and decimals — facts
 *              about the past, or about a contract that cannot change them
 *   briefly    nothing here yet; spot prices and balances are deliberately not
 *              cached, because a stale one is a wrong number presented with
 *              confidence, which is the failure this tool exists to avoid
 *
 * Entries are held in one JSON file per namespace, read once and written on
 * flush, because thousands of tiny files is worse for both disk and startup.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Never expires. For facts that cannot change. */
export const FOREVER = null;

export function defaultCacheDir() {
  const override = process.env['WALLET_FORENSICS_CACHE_DIR'];
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.cache', 'wallet-forensics');
}

export function cacheDisabled() {
  const v = process.env['WALLET_FORENSICS_NO_CACHE'];
  return Boolean(v && v !== '0' && v !== 'false');
}

/**
 * @param {string} namespace  file name stem, e.g. "prices"
 * @param {{dir?: string, disabled?: boolean, now?: () => number}} [opts]
 */
export function createCache(namespace, opts = {}) {
  const disabled = opts.disabled ?? cacheDisabled();
  const dir = opts.dir ?? defaultCacheDir();
  const now = opts.now ?? (() => Date.now());
  const file = join(dir, `${namespace}.json`);

  /** @type {Map<string, {v: any, e: number|null}>} */
  let entries = new Map();
  let loaded = disabled;
  let dirty = false;
  let hits = 0;
  let misses = 0;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object' && raw.entries) {
          entries = new Map(Object.entries(raw.entries));
        }
      }
    } catch {
      // A corrupt or half-written cache is not worth failing a run over.
      // Starting empty costs time, not correctness.
      entries = new Map();
    }
  }

  return {
    /** Returns the cached value, or undefined on a miss or an expired entry. */
    get(key) {
      if (disabled) return undefined;
      load();
      const hit = entries.get(key);
      if (!hit) {
        misses++;
        return undefined;
      }
      if (hit.e !== null && hit.e <= now()) {
        entries.delete(key);
        misses++;
        return undefined;
      }
      hits++;
      return hit.v;
    },

    /**
     * @param {string} key
     * @param {any} value
     * @param {number|null} ttlMs  FOREVER for facts that cannot change.
     */
    set(key, value, ttlMs = FOREVER) {
      if (disabled || value === undefined) return;
      load();
      entries.set(key, { v: value, e: ttlMs === null ? null : now() + ttlMs });
      dirty = true;
    },

    /** Write to disk. Safe to call when nothing changed. */
    flush() {
      if (disabled || !dirty) return;
      try {
        mkdirSync(dir, { recursive: true });
        const payload = JSON.stringify({
          version: 1,
          entries: Object.fromEntries(entries),
        });
        // Write then rename, so an interrupted run cannot leave a truncated
        // file that the next one has to throw away.
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, payload);
        renameSync(tmp, file);
        dirty = false;
      } catch {
        // A cache that cannot be written is a slow run, not a failed one.
      }
    },

    stats() {
      return { hits, misses, size: entries.size, file, disabled };
    },
  };
}
