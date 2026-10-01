/**
 * dsh-steam 的 Cordis 插件入口。
 *
 * 注册 14 个只读工具，分三层：
 * - 本地层（5 个）：读本机 Steam 安装与库，完全不联网；
 * - 公开层（4 个）：读 Steam 商店与公共端点，不需要 Key；
 * - 密钥层（5 个）：官方 Steam Web API，需要 `STEAM_API_KEY`。
 *
 * Key 的处理方式见 `getApiKey`：每次调用重新解析，不缓存。
 *
 * **本模块刻意不 import 任何 `@deepseek-ai/*` 包。** 插件是 `link:` 安装的 profile bundle，
 * 代码在 DSH 安装作用域之外，DSH 的 profile 解析路由不会把 bundle 里的 `@deepseek-ai/*`
 * 导入重定向到安装目录——一旦 import 就会让整个插件以 ERR_MODULE_NOT_FOUND 加载失败。
 * 参数 schema 由本地 `./tool-kit.js` 编译（工具注册表只要求 `parameters` 是 JSON Schema）。
 * 同理这里不导出 `Config`：`resolveConfig` 在没有 `Config` 时会原样透传配置对象，
 * 校验与默认值由下面的 `normalizeConfig` 负责。
 *
 * @module @local/steam
 */

import { createHttpClient, ensureSystemCaTrusted } from './http.js';
import { scanSteamLibrary } from './library.js';
import { registerLocalTools } from './tools/local.js';
import { createLibraryReader } from './tools/shared.js';
import { registerStoreTools } from './tools/store.js';
import { registerWebApiTools } from './tools/webapi.js';

/** 插件名，也是 loader row 的 `name` 里 App 面的标识。 */
export const name = 'steam';

/** 工具注册表是本插件的硬依赖。 */
export const inject = ['tools'];

/**
 * 配置字段与默认值（无 Schemastery schema，取值由 `normalizeConfig` 兜底）：
 *
 * | 字段 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `steamPath` | `''` | 手动指定 Steam 根目录；留空自动探测 |
 * | `extraLibraryPaths` | `[]` | 追加库根 |
 * | `webApi` | `'auto'` | `auto` / `on` / `off` |
 * | `apiKeyEnv` | `'STEAM_API_KEY'` | Key 的凭据名 |
 * | `trustSystemCa` | `'auto'` | `auto` / `always` / `never` |
 * | `storeCountry` / `storeLanguage` | `'cn'` / `'schinese'` | 商店端点地区与语言 |
 * | `requestTimeoutMs` | `15000` | 单次 HTTP 超时 |
 * | `maxListedApps` | `200` | 列表类工具一次最多返回多少条 |
 */

const WEB_API_MODES = new Set(['auto', 'on', 'off']);
const CA_MODES = new Set(['auto', 'always', 'never']);

/**
 * 把 loader 传来的配置收进合法范围。
 * 这里不抛错：一个写错的字段不应该让整个插件装不上，回退到默认值并留一行日志更合适。
 * @param {Record<string, unknown>} raw - loader 校验后的配置。
 * @returns {{ steamPath: string, extraLibraryPaths: string[], webApi: string, apiKeyEnv: string,
 *   trustSystemCa: string, storeCountry: string, storeLanguage: string, requestTimeoutMs: number,
 *   maxListedApps: number }} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : []);
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback);
  return {
    steamPath: typeof raw.steamPath === 'string' ? raw.steamPath.trim() : '',
    extraLibraryPaths: list(raw.extraLibraryPaths),
    webApi: WEB_API_MODES.has(raw.webApi) ? raw.webApi : 'auto',
    apiKeyEnv: text(raw.apiKeyEnv, 'STEAM_API_KEY'),
    trustSystemCa: CA_MODES.has(raw.trustSystemCa) ? raw.trustSystemCa : 'auto',
    storeCountry: text(raw.storeCountry, 'cn'),
    storeLanguage: text(raw.storeLanguage, 'schinese'),
    requestTimeoutMs: positive(raw.requestTimeoutMs, 15000),
    maxListedApps: positive(raw.maxListedApps, 200),
  };
}

/**
 * 装配插件。
 * @param {object} ctx - Cordis 上下文（带 `tools`，可选带 `credentials`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @returns {Promise<void>} 无。
 */
export async function apply(ctx, config) {
  const effective = normalizeConfig(config);

  /** 记一行日志；日志不可用不该影响插件本身。 */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[steam] ${message}`);
    } catch {
      // 日志失败无所谓。
    }
  };

  const http = createHttpClient({
    timeoutMs: effective.requestTimeoutMs,
    trustSystemCa: effective.trustSystemCa,
  });
  const library = createLibraryReader(effective, { scan: scanSteamLibrary });

  const ref = effective.apiKeyEnv;
  /**
   * 每次调用重新解析 Key。凭据服务的约定就是「不要跨操作缓存」，
   * 这样用户往 `$DSH_HOME/.env` 里加一行之后，下一个工具调用就能用上。
   *
   * 这里传的是普通字符串：`credentialRef()` 在运行时只是给字符串打品牌标记，
   * 而它的名字合法性检查已经由 `normalizeConfig` 的默认值与调用方保证。
   * @returns {Promise<string | undefined>} Key，或 undefined。
   */
  const getApiKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return undefined;
    try {
      const resolved = await credentials.resolve(ref);
      return resolved?.value;
    } catch (cause) {
      log('warn', `读取凭据 ${effective.apiKeyEnv} 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  };

  const deps = { http, library, getApiKey };

  const localTools = registerLocalTools(ctx, effective, deps);
  const storeTools = registerStoreTools(ctx, effective, deps);

  let keyTools = [];
  if (effective.webApi === 'off') {
    log('info', 'webApi=off：不注册需要 API Key 的工具。');
  } else if (effective.webApi === 'on') {
    keyTools = registerWebApiTools(ctx, effective, deps);
    log('info', `webApi=on：已注册 ${keyTools.length} 个需要 API Key 的工具。`);
  } else {
    const key = await getApiKey();
    if (typeof key === 'string' && key.trim() !== '') {
      keyTools = registerWebApiTools(ctx, effective, deps);
      log('info', `已解析到 ${effective.apiKeyEnv}，注册 ${keyTools.length} 个需要 API Key 的工具。`);
    } else {
      log(
        'info',
        `没有解析到 ${effective.apiKeyEnv}：只注册 ${localTools.length + storeTools.length} 个不需要 Key 的工具。` +
          `把 Key 写进 $DSH_HOME/.env（一行 ${effective.apiKeyEnv}=你的KEY）后，在插件页把 steam 关开一次即可启用其余 5 个。`,
      );
    }
  }

  if (effective.trustSystemCa === 'always') {
    const state = ensureSystemCaTrusted();
    log(
      'info',
      state.error === undefined
        ? `trustSystemCa=always：已并入系统根证书（+${state.added}，共 ${state.total}）。`
        : `trustSystemCa=always：并入系统根证书失败——${state.error}`,
    );
  }

  log(
    'info',
    `就绪：本地 ${localTools.length} + 公开 ${storeTools.length} + 密钥 ${keyTools.length} 个工具；` +
      `steamPath=${effective.steamPath || '(自动探测)'}，webApi=${effective.webApi}，trustSystemCa=${effective.trustSystemCa}。`,
  );
}
