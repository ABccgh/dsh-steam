import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

import {
  createHttpClient,
  ensureSystemCaTrusted,
  explainHttpStatus,
  fetchJson,
  findErrorCode,
  isCertificateError,
  systemCaStatus,
} from '../lib/http.js';

/**
 * 拿一个「刚刚还开着、现在一定没人监听」的端口，用来稳定地制造 ECONNREFUSED。
 * 写死端口是不行的：9 之类的端口在 WHATWG 里属于禁用端口，fetch 会在连接前就拒绝。
 * @returns {Promise<number>} 已释放的端口号。
 */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('findErrorCode 会沿 cause 链找到真正的错误码', () => {
  const inner = Object.assign(new Error('boom'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  const outer = new TypeError('fetch failed', { cause: new Error('middle', { cause: inner }) });
  assert.equal(findErrorCode(outer), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.equal(findErrorCode(new Error('plain')), '');
  assert.equal(findErrorCode(undefined), '');
});

test('isCertificateError 同时认错误码与消息文本', () => {
  assert.equal(isCertificateError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })), true);
  assert.equal(isCertificateError(new Error('unable to verify the first certificate')), true);
  assert.equal(isCertificateError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
});

test('ensureSystemCaTrusted 合并系统根证书，并且可重复调用', () => {
  const before = tls.getCACertificates('default').length;
  const first = ensureSystemCaTrusted();
  const after = tls.getCACertificates('default').length;
  const second = ensureSystemCaTrusted();

  assert.equal(first.error, undefined, `不该失败：${first.error ?? ''}`);
  assert.equal(first.merged, true);
  assert.ok(after >= before, '默认 CA 数量只应增加');
  assert.equal(first.total, after, 'total 必须是实际生效的数量，而不是拼接数组的长度');
  assert.deepEqual(second, first, '第二次调用必须返回同一份状态');
  assert.deepEqual(systemCaStatus(), first);
});

test('fetchJson 对不可达端口返回 ECONNREFUSED 与可执行建议', async () => {
  const port = await closedPort();
  const result = await fetchJson(`http://127.0.0.1:${port}/never-listening`, { timeoutMs: 3000, retries: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
  assert.match(result.hint ?? '', /加速/);
});

test('fetchJson 在 trustSystemCa=never 时也照常归一化失败', async () => {
  const port = await closedPort();
  const result = await fetchJson(`http://127.0.0.1:${port}/never-listening`, {
    timeoutMs: 3000,
    retries: 0,
    trustSystemCa: 'never',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
});

test('explainHttpStatus 给出可执行建议', () => {
  assert.match(explainHttpStatus(401), /Key/);
  assert.match(explainHttpStatus(429), /限流/);
  assert.equal(explainHttpStatus(200), '');
});

test('createHttpClient 把信任策略传给每一次请求', async () => {
  const port = await closedPort();
  const client = createHttpClient({ timeoutMs: 3000, trustSystemCa: 'never' });
  assert.equal(client.trustSystemCa, 'never');
  const result = await client.json(`http://127.0.0.1:${port}/never-listening`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
});
