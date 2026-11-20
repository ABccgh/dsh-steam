/**
 * 只读的本地工具：安装状态、已安装游戏、单个游戏详情、库健康检查、本地创意工坊内容。
 *
 * 这一组完全不联网，也不需要 API Key。所有输出都是给模型读的紧凑文本。
 *
 * @module dsh-steam/tools/local
 */

import { formatBytes, formatUnixLocal } from '../library.js';
import { systemCaStatus } from '../http.js';
import { VERSION } from '../version.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT,
  TOOL_TIMEOUT_MS,
  alwaysSafe,
  clampLimit,
  describeAccount,
  truncateLines,
} from './shared.js';

/**
 * 注册 5 个本地工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {{ maxListedApps: number }} config - 生效配置。
 * @param {{ library: { read: Function } }} deps - 库读取器。
 * @returns {string[]} 已注册的工具名。
 */
export function registerLocalTools(ctx, config, deps) {
  const { library, getApiKey, getApiKeyInfo, isKeyToolsRegistered, ensureKeyTools } = deps;

  ctx.tools.register(
    defineTool({
      name: 'steam_status',
      description:
        '查看本机 Steam 的整体状态：安装目录、客户端是否在运行（含 PID）、所有库根及其占用、已登录账号、已安装游戏数与总占用、本地创意工坊内容数量、插件版本、系统根证书状态，以及 Steam Web API Key 是否已配置。本组本地工具都不联网、不需要 API Key。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      // 刻意不声明 isConcurrencySafe：这个工具会在调用中触发密钥层工具的补注册
      // （修改插件级状态，见 ensureKeyTools）。注册动作本身幂等，但同时跑两次
      // 只会让 DSH 误以为交互是纯读取的；保守地按非并发安全处理。
      async execute() {
        const scan = await library.read();
        // 自愈：若此前因为凭据服务尚未就绪而没注册上密钥层工具，这里再试一次。
        if (typeof ensureKeyTools === 'function') {
          try {
            await ensureKeyTools();
          } catch {
            // 自愈失败不该影响这次状态查询本身。
          }
        }
        // Key 状态在这里回报：凭据服务没有日志通道，这一行是唯一能从外部看到
        // 「插件到底有没有拿到 Key、工具到底注册了没有」的地方。
        const key = typeof getApiKey === 'function' ? await getApiKey() : undefined;
        const registered = typeof isKeyToolsRegistered === 'function' ? isKeyToolsRegistered() : undefined;
        const info = typeof getApiKeyInfo === 'function' ? await getApiKeyInfo() : undefined;
        return { text: `${renderStatus(scan, config)}\n${describeApiKey(config.apiKeyEnv, key, registered, config.webApi, info)}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_games',
      description:
        '列出本机 Steam 已安装的游戏（来自各库的 appmanifest 文件），含占用空间、最后游玩时间与安装状态。可按名称/appid 过滤、按占用或最后游玩排序。',
      parameters: {
        filter: { type: 'string', description: '按游戏名做不区分大小写的子串过滤；纯数字则按 appid 精确匹配。' },
        sort: {
          type: 'string',
          enum: ['size', 'lastPlayed', 'name'],
          description: '排序方式：size（占用降序，默认）、lastPlayed（最后游玩降序）、name（名称升序）。',
        },
        limit: { type: 'integer', description: `最多显示多少条，默认 ${config.maxListedApps}。` },
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: alwaysSafe,
      async execute(args) {
        const scan = await library.read();
        if (!scan.detected) return { text: notDetected(scan) };

        const limit = clampLimit(args.limit, config.maxListedApps, 1000);
        const filter = typeof args.filter === 'string' ? args.filter.trim() : '';
        let games = scan.games.slice();
        if (filter !== '') {
          const lowered = filter.toLowerCase();
          games = games.filter(
            (game) => game.name.toLowerCase().includes(lowered) || String(game.appid) === filter,
          );
        }

        const sort = typeof args.sort === 'string' ? args.sort : 'size';
        if (sort === 'lastPlayed') games.sort((left, right) => right.lastPlayed - left.lastPlayed);
        else if (sort === 'name') games.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
        else games.sort((left, right) => right.sizeBytes - left.sizeBytes);

        if (games.length === 0) {
          // 「过滤后为空」和「本机真的一个都没装」是两件事，不能都写成「已安装 0 个」。
          if (scan.games.length === 0) {
            return { text: '本机没有已安装的游戏。用 steam_status 看库根是否都读到了。' };
          }
          return {
            text: `没有匹配「${filter}」的游戏（共 ${scan.games.length} 个已安装）。换个关键词，或留空 filter 看全部。`,
          };
        }

        const lines = truncateLines(
          games.map((game) => renderGameLine(game)),
          limit,
          '个已安装游戏',
          '用 filter 或更小的 limit 缩小范围。',
        );
        const summary = `已安装 ${scan.games.length} 个游戏，合计 ${formatBytes(scan.health.totalSizeBytes)}；本次显示 ${Math.min(games.length, limit)} 条（排序：${sort}）。`;
        return { text: [summary, ...lines].join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_game',
      description:
        '按 appid 查一个游戏在本机的安装详情：安装目录、占用、buildid、安装状态位、语言、最后更新时间。找不到时会说明它没装在本机。',
      parameters: {
        appid: { type: 'integer', required: true, description: 'Steam 应用 ID，例如 431960。' },
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: alwaysSafe,
      async execute(args) {
        const scan = await library.read();
        if (!scan.detected) return { text: notDetected(scan) };
        const appid = Number.parseInt(String(args.appid ?? ''), 10);
        if (!Number.isFinite(appid)) throw new Error('appid 必须是整数。');

        const matches = scan.games.filter((game) => game.appid === appid);
        if (matches.length === 0) {
          return {
            text: `appid ${appid} 没有安装在本机。用 steam_games 看已安装列表，或用 steam_store_app 看商店里的信息。`,
          };
        }
        return { text: matches.map((game) => renderGameDetail(game)).join('\n\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_library_health',
      description:
        '检查本机 Steam 库的完整性：各库占用汇总、有目录但没有 appmanifest 的残留、appmanifest 指向的安装目录丢失、跨库重复的 appid、无法解析的 appmanifest。用来找可以清理的占用。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: alwaysSafe,
      async execute() {
        const scan = await library.read();
        if (!scan.detected) return { text: notDetected(scan) };

        const lines = [];
        lines.push(`总计：${scan.games.length} 个已安装项，${formatBytes(scan.health.totalSizeBytes)}`);
        for (const library of scan.libraries) {
          lines.push(
            library.error
              ? `  - ${library.path} — 读取失败：${library.error}`
              : `  - ${library.path} — ${library.apps} 项，${formatBytes(library.sizeBytes)}`,
          );
        }

        lines.push('', `安装目录缺失（appmanifest 在，但 steamapps/common 下没有对应目录）：${scan.health.missingInstalls.length} 个`);
        for (const entry of scan.health.missingInstalls.slice(0, 20)) {
          lines.push(`  - ${entry.appid} ${entry.name} — 期望位置 ${entry.expected}`);
        }

        lines.push('', `多余目录（common 下有目录，但没有对应的 appmanifest）：${scan.health.orphanDirs.length} 个`);
        for (const entry of scan.health.orphanDirs.slice(0, 20)) {
          lines.push(`  - ${entry.path}`);
        }

        if (scan.health.duplicateAppIds.length > 0) {
          lines.push('', `跨库重复的 appid：${scan.health.duplicateAppIds.join('、')}`);
        }
        if (scan.manifestErrors.length > 0) {
          lines.push('', `无法解析的 appmanifest：${scan.manifestErrors.length} 个`);
          for (const entry of scan.manifestErrors.slice(0, 10)) lines.push(`  - ${entry.file}：${entry.error}`);
        }
        if (scan.libraryError) lines.push('', `库列表本身有问题：${scan.libraryError}`);
        return { text: lines.join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_workshop_local',
      description:
        '列出本机已下载的 Steam 创意工坊内容（steamapps/workshop/content/<appid>/<id>），含大小与最后修改时间。可按 appid 过滤。',
      parameters: {
        appid: { type: 'integer', description: '只看这个游戏的创意工坊内容，例如 1158310（Crusader Kings III）。' },
        limit: { type: 'integer', description: `最多显示多少条，默认 ${config.maxListedApps}。` },
      },
      output: TEXT_OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: alwaysSafe,
      async execute(args) {
        const scan = await library.read();
        if (!scan.detected) return { text: notDetected(scan) };

        const limit = clampLimit(args.limit, config.maxListedApps, 1000);
        const appid = Number.parseInt(String(args.appid ?? ''), 10);
        let items = scan.workshop;
        if (Number.isFinite(appid)) items = items.filter((item) => item.appid === appid);
        if (items.length === 0) {
          return {
            text: Number.isFinite(appid)
              ? `本机没有 appid ${appid} 的创意工坊内容。`
              : '本机没有已下载的创意工坊内容。',
          };
        }

        const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
        const nameByAppId = new Map(scan.games.map((game) => [game.appid, game.name]));
        const lines = truncateLines(
          items.map((item) => {
            const game = nameByAppId.get(item.appid);
            const gameLabel = game === undefined || game === '' ? `${item.appid}` : `${item.appid}（${game}）`;
            // 目录遍历有 maxEntries 上限；被截断时大小与文件数是下限值，必须标出来，
            // 否则看起来像是精确统计。
            const truncated = item.truncated === true ? '（目录遍历已截断，大小与文件数偏小）' : '';
            return `${gameLabel}  工坊ID ${item.publishedFileId} — ${formatBytes(item.sizeBytes)}（${item.files} 个文件）— 修改于 ${formatUnixLocal(Math.floor(item.mtimeMs / 1000))}${truncated}`;
          }),
          limit,
          '项创意工坊内容',
          '用 appid 过滤或更小的 limit 缩小范围。',
        );
        return { text: [`共 ${items.length} 项，合计 ${formatBytes(totalBytes)}：`, ...lines].join('\n') };
      },
    }),
  );

  return ['steam_status', 'steam_games', 'steam_game', 'steam_library_health', 'steam_workshop_local'];
}

/**
 * 把 Steam Web API Key 的配置状态说清楚。凭据服务没有日志通道，这一行是排查
 * 「为什么密钥层工具没出现」时唯一能看到的事实：既报凭据是否解析得到，
 * 也报工具是否真的注册上了——这两件事可能不一致（激活时序问题）。
 * @param {string} envName - 期望的凭据名。
 * @param {string | undefined} key - 当前解析到的 Key。
 * @param {boolean | undefined} registered - 密钥层工具是否已注册。
 * @param {string} mode - 生效的 `webApi` 模式。
 * @param {{ source?: string, writable?: boolean }|undefined} [info] - 凭据服务的 `describe` 结果。
 * @returns {string} 文本。
 */
function describeApiKey(envName, key, registered, mode, info) {
  const value = typeof key === 'string' ? key.trim() : '';
  const origin = describeCredentialSource(info);
  if (value !== '') {
    if (registered === false && mode === 'off') {
      return `Web API Key（${envName}）：已配置（长度 ${value.length}${origin}），但 webApi=off —— 密钥层工具按配置未注册。改成 auto 或 on 并重载即可启用。`;
    }
    if (registered === false) {
      return `Web API Key（${envName}）：已配置（长度 ${value.length}${origin}），但密钥层工具尚未注册 —— 插件激活时凭据服务还没就绪。重启 DSH 后会补上；若重启仍不行，把 webApi 设为 on。`;
    }
    return `Web API Key（${envName}）：已配置（长度 ${value.length}${origin}）—— 5 个密钥层工具已注册。`;
  }
  if (registered === true) {
    return `Web API Key（${envName}）：未配置 —— 密钥层工具已按 webApi=on 注册，调用时会提示怎么配置。`;
  }
  return [
    `Web API Key（${envName}）：未配置 —— 密钥层工具（steam_player / steam_owned_games / steam_recent_games / steam_achievements / steam_workshop_search）不会注册。`,
    `排查：在 $DSH_HOME\\.credentials.yaml 的 version: 1 / refs: 下写 ${envName}: 你的KEY（保存后通常立刻生效；裸写一行不会被解析）；或在启动 DSH 前设成环境变量（setx ${envName} "你的KEY"，需重启）。`,
  ].join('\n');
}

/**
 * 把凭据来源渲染成 `；来源：xxx` 片段，拿不到来源时返回空串。
 *
 * 凭据服务按「已存文件 > 启动环境 > 项目 .env > $DSH_HOME/.env」解析，四层都可能
 * 供值；只有 `describe().source` 能说清当前是哪一层——这正是「我明明配了为什么
 * 没生效」最常见的困惑点。
 * @param {{ source?: string, writable?: boolean }|undefined} info - `describe` 结果。
 * @returns {string} 片段（可能为空）。
 */
function describeCredentialSource(info) {
  if (info === null || typeof info !== 'object') return '';
  const source = typeof info.source === 'string' && info.source.trim() !== '' ? info.source.trim() : '';
  if (source === '') return '';
  return `；来源：${source}${info.writable === false ? '（只读）' : ''}`;
}

/**
 * 本机没有 Steam 时的统一话术：说清楚找过哪里、以及怎么纠正。
 * @param {any} scan - 库扫描结果。
 * @returns {string} 文本。
 */
function notDetected(scan) {  return [
    '没有找到本机 Steam 安装。',
    `已经找过这些位置：${scan.candidates.length > 0 ? scan.candidates.join('、') : '(无)'}`,
    '如果 Steam 装在别处，在 cordis.patch.yml 里把 steamPath 设为它的绝对路径。',
  ].join('\n');
}

/**
 * 渲染 `steam_status` 的正文。
 * @param {any} scan - 库扫描结果。
 * @param {{ webApi?: string, steamPath?: string, storeCountry?: string, storeLanguage?: string,
 *   requestTimeoutMs?: number, trustSystemCa?: string }} config - 生效配置。
 * @returns {string} 文本。
 */
function renderStatus(scan, config = {}) {
  if (!scan.detected) return notDetected(scan);

  const lines = [];
  lines.push(`插件：@local/steam ${VERSION}`);
  lines.push(
    `配置：webApi=${config.webApi ?? 'auto'}，steamPath=${config.steamPath ? config.steamPath : '(自动探测)'}，` +
      `store=${config.storeCountry ?? 'cn'}/${config.storeLanguage ?? 'schinese'}，HTTP 超时 ${config.requestTimeoutMs ?? 15000}ms`,
  );
  lines.push(`Steam 安装目录：${scan.root}`);
  lines.push(`探测来源：${scan.rootSource ?? '未知'}`);
  lines.push(`客户端：${scan.running ? `运行中（pid ${scan.pid ?? '未知'}，来源 ${scan.runningSource}）` : '未运行'}`);
  lines.push(`库列表文件：${scan.libraryVdf ?? '未找到'}${scan.libraryError ? `（${scan.libraryError}）` : ''}`);
  lines.push(`库根（${scan.libraries.length}）：`);
  for (const library of scan.libraries) {
    lines.push(
      library.error
        ? `  - ${library.path} — 读取失败：${library.error}`
        : `  - ${library.path} — ${library.apps} 个已安装项，合计 ${formatBytes(library.sizeBytes)}`,
    );
  }
  lines.push(
    scan.accounts.length > 0
      ? `本机账号：${scan.accounts.map((account) => describeAccount(account)).join('；')}`
      : `本机账号：读不到（${scan.accountError ?? 'config/loginusers.vdf 不存在'}）`,
  );
  lines.push(`已安装游戏：${scan.games.length} 个，合计 ${formatBytes(scan.health.totalSizeBytes)}`);

  const problems = [];
  if (scan.health.missingInstalls.length > 0) problems.push(`安装目录缺失 ${scan.health.missingInstalls.length} 个`);
  if (scan.health.orphanDirs.length > 0) problems.push(`多余目录 ${scan.health.orphanDirs.length} 个`);
  if (scan.manifestErrors.length > 0) problems.push(`无法解析的 appmanifest ${scan.manifestErrors.length} 个`);
  if (scan.health.duplicateAppIds.length > 0) problems.push(`跨库重复 appid ${scan.health.duplicateAppIds.length} 个`);
  lines.push(problems.length > 0 ? `库问题：${problems.join('；')}（用 steam_library_health 看详情）` : '库问题：无');
  lines.push(`创意工坊本地内容：${scan.workshop.length} 项`);
  lines.push(describeCaState(config.trustSystemCa));
  return lines.join('\n');
}

/**
 * 说清系统根证书的合并状态：本机若是加速器（Steam++/Watt Toolkit）接管 TLS，
 * 这一行是「网络工具为什么能用/不能用」的直接证据。
 * @param {string} [mode] - 生效的 `trustSystemCa` 配置。
 * @returns {string} 文本。
 */
function describeCaState(mode) {
  if (mode === 'never') return '系统根证书：trustSystemCa=never —— 按配置不并入，加速器开着时网络工具会失败。';
  const state = systemCaStatus();
  if (state.error !== undefined) return `系统根证书：并入失败 —— ${state.error}`;
  if (state.merged) return `系统根证书：已并入（+${state.added}，共 ${state.total}）。`;
  return '系统根证书：尚未触发合并（trustSystemCa=auto，第一次遇到证书错误时并入一次）。';
}

/**
 * 渲染一行游戏摘要。
 * @param {any} game - 游戏条目。
 * @returns {string} 文本。
 */
function renderGameLine(game) {
  const parts = [
    `${game.appid}  ${game.name}`,
    formatBytes(game.sizeBytes),
    `最后游玩 ${formatUnixLocal(game.lastPlayed)}`,
    game.stateLabels.join('+') || `StateFlags=${game.stateFlags}`,
  ];
  if (game.installDir !== '') parts.push(game.installDir);
  if (game.missing) parts.push('⚠ 安装目录缺失');
  return parts.join(' — ');
}

/**
 * 渲染单个游戏的完整详情。
 * @param {any} game - 游戏条目。
 * @returns {string} 文本。
 */
function renderGameDetail(game) {
  const lines = [];
  lines.push(`${game.name}（appid ${game.appid}）`);
  lines.push(`安装目录：${game.installPath || '(manifest 里没有 installdir)'}${game.missing ? ' —— ⚠ 该目录不存在' : ''}`);
  lines.push(`所在库：${game.libraryPath}`);
  lines.push(`占用：${formatBytes(game.sizeBytes)}（${game.sizeBytes} 字节）`);
  lines.push(`安装状态：StateFlags=${game.stateFlags}（${game.stateLabels.join('、') || '无可识别位'}）`);
  lines.push(`buildid：${game.buildId || '未知'}`);
  lines.push(`最后更新：${formatUnixLocal(game.lastUpdated)}`);
  lines.push(`最后游玩：${formatUnixLocal(game.lastPlayed)}`);
  lines.push(`语言：${game.language || '未设置'}`);
  return lines.join('\n');
}
