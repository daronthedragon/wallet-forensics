import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { USAGE, parseArgs } from '../src/index.js';
import { ALL_CHAINS } from '../src/config.js';

const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/* ───────────────────────────────────── the help text is a promise ── */

describe('documented flags', () => {
  /** Every long flag the help text advertises, with its argument shape. */
  function documentedFlags(): string[] {
    const options = USAGE.slice(USAGE.indexOf('Options'), USAGE.indexOf('Chains'));
    return [...options.matchAll(/^\s{4}(--[a-z-]+)/gm)].map((m) => m[1]!);
  }

  test('the help text lists flags', () => {
    const flags = documentedFlags();
    assert.ok(flags.length >= 6, `only found ${flags.length}: ${flags.join(', ')}`);
  });

  test('every documented flag is accepted by the parser', () => {
    // This is the invariant that a shipped bug violated: --no-cache appeared in
    // the help text while the parser rejected it as unknown. Anything the help
    // advertises must parse, or the first thing a user tries fails.
    const needsValue: Record<string, string> = {
      '--chain': 'ethereum',
      '--html': 'out.html',
      '--since': '2024-01-01',
      '--max': '10',
    };

    for (const flag of documentedFlags()) {
      const argv = [EVM, flag];
      if (needsValue[flag]) argv.push(needsValue[flag]);
      assert.doesNotThrow(
        () => parseArgs(argv),
        `${flag} is documented in --help but the parser rejects it`,
      );
    }
  });

  test('the chains the help lists are the chains the parser accepts', () => {
    const listed = USAGE.slice(USAGE.indexOf('Chains'), USAGE.indexOf('Examples'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(','))[0]!
      .split(',')
      .map((c) => c.trim());

    assert.deepEqual([...listed].sort(), [...ALL_CHAINS].sort());
  });
});

/* ───────────────────────────────────────────────── chain selection ── */

describe('--chain', () => {
  test('takes a comma-separated list', () => {
    assert.deepEqual(parseArgs([EVM, '--chain', 'base,arbitrum']).chains, ['base', 'arbitrum']);
  });

  test('is case-insensitive and tolerates spacing', () => {
    assert.deepEqual(parseArgs([EVM, '--chain', ' BASE , Arbitrum ']).chains, [
      'base',
      'arbitrum',
    ]);
  });

  test('deduplicates', () => {
    assert.deepEqual(parseArgs([EVM, '--chain', 'base,base,base']).chains, ['base']);
  });

  test('rejects an unknown chain by name, and says which are valid', () => {
    assert.throws(
      () => parseArgs([EVM, '--chain', 'avalanche']),
      /unknown chain "avalanche".*ethereum/s,
    );
  });

  test('requires a value', () => {
    assert.throws(() => parseArgs([EVM, '--chain']), /--chain requires/);
  });

  test('--all-evm selects every EVM chain and no others', () => {
    const { chains } = parseArgs([EVM, '--all-evm']);
    assert.ok(chains.length > 1);
    assert.equal(chains.includes('solana'), false, 'solana is not an EVM chain');
    assert.equal(chains.includes('ethereum'), true);
  });

  test('--all-evm merges with an explicit --chain without duplicating', () => {
    const { chains } = parseArgs([EVM, '--chain', 'base', '--all-evm']);
    assert.equal(new Set(chains).size, chains.length, 'no duplicates');
  });
});

/* ─────────────────────────────────────────────────────── arguments ── */

describe('argument handling', () => {
  test('collects multiple addresses', () => {
    assert.deepEqual(parseArgs([EVM, SOL]).addresses, [EVM, SOL]);
  });

  test('requires at least one address', () => {
    assert.throws(() => parseArgs(['--no-mev']), /No address provided/);
  });

  test('rejects an unknown option rather than treating it as an address', () => {
    // Silently swallowing --typo as an address would produce a confusing
    // "not a recognizable address" error instead of naming the real mistake.
    assert.throws(() => parseArgs([EVM, '--typo']), /Unknown option: --typo/);
  });

  test('--json takes an optional path', () => {
    assert.equal(parseArgs([EVM, '--json']).json, true, 'bare --json means stdout');
    assert.equal(parseArgs([EVM, '--json', 'out.json']).json, 'out.json');
  });

  test('--json does not swallow a following flag as its path', () => {
    const args = parseArgs([EVM, '--json', '--no-mev']);
    assert.equal(args.json, true);
    assert.equal(args.options.skipMev, true, '--no-mev must still be parsed');
  });

  test('--max requires a positive number', () => {
    assert.equal(parseArgs([EVM, '--max', '50']).options.maxTransactions, 50);
    assert.throws(() => parseArgs([EVM, '--max', '0']), /positive number/);
    assert.throws(() => parseArgs([EVM, '--max', '-5']), /positive number/);
    assert.throws(() => parseArgs([EVM, '--max', 'many']), /positive number/);
  });

  test('--max truncates a fractional count rather than passing it on', () => {
    assert.equal(parseArgs([EVM, '--max', '10.9']).options.maxTransactions, 10);
  });

  test('--since requires a parseable date', () => {
    assert.equal(
      parseArgs([EVM, '--since', '2024-03-01']).options.since?.toISOString().slice(0, 10),
      '2024-03-01',
    );
    assert.throws(() => parseArgs([EVM, '--since', 'last tuesday']), /not a valid date/);
    assert.throws(() => parseArgs([EVM, '--since']), /--since requires/);
  });

  test('--html requires a path', () => {
    assert.equal(parseArgs([EVM, '--html', 'r.html']).html, 'r.html');
    assert.throws(() => parseArgs([EVM, '--html']), /--html requires/);
  });

  test('boolean flags set exactly their own option', () => {
    const args = parseArgs([EVM, '--no-mev', '--no-liquidity', '--no-cache', '-v']);
    assert.equal(args.options.skipMev, true);
    assert.equal(args.options.skipLiquidity, true);
    assert.equal(args.options.noCache, true);
    assert.equal(args.options.verbose, true);
  });

  test('defaults leave every optional behaviour off', () => {
    const { options, chains, json, html } = parseArgs([EVM]);
    assert.equal(options.skipMev, false);
    assert.equal(options.skipLiquidity, false);
    assert.equal(options.verbose, false);
    assert.equal(options.since, undefined);
    assert.deepEqual(chains, [], 'empty means infer from the address');
    assert.equal(json, undefined);
    assert.equal(html, undefined);
  });

  test('parsing one invocation does not leak into the next', () => {
    // options is spread from a shared DEFAULT_OPTIONS; mutating it in place
    // would make every later run inherit the previous run's flags.
    parseArgs([EVM, '--no-mev', '--max', '7']);
    const second = parseArgs([EVM]);
    assert.equal(second.options.skipMev, false);
    assert.notEqual(second.options.maxTransactions, 7);
  });

  test('an address that looks like a flag value is still an address', () => {
    const args = parseArgs(['--max', '10', EVM]);
    assert.deepEqual(args.addresses, [EVM]);
    assert.equal(args.options.maxTransactions, 10);
  });
});
