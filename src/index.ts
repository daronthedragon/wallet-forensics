#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyze, DEFAULT_OPTIONS, detectChains } from './forensics.js';
import { renderHtml } from './report/html.js';
import { renderTerminal } from './report/terminal.js';
import type { AnalysisOptions, Chain, ForensicsReport } from './types.js';

loadEnv();

const USAGE = `
  wallet-forensics — deep forensic report for an Ethereum or Solana address

  Usage
    forensics <address> [address...] [options]

  Options
    --chain <name>     Force a chain (ethereum | solana). Default: auto-detect
    --json [path]      Emit JSON. Writes to path, or stdout if omitted
    --html <path>      Write a self-contained HTML report
    --since <date>     Only analyze activity on or after this date (YYYY-MM-DD)
    --max <n>          Cap transactions fetched per chain (default 3000)
    --no-mev           Skip sandwich detection (much faster)
    --no-liquidity     Skip exit-liquidity routing quotes
    -v, --verbose      Progress output on stderr
    -h, --help         Show this message

  Examples
    forensics 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
    forensics 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU --html report.html
    forensics 0xd8dA... --json report.json --no-mev
    forensics 0xd8dA... 7xKXtg... -v      # both chains in one report

  Configuration
    Copy .env.example to .env. An Etherscan API key is required for Ethereum
    transaction history; everything else has a working public default.
`;

interface Args {
  addresses: string[];
  chain?: Chain;
  json?: string | true;
  html?: string;
  options: AnalysisOptions;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    fail((err as Error).message);
  }

  // Resolve each address to the chain(s) it could belong to.
  const targets: Array<{ chain: Chain; address: string }> = [];
  for (const address of args.addresses) {
    if (args.chain) {
      targets.push({ chain: args.chain, address });
      continue;
    }

    const detected = detectChains(address);
    if (detected.length === 0) {
      fail(`"${address}" is not a recognizable Ethereum or Solana address.`);
    }
    if (detected.length > 1) {
      fail(
        `"${address}" is ambiguous — it parses as both ${detected.join(' and ')}. ` +
          `Pass --chain to disambiguate.`,
      );
    }
    targets.push({ chain: detected[0]!, address });
  }

  if (args.options.verbose) {
    process.stderr.write(
      `analyzing ${targets.length} address${targets.length === 1 ? '' : 'es'}…\n`,
    );
  }

  let report: ForensicsReport;
  try {
    report = await analyze(targets, args.options);
  } catch (err) {
    fail(`Analysis failed: ${(err as Error).message}`);
  }

  // --- Output ---------------------------------------------------------------
  let wroteFile = false;

  if (args.html) {
    const path = resolve(args.html);
    writeFileSync(path, renderHtml(report), 'utf8');
    process.stderr.write(`HTML report written to ${path}\n`);
    wroteFile = true;
  }

  if (args.json !== undefined) {
    const json = JSON.stringify(report, bigintReplacer, 2);
    if (args.json === true) {
      process.stdout.write(`${json}\n`);
      return; // JSON to stdout means no terminal report
    }
    const path = resolve(args.json);
    writeFileSync(path, json, 'utf8');
    process.stderr.write(`JSON report written to ${path}\n`);
    wroteFile = true;
  }

  process.stdout.write(`${renderTerminal(report)}\n`);

  if (wroteFile) process.stdout.write('');
}

function parseArgs(argv: string[]): Args {
  const addresses: string[] = [];
  const options: AnalysisOptions = { ...DEFAULT_OPTIONS };
  let chain: Chain | undefined;
  let json: string | true | undefined;
  let html: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    switch (arg) {
      case '--chain': {
        const value = argv[++i];
        if (value !== 'ethereum' && value !== 'solana') {
          throw new Error(`--chain must be "ethereum" or "solana", got "${value ?? ''}"`);
        }
        chain = value;
        break;
      }
      case '--json': {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          json = next;
          i++;
        } else {
          json = true;
        }
        break;
      }
      case '--html': {
        const value = argv[++i];
        if (!value) throw new Error('--html requires a file path');
        html = value;
        break;
      }
      case '--since': {
        const value = argv[++i];
        if (!value) throw new Error('--since requires a date (YYYY-MM-DD)');
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error(`--since: "${value}" is not a valid date`);
        options.since = date;
        break;
      }
      case '--max': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) throw new Error('--max requires a positive number');
        options.maxTransactions = Math.floor(value);
        break;
      }
      case '--no-mev':
        options.skipMev = true;
        break;
      case '--no-liquidity':
        options.skipLiquidity = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        addresses.push(arg);
    }
  }

  if (addresses.length === 0) throw new Error('No address provided.');
  return { addresses, chain, json, html, options };
}

/** BigInt is not JSON-serializable; emit as a decimal string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Minimal .env loader.
 *
 * Node's --env-file flag would do this, but requiring a flag makes the binary
 * awkward to invoke. Twelve lines is cheaper than a dependency.
 */
function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function fail(message: string): never {
  process.stderr.write(`\nerror: ${message}\n\nRun with --help for usage.\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`\nunexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
