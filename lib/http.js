/**
 * 出网 HTTP 的最小封装：超时、重试、JSON 解析、错误归一化，以及**本机加速器的证书处理**。
 *
 * 为什么需要处理证书：这台机器的 hosts 把 `store.steampowered.com` / `api.steampowered.com`
 * 等域名指向 `127.0.0.1`（Steam++ / Watt Toolkit 一类加速器的加速模式），由本进程之外的
 * 加速器用一张自签名根证书接管 TLS。Windows 信任它，Node 自带的 CA 包不信任，于是
 * `fetch` 直接抛 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。
 *
 * 处理方式是 Node 24 提供的运行时 API：`tls.getCACertificates('system')` 能拿到系统存储里
 * 的根证书，`tls.setDefaultCACertificates()` 能把它并进默认列表。合并只做一次，且只在
 * 第一次遇到证书错误时发生（`trustSystemCa: 'auto'`），所以不需要它的机器不会被改动。
 *
 * 不自己管代理：DSH 的 `dsh-http-proxy` 已经把 undici 的全局 dispatcher 装好，
 * 这里的 `fetch` 会自动走同一套代理策略。
 *
 * @module dsh-steam/http
 */

import tls from 'node:tls';

import { VERSION } from './version.js';

const USER_AGENT = `dsh-steam/${VERSION}`;

/** 表示「证书链验证不过」的错误码。 */
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

/** 合并系统 CA 的结果；进程内只做一次。 */
let systemCaState = { merged: false, added: 0, total: 0, error: undefined };

/**
 * 把 URL 里的 API Key 脱敏。错误对象与结果对象都会流向日志/模型，不能带完整 Key。
 * @param {string} url - 原始 URL。
 * @returns {string} 脱敏后的 URL；解析失败时原样返回。
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    for (const name of ['key', 'api_key', 'apikey']) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, '***');
    }
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * 沿 `cause` 链找到第一个带 `code` 的错误码。undici 会把真实原因藏在 `error.cause.cause`。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 错误码，找不到时为空字符串。
 */
export function findErrorCode(cause) {
  let current = cause;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') return current.code;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return '';
}

/**
 * 沿 `cause` 链找最内层的可读消息。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 消息文本。
 */
function deepestMessage(cause) {
  let current = cause;
  let message = '';
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error && current.message) message = current.message;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return message;
}

/**
 * 判断异常是不是证书验证失败。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {boolean} 是否属于证书问题。
 */
export function isCertificateError(cause) {
  return CERTIFICATE_CODES.has(findErrorCode(cause)) || /certificate|self.signed/i.test(deepestMessage(cause));
}

/**
 * 把系统根证书并入 Node 默认的 CA 列表。幂等，进程内只生效一次。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 合并结果。
 */
export function ensureSystemCaTrusted() {
  if (systemCaState.merged || systemCaState.error !== undefined) return systemCaState;
  try {
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const before = current.length;
    tls.setDefaultCACertificates([...new Set([...current, ...system])]);
    // 读回来的数量才是生效值：setDefaultCACertificates 会丢弃它不接受的条目，
    // 也可能按内容去重，所以不能用拼出来的数组长度当结果。
    const observed = tls.getCACertificates('default').length;
    systemCaState = { merged: true, added: Math.max(0, observed - before), total: observed };
  } catch (cause) {
    systemCaState = {
      merged: false,
      added: 0,
      total: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return systemCaState;
}

/**
 * 当前的系统 CA 合并状态（供诊断用）。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 状态快照。
 */
export function systemCaStatus() {
  return { ...systemCaState };
}

/**
 * 针对错误码给出可执行的建议。
 * @param {string} code - 归一化后的错误码。
 * @returns {string} 建议文本（可能为空）。
 */
function hintForCode(code) {
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝：本机 hosts 可能把该域名指向了 127.0.0.1（Steam++ / Watt Toolkit 之类的加速工具），但加速器当前没有运行。启动加速器，或把它的 hosts 加速模式关掉再试。';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：检查网络与 DNS。';
  if (CERTIFICATE_CODES.has(code)) {
    return 'TLS 证书链无法验证：多半是本机加速器用自签名证书接管了该域名。保持 trustSystemCa 为 auto（默认）或 always；也可以用 --use-system-ca 启动 DSH。';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：检查网络或代理。';
  if (code === 'ECONNRESET') return '连接被重置：可能是网络中间设备中断了请求，也可能是加速器刚退出。';
  return '';
}

/**
 * 把 HTTP 状态码翻译成可执行的建议。
 * @param {number} status - 状态码。
 * @returns {string} 建议文本（可能为空）。
 */
export function explainHttpStatus(status) {
  switch (status) {
    case 400:
      return '请求参数被拒绝（常见原因：SteamID64 格式不对、appid 不存在）';
    case 401:
    case 403:
      return '鉴权失败：Steam Web API Key 无效、过期，或该接口不对外开放';
    case 404:
      return '接口不存在或资源已下架';
    case 429:
      return 'Steam 限流：匿名调用共享较低的配额，Steam 自己还会缓存结果约 10 分钟；稍等 1–10 分钟再试，或配置 API Key 提高配额';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'Steam 侧暂时不可用';
    default:
      return '';
  }
}

/**
 * 取一个 JSON 端点。
 * @param {string} url - 完整 URL。
 * @param {{ timeoutMs?: number, retries?: number, signal?: AbortSignal, headers?: Record<string, string>,
 *   trustSystemCa?: 'auto' | 'always' | 'never' }} [options] - `retries` 是**额外**重试次数，
 *   默认 1（只在 5xx 与网络错误上重试）；`trustSystemCa` 控制是否把系统根证书并入 Node 的默认 CA。
 * @returns {Promise<{ ok: true, status: number, data: unknown, url: string } |
 *   { ok: false, error: string, url: string, status?: number, body?: string, hint?: string,
 *   code?: string, aborted?: boolean }>} 归一化的结果；调用方永远不需要 try/catch。
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const trustSystemCa = options.trustSystemCa ?? 'auto';
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...options.headers };

  if (trustSystemCa === 'always') ensureSystemCaTrusted();

  /** 原始请求地址（用于识别「被重定向到别处」）；不合法时交给 fetch 自己报错。 */
  let requested;
  try {
    requested = new URL(url);
  } catch {
    requested = undefined;
  }

  let remainingRetries = options.retries ?? 1;
  let caRetryUsed = false;
  let lastCode = '';
  let lastMessage = '请求失败';
  let lastHint = '';

  for (;;) {
    if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url: redactUrl(url), aborted: true };

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      const response = await fetch(url, { headers, signal, redirect: 'follow' });
      const text = await response.text();

      // 被重定向到别的路径：Steam 停用/迁移接口时常见（旧评测端点就是 302 到商店首页）。
      // 继续按 JSON 解析只会得到一句「不是合法 JSON」，这里直接把它说清楚。
      if (differsFromRequest(requested, response.url)) {
        return {
          ok: false,
          status: response.status,
          error: `请求被重定向到 ${redactUrl(response.url)}`,
          hint: '接口地址可能已迁移，或该地区不可用（Steam 会把失效接口 302 到商店首页）。检查插件是否已适配最新接口。',
          body: text.slice(0, 200),
          url: redactUrl(url),
        };
      }

      if (!response.ok) {
        const hint = explainHttpStatus(response.status);
        if (response.status >= 500 && remainingRetries > 0) {
          remainingRetries -= 1;
          lastMessage = `HTTP ${response.status}`;
          lastHint = hint;
          continue;
        }
        const retryAfter = response.headers.get('retry-after');
        const waitHint = retryAfter === null ? hint : `${hint}（Steam 建议 ${retryAfter} 秒后重试）`;
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}${waitHint === '' ? '' : `：${waitHint}`}`,
          hint: waitHint,
          body: text.slice(0, 400),
          url: redactUrl(url),
        };
      }

      try {
        return { ok: true, status: response.status, data: JSON.parse(text), url: redactUrl(url) };
      } catch {
        const contentType = response.headers.get('content-type') ?? '未知 content-type';
        return {
          ok: false,
          status: response.status,
          error: `响应不是合法的 JSON（HTTP ${response.status}，${contentType}，最终地址 ${redactUrl(response.url)}）`,
          hint: '可能被加速器/代理替换成了 HTML，或接口已迁移；原始片段见 body。',
          body: text.slice(0, 400),
          url: redactUrl(url),
        };
      }
    } catch (cause) {
      if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url: redactUrl(url), aborted: true };

      lastCode = findErrorCode(cause);
      lastMessage = deepestMessage(cause) || (cause instanceof Error ? cause.message : String(cause));
      lastHint = hintForCode(lastCode);

      // 证书错误：把系统根证书并进来再试一次。这次重试不占普通重试预算，且最多一次。
      if (trustSystemCa === 'auto' && !caRetryUsed && isCertificateError(cause)) {
        caRetryUsed = true;
        const state = ensureSystemCaTrusted();
        if (state.merged && state.added > 0) continue;
        lastHint = state.error !== undefined
          ? `TLS 证书验证失败，且无法读取系统根证书：${state.error}`
          : 'TLS 证书验证失败；系统根证书已合并但问题依旧，请检查加速器或改用代理。';
      }

      if (lastCode === 'TimeoutError' || lastMessage === 'The operation was aborted due to timeout') {
        lastMessage = '请求超时';
        lastCode = 'ETIMEDOUT';
        lastHint = hintForCode('ETIMEDOUT');
      }

      if (remainingRetries > 0) {
        remainingRetries -= 1;
        continue;
      }
      break;
    }
  }

  const suffix = lastMessage === '请求超时' ? `（超过 ${timeoutMs} ms）` : '';
  return { ok: false, error: `${lastMessage}${suffix}`, hint: lastHint, code: lastCode, url: redactUrl(url) };
}

/**
 * 判断最终响应地址是否已偏离请求地址（路径或查询不同）。
 * @param {URL | undefined} requested - 原始请求 URL。
 * @param {string} finalUrl - `Response.url`。
 * @returns {boolean} 是否被重定向到了别处。
 */
function differsFromRequest(requested, finalUrl) {
  if (requested === undefined) return false;
  try {
    const final = new URL(finalUrl);
    return final.origin !== requested.origin || final.pathname !== requested.pathname || final.search !== requested.search;
  } catch {
    return false;
  }
}

/**
 * 造一个带上默认超时、信任策略与请求头的取数器，省得每个工具都重复传参。
 * @param {{ timeoutMs?: number, headers?: Record<string, string>, trustSystemCa?: 'auto' | 'always' | 'never' }} [defaults]
 *   默认值。
 * @returns {{ json: (url: string, options?: object) => Promise<object>, timeoutMs: number }} 取数器。
 */
export function createHttpClient(defaults = {}) {
  const timeoutMs = defaults.timeoutMs ?? 15_000;
  const headers = defaults.headers ?? {};
  const trustSystemCa = defaults.trustSystemCa ?? 'auto';
  return {
    timeoutMs,
    trustSystemCa,
    json(url, options = {}) {
      return fetchJson(url, {
        timeoutMs,
        trustSystemCa,
        ...options,
        headers: { ...headers, ...(options.headers ?? {}) },
      });
    },
  };
}
