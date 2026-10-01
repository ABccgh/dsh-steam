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
 * 「Web API Key 没配」时的可执行提示。
 * @param {string} envName - 期望的凭据名（默认 `STEAM_API_KEY`）。
 * @returns {string} 多行提示。
 */
export function apiKeyHelp(envName) {
  return [
    `Steam Web API Key 未配置（正在找凭据 ${envName}）。`,
    `最快的办法：在 ${path.join(dshHome(), '.env')} 里加一行 ${envName}=你的KEY（文件不存在就新建）。`,
    `也可以写进 ${path.join(dshHome(), '.credentials.yaml')}，或在启动 DSH 前设成用户环境变量。`,
    '保存后在「插件」页把 steam 这一行关开一次（或重启应用）即可生效，不需要改这里的配置。',
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
 * @returns {string[]} 可输出的行数组。
 */
export function truncateLines(lines, limit, unit) {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `…… 共 ${lines.length} ${unit}，只显示了前 ${limit} 个；用 filter 或更小的 limit 缩小范围。`];
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
