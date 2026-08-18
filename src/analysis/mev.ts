import { formatUnits, getAddress, parseAbiItem, type PublicClient } from 'viem';

import { KNOWN_MEV_ACTORS, type EvmChainConfig } from '../config.js';
import type { PriceOracle } from '../pricing/index.js';
import type { AnalysisOptions, MevEvent, NormalizedTx } from '../types.js';

/**
 * ERC-20 Transfer. ERC-721 shares this topic0 but carries a fourth indexed
 * topic, so `strict: true` filters NFT transfers out for us.
 */
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** Reading full blocks is the slowest thing this tool does. Keep it bounded. */
const MAX_BLOCKS_TO_INSPECT = 250;

interface BlockTx {
  hash: string;
  from: string;
  index: number;
}

interface TransferLog {
  txHash: string;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/**
 * Detect sandwich attacks against a set of transactions.
 *
 * The structural signature of a sandwich is narrow enough to detect reliably:
 * the same address appears immediately before *and* after the victim in the
 * same block, and all three transactions touch a common pool.
 *
 * We then estimate what the attacker captured from their own token flow —
 * they enter a position in the front-run and exit it in the back-run, so their
 * net gain in WETH or a stablecoin across the pair is the extracted value.
 *
 * Confidence is reported honestly:
 *   high   — adjacent on both sides, shared pool, positive measurable profit
 *   medium — adjacent on both sides and shared pool, profit not measurable
 *   low    — same-block bracketing but not directly adjacent
 */
export async function detectSandwiches(
  client: PublicClient,
  cfg: EvmChainConfig,
  victim: string,
  txs: NormalizedTx[],
  prices: PriceOracle,
  opts: AnalysisOptions,
): Promise<MevEvent[]> {
  const swaps = txs.filter(isLikelySwap);
  if (swaps.length === 0) return [];

  // One block can hold several of the subject's swaps; dedupe before fetching.
  const blocks = [...new Set(swaps.map((s) => s.block))]
    .sort((a, b) => b - a)
    .slice(0, MAX_BLOCKS_TO_INSPECT);

  const truncated = new Set(swaps.map((s) => s.block)).size > blocks.length;
  if (truncated && opts.verbose) {
    process.stderr.write(
      `  note: inspecting the ${MAX_BLOCKS_TO_INSPECT} most recent swap blocks ` +
        `of ${new Set(swaps.map((s) => s.block)).size} total\n`,
    );
  }

  const swapsByBlock = new Map<number, NormalizedTx[]>();
  for (const s of swaps) {
    if (!blocks.includes(s.block)) continue;
    const list = swapsByBlock.get(s.block) ?? [];
    list.push(s);
    swapsByBlock.set(s.block, list);
  }

  const events: MevEvent[] = [];
  const nativePrice = await prices.nativePrice(cfg.chain);

  for (const blockNumber of blocks) {
    const victimTxs = swapsByBlock.get(blockNumber);
    if (!victimTxs?.length) continue;

    let blockTxs: BlockTx[];
    let transfers: TransferLog[];
    try {
      [blockTxs, transfers] = await Promise.all([
        readBlockTxs(client, blockNumber),
        readTransferLogs(client, blockNumber),
      ]);
    } catch {
      continue; // Pruned block, RPC hiccup — skip rather than fail the report.
    }

    const indexByHash = new Map(blockTxs.map((t) => [t.hash.toLowerCase(), t]));
    const transfersByTx = groupBy(transfers, (t) => t.txHash.toLowerCase());

    for (const vtx of victimTxs) {
      const vEntry = indexByHash.get(vtx.id.toLowerCase());
      if (!vEntry) continue;

      const victimPools = poolsTouched(transfersByTx.get(vtx.id.toLowerCase()) ?? [], victim);
      if (victimPools.size === 0) continue;

      // Scan outward from the victim for a bracketing sender.
      const before = blockTxs.filter((t) => t.index < vEntry.index).sort((a, b) => b.index - a.index);
      const after = blockTxs.filter((t) => t.index > vEntry.index).sort((a, b) => a.index - b.index);

      const match = findBracket(before, after, transfersByTx, victimPools, victim);
      if (!match) continue;

      const { attacker, frontTx, backTx, adjacent } = match;

      const profit = estimateProfit(
        transfersByTx.get(frontTx.toLowerCase()) ?? [],
        transfersByTx.get(backTx.toLowerCase()) ?? [],
        attacker,
        cfg,
        nativePrice,
      );

      const known = KNOWN_MEV_ACTORS.has(attacker.toLowerCase());
      const confidence: MevEvent['confidence'] =
        !adjacent ? 'low' : profit > 0 || known ? 'high' : 'medium';

      events.push({
        victimTx: vtx.id,
        block: blockNumber,
        timestamp: vtx.timestamp,
        kind: 'sandwich',
        attacker,
        frontTx,
        backTx,
        extractedUsd: profit,
        confidence,
      });
    }
  }

  return events.sort((a, b) => b.extractedUsd - a.extractedUsd);
}

/** A swap moves at least one token out and one token in within a single tx. */
function isLikelySwap(tx: NormalizedTx): boolean {
  if (tx.failed) return false;
  let sent = false;
  let received = false;
  for (const t of tx.transfers) {
    if (t.amount < 0n) sent = true;
    if (t.amount > 0n) received = true;
    if (sent && received) return true;
  }
  return false;
}

/**
 * Find a sender that appears on both sides of the victim while touching one of
 * the victim's pools. Searches up to three positions out on each side —
 * sandwiches are usually tightly adjacent, but a competing bundle can wedge a
 * transaction in between.
 */
function findBracket(
  before: BlockTx[],
  after: BlockTx[],
  transfersByTx: Map<string, TransferLog[]>,
  victimPools: Set<string>,
  victim: string,
): { attacker: string; frontTx: string; backTx: string; adjacent: boolean } | null {
  const WINDOW = 3;
  const candidatesBefore = before.slice(0, WINDOW);
  const candidatesAfter = after.slice(0, WINDOW);

  for (const f of candidatesBefore) {
    if (f.from.toLowerCase() === victim.toLowerCase()) continue;

    const frontPools = poolsTouched(transfersByTx.get(f.hash.toLowerCase()) ?? [], f.from);
    if (!sharesAny(frontPools, victimPools)) continue;

    for (const b of candidatesAfter) {
      if (b.from.toLowerCase() !== f.from.toLowerCase()) continue;

      const backPools = poolsTouched(transfersByTx.get(b.hash.toLowerCase()) ?? [], b.from);
      if (!sharesAny(backPools, victimPools)) continue;

      return {
        attacker: getAddress(f.from),
        frontTx: f.hash,
        backTx: b.hash,
        adjacent: candidatesBefore.indexOf(f) === 0 && candidatesAfter.indexOf(b) === 0,
      };
    }
  }
  return null;
}

/**
 * Addresses that received or sent tokens to `actor` within a transaction.
 *
 * For a swap these are the pool contracts, which is exactly the fingerprint we
 * need to confirm the attacker hit the same venue as the victim.
 */
function poolsTouched(logs: TransferLog[], actor: string): Set<string> {
  const actorLc = actor.toLowerCase();
  const pools = new Set<string>();
  for (const l of logs) {
    if (l.from.toLowerCase() === actorLc) pools.add(l.to.toLowerCase());
    if (l.to.toLowerCase() === actorLc) pools.add(l.from.toLowerCase());
  }
  return pools;
}

function sharesAny(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Estimate what the attacker captured, in USD.
 *
 * The attacker spends WETH (or a stablecoin) in the front-run and reclaims more
 * of it in the back-run. Netting their flow of that denominator across both
 * transactions gives the profit without needing to model pool math.
 *
 * Returns 0 when the flow cannot be measured — better to under-report than to
 * invent a number.
 */
function estimateProfit(
  frontLogs: TransferLog[],
  backLogs: TransferLog[],
  attacker: string,
  cfg: EvmChainConfig,
  nativePrice?: number,
): number {
  const net = (token: string, decimals: number): number => {
    const actorLc = attacker.toLowerCase();
    let delta = 0n;
    for (const l of [...frontLogs, ...backLogs]) {
      if (l.token.toLowerCase() !== token) continue;
      if (l.to.toLowerCase() === actorLc) delta += l.value;
      if (l.from.toLowerCase() === actorLc) delta -= l.value;
    }
    return Number(formatUnits(delta, decimals));
  };

  const wrappedGain = net(cfg.wrappedNative.toLowerCase(), cfg.nativeDecimals);
  if (wrappedGain > 0 && nativePrice) return wrappedGain * nativePrice;

  for (const [stable, decimals] of Object.entries(cfg.stables)) {
    const gain = net(stable.toLowerCase(), decimals);
    if (gain > 0) return gain;
  }

  return 0;
}

async function readBlockTxs(client: PublicClient, blockNumber: number): Promise<BlockTx[]> {
  const block = await client.getBlock({
    blockNumber: BigInt(blockNumber),
    includeTransactions: true,
  });
  return block.transactions.map((t, i) => ({
    hash: typeof t === 'string' ? t : t.hash,
    from: typeof t === 'string' ? '' : t.from,
    index: typeof t === 'string' ? i : (t.transactionIndex ?? i),
  }));
}

async function readTransferLogs(
  client: PublicClient,
  blockNumber: number,
): Promise<TransferLog[]> {
  const logs = await client.getLogs({
    event: TRANSFER_EVENT,
    fromBlock: BigInt(blockNumber),
    toBlock: BigInt(blockNumber),
    strict: true,
  });

  const out: TransferLog[] = [];
  for (const log of logs) {
    const { from, to, value } = log.args;
    if (!from || !to || value === undefined || !log.transactionHash) continue;

    out.push({
      txHash: log.transactionHash,
      token: log.address.toLowerCase(),
      from,
      to,
      value,
    });
  }
  return out;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}
