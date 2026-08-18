import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  ALL_CHAINS,
  ALL_EVM_CHAINS,
  EVM_CHAINS,
  chainLabel,
  coingeckoId,
  coingeckoPlatform,
  evmConfig,
  isEvmChain,
  nativeDecimals,
  nativeSymbol,
  stablesFor,
} from '../src/config.js';
import { detectChains, isEvmAddress } from '../src/forensics.js';

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('chain table', () => {
  test('every EVM chain is fully specified', () => {
    for (const key of ALL_EVM_CHAINS) {
      const cfg = EVM_CHAINS[key];
      assert.equal(cfg.chain, key, `${key}: chain field must match its key`);
      assert.ok(cfg.chainId > 0, `${key}: needs a chain id`);
      assert.ok(cfg.rpcUrl.startsWith('http'), `${key}: needs an RPC url`);
      assert.ok(cfg.label.length > 0, `${key}: needs a label`);
      assert.ok(cfg.nativeSymbol.length > 0, `${key}: needs a native symbol`);
      assert.ok(cfg.nativeDecimals > 0, `${key}: needs native decimals`);
      assert.ok(cfg.coingeckoId.length > 0, `${key}: needs a coingecko id`);
      assert.ok(cfg.coingeckoPlatform.length > 0, `${key}: needs a coingecko platform`);
      assert.match(cfg.wrappedNative, /^0x[0-9a-fA-F]{40}$/, `${key}: bad wrapped native`);
      assert.ok(cfg.blockscoutBase.startsWith('http'), `${key}: needs a blockscout base`);
      assert.ok(cfg.explorer.startsWith('http'), `${key}: needs an explorer`);
    }
  });

  test('chain ids are unique', () => {
    const ids = ALL_EVM_CHAINS.map((c) => EVM_CHAINS[c].chainId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate chain id in the table');
  });

  test('quoter addresses are well formed where present', () => {
    for (const key of ALL_EVM_CHAINS) {
      const q = EVM_CHAINS[key].quoter;
      if (q !== undefined) assert.match(q, /^0x[0-9a-fA-F]{40}$/, `${key}: bad quoter`);
    }
  });

  test('every chain has at least one stablecoin to anchor cost basis', () => {
    for (const chain of ALL_CHAINS) {
      assert.ok(
        Object.keys(stablesFor(chain)).length > 0,
        `${chain}: needs a stablecoin numeraire or PnL cannot be valued`,
      );
    }
  });

  test('stablecoin keys are lowercased so lookups match', () => {
    // Cost basis looks tokens up by lowercased address; a mixed-case key here
    // would silently fail to match and drop the trade from PnL.
    for (const key of ALL_EVM_CHAINS) {
      for (const addr of Object.keys(EVM_CHAINS[key].stables)) {
        assert.equal(addr, addr.toLowerCase(), `${key}: stablecoin key must be lowercase`);
      }
    }
  });
});

describe('chain lookups', () => {
  test('resolve for every chain including solana', () => {
    for (const chain of ALL_CHAINS) {
      assert.ok(chainLabel(chain).length > 0);
      assert.ok(nativeSymbol(chain).length > 0);
      assert.ok(nativeDecimals(chain) > 0);
      assert.ok(coingeckoId(chain).length > 0);
      assert.ok(coingeckoPlatform(chain).length > 0);
    }
  });

  test('isEvmChain separates solana from the rest', () => {
    assert.equal(isEvmChain('solana'), false);
    for (const c of ALL_EVM_CHAINS) assert.equal(isEvmChain(c), true);
  });

  test('evmConfig refuses solana rather than returning nonsense', () => {
    assert.throws(() => evmConfig('solana'), /not an EVM chain/);
  });

  test('chains carry the right native asset', () => {
    assert.equal(nativeSymbol('polygon'), 'POL');
    assert.equal(coingeckoId('polygon'), 'matic-network');
    // L2s settle in ETH, so they price against ethereum despite differing platforms.
    assert.equal(coingeckoId('base'), 'ethereum');
    assert.notEqual(coingeckoPlatform('base'), coingeckoPlatform('ethereum'));
  });
});

describe('address detection', () => {
  test('recognizes EVM and Solana address shapes', () => {
    assert.deepEqual(detectChains(VITALIK), ['ethereum']);
    assert.deepEqual(detectChains(SOL_ADDRESS), ['solana']);
    assert.deepEqual(detectChains('nonsense'), []);
  });

  test('an EVM address is valid on every EVM chain, so detection defaults', () => {
    // Detection cannot tell Base from Ethereum — that is a user choice, and
    // the default must be a single chain rather than a fan-out.
    assert.equal(detectChains(VITALIK).length, 1);
    assert.equal(isEvmAddress(VITALIK), true);
    assert.equal(isEvmAddress(SOL_ADDRESS), false);
  });
});
