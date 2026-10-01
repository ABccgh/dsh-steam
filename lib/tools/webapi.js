/**
 * 需要 Steam Web API Key 的工具：玩家资料、拥有游戏、最近游玩、成就、创意工坊查询。
 *
 * Key 的处理有两条硬规则：
 * 1. **每次调用都重新向凭据服务解析**，不缓存——这样往 `$DSH_HOME/.env` 里加一行就能立刻生效；
 * 2. 解析不到时抛出的是「去哪儿写、怎么生效」的完整指引，而不是一句 "missing key"。
 *
 * @module dsh-steam/tools/webapi
 */

import {
  mapOwnedGames,
  mapPlayerAchievements,
  mapPlayerSummaries,
  mapQueryFiles,
  mapRecentlyPlayed,
  mapResolveVanity,
  normalizeSteamIdInput,
  ownedGamesUrl,
  playerAchievementsUrl,
  playerSummariesUrl,
  queryFilesUrl,
  recentlyPlayedUrl,
  resolveVanityUrl,
} from '../webapi.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, alwaysSafe, apiKeyHelp, clampLimit, formatMinutes } from './shared.js';

/** 创意工坊排序的可选值。 */
const QUERY_TYPES = [
  'rankedByVote',
  'rankedByPublicationDate',
  'rankedByTrend',
  'rankedByTotalUniqueSubscriptions',
  'rankedByTotalPlaytime',
  'rankedByLifetimeAveragePlaytime',
];

/**
 * 注册 5 个需要 API Key 的工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {{ apiKeyEnv: string, maxListedApps: number, storeLanguage: string }} config - 生效配置。
 * @param {{ http: { json: Function }, getApiKey: Function, library: { read: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerWebApiTools(ctx, config, deps) {
  const { http, getApiKey, library } = deps;

  /**
   * 取当前有效的 Key，取不到就抛出完整指引。
   * @returns {Promise<string>} Key。
   */
  async function requireKey() {
    const key = await getApiKey();
    if (typeof key !== 'string' || key.trim() === '') throw new Error(apiKeyHelp(config.apiKeyEnv));
    return key.trim();
  }

  /**
   * 把 `steamId` 参数（或本机登录账号）解析成 SteamID64。
   * @param {unknown} input - 模型传入的 steamId，可为空。
   * @param {string} key - 当前 API Key。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<{ steamId64: string, note: string }>} 目标账号。
   */
  async function resolveTarget(input, key, signal) {
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '') {
      const scan = await library.read();
      const account = scan.accounts?.[0];
      if (!account) {
        throw new Error(
          '没有传 steamId，也读不到本机 Steam 的登录账号（config/loginusers.vdf）。请显式传 steamId：17 位 SteamID64、vanity 名，或 steamcommunity.com 的主页链接。',
        );
      }
      return { steamId64: account.steamId64, note: `（未指定 steamId，使用本机登录账号 ${account.personaName || account.steamId64}）` };
    }

    const normalized = normalizeSteamIdInput(text);
    if (normalized.kind === 'steamid64') return { steamId64: normalized.value, note: '' };
    if (normalized.kind === 'invalid') {
      throw new Error(`认不出这个 steamId：${text}。请给 17 位 SteamID64、vanity 名，或 steamcommunity.com 的主页链接。`);
    }

    const resolved = await getJson(http, resolveVanityUrl(key, normalized.value), signal);
    const mapped = mapResolveVanity(resolved);
    if (!mapped.ok) throw new Error(`vanity 名 "${normalized.value}" 解析不到账号（可能拼错，或该用户设置了自定义 URL 但账号已注销）。`);
    return { steamId64: mapped.steamId64, note: `（vanity ${normalized.value} → ${mapped.steamId64}）` };
  }

  ctx.tools.register(
    defineTool({
      name: 'steam_player',
      description:
        '查一个 Steam 账号的公开资料：显示名、在线状态、所在国家、账号创建时间、最近下线时间，以及当前在玩的游戏。需要 Steam Web API Key。不传 steamId 时用本机登录的账号。',
      parameters: {
        steamId: { type: 'string', description: '17 位 SteamID64、vanity 名，或 steamcommunity.com 主页链接；留空用本机登录账号。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const key = await requireKey();
        const target = await resolveTarget(args.steamId, key, exec.signal);
        const data = await getJson(http, playerSummariesUrl(key, [target.steamId64]), exec.signal);
        const { players } = mapPlayerSummaries(data);
        if (players.length === 0) {
          return { text: `steamid ${target.steamId64} 查不到公开资料：账号可能不存在，或隐私设置不公开。${target.note}` };
        }
        const player = players[0];
        const lines = [`${player.personaName || '(无显示名)'}（${player.steamId64}）${target.note}`];
        lines.push(`状态：${player.state}`);
        if (player.countryCode !== '') lines.push(`国家/地区：${player.countryCode}`);
        if (player.timeCreated > 0) lines.push(`账号创建：${new Date(player.timeCreated * 1000).toISOString().slice(0, 10)}`);
        if (player.lastLogoff > 0) lines.push(`最近下线：${new Date(player.lastLogoff * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`);
        lines.push(player.inGameName !== '' ? `正在玩：${player.inGameName}（appid ${player.inGameAppId ?? '未知'}）` : '正在玩：没有在游戏中');
        if (player.profileUrl !== '') lines.push(`主页：${player.profileUrl}`);
        return { text: lines.join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_owned_games',
      description:
        '列出账号拥有的 Steam 游戏及累计游玩时长，并标出哪些已经装在本机。需要 Steam Web API Key；调用者的「游戏详情」隐私设置必须是公开，否则只会返回私密提示。',
      parameters: {
        steamId: { type: 'string', description: 'SteamID64 / vanity / 主页链接；留空用本机登录账号。' },
        limit: { type: 'integer', description: `最多显示多少条，默认 50，上限 ${config.maxListedApps}。` },
        sort: { type: 'string', enum: ['playtime', 'name'], description: '排序：playtime（时长降序，默认）或 name（名称升序）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const key = await requireKey();
        const target = await resolveTarget(args.steamId, key, exec.signal);
        const data = await getJson(http, ownedGamesUrl(key, target.steamId64), exec.signal);
        const owned = mapOwnedGames(data);
        if (owned.private) {
          return {
            text: `拿不到 ${target.steamId64} 的游戏列表：该账号的「游戏详情」隐私设置不是公开，或者它确实一个游戏都没有。请在 Steam 的隐私设置里把「游戏详情」设为公开后重试。${target.note}`,
          };
        }

        const scan = await library.read();
        const installed = new Set(scan.detected ? scan.games.map((game) => game.appid) : []);
        const limit = clampLimit(args.limit, 50, config.maxListedApps);
        const sort = typeof args.sort === 'string' ? args.sort : 'playtime';
        const games = owned.games.slice();
        if (sort === 'name') games.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));

        const lines = games
          .slice(0, limit)
          .map((game) => {
            const marks = [];
            if (installed.has(game.appid)) marks.push('已装在本机');
            else marks.push('未装在本机');
            if (game.playtimeTwoWeeksMinutes > 0) marks.push(`近两周 ${formatMinutes(game.playtimeTwoWeeksMinutes)}`);
            return `${game.appid}  ${game.name || '(无名称)'} — 累计 ${formatMinutes(game.playtimeForeverMinutes)} — ${marks.join('，')}`;
          });
        const tail = games.length > limit ? `\n…… 共 ${owned.count} 个，只显示了前 ${limit} 个。` : '';
        return {
          text: `${target.steamId64} 拥有 ${owned.count} 个游戏${target.note}（按${sort === 'name' ? '名称' : '游玩时长'}排序）：\n${lines.join('\n')}${tail}`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_recent_games',
      description: '列出账号最近两周玩过的游戏及时长。需要 Steam Web API Key，且「游戏详情」隐私设置要公开。',
      parameters: {
        steamId: { type: 'string', description: 'SteamID64 / vanity / 主页链接；留空用本机登录账号。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const key = await requireKey();
        const target = await resolveTarget(args.steamId, key, exec.signal);
        const data = await getJson(http, recentlyPlayedUrl(key, target.steamId64), exec.signal);
        const recent = mapRecentlyPlayed(data);
        if (recent.private || recent.games.length === 0) {
          return { text: `${target.steamId64} 最近两周没有游玩记录（或「游戏详情」隐私设置不是公开）。${target.note}` };
        }
        const lines = recent.games.map(
          (game) => `${game.appid}  ${game.name} — 近两周 ${formatMinutes(game.playtimeTwoWeeksMinutes)} — 累计 ${formatMinutes(game.playtimeForeverMinutes)}`,
        );
        return { text: `${target.steamId64} 最近两周玩过 ${recent.games.length} 个游戏${target.note}：\n${lines.join('\n')}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_achievements',
      description: '查某个账号在一个游戏里的成就解锁情况。需要 Steam Web API Key。没有该游戏的统计时会明确说明原因。',
      parameters: {
        appid: { type: 'integer', required: true, description: 'Steam 应用 ID。' },
        steamId: { type: 'string', description: 'SteamID64 / vanity / 主页链接；留空用本机登录账号。' },
        limit: { type: 'integer', description: '最多列出多少条成就，默认 30，上限 200。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const key = await requireKey();
        const appid = Number.parseInt(String(args.appid ?? ''), 10);
        if (!Number.isFinite(appid) || appid <= 0) throw new Error('appid 必须是正整数。');
        const target = await resolveTarget(args.steamId, key, exec.signal);
        const data = await getJson(
          http,
          playerAchievementsUrl(key, target.steamId64, appid, config.storeLanguage),
          exec.signal,
        );
        const achievements = mapPlayerAchievements(data);
        if (!achievements.ok) {
          return { text: `${target.steamId64} 的 appid ${appid} 成就读不到：${achievements.reason}${target.note}` };
        }
        const limit = clampLimit(args.limit, 30, 200);
        const sorted = achievements.achievements.slice().sort((left, right) => Number(right.achieved) - Number(left.achieved));
        const lines = sorted
          .slice(0, limit)
          .map((entry) => `${entry.achieved ? '✓' : '✗'} ${entry.name || entry.apiName}${entry.description === '' ? '' : ` — ${entry.description}`}`);
        const tail = sorted.length > limit ? `\n…… 共 ${sorted.length} 个成就，只显示了前 ${limit} 个。` : '';
        return {
          text: `${achievements.gameName || `appid ${appid}`}：已解锁 ${achievements.achieved}/${achievements.total}${target.note}\n${lines.join('\n')}${tail}`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_workshop_search',
      description:
        '查询 Steam 创意工坊条目（可用于查某个 mod 的订阅数、更新时间等）。需要 Steam Web API Key。',
      parameters: {
        searchText: { type: 'string', description: '搜索词；留空则按排序浏览。' },
        appid: { type: 'integer', description: '限定某个游戏的创意工坊，例如 1158310（Crusader Kings III）。' },
        queryType: { type: 'string', enum: QUERY_TYPES, description: '排序方式，默认 rankedByVote（按评分）。' },
        limit: { type: 'integer', description: `最多显示多少条，默认 20，上限 ${config.maxListedApps}。` },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const key = await requireKey();
        const limit = clampLimit(args.limit, 20, config.maxListedApps);
        const appid = Number.parseInt(String(args.appid ?? ''), 10);
        const data = await getJson(
          http,
          queryFilesUrl(key, {
            appid: Number.isFinite(appid) ? appid : undefined,
            searchText: typeof args.searchText === 'string' ? args.searchText : undefined,
            queryType: typeof args.queryType === 'string' ? args.queryType : 'rankedByVote',
            numPerPage: limit,
          }),
          exec.signal,
        );
        const mapped = mapQueryFiles(data);
        if (mapped.items.length === 0) {
          return { text: '创意工坊没有匹配的条目。换个关键词或去掉 appid 限定再试。' };
        }
        const lines = mapped.items.map((item) => {
          const size = item.fileSize > 0 ? `${(item.fileSize / 1048576).toFixed(1)} MiB` : '大小未知';
          const updated = item.timeUpdated > 0 ? new Date(item.timeUpdated * 1000).toISOString().slice(0, 10) : '未知';
          return `工坊ID ${item.publishedFileId}  ${item.title} — appid ${item.appid ?? '未知'} — 订阅 ${item.subscriptions} / 收藏 ${item.favorited} / 浏览 ${item.views} — ${size} — 更新于 ${updated}${item.tags.length > 0 ? ` — 标签 ${item.tags.join('、')}` : ''}`;
        });
        return { text: `创意工坊共 ${mapped.total} 条匹配：\n${lines.join('\n')}` };
      },
    }),
  );

  return ['steam_player', 'steam_owned_games', 'steam_recent_games', 'steam_achievements', 'steam_workshop_search'];
}

/**
 * 取一个 JSON 端点，失败时抛出带建议的错误。
 * @param {{ json: Function }} http - 取数器。
 * @param {string} url - 完整 URL。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<any>} 解析后的 JSON。
 */
async function getJson(http, url, signal) {
  const result = await http.json(url, { signal });
  if (result.ok) return result.data;
  throw new Error([result.error, result.hint].filter(Boolean).join('；'));
}
