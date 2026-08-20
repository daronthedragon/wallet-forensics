import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { AdapterWarning } from '../src/adapters/types.js';
import {
  labelFor,
  parseExplorerResult,
  parseTokenList,
  scoreApproval,
  type EtherscanTx,
} from '../src/adapters/evm.js';

const UNISWAP_ROUTER = '0xe592427a0aece92de3edee1f18e0157c05861564'; // in KNOWN_SPENDERS
const UNKNOWN = '0x1111111111111111111111111111111111111111';

/* ─────────────────────────────────────────────────────── approval risk ── */

describe('approval risk scoring', () => {
  // What is scored is not the allowance in isolation but what could be taken
  // right now — the smaller of the allowance and the balance held.

  test('unlimited allowance to an unknown spender with real value is critical', () => {
    const { risk, reasons } = scoreApproval({
      unlimited: true,
      atRiskUsd: 25_000,
      spender: UNKNOWN,
    });
    assert.equal(risk, 'critical');
    assert.ok(reasons.some((r) => /Unlimited/.test(r)));
    assert.ok(reasons.some((r) => /not a recognized protocol/.test(r)));
    assert.ok(reasons.some((r) => /25,000/.test(r)), 'the exposed figure is stated');
  });

  test('a large bounded allowance to an unknown spender is also critical', () => {
    // A bounded approval for $500k is exactly as dangerous as an unlimited one
    // when the spender can take $500k today. Only the ceiling differs, and the
    // ceiling is above everything the wallet holds.
    const { risk } = scoreApproval({ unlimited: false, atRiskUsd: 500_000, spender: UNKNOWN });
    assert.equal(risk, 'critical');
  });

  test('unlimited to a known protocol is high, not critical', () => {
    const { risk } = scoreApproval({
      unlimited: true,
      atRiskUsd: 25_000,
      spender: UNISWAP_ROUTER,
    });
    assert.equal(risk, 'high');
  });

  test('an unknown spender with modest value is high', () => {
    const { risk } = scoreApproval({ unlimited: false, atRiskUsd: 500, spender: UNKNOWN });
    assert.equal(risk, 'high');
  });

  test('unlimited on an empty position is medium, not critical', () => {
    // Nothing can be taken today, but the approval stays dangerous the moment
    // the wallet is refilled — so it is reported, just not as urgent.
    const { risk, reasons } = scoreApproval({
      unlimited: true,
      atRiskUsd: 0,
      spender: UNISWAP_ROUTER,
    });
    assert.equal(risk, 'medium');
    assert.ok(reasons.some((r) => /Unlimited/.test(r)));
  });

  test('a bounded allowance to a known protocol is low and says why', () => {
    const { risk, reasons } = scoreApproval({
      unlimited: false,
      atRiskUsd: 50,
      spender: UNISWAP_ROUTER,
    });
    assert.equal(risk, 'low');
    assert.deepEqual(reasons, ['Bounded allowance to a known protocol']);
  });

  test('an unpriceable token is scored as zero exposure, never as unknown risk', () => {
    // atRiskUsd is absent when the token has no price. That must not silently
    // promote the finding, and must not crash the ladder.
    const { risk } = scoreApproval({ unlimited: false, spender: UNISWAP_ROUTER });
    assert.equal(risk, 'low');
  });

  test('spender matching is case-insensitive', () => {
    const lower = scoreApproval({ unlimited: true, atRiskUsd: 5_000, spender: UNISWAP_ROUTER });
    const upper = scoreApproval({
      unlimited: true,
      atRiskUsd: 5_000,
      spender: UNISWAP_ROUTER.toUpperCase().replace('0X', '0x'),
    });
    assert.equal(lower.risk, upper.risk, 'a checksummed address is the same spender');
  });

  test('every outcome carries at least one reason', () => {
    for (const unlimited of [true, false]) {
      for (const atRiskUsd of [0, 50, 500, 5_000, 500_000]) {
        for (const spender of [UNKNOWN, UNISWAP_ROUTER]) {
          const { reasons } = scoreApproval({ unlimited, atRiskUsd, spender });
          assert.ok(reasons.length > 0, `no reason for ${unlimited}/${atRiskUsd}/${spender}`);
        }
      }
    }
  });
});

/* ──────────────────────────────────────────────────────────── labels ── */

describe('transaction labels', () => {
  const tx = (functionName?: string) => ({ functionName }) as EtherscanTx;

  test('names the protocol and the call when both are known', () => {
    assert.equal(
      labelFor(tx('swapExactTokensForTokens(uint256,uint256)'), UNISWAP_ROUTER),
      'Uniswap V3 Router: swapExactTokensForTokens',
    );
  });

  test('falls back to the protocol alone', () => {
    assert.equal(labelFor(tx(undefined), UNISWAP_ROUTER), 'Uniswap V3 Router');
  });

  test('falls back to the function alone', () => {
    assert.equal(labelFor(tx('transfer(address,uint256)'), UNKNOWN), 'transfer');
  });

  test('returns undefined rather than an empty label', () => {
    assert.equal(labelFor(tx(undefined), UNKNOWN), undefined);
    assert.equal(labelFor(tx(''), ''), undefined);
  });
});

/* ────────────────────────────────────────── explorer response parsing ── */

describe('explorer responses', () => {
  test('returns rows on success', () => {
    const rows = parseExplorerResult(
      { status: '1', result: [{ hash: '0xabc' }] },
      'etherscan',
      'txlist',
    );
    assert.equal(rows.length, 1);
  });

  test('an empty result array is no history, not an error', () => {
    assert.deepEqual(parseExplorerResult({ status: '0', result: [] }, 'etherscan', 'txlist'), []);
  });

  test('"no transactions found" is no history, not an error', () => {
    // A brand-new wallet must not read as a broken request.
    assert.deepEqual(
      parseExplorerResult(
        { status: '0', message: 'No transactions found', result: [] },
        'etherscan',
        'txlist',
      ),
      [],
    );
    assert.deepEqual(
      parseExplorerResult(
        { status: '0', message: 'OK', result: 'No transactions found' },
        'blockscout',
        'txlist',
      ),
      [],
    );
  });

  test('a real failure throws, so it can never read as an empty wallet', () => {
    assert.throws(
      () =>
        parseExplorerResult(
          { status: '0', message: 'NOTOK', result: 'Invalid API Key' },
          'etherscan',
          'txlist',
        ),
      (e: unknown) => e instanceof AdapterWarning && /Invalid API Key/.test((e as Error).message),
    );
  });

  test('a success status with a non-array result yields nothing rather than crashing', () => {
    assert.deepEqual(
      parseExplorerResult({ status: '1', result: 'unexpected' }, 'etherscan', 'txlist'),
      [],
    );
  });
});

/* ─────────────────────────────────────────────────────── token lists ── */

describe('token list parsing', () => {
  const row = (o: Record<string, string>) => ({ type: 'ERC-20', ...o });

  test('carries the balance through so it never needs an eth_call', () => {
    const out = parseTokenList([
      row({
        contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: '6',
        balance: '1500000',
      }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.balance, 1_500_000n);
    assert.equal(out[0]!.decimals, 6);
    assert.equal(out[0]!.address, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'lowercased');
  });

  test('skips zero balances and non-ERC-20 rows', () => {
    const out = parseTokenList([
      row({ contractAddress: '0x' + '1'.repeat(40), balance: '0' }),
      { type: 'ERC-721', contractAddress: '0x' + '2'.repeat(40), balance: '1' },
    ]);
    assert.deepEqual(out, []);
  });

  test('drops rows without a usable contract address', () => {
    const out = parseTokenList([
      row({ balance: '5' }),
      row({ contractAddress: 'not-an-address', balance: '5' }),
    ]);
    assert.deepEqual(out, []);
  });

  test('a malformed balance is skipped rather than thrown', () => {
    // BigInt('abc') throws. One bad row must not lose the whole wallet.
    const out = parseTokenList([
      row({ contractAddress: '0x' + '3'.repeat(40), balance: 'abc' }),
      row({ contractAddress: '0x' + '4'.repeat(40), balance: '10', decimals: '18' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.balance, 10n);
  });

  test('missing decimals default to 18', () => {
    const out = parseTokenList([row({ contractAddress: '0x' + '5'.repeat(40), balance: '1' })]);
    assert.equal(out[0]!.decimals, 18);
  });

  test('a non-array payload yields nothing', () => {
    assert.deepEqual(parseTokenList(undefined), []);
    assert.deepEqual(parseTokenList('nope'), []);
  });
});
