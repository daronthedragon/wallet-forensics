/**
 * Normalized data model.
 *
 * Every chain adapter converts its native shapes into these types, so the
 * analysis layer never needs to know whether it is looking at an EVM
 * transaction or a Solana one.
 */

export type Chain = 'ethereum' | 'solana';

/** A transaction, flattened to the fields the analysis layer actually uses. */
export interface NormalizedTx {
  /** Tx hash (EVM) or signature (Solana). */
  id: string;
  chain: Chain;
  timestamp: Date;
  /** Block number (EVM) or slot (Solana). */
  block: number;
  /** Whether the subject address originated this tx. */
  outgoing: boolean;
  /** Fee paid in native units (wei / lamports). Zero if the subject didn't pay. */
  fee: bigint;
  /** Fee converted to USD at the time of the transaction, when pricing is available. */
  feeUsd?: number;
  /** True if the transaction reverted / failed. Failed txs still cost fees. */
  failed: boolean;
  /** Counterparty address, when there is a single obvious one. */
  counterparty?: string;
  /** Best-effort label, e.g. "Uniswap V3: swap" or "Jupiter: route". */
  label?: string;
  /** Token movements attributed to the subject address. */
  transfers: TokenTransfer[];
}

/** A single token movement in or out of the subject address. */
export interface TokenTransfer {
  /** Contract address (EVM) or mint (Solana). `native` for ETH/SOL itself. */
  asset: string;
  symbol?: string;
  decimals: number;
  /** Positive = received, negative = sent. Raw base units. */
  amount: bigint;
  /** USD value at transaction time, when historical pricing is available. */
  valueUsd?: number;
}

/** A token the address currently holds. */
export interface TokenBalance {
  asset: string;
  symbol?: string;
  name?: string;
  decimals: number;
  amount: bigint;
  priceUsd?: number;
  valueUsd?: number;
}

/** An outstanding spend permission granted to a third party. */
export interface Approval {
  chain: Chain;
  /** Token contract (EVM) or mint (Solana). */
  asset: string;
  symbol?: string;
  /** Who is allowed to spend. */
  spender: string;
  spenderLabel?: string;
  /** Raw allowance. `null` means unlimited. */
  allowance: bigint | null;
  /** Allowance expressed in USD at current prices, capped at the balance held. */
  atRiskUsd?: number;
  /** When the approval was granted. */
  grantedAt?: Date;
  /** Heuristic risk assessment. */
  risk: 'critical' | 'high' | 'medium' | 'low';
  riskReasons: string[];
}

/** Evidence that value was extracted from one of the subject's transactions. */
export interface MevEvent {
  /** The victim transaction (belonging to the subject). */
  victimTx: string;
  block: number;
  timestamp: Date;
  kind: 'sandwich' | 'frontrun' | 'backrun';
  /** The address that captured the value, when identifiable. */
  attacker?: string;
  /** Attacker's leading transaction, for sandwiches. */
  frontTx?: string;
  /** Attacker's trailing transaction, for sandwiches. */
  backTx?: string;
  /** Estimated value extracted, in USD. */
  extractedUsd: number;
  /** How confident the detector is in this classification. */
  confidence: 'high' | 'medium' | 'low';
}

/** How much of a position can actually be sold before slippage bites. */
export interface ExitLiquidity {
  asset: string;
  symbol?: string;
  /** Nominal value: balance x spot price. What every portfolio tracker shows. */
  nominalUsd: number;
  /** Proceeds if the entire position were sold right now, per routing simulation. */
  realizableUsd: number;
  /** Largest sale, in USD, that stays under 5% price impact. */
  maxExitUnder5Pct: number;
  /** Price impact of selling the whole position, as a fraction (0.2 = 20%). */
  fullExitImpact: number;
  /** realizableUsd / nominalUsd. Below ~0.9 means the tracker is lying to you. */
  liquidityRatio: number;
  /** Set when quotes could not be obtained (no route, API failure, etc.). */
  error?: string;
}

/** A closed or open position with cost-basis accounting attached. */
export interface Position {
  asset: string;
  symbol?: string;
  decimals: number;
  /** Units still held. */
  openAmount: bigint;
  /** Weighted-average cost of the units still held, in USD. */
  costBasisUsd: number;
  /** Realized gain/loss from units already sold, in USD. */
  realizedPnlUsd: number;
  /** Unrealized gain/loss on units still held, in USD. */
  unrealizedPnlUsd: number;
  /** Number of acquisitions and disposals seen. */
  buys: number;
  sells: number;
  firstAcquired?: Date;
  lastActivity?: Date;
}

/** A single expensive mistake, surfaced for the report's headline section. */
export interface Regret {
  kind: 'worst-trade' | 'mev-victim' | 'failed-tx-burn' | 'stale-approval' | 'illiquid-bag';
  title: string;
  detail: string;
  /** Dollar cost of the mistake. Used for ranking. */
  costUsd: number;
  /** Link back to the on-chain evidence. */
  reference?: string;
  timestamp?: Date;
}

/** High-level activity statistics. */
export interface ActivitySummary {
  address: string;
  chain: Chain;
  firstSeen?: Date;
  lastSeen?: Date;
  ageDays?: number;
  totalTxs: number;
  failedTxs: number;
  /** Distinct counterparties interacted with. */
  uniqueCounterparties: number;
  /** Protocol labels ranked by interaction count. */
  topProtocols: Array<{ label: string; count: number }>;
  /** Busiest single day of activity. */
  busiestDay?: { date: string; count: number };
}

/** Total transaction costs over the address's lifetime. */
export interface FeeSummary {
  chain: Chain;
  /** Native units burned (wei / lamports). */
  totalNative: bigint;
  nativeSymbol: string;
  /** USD at the time each fee was paid, when historical pricing is available. */
  totalUsdHistorical?: number;
  /** USD if all that native currency were valued at today's price. */
  totalUsdAtCurrentPrice?: number;
  /** Fees spent on transactions that reverted. Pure waste. */
  wastedOnFailedUsd?: number;
  averageUsdPerTx?: number;
  mostExpensiveTx?: { id: string; usd: number; timestamp: Date };
}

/** The complete report for one address on one chain. */
export interface ChainReport {
  chain: Chain;
  address: string;
  activity: ActivitySummary;
  fees: FeeSummary;
  positions: Position[];
  balances: TokenBalance[];
  approvals: Approval[];
  mev: {
    events: MevEvent[];
    totalExtractedUsd: number;
  };
  liquidity: ExitLiquidity[];
  regrets: Regret[];
  /** Non-fatal problems encountered while building the report. */
  warnings: string[];
}

/** The top-level report, spanning every chain that was analyzed. */
export interface ForensicsReport {
  generatedAt: Date;
  chains: ChainReport[];
  totals: {
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    feesUsd: number;
    mevExtractedUsd: number;
    /** Nominal portfolio value across chains. */
    portfolioNominalUsd: number;
    /** What that portfolio could actually be sold for. */
    portfolioRealizableUsd: number;
  };
  /** The most expensive mistakes across all chains, ranked. */
  topRegrets: Regret[];
}

export interface AnalysisOptions {
  /** Only consider activity at or after this date. */
  since?: Date;
  /** Cap on transactions fetched per chain. Guards against enormous wallets. */
  maxTransactions: number;
  /** Skip the MEV pass, which is the slowest stage (it reads full blocks). */
  skipMev: boolean;
  /** Skip exit-liquidity routing quotes. */
  skipLiquidity: boolean;
  /** Emit progress to stderr. */
  verbose: boolean;
}
