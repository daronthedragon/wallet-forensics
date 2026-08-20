#!/usr/bin/env node
/**
 * MCP server — the cross-agent entry point.
 *
 * The CLI already works for anything that can run a command, but most agents
 * discover tools over MCP rather than by reading a README. This exposes the
 * same analyzer to Cursor, Windsurf, Zed, Continue, VS Code and anything else
 * with an MCP client.
 *
 * Implemented directly against the wire format rather than with the official
 * SDK. MCP over stdio is newline-delimited JSON-RPC 2.0, which is a modest
 * amount of code, and it keeps this repo's dependency list to the two clients
 * that actually do chain work.
 *
 * The one rule of a stdio MCP server: stdout carries protocol messages and
 * nothing else. The analyzer therefore runs as a child process with its stdout
 * captured rather than inherited, so a progress line can never corrupt the
 * stream.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_CHAINS } from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built CLI, one directory up from dist/mcp/. */
const CLI = join(HERE, '..', 'index.js');

/** Versions this server understands. The client's choice is echoed when known. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2024-11-05';

interface ToolArgs {
  address?: unknown;
  chains?: unknown;
  maxTransactions?: unknown;
  skipMev?: unknown;
  skipLiquidity?: unknown;
}

const TOOLS = [
  {
    name: 'analyze_wallet',
    description:
      'Forensic analysis of an Ethereum, Base, Arbitrum, Optimism, Polygon or Solana wallet. ' +
      'Returns realized and unrealized PnL, lifetime fees, MEV sandwich attacks committed against ' +
      'the wallet, risky token approvals, and exit liquidity — what positions would actually sell ' +
      'for versus what a portfolio tracker claims. Use when asked to analyze, audit or investigate ' +
      'an address, what a wallet holds or is worth, how much was lost to gas or MEV, whether ' +
      'approvals are safe, or whether a position can actually be sold. Read the "warnings" array ' +
      'before presenting any figure as complete: a degraded scan finding nothing is not a clean ' +
      'bill of health.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'A 0x EVM address or a base58 Solana address.',
        },
        chains: {
          type: 'array',
          items: { type: 'string', enum: ALL_CHAINS },
          description:
            'Chains to analyze. Defaults to ethereum for 0x addresses and solana for base58 ones. ' +
            'One EVM address is valid on every EVM chain, so this is a choice, not a detection.',
        },
        maxTransactions: {
          type: 'integer',
          minimum: 1,
          description:
            'Cap on transactions fetched. Truncation makes wallet age and lifetime fee totals ' +
            'floors rather than true values, and the report says so.',
        },
        skipMev: {
          type: 'boolean',
          description: 'Skip sandwich detection. Much faster; it reads full blocks.',
        },
        skipLiquidity: {
          type: 'boolean',
          description: 'Skip exit-liquidity routing quotes.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
];

/* ─────────────────────────────────────────────────────────── JSON-RPC ── */

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/* ────────────────────────────────────────────────────────── the tool ── */

function buildArgs(args: ToolArgs): string[] {
  const out = [String(args.address), '--json'];
  if (Array.isArray(args.chains) && args.chains.length > 0) {
    out.push('--chain', args.chains.join(','));
  }
  if (Number.isInteger(args.maxTransactions)) {
    out.push('--max', String(args.maxTransactions));
  }
  if (args.skipMev === true) out.push('--no-mev');
  if (args.skipLiquidity === true) out.push('--no-liquidity');
  return out;
}

type RunResult = { ok: true; report: unknown } | { ok: false; err: string };

function runAnalyzer(args: ToolArgs): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...buildArgs(args)], {
      // stdout captured, never inherited: a stray line would corrupt the
      // protocol stream. stderr carries progress and is kept for context.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    child.on('error', (e: Error) => resolve({ ok: false, err: e.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, err: err.trim() || `analyzer exited with code ${code}` });
        return;
      }
      try {
        resolve({ ok: true, report: JSON.parse(out) });
      } catch {
        resolve({ ok: false, err: `analyzer produced unparseable output: ${out.slice(0, 300)}` });
      }
    });
  });
}

async function callTool(name: unknown, args: ToolArgs | undefined): Promise<unknown> {
  if (name !== 'analyze_wallet') {
    return { isError: true, content: [{ type: 'text', text: `unknown tool: ${String(name)}` }] };
  }
  if (!args || typeof args.address !== 'string' || args.address.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: 'address is required' }] };
  }

  const res = await runAnalyzer(args);
  if (!res.ok) {
    return { isError: true, content: [{ type: 'text', text: res.err }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(res.report, null, 2) }] };
}

/* ──────────────────────────────────────────────────────── dispatch ── */

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: string; name?: unknown; arguments?: ToolArgs };
}

async function handle(msg: RpcMessage): Promise<void> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion:
          asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'wallet-forensics', version: '1.0.0' },
      });
      return;
    }

    // Notifications carry no id and must never be answered.
    case 'notifications/initialized':
    case 'initialized':
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call':
      reply(id, await callTool(params?.name, params?.arguments));
      return;

    case 'ping':
      reply(id, {});
      return;

    default:
      if (id !== undefined) fail(id, -32601, `method not found: ${String(method)}`);
  }
}

/* ───────────────────────────────────────────────────────── transport ── */

let buffer = '';

/**
 * Requests still being served.
 *
 * A tool call spawns the analyzer and answers when it finishes. Exiting the
 * moment stdin closes would drop that answer — harmless with a live client
 * that holds the pipe open, wrong when driven by a script or a one-shot run.
 */
let inFlight = 0;
let stdinClosed = false;

function exitWhenIdle(): void {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;

  // Messages are newline-delimited. Anything after the last newline is a
  // partial message and stays buffered.
  let nl: number;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      fail(null, -32700, 'parse error');
      continue;
    }

    inFlight++;
    handle(msg)
      .catch((e: unknown) => {
        if (msg.id !== undefined) {
          fail(msg.id, -32603, e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        inFlight--;
        exitWhenIdle();
      });
  }
});

process.stdin.on('end', () => {
  stdinClosed = true;
  exitWhenIdle();
});
