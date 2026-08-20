# Wallet forensics — agent instructions

Vendor-neutral instructions for any coding agent.

| Integration | Best for |
| --- | --- |
| **MCP server** (`dist/mcp/server.js`) | Cursor, Windsurf, Zed, Continue, VS Code, or any MCP client |
| **CLI** (`dist/index.js`) | Any agent that can run a shell command |

Both run the same analyzer. Requires `npm install && npm run build` once.

If you want a version with **no build and no dependencies**, use the sibling
[wallet-forensics-skill](https://github.com/daronthedragon/wallet-forensics-skill),
which shares this repo's analysis core verbatim.

## What it does

Analyzes an Ethereum, Base, Arbitrum, Optimism, Polygon or Solana address and
reports realized and unrealized PnL, lifetime fees, MEV sandwich attacks
committed against the wallet, risky token approvals, and **exit liquidity** —
what a position would actually sell for versus what a portfolio tracker claims.

That last one is usually the most valuable thing in the report. Every tracker
computes `balance × spot price`; for anything outside the top few hundred
tokens that is fiction, because spot price comes from the last trade, which may
have been $40 against a pool holding $3,000. This route-quotes the real sale.

## When to invoke it

- "Analyze this wallet: 0x…" / "What's in this address?"
- "How much have I spent on gas?"
- "Have I been sandwiched?" / "How much have I lost to MEV?"
- "Are any of my approvals dangerous?" / "What should I revoke?"
- "Can I actually sell this token?" / "Is this position liquid?"
- A bare address pasted with any question about it

## Running it

```bash
node dist/index.js <address> [options]
```

| Option | Effect |
| --- | --- |
| `--chain <list>` | `ethereum,base,arbitrum,optimism,polygon,solana` |
| `--all-evm` | Every supported EVM chain |
| `--json [path]` | JSON to a file, or stdout if no path |
| `--html <path>` | Self-contained HTML report |
| `--max <n>` | Cap transactions fetched |
| `--since <date>` | Only activity from this date |
| `--no-mev` | Skip sandwich detection (much faster; it reads full blocks) |
| `--no-liquidity` | Skip exit-liquidity routing quotes |

Without `--json` the CLI prints a human-readable terminal report. For
programmatic use pass `--json`. Read the result and explain it in prose — do
not paste raw JSON at the user.

### Environment

Everything has a working default and no key is required.

- `ETHERSCAN_API_KEY` — optional. Without it, EVM history comes from
  Blockscout. With it, Etherscan is more complete; one key covers every EVM chain.
- `SOLANA_RPC_URL` — the public endpoint is heavily rate limited.
- `COINGECKO_API_KEY` — optional, raises pricing rate limits.
- `WALLET_FORENSICS_CACHE_DIR` / `WALLET_FORENSICS_NO_CACHE` — control the
  on-disk cache of historical prices.

## Reading the output

```
{
  "chains": [{ "chain", "activity", "fees", "positions", "approvals",
               "mev", "liquidity", "regrets", "warnings" }],
  "totals": { "realizedPnlUsd", "unrealizedPnlUsd", "feesUsd",
              "mevExtractedUsd", "portfolioNominalUsd", "portfolioRealizableUsd" },
  "topRegrets": [{ "kind", "title", "detail", "costUsd" }]
}
```

**Read `warnings` first.** They say which numbers are trustworthy. A run can
succeed partially — history truncated by `--max`, token balances lost to a rate
limit, an approval scan degraded by an RPC that refuses unbounded log queries.
Each makes some headline figure a floor rather than a total.

**Lead with `topRegrets`.** Already ranked by dollar cost across every category.

**The headline number** is `portfolioNominalUsd` versus
`portfolioRealizableUsd`. If they diverge by more than a few percent, that gap
is the story.

**Exit-liquidity entries carry `quoted`.** When it is false, the figures are
unknown rather than zero — a refused quote is not evidence a position is
worthless. Only a genuine absence of route is a loss.

**Approvals** are ranked by what could be taken *right now* — the smaller of
the allowance and the current balance.

**MEV events** carry a `confidence` of `high` / `medium` / `low`. Report it.

## Interpreting responsibly

- **Cost basis is inferred, not authoritative.** Trades with no stablecoin or
  native leg are counted in `warnings` and excluded. Never present as tax-ready.
- **Exit liquidity is a point-in-time quote** that ignores centralised exchange
  depth entirely.
- **Absence of evidence is not evidence of absence.** Do not report clean
  approvals when the scan was partial.
- **No financial advice.** State facts; do not recommend buying or selling.
- **Revoking is the user's action.** Never construct or send a transaction.

## Privacy

An address is pseudonymous but not anonymous. Analyze the address you were
given. Do not go looking for other addresses belonging to the same person, and
do not cross-reference an address against identity sources.
