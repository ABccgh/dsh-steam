/**
 * 官方 Steam Web API（`api.steampowered.com`）里需要 API Key 的那部分：
 * 玩家资料、拥有游戏、最近游玩、成就、创意工坊查询。
 *
 * 与 `store.js` 一样，URL 构造与响应映射都是纯函数；网络调用集中在 `createWebApiClient`。
 * Steam 的隐私设置会让「请求成功但内容为空」，这里的映射会把这种情况显式标成
 * `empty`/`private`，而不是当成「这个人没有游戏」。
 *
 * @module dsh-steam/webapi
 */

import { toNumber, toNumberOr } from './numbers.js';

export const WEB_API_ORIGIN = 'https://api.steampowered.com';

/** personaState 到可读状态的映射。 */
export const PERSONA_STATES = new Map([
  [0, '离线'],
  [1, '在线'],
  [2, '忙碌'],
  [3, '离开'],
  [4, '打盹'],
  [5, '想交易'],
  [6, '想玩游戏'],
]);

/** IPublishedFileService/QueryFiles 的 query_type 取值。 */
export const WORKSHOP_QUERY_TYPES = new Map([
  ['rankedByVote', 0],
  ['rankedByPublicationDate', 1],
  ['acceptedForGameRankedByAcceptanceDate', 2],
  ['rankedByTrend', 3],
  ['favoritedByFriendsRankedByPublicationDate', 4],
  ['createdByFriendsRankedByPublicationDate', 5],
  ['rankedByNumTimesReported', 6],
  ['createdByFollowedUsersRankedByPublicationDate', 7],
  ['notYetRated', 8],
  ['rankedByTotalUniqueSubscriptions', 9],
  ['rankedByPlaytimeTrend', 10],
  ['rankedByTotalPlaytime', 11],
  ['rankedByAveragePlaytimeTrend', 12],
  ['rankedByLifetimeAveragePlaytime', 13],
  ['rankedByPlaytimeSessionsTrend', 14],
  ['rankedByLifetimePlaytimeSessions', 15],
  ['rankedByInappropriateContentRating', 16],
]);

/**
 * 判断字符串是不是 SteamID64（17 位纯数字）。
 * @param {string} value - 待判断的字符串。
 * @returns {boolean} 是否是 SteamID64。
 */
export function looksLikeSteamId64(value) {
  return /^\d{17}$/.test(value);
}

/**
 * 把用户给出的 SteamID64 / vanity / 主页链接归一成可查询的目标。
 * @param {string} input - 用户输入。
 * @returns {{ kind: 'steamid64' | 'vanity' | 'invalid', value: string }} 归一结果。
 */
export function normalizeSteamIdInput(input) {
  const text = String(input ?? '').trim();
  if (text === '') return { kind: 'invalid', value: '' };
  if (looksLikeSteamId64(text)) return { kind: 'steamid64', value: text };

  const profileMatch = /^https?:\/\/steamcommunity\.com\/(profiles|id)\/([^/?#]+)/i.exec(text);
  if (profileMatch) {
    const [, kind, segment] = profileMatch;
    if (kind.toLowerCase() === 'profiles' && looksLikeSteamId64(segment)) return { kind: 'steamid64', value: segment };
    return /^[A-Za-z0-9_-]{2,64}$/.test(segment) ? { kind: 'vanity', value: segment } : { kind: 'invalid', value: text };
  }

  if (/^[A-Za-z0-9_-]{2,64}$/.test(text)) return { kind: 'vanity', value: text };
  return { kind: 'invalid', value: text };
}

/**
 * GetPlayerSummaries 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {string[]} steamIds - SteamID64 列表（最多 100 个）。
 * @returns {string} 完整 URL。
 */
export function playerSummariesUrl(apiKey, steamIds) {
  const url = new URL('/ISteamUser/GetPlayerSummaries/v2/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamids', steamIds.join(','));
  return url.href;
}

/**
 * ResolveVanityURL 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {string} vanity - vanity 名。
 * @returns {string} 完整 URL。
 */
export function resolveVanityUrl(apiKey, vanity) {
  const url = new URL('/ISteamUser/ResolveVanityURL/v1/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('vanityurl', vanity);
  return url.href;
}

/**
 * GetOwnedGames 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {string} steamId - SteamID64。
 * @param {{ includeAppInfo?: boolean, includePlayedFreeGames?: boolean }} [options] - 附加开关。
 * @returns {string} 完整 URL。
 */
export function ownedGamesUrl(apiKey, steamId, options = {}) {
  const url = new URL('/IPlayerService/GetOwnedGames/v1/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', options.includeAppInfo === false ? '0' : '1');
  url.searchParams.set('include_played_free_games', options.includePlayedFreeGames === false ? '0' : '1');
  return url.href;
}

/**
 * GetRecentlyPlayedGames 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {string} steamId - SteamID64。
 * @param {number} [count] - 取多少条（0 表示由 Steam 决定）。
 * @returns {string} 完整 URL。
 */
export function recentlyPlayedUrl(apiKey, steamId, count = 0) {
  const url = new URL('/IPlayerService/GetRecentlyPlayedGames/v1/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId);
  if (count > 0) url.searchParams.set('count', String(count));
  return url.href;
}

/**
 * GetPlayerAchievements 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {string} steamId - SteamID64。
 * @param {number} appid - 应用 ID。
 * @param {string} [language] - 成就文案语言。
 * @returns {string} 完整 URL。
 */
export function playerAchievementsUrl(apiKey, steamId, appid, language = 'schinese') {
  const url = new URL('/ISteamUserStats/GetPlayerAchievements/v1/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('appid', String(appid));
  url.searchParams.set('l', language);
  return url.href;
}

/**
 * IPublishedFileService/QueryFiles 的 URL。
 * @param {string} apiKey - Web API Key。
 * @param {{ appid?: number, searchText?: string, numPerPage?: number, page?: number,
 *   queryType?: string, fileType?: number }} [options] - 查询条件。
 * @returns {string} 完整 URL。
 */
export function queryFilesUrl(apiKey, options = {}) {
  const url = new URL('/IPublishedFileService/QueryFiles/v1/', WEB_API_ORIGIN);
  url.searchParams.set('key', apiKey);
  const queryType = WORKSHOP_QUERY_TYPES.get(options.queryType ?? 'rankedByVote');
  url.searchParams.set('query_type', String(queryType ?? 0));
  url.searchParams.set('page', String(options.page ?? 1));
  url.searchParams.set('numperpage', String(options.numPerPage ?? 20));
  if (Number.isFinite(options.fileType)) url.searchParams.set('filetype', String(options.fileType));
  if (Number.isFinite(options.appid)) url.searchParams.set('appid', String(options.appid));
  if (typeof options.searchText === 'string' && options.searchText.trim() !== '') {
    url.searchParams.set('search_text', options.searchText.trim());
    url.searchParams.set('return_short_description', '1');
  }
  url.searchParams.set('return_tags', '1');
  url.searchParams.set('return_vote_data', '1');
  return url.href;
}

/**
 * 整理 GetPlayerSummaries 响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ players: Array<object> }} 玩家列表。
 */
export function mapPlayerSummaries(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  const players = response && Array.isArray(response.players) ? response.players : [];
  return {
    players: players
      .filter((player) => player && typeof player === 'object')
      .map((player) => ({
        steamId64: String(player.steamid ?? ''),
        personaName: String(player.personaname ?? ''),
        profileUrl: String(player.profileurl ?? ''),
        state: PERSONA_STATES.get(player.personastate) ?? `未知(${String(player.personastate ?? '')})`,
        visibility: Number.isFinite(player.communityvisibilitystate) ? player.communityvisibilitystate : null,
        lastLogoff: Number.isFinite(player.lastlogoff) ? player.lastlogoff : 0,
        timeCreated: Number.isFinite(player.timecreated) ? player.timecreated : 0,
        countryCode: typeof player.loccountrycode === 'string' ? player.loccountrycode : '',
        inGameName: typeof player.gameextrainfo === 'string' ? player.gameextrainfo : '',
        // gameid 在 Steam 的响应里是字符串，不能直接用 Number.isFinite 判。
        inGameAppId: Number.parseInt(String(player.gameid ?? ''), 10) || null,
      })),
  };
}

/**
 * 整理 GetOwnedGames 响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ count: number, games: Array<object>, private: boolean }} 结果。
 */
export function mapOwnedGames(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  if (!response || typeof response !== 'object') return { count: 0, games: [], private: true };
  const games = Array.isArray(response.games) ? response.games : [];
  if (games.length === 0) return { count: 0, games: [], private: true };
  return {
    count: Number.isFinite(response.game_count) ? response.game_count : games.length,
    private: false,
    games: games
      .filter((game) => game && typeof game === 'object')
      .map((game) => ({
        appid: Number.parseInt(String(game.appid ?? ''), 10) || null,
        name: String(game.name ?? ''),
        playtimeForeverMinutes: Number.isFinite(game.playtime_forever) ? game.playtime_forever : 0,
        playtimeTwoWeeksMinutes: Number.isFinite(game.playtime_2weeks) ? game.playtime_2weeks : 0,
        lastPlayed: Number.isFinite(game.rtime_last_played) ? game.rtime_last_played : 0,
      }))
      .sort((left, right) => right.playtimeForeverMinutes - left.playtimeForeverMinutes),
  };
}

/**
 * 整理 GetRecentlyPlayedGames 响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ total: number, games: Array<object>, private: boolean }} 结果。
 */
export function mapRecentlyPlayed(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  if (!response || typeof response !== 'object') return { total: 0, games: [], private: true };
  const games = Array.isArray(response.games) ? response.games : [];
  return {
    total: Number.isFinite(response.total_count) ? response.total_count : games.length,
    private: games.length === 0,
    games: games
      .filter((game) => game && typeof game === 'object')
      .map((game) => ({
        appid: Number.parseInt(String(game.appid ?? ''), 10) || null,
        name: String(game.name ?? ''),
        playtimeTwoWeeksMinutes: Number.isFinite(game.playtime_2weeks) ? game.playtime_2weeks : 0,
        playtimeForeverMinutes: Number.isFinite(game.playtime_forever) ? game.playtime_forever : 0,
      })),
  };
}

/**
 * 整理 GetPlayerAchievements 响应。Steam 会在「没有统计」时也返回 200，
 * 此时 `playerstats.success === false`，必须区分出来。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ ok: boolean, reason?: string, gameName: string, achieved: number, total: number,
 *   achievements: Array<object> }} 结果。
 */
export function mapPlayerAchievements(payload) {
  const stats = payload && typeof payload === 'object' ? /** @type {any} */ (payload).playerstats : undefined;
  if (!stats || typeof stats !== 'object') return { ok: false, reason: '响应里没有 playerstats', gameName: '', achieved: 0, total: 0, achievements: [] };
  if (stats.success === false) {
    return {
      ok: false,
      reason: typeof stats.error === 'string' ? stats.error : '该玩家在这个游戏里没有可读的成就数据（未玩过、无成就，或资料未公开）',
      gameName: String(stats.gameName ?? ''),
      achieved: 0,
      total: 0,
      achievements: [],
    };
  }
  const achievements = (Array.isArray(stats.achievements) ? stats.achievements : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      apiName: String(entry.apiname ?? ''),
      achieved: entry.achieved === 1,
      unlockTime: Number.isFinite(entry.unlocktime) ? entry.unlocktime : 0,
      name: String(entry.name ?? ''),
      description: String(entry.description ?? ''),
    }));
  return {
    ok: true,
    gameName: String(stats.gameName ?? ''),
    achieved: achievements.filter((entry) => entry.achieved).length,
    total: achievements.length,
    achievements,
  };
}

/**
 * 整理 ResolveVanityURL 响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ ok: boolean, steamId64?: string }} 结果。
 */
export function mapResolveVanity(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  if (!response || typeof response !== 'object') return { ok: false };
  if (response.success !== 1 || typeof response.steamid !== 'string' || !looksLikeSteamId64(response.steamid)) return { ok: false };
  return { ok: true, steamId64: response.steamid };
}

/**
 * 整理 IPublishedFileService/QueryFiles 响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ total: number, items: Array<object> }} 结果。
 */
export function mapQueryFiles(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  const details = response && Array.isArray(response.publishedfiledetails) ? response.publishedfiledetails : [];
  return {
    total: response && Number.isFinite(response.total) ? response.total : details.length,
    items: details
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        publishedFileId: String(item.publishedfileid ?? ''),
        title: String(item.title ?? ''),
        appid: toNumber(item.consumer_app_id),
        // file_size 是 uint64，protobuf-JSON 会把它序列化成字符串。
        fileSize: toNumberOr(item.file_size, 0),
        subscriptions: toNumberOr(item.subscriptions, 0),
        favorited: toNumberOr(item.favorited, 0),
        views: toNumberOr(item.views, 0),
        timeUpdated: toNumberOr(item.time_updated, 0),
        tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => String(tag?.tag ?? '')).filter(Boolean),
        shortDescription: typeof item.short_description === 'string' ? item.short_description : '',
      })),
  };
}
