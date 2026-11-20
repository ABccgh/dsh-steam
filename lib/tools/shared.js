/**
 * 工具层共用的小工具：统一的文本输出形状、数量裁剪、时间/时长格式化，
 * 以及「Key 没配」时要给出的那句可执行提示。
 *
 * @module dsh-steam/tools/shared
 */

import path from 'node:path';

/**
 * 所有 `steam_*` 工具的输出形状：一段给模型读的紧凑文本。
 *
 * 这里刻意不返回结构化对象：DSH 的输出值 schema 是简写 spec，嵌套结构一旦写错
 * 会在工具调用时变成校验失败，而模型真正需要的是可读文本。
 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text) }],
};

/** 只读工具都可以并发执行。 */
export function alwaysSafe() {
  return true;
}

/**
 * 所有工具的兜底超时。
 *
 * 工具本身只发出网请求，HTTP 层另有 `requestTimeoutMs`（默认 15 秒）与一次重试；
 * 这里再给一个总上限，避免某次调用因为重试叠加或外部取消信号缺失而永远不返回。
 * 每次 `defineTool({...})` 都传 `timeoutMs: TOOL_TIMEOUT_MS`。
 */
export const TOOL_TIMEOUT_MS = 60_000;

/**
 * 造一个带 `AbortError` 身份的取消错误。
 *
 * DSH 只把「signal 已取消 + 抛出的值没有自己的错误身份且 name 为 AbortError」的
 * 调用记成 `ABORTED`；普通 `Error` 会被记成一次普通工具失败。
 * @param {string} [message] - 错误消息。
 * @returns {Error} name 为 AbortError 的错误。
 */
export function abortError(message = '请求已被取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * DSH 的 home 目录，用于拼出「去哪写 Key」的绝对路径。
 * @returns {string} 目录路径。
 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return path.join(home, '.dsh');
}

/**
 * 把出网层结果里的 `error` 与 `hint` 拼成一句。
 *
 * HTTP 层在错误消息里已经带了建议，直接 `${error}；${hint}` 会重复一遍
 * （实测 `HTTP 400：请求参数被拒绝（原因）；请求参数被拒绝（原因）`）。
 * @param {{ error?: string, hint?: string }} result - `fetchJson` 的结果。
 * @returns {string} 给模型看的错误文本。
 */
export function failureText(result) {
  const error = typeof result?.error === 'string' && result.error !== '' ? result.error : '未知错误';
  const hint = typeof result?.hint === 'string' ? result.hint : '';
  if (hint === '' || error.includes(hint)) return error;
  return `${error}；${hint}`;
}

/**
 * 「Web API Key 没配」时的可执行提示。
 *
 * 这里的顺序必须与 DSH 凭据服务的真实优先级一致（`@deepseek-ai/dsh-credentials-local`）：
 * 已存的 `$DSH_HOME/.credentials.yaml` > 启动环境变量 > 项目 `.env` > `$DSH_HOME/.env`。
 * 另外凭据文件是**带版本的结构化文档**，不是 dotenv：裸写一行 `STEAM_API_KEY: …`
 * 会被当成未知顶层键忽略，必须写 `version: 1` + `refs:` 下才解析。
 * @param {string} envName - 期望的凭据名（默认 `STEAM_API_KEY`）。
 * @returns {string} 多行提示。
 */
export function apiKeyHelp(envName) {
  const credentialsFile = path.join(dshHome(), '.credentials.yaml');
  const homeEnvFile = path.join(dshHome(), '.env');
  return [
    `Steam Web API Key 未配置（正在找凭据 ${envName}）。按优先级从高到低，配好任意一条即可：`,
    `1. 已存凭据：编辑 ${credentialsFile}，把 Key 写在 version: 1 的 refs: 下（这是最高优先级，凭据服务会热加载，保存后通常立刻生效）：`,
    '   version: 1',
    '   refs:',
    `     ${envName}: 你的KEY`,
    `   注意：直接加一行裸 \`${envName}: 你的KEY\` 会被当作未知顶层键忽略——文件必须是 version: 1 + refs: 结构。也可以用凭据 UI 或 credentials.set 写入。`,
    `2. 启动 DSH 前的环境变量：setx ${envName} "你的KEY"，然后重启 DSH（排在已存凭据之后，不受凭据文件格式影响）。`,
    '3. 启动目录下的 .env（项目 .env）：只在启动时读取，写完必须重启 DSH。',
    `4. ${homeEnvFile}：优先级最低，只在启动时读取；桌面版还只在 cwd ≠ $DSH_HOME 时才把它当 user-env 层，最容易「写了不生效」。`,
    '不确定有没有生效时直接调 steam_status，它会写「已配置／未配置」以及 5 个密钥层工具是否已注册。',
    '申请地址：https://steamcommunity.com/dev/apikey',
  ].join('\n');
}

/**
 * 把可选的 `limit` 参数收进合法范围。
 * @param {unknown} value - 模型传来的值。
 * @param {number} fallback - 默认值。
 * @param {number} max - 上限。
 * @returns {number} 夹紧后的整数。
 */
export function clampLimit(value, fallback, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.min(fallback, max);
  return Math.min(Math.trunc(parsed), max);
}

/**
 * 把分钟数变成 `12 小时 34 分` 这样的文本。
 * @param {number} minutes - 分钟数。
 * @returns {string} 文本。
 */
export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest} 分`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分`;
}

/**
 * 按上限截断列表，并给出一行「还有多少没显示」。
 * @param {string[]} lines - 内容行。
 * @param {number} limit - 最多显示多少行。
 * @param {string} unit - 计数单位，例如「个游戏」。
 * @param {string} [hint] - 缩小范围的建议；不同工具可用的参数不一样，所以由调用方给。
 * @returns {string[]} 可输出的行数组。
 */
export function truncateLines(lines, limit, unit, hint = '用更小的 limit 缩小范围。') {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `…… 共 ${lines.length} ${unit}，只显示了前 ${limit} 个；${hint}`];
}

/**
 * 造一个带短 TTL 的库扫描读取器，避免一次对话里反复扫盘。
 * @param {{ steamPath?: string, extraLibraryPaths?: string[] }} config - 扫描配置。
 * @param {{ scan: Function, ttlMs?: number }} deps - 扫描函数与缓存时长。
 * @returns {{ read: (options?: { fresh?: boolean }) => Promise<object> }} 读取器。
 */
export function createLibraryReader(config, deps) {
  const ttlMs = deps.ttlMs ?? 5000;
  let cachedAt = 0;
  let cached;
  let inflight;

  return {
    async read(options = {}) {
      const now = Date.now();
      if (options.fresh !== true && cached !== undefined && now - cachedAt < ttlMs) return cached;
      if (inflight !== undefined) return inflight;
      inflight = Promise.resolve(
        deps.scan({
          steamPath: config.steamPath,
          extraLibraryPaths: config.extraLibraryPaths,
        }),
      )
        .then((value) => {
          cached = value;
          cachedAt = Date.now();
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}

/**
 * 把「本机账号」渲染成一行。
 * @param {{ personaName: string, steamId64: string, autoLogin: boolean }} account - 账号。
 * @returns {string} 文本。
 */
export function describeAccount(account) {
  const auto = account.autoLogin ? '，自动登录' : '';
  return `${account.personaName || '(无显示名)'}（${account.steamId64}${auto}）`;
}
