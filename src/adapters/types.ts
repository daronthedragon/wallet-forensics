import type {
  Approval,
  AnalysisOptions,
  Chain,
  MevEvent,
  NormalizedTx,
  TokenBalance,
} from '../types.js';

/**
 * The contract every chain implements.
 *
 * Adding a chain means writing one of these — the analysis and reporting
 * layers need no changes. Optional methods let a chain opt out of a capability
 * it genuinely cannot provide (Solana has no ERC-20-style approvals, for
 * instance, so its `getApprovals` reports delegations instead).
 */
export interface ChainAdapter {
  readonly chain: Chain;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;

  /** Cheap syntactic check. Does not touch the network. */
  isValidAddress(address: string): boolean;

  /** Transaction history, newest first, subject to `opts.maxTransactions`. */
  getTransactions(address: string, opts: AnalysisOptions): Promise<NormalizedTx[]>;

  /** Current holdings, including the native asset. */
  getBalances(address: string): Promise<TokenBalance[]>;

  /** Outstanding spend permissions granted to third parties. */
  getApprovals(address: string, txs: NormalizedTx[]): Promise<Approval[]>;

  /**
   * Look for value extracted from the subject's transactions.
   *
   * Implementations receive the already-fetched history so they can narrow the
   * search to blocks the subject actually appears in.
   */
  detectMev(address: string, txs: NormalizedTx[], opts: AnalysisOptions): Promise<MevEvent[]>;

  /**
   * Simulate selling `amount` of `asset` and report the proceeds in USD along
   * with the price impact. Returns null when no route exists.
   */
  quoteSell(
    asset: string,
    amount: bigint,
    decimals: number,
  ): Promise<{ proceedsUsd: number; priceImpact: number } | null>;
}

/** Thrown when an adapter cannot complete a request but the run should continue. */
export class AdapterWarning extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = 'AdapterWarning';
  }
}
