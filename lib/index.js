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
import { VERSION } from './version.js';

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
   * 每次调用重新解析 Key。凭据服务的约定就是「不要跨操作缓存」，所以
   * 受管凭据存储里的变更立刻可见。
   *
   * 注意 `.env` 不是这样：`$DSH_HOME\.env` 由启动引导读进环境快照，改完要重启 DSH；
   * 而启动环境变量本身也在启动时定格。两者都不会被这里「重新解析」追平。
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

  const deps = {
    http,
    library,
    getApiKey,
    isKeyToolsRegistered: () => keyToolsRegistered,
    // `auto` 模式下的自愈入口：steam_status 每次被调用都会尝试补注册。
    // 这样即使激活时的重试窗口错过了，只要凭据已经就绪，一次查询就能把工具补齐。
    ensureKeyTools: async () => {
      if (effective.webApi !== 'auto') return;
      await registerKeyToolsOnce();
    },
  };

  const localTools = registerLocalTools(ctx, effective, deps);
  const storeTools = registerStoreTools(ctx, effective, deps);

  /** 密钥层工具当前的注册状态；`steam_status` 会把它一并回报出来。 */
  let keyToolsRegistered = false;
  /** 已注册的密钥层工具名。 */
  let registeredKeyToolNames = [];

  /**
   * 尝试注册密钥层工具，成功返回 `true`。幂等。
   * @returns {Promise<boolean>} 是否已注册。
   */
  const registerKeyToolsOnce = async () => {
    if (keyToolsRegistered) return true;
    const key = await getApiKey();
    if (typeof key !== 'string' || key.trim() === '') return false;
    try {
      registeredKeyToolNames = registerWebApiTools(ctx, effective, deps);
      keyToolsRegistered = true;
    } catch (cause) {
      log('warn', `注册密钥层工具失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
    log('info', `已解析到 ${effective.apiKeyEnv}，注册 ${registeredKeyToolNames.length} 个需要 API Key 的工具。`);
    return true;
  };

  /**
   * 等凭据服务就绪后补注册密钥层工具。
   *
   * 桌面版实测：插件可能在凭据服务（以及它背后的凭据文件）完成初始化之前就被激活，
   * 那一刻 `resolve` 必然返回空。这里用两条路覆盖两种时序——服务出现时立刻重试，
   * 以及一段有上限的兜底轮询——避免出现「Key 配好了但工具永远不出现」。
   * 任一次成功即停止，最多持续约 15 秒。
   */
  const scheduleKeyToolRetry = () => {
    const delays = [500, 1000, 2000, 4000, 8000];

    try {
      ctx.inject(['credentials'], () => {
        void registerKeyToolsOnce();
      });
    } catch {
      // 注入本身的失败不该影响兜底轮询。
    }

    const attempt = async (index) => {
      if (keyToolsRegistered || index >= delays.length) return;
      if (await registerKeyToolsOnce()) return;
      const timer = setTimeout(() => {
        void attempt(index + 1);
      }, delays[index]);
      timer.unref?.();
    };
    void attempt(0);
  };

  let keyTools = [];
  if (effective.webApi === 'off') {
    log('info', 'webApi=off：不注册需要 API Key 的工具。');
  } else if (effective.webApi === 'on') {
    keyTools = registerWebApiTools(ctx, effective, deps);
    keyToolsRegistered = true;
    log('info', `webApi=on：已注册 ${keyTools.length} 个需要 API Key 的工具。`);
  } else if (await registerKeyToolsOnce()) {
    keyTools = registeredKeyToolNames;
  } else {
    // auto 模式：激活时还没拿到 Key。桌面版实测插件会**早于凭据服务就绪**被激活，
    // 此刻 resolve 必然返回空——只在这一次判断，就会出现「Key 明明配好了、
    // steam_status 也显示已配置，但 5 个工具就是不出现」。所以这里等它。
    scheduleKeyToolRetry();
    log(
      'info',
      `激活时没有解析到 ${effective.apiKeyEnv}：先注册 ${localTools.length + storeTools.length} 个不需要 Key 的工具，` +
        '并在凭据服务就绪后自动重试注册密钥层工具。',
    );
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
    `就绪（v${VERSION}）：本地 ${localTools.length} + 公开 ${storeTools.length} + 密钥 ${keyToolsRegistered ? registeredKeyToolNames.length : keyTools.length} 个工具；` +
      `steamPath=${effective.steamPath || '(自动探测)'}，webApi=${effective.webApi}，trustSystemCa=${effective.trustSystemCa}。`,
  );
}
