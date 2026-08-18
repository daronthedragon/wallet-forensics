# wallet-forensics

A forensic report for any Ethereum or Solana address. Realized PnL, fees burned, value extracted by MEV bots, outstanding approval risk — and the number no portfolio tracker will show you: **what your bags are actually worth if you tried to sell them.**

One CLI, both chains, no account required.

```bash
npx wallet-forensics 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

```
  WALLET FORENSICS

  ────────────────────────────────────────────────────────────────────────

  Portfolio (nominal)       $84,210
  Portfolio (realizable)    $31,447    62.7% evaporates on exit
  Realized PnL              -$12,905
  Unrealized PnL            +$4,180
  Net PnL                   -$8,725
  Fees burned               $6,412
  Lost to MEV               $2,340

  ─ WHAT COST YOU THE MOST ───────────────────────────────────────────────

  1. Unlimited approval: USDC                                     $25,000
     0x1f9840…5f984 can move $25,000 of your USDC right now.
     Unlimited allowance. Spender is not a recognized protocol.

  2. Illiquid position: PEPE2                                     $18,300
     Shows as $21,400 but would realize $3,100 — 85% price impact to
     exit. Only $240 can be sold cleanly.

  3. Sandwiched 14 times                                           $2,340
     $2,340 extracted by MEV bots. Largest single hit: $612 in
     block 19244871.
```

## Why this exists

Every portfolio tracker computes `balance × spot price` and calls it your net worth.

For anything outside the top few hundred tokens, that number is fiction. Spot price comes from the last trade — which may have been $40 against a pool holding $3,000 of liquidity. Selling a "$50,000" position into that pool does not produce $50,000. It produces maybe $4,000 and a chart that looks like a cliff.

This tool route-quotes the actual sale and reports the gap. It also surfaces the other things that quietly cost you money and never appear on a dashboard: the unlimited approval you granted in 2021 and forgot, the sandwich bots taxing every swap, the gas you burned on transactions that reverted.

## What it reports

| | |
|---|---|
| **Exit liquidity** | Route-simulated sale of every position. Nominal vs. realizable, price impact, and the largest sale that stays under 5% impact. |
| **Realized & unrealized PnL** | Weighted-average cost basis, reconstructed from transaction history. |
| **MEV extraction** | Sandwich attacks against your swaps, with the attacker's transactions and estimated value taken. |
| **Approval risk** | Outstanding allowances on Ethereum, token-account delegates on Solana, scored by what could actually be taken right now. |
| **Fee archaeology** | Lifetime fees in native units, what they cost at the time, what that currency is worth today, and how much went to reverted transactions. |
| **Activity profile** | Wallet age, counterparties, protocols used, failure rate. |
| **Ranked regrets** | Every finding above, sorted by dollar cost. |

## Install

```bash
git clone https://github.com/YOUR_USERNAME/wallet-forensics
cd wallet-forensics
npm install
cp .env.example .env
```

Requires Node 20+.

### Configuration

Everything has a working public default except Ethereum transaction history.

| Variable | Needed for | Notes |
|---|---|---|
| `ETHERSCAN_API_KEY` | ETH transaction history, PnL, MEV | Free tier is plenty. Without it, only balances and approvals are reported. |
| `ETH_RPC_URL` | ETH balances, approvals, MEV | Public default works, but approval scanning needs an endpoint with unbounded `eth_getLogs` — use Alchemy or Infura. |
| `SOLANA_RPC_URL` | Everything Solana | The public endpoint is heavily rate limited. Helius or Triton strongly recommended. |
| `COINGECKO_API_KEY` | Faster pricing | Optional. Raises rate limits considerably. |

## Usage

```bash
# Ethereum
npm run dev -- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# Solana
npm run dev -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

# Both in one report
npm run dev -- 0xd8dA6BF... 7xKXtg2CW... --verbose

# Shareable HTML
npm run dev -- 0xd8dA6BF... --html report.html

# Machine-readable
npm run dev -- 0xd8dA6BF... --json > report.json
```

| Flag | Effect |
|---|---|
| `--chain <name>` | Force `ethereum` or `solana` instead of auto-detecting |
| `--html <path>` | Write a self-contained HTML report (no external requests, works offline) |
| `--json [path]` | JSON to a file, or stdout if no path given |
| `--since <date>` | Only analyze activity from this date onward |
| `--max <n>` | Cap transactions fetched per chain (default 3000) |
| `--no-mev` | Skip sandwich detection — much faster |
| `--no-liquidity` | Skip routing quotes |
| `-v` | Progress on stderr |

## How it works

### Cost basis without a historical price oracle

The hard part of on-chain PnL isn't the accounting — it's knowing what anything was worth the moment it moved. Fetching a historical price for every token on every day is thousands of API calls, and most long-tail tokens have no price history at all.

So the value is inferred from the transaction itself. A swap has two sides; if either side is a stablecoin or the chain's native asset, that side reveals the dollar value of the whole trade, and it's attributed to the other side. This covers the overwhelming majority of real trades and needs **one price lookup per day** instead of one per token per day.

Transfers with no anchor — an airdrop of an unknown token, a transfer between your own wallets — are counted and excluded rather than guessed at. The report tells you how many.

### Sandwich detection

The structural signature is narrow enough to detect reliably: the same address appears immediately before **and** after your transaction in the same block, and all three touch a common pool.

Extracted value is measured from the attacker's own token flow — they enter a position in the front-run and exit it in the back-run, so their net gain in WETH or a stablecoin across the pair is what they took. When that can't be measured, the detection is reported with the value left blank rather than estimated. Confidence is labeled `high` / `medium` / `low` on every event.

### Exit liquidity

Full-size sale quoted through Uniswap V3 (probing every fee tier) on Ethereum and Jupiter on Solana. When full exit exceeds 5% price impact, a binary search finds the largest sale that stays under it.

### Adding a chain

Implement one interface in [`src/adapters/types.ts`](src/adapters/types.ts) — history, balances, approvals, MEV, sell quotes. The analysis and reporting layers work on a normalized model and need no changes.

## Architecture

```
src/
├── adapters/          chain-specific data access
│   ├── types.ts       the interface a chain must implement
│   ├── evm.ts         viem + Etherscan V2 + Uniswap V3 Quoter
│   └── solana.ts      web3.js + Jupiter
├── analysis/          chain-agnostic, operates on normalized types
│   ├── pnl.ts         weighted-average cost basis
│   ├── mev.ts         sandwich detection
│   ├── liquidity.ts   route-quoted exit simulation
│   ├── fees.ts        lifetime fee archaeology
│   ├── activity.ts    wallet profile
│   └── regrets.ts     ranking by dollar cost
├── pricing/           CoinGecko with day-resolution caching
├── report/            terminal + self-contained HTML
└── forensics.ts       pipeline orchestration
```

Every stage degrades independently. If approval scanning fails because your RPC caps `eth_getLogs`, you still get PnL, fees, and liquidity — with a note explaining what's missing and why. Nothing is silently dropped.

## Tests

```bash
npm test
```

Covers cost-basis inference (stablecoin anchoring, native anchoring, unvalued transfers), fee accounting, regret ranking, and renderer output including HTML escaping.

## Limitations

Worth being straight about:

- **Cost basis is inferred, not authoritative.** Trades with no stablecoin or native leg are excluded from PnL. Don't file taxes with this.
- **Exit liquidity is a point-in-time quote.** It moves with the market and ignores CEX depth entirely.
- **MEV detection finds sandwiches**, not JIT liquidity, backrunning-only, or cross-domain extraction.
- **Solana MEV value is not attributed.** Detection is structural; profit attribution requires modelling pool state per DEX.
- **Ethereum only** on the EVM side right now. L2s need per-chain quoter addresses and an Etherscan V2 chain id — the adapter is otherwise ready.
- **Bridged and cross-wallet transfers** look like unexplained inflows. They'll show up as unvalued.

## License

MIT
