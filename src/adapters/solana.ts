import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';

import { config, NATIVE_ASSET, SOLANA_CONFIG } from '../config.js';
import type { PriceOracle } from '../pricing/index.js';
import type {
  Approval,
  AnalysisOptions,
  MevEvent,
  NormalizedTx,
  TokenBalance,
  TokenTransfer,
} from '../types.js';
import { AdapterWarning, type ChainAdapter, type QuoteResult } from './types.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Programs worth naming in the report. */
const KNOWN_PROGRAMS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter Aggregator v6',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter Aggregator v4',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpools',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Raydium Liquidity Pool',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
};

/** Signature pages to pull. Each page is up to 1000 signatures. */
const MAX_SIGNATURE_PAGES = 10;

/** Parsed-transaction batch size. Larger batches get rejected by most providers. */
const TX_BATCH_SIZE = 50;

/** Blocks to inspect for MEV. Solana blocks are large; keep this small. */
const MAX_BLOCKS_TO_INSPECT = 40;

export class SolanaAdapter implements ChainAdapter {
  readonly chain = 'solana' as const;
  readonly nativeSymbol = 'SOL';
  readonly nativeDecimals = 9;

  private readonly conn: Connection;

  constructor(private readonly prices: PriceOracle) {
    this.conn = new Connection(SOLANA_CONFIG.rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
    });
  }

  isValidAddress(address: string): boolean {
    try {
      const key = new PublicKey(address);
      return PublicKey.isOnCurve(key.toBytes()) || key.toBase58() === address;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- history

  async getTransactions(address: string, opts: AnalysisOptions): Promise<NormalizedTx[]> {
    const owner = new PublicKey(address);
    const signatures = await this.fetchSignatures(owner, opts);
    if (signatures.length === 0) return [];

    const wanted = signatures.slice(0, opts.maxTransactions);
    const out: NormalizedTx[] = [];

    for (let i = 0; i < wanted.length; i += TX_BATCH_SIZE) {
      const batch = wanted.slice(i, i + TX_BATCH_SIZE);
      if (opts.verbose) {
        process.stderr.write(
          `  fetching transactions ${i + 1}-${Math.min(i + TX_BATCH_SIZE, wanted.length)} of ${wanted.length}\r`,
        );
      }

      let parsed: (ParsedTransactionWithMeta | null)[];
      try {
        parsed = await this.conn.getParsedTransactions(
          batch.map((s) => s.signature),
          { maxSupportedTransactionVersion: 0 },
        );
      } catch (err) {
        throw new AdapterWarning(
          `Failed to fetch parsed transactions: ${(err as Error).message.slice(0, 120)}. ` +
            `The public Solana endpoint is heavily rate limited — set SOLANA_RPC_URL to a dedicated provider.`,
          'history',
        );
      }

      parsed.forEach((tx, j) => {
        const sig = batch[j];
        if (!tx || !sig) return;
        const normalized = this.toNormalized(tx, sig, address);
        if (opts.since && normalized.timestamp < opts.since) return;
        out.push(normalized);
      });
    }

    if (opts.verbose) process.stderr.write('\n');

    await this.priceFees(out);
    return out;
  }

  private async fetchSignatures(
    owner: PublicKey,
    opts: AnalysisOptions,
  ): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const batch = await this.conn.getSignaturesForAddress(owner, { before, limit: 1000 });
      if (batch.length === 0) break;
      all.push(...batch);

      const last = batch[batch.length - 1];
      before = last?.signature;

      if (all.length >= opts.maxTransactions) break;
      if (opts.since && last?.blockTime && last.blockTime * 1000 < opts.since.getTime()) break;
      if (batch.length < 1000) break;
    }

    return all;
  }

  /**
   * Convert a parsed transaction into the normalized shape.
   *
   * Solana gives us pre/post balance snapshots rather than transfer events,
   * which is actually more reliable — netting the snapshots captures every
   * movement including ones buried inside CPIs.
   */
  private toNormalized(
    tx: ParsedTransactionWithMeta,
    sig: ConfirmedSignatureInfo,
    owner: string,
  ): NormalizedTx {
    const meta = tx.meta;
    const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const ownerIndex = accountKeys.indexOf(owner);
    const feePayer = accountKeys[0];
    const paidFee = feePayer === owner;

    const transfers: TokenTransfer[] = [];

    // Native SOL delta. For the fee payer this includes the fee, so add it
    // back to isolate the economic movement.
    if (ownerIndex >= 0 && meta) {
      const pre = BigInt(meta.preBalances[ownerIndex] ?? 0);
      const post = BigInt(meta.postBalances[ownerIndex] ?? 0);
      let delta = post - pre;
      if (paidFee) delta += BigInt(meta.fee);
      if (delta !== 0n) {
        transfers.push({
          asset: NATIVE_ASSET,
          symbol: 'SOL',
          decimals: 9,
          amount: delta,
        });
      }
    }

    // SPL token deltas, from the pre/post token balance snapshots.
    if (meta?.preTokenBalances && meta.postTokenBalances) {
      const preByKey = new Map<string, bigint>();
      const decimalsByMint = new Map<string, number>();

      for (const b of meta.preTokenBalances) {
        if (b.owner !== owner) continue;
        const key = `${b.accountIndex}:${b.mint}`;
        preByKey.set(key, BigInt(b.uiTokenAmount.amount));
        decimalsByMint.set(b.mint, b.uiTokenAmount.decimals);
      }

      const netByMint = new Map<string, bigint>();
      for (const b of meta.postTokenBalances) {
        if (b.owner !== owner) continue;
        const key = `${b.accountIndex}:${b.mint}`;
        const pre = preByKey.get(key) ?? 0n;
        const post = BigInt(b.uiTokenAmount.amount);
        decimalsByMint.set(b.mint, b.uiTokenAmount.decimals);
        netByMint.set(b.mint, (netByMint.get(b.mint) ?? 0n) + (post - pre));
        preByKey.delete(key);
      }

      // Accounts that existed before but not after: fully drained or closed.
      for (const [key, pre] of preByKey) {
        const mint = key.split(':')[1];
        if (!mint) continue;
        netByMint.set(mint, (netByMint.get(mint) ?? 0n) - pre);
      }

      for (const [mint, amount] of netByMint) {
        if (amount === 0n) continue;
        transfers.push({
          asset: mint,
          decimals: decimalsByMint.get(mint) ?? 0,
          amount,
        });
      }
    }

    return {
      id: sig.signature,
      chain: 'solana',
      timestamp: new Date((sig.blockTime ?? 0) * 1000),
      block: sig.slot,
      outgoing: paidFee,
      fee: paidFee ? BigInt(meta?.fee ?? 0) : 0n,
      failed: sig.err !== null || meta?.err !== null,
      counterparty: undefined,
      label: labelFor(accountKeys),
      transfers,
    };
  }

  private async priceFees(txs: NormalizedTx[]): Promise<void> {
    const days = new Map<string, Date>();
    for (const tx of txs) {
      if (tx.fee === 0n || tx.timestamp.getTime() === 0) continue;
      days.set(tx.timestamp.toISOString().slice(0, 10), tx.timestamp);
    }

    const priceByDay = new Map<string, number | undefined>();
    for (const [day, when] of days) {
      priceByDay.set(day, await this.prices.nativePriceOn('solana', when));
    }

    for (const tx of txs) {
      if (tx.fee === 0n) continue;
      const price = priceByDay.get(tx.timestamp.toISOString().slice(0, 10));
      if (price === undefined) continue;
      tx.feeUsd = (Number(tx.fee) / LAMPORTS_PER_SOL) * price;
    }
  }

  // --------------------------------------------------------------- balances

  async getBalances(address: string): Promise<TokenBalance[]> {
    const owner = new PublicKey(address);
    const out: TokenBalance[] = [];

    const lamports = await this.conn.getBalance(owner);
    const solPrice = await this.prices.nativePrice('solana');
    out.push({
      asset: NATIVE_ASSET,
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      amount: BigInt(lamports),
      priceUsd: solPrice,
      valueUsd: solPrice ? (lamports / LAMPORTS_PER_SOL) * solPrice : undefined,
    });

    // Both token programs — a Token-2022 mint is invisible to the classic one.
    const [classic, token2022] = await Promise.all([
      this.conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
      this.conn
        .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM })
        .catch(() => ({ value: [] as never[] })),
    ]);

    const holdings = new Map<string, { amount: bigint; decimals: number }>();
    for (const { account } of [...classic.value, ...token2022.value]) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      if (!info) continue;
      const mint = String(info['mint']);
      const tokenAmount = info['tokenAmount'] as { amount: string; decimals: number } | undefined;
      if (!tokenAmount) continue;

      const raw = BigInt(tokenAmount.amount);
      if (raw === 0n) continue;

      const prev = holdings.get(mint);
      holdings.set(mint, {
        amount: (prev?.amount ?? 0n) + raw,
        decimals: tokenAmount.decimals,
      });
    }

    if (holdings.size === 0) return out;

    const priceMap = await this.prices.tokenPrices('solana', [...holdings.keys()]);

    for (const [mint, { amount, decimals }] of holdings) {
      const price = priceMap.get(mint);
      out.push({
        asset: mint,
        decimals,
        amount,
        priceUsd: price,
        valueUsd: price ? (Number(amount) / 10 ** decimals) * price : undefined,
      });
    }

    return out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  }

  // -------------------------------------------------------------- approvals

  /**
   * Solana has no ERC-20-style allowance. The equivalent standing risk is a
   * token account **delegate**: an address permitted to move tokens out of that
   * specific account. Delegates persist until explicitly revoked, and most
   * users have no idea they exist.
   */
  async getApprovals(address: string): Promise<Approval[]> {
    const owner = new PublicKey(address);

    const [classic, token2022] = await Promise.all([
      this.conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
      this.conn
        .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM })
        .catch(() => ({ value: [] as never[] })),
    ]);

    const delegated: Array<{
      mint: string;
      delegate: string;
      amount: bigint;
      balance: bigint;
      decimals: number;
    }> = [];

    for (const { account } of [...classic.value, ...token2022.value]) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      if (!info) continue;

      const delegate = info['delegate'];
      if (!delegate || typeof delegate !== 'string') continue;

      const tokenAmount = info['tokenAmount'] as { amount: string; decimals: number } | undefined;
      const delegatedAmount = info['delegatedAmount'] as { amount: string } | undefined;
      if (!tokenAmount) continue;

      delegated.push({
        mint: String(info['mint']),
        delegate,
        amount: BigInt(delegatedAmount?.amount ?? '0'),
        balance: BigInt(tokenAmount.amount),
        decimals: tokenAmount.decimals,
      });
    }

    if (delegated.length === 0) return [];

    const priceMap = await this.prices.tokenPrices(
      'solana',
      delegated.map((d) => d.mint),
    );

    return delegated
      .map((d) => {
        const price = priceMap.get(d.mint);
        const exposed = d.amount < d.balance ? d.amount : d.balance;
        const atRiskUsd = price ? (Number(exposed) / 10 ** d.decimals) * price : undefined;

        const reasons: string[] = ['Token account has an active delegate'];
        if (d.amount >= d.balance) reasons.push('Delegate can move the entire balance');
        if (atRiskUsd && atRiskUsd > 1_000) {
          reasons.push(`$${Math.round(atRiskUsd).toLocaleString()} currently exposed`);
        }

        let risk: Approval['risk'] = 'low';
        const value = atRiskUsd ?? 0;
        if (value > 10_000) risk = 'critical';
        else if (value > 1_000) risk = 'high';
        else if (value > 50) risk = 'medium';

        return {
          chain: 'solana' as const,
          asset: d.mint,
          spender: d.delegate,
          spenderLabel: KNOWN_PROGRAMS[d.delegate],
          allowance: d.amount,
          atRiskUsd,
          risk,
          riskReasons: reasons,
        };
      })
      .sort((a, b) => (b.atRiskUsd ?? 0) - (a.atRiskUsd ?? 0));
  }

  // -------------------------------------------------------------------- MEV

  /**
   * Sandwiches on Solana ride inside Jito bundles, which land as consecutive
   * transactions in a slot. The structural signature is therefore the same as
   * on Ethereum: one fee payer bracketing the victim while touching the same
   * pool accounts.
   */
  async detectMev(
    address: string,
    txs: NormalizedTx[],
    opts: AnalysisOptions,
  ): Promise<MevEvent[]> {
    const swaps = txs.filter((t) => !t.failed && hasSwapShape(t));
    if (swaps.length === 0) return [];

    const slots = [...new Set(swaps.map((s) => s.block))]
      .sort((a, b) => b - a)
      .slice(0, MAX_BLOCKS_TO_INSPECT);

    const events: MevEvent[] = [];
    const solPrice = await this.prices.nativePrice('solana');

    for (const slot of slots) {
      let block;
      try {
        block = await this.conn.getParsedBlock(slot, {
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full',
          rewards: false,
        });
      } catch {
        // Public RPCs commonly refuse getBlock, and old slots get pruned.
        continue;
      }

      const entries = block.transactions.map((t, index) => {
        const keys = extractAccountKeys(t.transaction);
        return {
          index,
          signature: t.transaction.signatures[0] ?? '',
          feePayer: keys[0] ?? '',
          accounts: new Set<string>(keys),
        };
      });

      const victimsHere = swaps.filter((s) => s.block === slot);
      for (const victim of victimsHere) {
        const vIdx = entries.findIndex((e) => e.signature === victim.id);
        if (vIdx < 0) continue;
        const vEntry = entries[vIdx]!;

        const front = entries[vIdx - 1];
        const back = entries[vIdx + 1];
        if (!front || !back) continue;
        if (front.feePayer === address || front.feePayer !== back.feePayer) continue;

        // Confirm all three touched a common pool account.
        const shared = [...front.accounts].filter(
          (a) => vEntry.accounts.has(a) && back.accounts.has(a),
        );
        // System/token programs appear everywhere; require something else too.
        const meaningful = shared.filter((a) => !KNOWN_PROGRAMS[a]);
        if (meaningful.length === 0) continue;

        events.push({
          victimTx: victim.id,
          block: slot,
          timestamp: victim.timestamp,
          kind: 'sandwich',
          attacker: front.feePayer,
          frontTx: front.signature,
          backTx: back.signature,
          // Attributing exact profit requires modelling the pool; report the
          // detection and leave the number to a dedicated pass.
          extractedUsd: 0,
          confidence: 'medium',
        });
      }
    }

    void solPrice;
    return events;
  }

  // ------------------------------------------------------------- liquidity

  async quoteSell(
    asset: string,
    amount: bigint,
    decimals: number,
  ): Promise<QuoteResult> {
    if (asset === NATIVE_ASSET) {
      const price = await this.prices.nativePrice('solana');
      if (!price) return { ok: false, reason: 'no-price' };
      return {
        ok: true,
        proceedsUsd: (Number(amount) / LAMPORTS_PER_SOL) * price,
        priceImpact: 0,
      };
    }
    if (asset === USDC_MINT) {
      return { ok: true, proceedsUsd: Number(amount) / 10 ** decimals, priceImpact: 0 };
    }

    const url =
      `${config.jupiter.quoteUrl}?inputMint=${asset}&outputMint=${USDC_MINT}` +
      `&amount=${amount.toString()}&slippageBps=50`;

    try {
      const res = await fetch(url);
      // Jupiter answers 400 when it genuinely cannot route the pair, and 429
      // or 5xx when it simply would not answer us. Only the first is a
      // statement about the token.
      if (!res.ok) return { ok: false, reason: res.status === 400 ? 'no-route' : 'no-price' };
      const json = (await res.json()) as { outAmount?: string; priceImpactPct?: string };
      if (!json.outAmount) return { ok: false, reason: 'no-route' };

      return {
        ok: true,
        proceedsUsd: Number(json.outAmount) / 1e6, // USDC has 6 decimals
        priceImpact: Number(json.priceImpactPct ?? 0),
      };
    } catch {
      // Network failure on our side, not a verdict on the token.
      return { ok: false, reason: 'no-price' };
    }
  }
}

/**
 * Pull account keys out of a parsed transaction.
 *
 * `getParsedBlock` returns a different shape depending on `transactionDetails`:
 * the "accounts" variant puts `accountKeys` directly on the transaction, the
 * "full" variant nests it under `message`. web3.js's types don't discriminate
 * on the option, so read both.
 */
function extractAccountKeys(tx: unknown): string[] {
  const t = tx as {
    accountKeys?: Array<{ pubkey: PublicKey }>;
    message?: { accountKeys?: Array<{ pubkey: PublicKey }> };
  };
  const keys = t.accountKeys ?? t.message?.accountKeys ?? [];
  return keys.map((k) => k.pubkey.toBase58());
}

function hasSwapShape(tx: NormalizedTx): boolean {
  let sent = false;
  let received = false;
  for (const t of tx.transfers) {
    if (t.amount < 0n) sent = true;
    if (t.amount > 0n) received = true;
  }
  return sent && received;
}

function labelFor(accountKeys: string[]): string | undefined {
  for (const key of accountKeys) {
    const known = KNOWN_PROGRAMS[key];
    if (known && known !== 'System Program' && known !== 'Compute Budget') return known;
  }
  return undefined;
}
