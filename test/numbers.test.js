import test from 'node:test';
import assert from 'node:assert/strict';

import { toNumber, toNumberOr } from '../lib/numbers.js';

test('toNumber 接受数字与数字字符串', () => {
  assert.equal(toNumber(61), 61);
  assert.equal(toNumber(1.5), 1.5);
  assert.equal(toNumber('61.1'), 61.1);
  assert.equal(toNumber('  42  '), 42);
  assert.equal(toNumber('-3'), -3);
  assert.equal(toNumber('0'), 0);
});

test('toNumber 对非数字给出 null', () => {
  assert.equal(toNumber('x'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('   '), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(Number.NaN), null);
  assert.equal(toNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(toNumber({}), null);
  assert.equal(toNumber([]), null);
  assert.equal(toNumber(true), null);
});

test('toNumberOr 给出回退值', () => {
  assert.equal(toNumberOr('12', 0), 12);
  assert.equal(toNumberOr('nope', 0), 0);
  assert.equal(toNumberOr(undefined, -1), -1);
});
