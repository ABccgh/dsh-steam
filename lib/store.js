/**
 * 公开的 Steam 商店 / 公共端点：商店搜索、App 详情、评测、当前在线人数、全球成就达成率。
 *
 * 这一组**不需要 API Key**。URL 构造与响应映射都是纯函数，便于用录好的 JSON 做单测；
 * 真正发请求的部分只有 `createStoreClient`。
 *
 * @module dsh-steam/store
 */

import { toNumber } from './numbers.js';

export const STORE_ORIGIN = 'https://store.steampowered.com';
export const API_ORIGIN = 'https://api.steampowered.com';

/**
 * 商店搜索的 URL。
 * @param {string} term - 搜索词。
 * @param {{ country?: string, language?: string }} [options] - 地区与语言。
 * @returns {string} 完整 URL。
 */
export function storeSearchUrl(term, options = {}) {
  const url = new URL('/api/storesearch/', STORE_ORIGIN);
  url.searchParams.set('term', term);
  url.searchParams.set('cc', options.country ?? 'cn');
  url.searchParams.set('l', options.language ?? 'schinese');
  return url.href;
}

/**
 * App 详情的 URL。
 * @param {number} appid - 应用 ID。
 * @param {{ country?: string, language?: string }} [options] - 地区与语言。
 * @returns {string} 完整 URL。
 */
export function appDetailsUrl(appid, options = {}) {
  const url = new URL('/api/appdetails', STORE_ORIGIN);
  url.searchParams.set('appids', String(appid));
  url.searchParams.set('cc', options.country ?? 'cn');
  url.searchParams.set('l', options.language ?? 'schinese');
  return url.href;
}

/**
 * 用户评测的 URL。
 * @param {number} appid - 应用 ID。
 * @param {{ language?: string, numPerPage?: number, purchaseType?: string }} [options] - 分页与过滤。
 * @returns {string} 完整 URL。
 */
export function reviewsUrl(appid, options = {}) {
  const url = new URL(`/appreviews/${appid}`, STORE_ORIGIN);
  url.searchParams.set('json', '1');
  url.searchParams.set('num_per_page', String(options.numPerPage ?? 20));
  url.searchParams.set('language', options.language ?? 'all');
  url.searchParams.set('purchase_type', options.purchaseType ?? 'all');
  url.searchParams.set('filter', 'summary');
  return url.href;
}

/**
 * 当前在线人数的 URL（无 Key）。
 * @param {number} appid - 应用 ID。
 * @returns {string} 完整 URL。
 */
export function currentPlayersUrl(appid) {
  const url = new URL('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', API_ORIGIN);
  url.searchParams.set('appid', String(appid));
  return url.href;
}

/**
 * 全球成就达成率的 URL（无 Key）。
 * @param {number} appid - 应用 ID。
 * @returns {string} 完整 URL。
 */
export function globalAchievementsUrl(appid) {
  const url = new URL('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', API_ORIGIN);
  url.searchParams.set('gameid', String(appid));
  return url.href;
}

/**
 * 把商店搜索响应整理成稳定的形状。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ total: number, items: Array<object> }} 整理后的结果。
 */
export function mapStoreSearch(payload) {
  const data = payload && typeof payload === 'object' ? /** @type {any} */ (payload) : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    total: Number.isFinite(data.total) ? data.total : items.length,
    items: items
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        // 实测：price 是一个 { currency, initial, final } 对象；当该条目在本次查询的
        // 地区里没有价格时，price 字段整个缺失（而不是 0）。这两种情况必须分开表达。
        const price = item.price && typeof item.price === 'object' ? item.price : null;
        return {
          appid: Number.parseInt(String(item.id ?? ''), 10) || null,
          name: typeof item.name === 'string' ? item.name : '',
          type: typeof item.type === 'string' ? item.type : '',
          priceKnown: price !== null,
          isFree: price !== null && price.final === 0,
          finalPrice: price !== null && Number.isFinite(price.final) ? price.final : null,
          initialPrice: price !== null && Number.isFinite(price.initial) ? price.initial : null,
          currency: price !== null && typeof price.currency === 'string' ? price.currency : '',
          metascore: typeof item.metascore === 'string' ? item.metascore : '',
          platforms: item.platforms && typeof item.platforms === 'object' ? item.platforms : {},
        };
      }),
  };
}

/**
 * 从 appdetails 的响应里取出目标 appid 的条目。
 * Steam 有时返回对象、有时返回单元素数组，两种都要认。
 * @param {unknown} payload - 原始 JSON。
 * @param {number} appid - 应用 ID。
 * @returns {{ found: boolean, reason?: string, app?: object }} 结果。
 */
export function pickAppDetails(payload, appid) {
  /** @type {any} */
  let entry;
  if (Array.isArray(payload)) entry = payload[0];
  else if (payload && typeof payload === 'object') {
    entry = /** @type {any} */ (payload)[String(appid)] ?? /** @type {any} */ (payload).data;
  }
  if (!entry || typeof entry !== 'object') return { found: false, reason: '响应里没有这个 appid 的条目' };
  if (entry.success !== true || !entry.data || typeof entry.data !== 'object') {
    return { found: false, reason: 'Steam 没有返回该应用的详情（地区锁定、已下架或 appid 不对）' };
  }
  return { found: true, app: mapAppData(entry.data) };
}

/**
 * 从 appdetails 的 `data` 里挑出常用字段。
 * @param {any} data - 原始 `data` 对象。
 * @returns {object} 稳定的字段集。
 */
export function mapAppData(data) {
  const price = data.price_overview && typeof data.price_overview === 'object' ? data.price_overview : null;
  /**
   * 从 `{ description }` 列表里取值，去重并保持原顺序——Steam 会重复返回同名条目
   * （例如 Wallpaper Engine 的 "Steam 创意工坊" 出现两次）。
   * @param {unknown} list - 原始列表。
   * @param {number} limit - 最多保留多少项。
   * @returns {string[]} 去重后的标签。
   */
  const labels = (list, limit) => {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    for (const entry of list) {
      const text = String(entry?.description ?? '').trim();
      if (text !== '') seen.add(text);
    }
    return [...seen].slice(0, limit);
  };
  return {
    appid: Number.isFinite(data.steam_appid) ? data.steam_appid : null,
    name: typeof data.name === 'string' ? data.name : '',
    type: typeof data.type === 'string' ? data.type : '',
    isFree: data.is_free === true,
    developers: Array.isArray(data.developers) ? data.developers : [],
    publishers: Array.isArray(data.publishers) ? data.publishers : [],
    releaseDate: data.release_date && typeof data.release_date === 'object' ? String(data.release_date.date ?? '') : '',
    comingSoon: data.release_date && typeof data.release_date === 'object' ? data.release_date.coming_soon === true : false,
    shortDescription: typeof data.short_description === 'string' ? data.short_description : '',
    genres: labels(data.genres, 20),
    categories: labels(data.categories, 12),
    platforms: data.platforms && typeof data.platforms === 'object' ? data.platforms : {},
    metacritic: data.metacritic && Number.isFinite(data.metacritic.score) ? data.metacritic.score : null,
    price: price === null ? null : {
      currency: String(price.currency ?? ''),
      initial: Number.isFinite(price.initial) ? price.initial : null,
      final: Number.isFinite(price.final) ? price.final : null,
      finalFormatted: String(price.final_formatted ?? ''),
      initialFormatted: String(price.initial_formatted ?? ''),
      discountPercent: Number.isFinite(price.discount_percent) ? price.discount_percent : 0,
    },
  };
}

/**
 * 整理用户评测响应。
 * @param {unknown} payload - 原始 JSON。
 * @param {{ sampleLimit?: number }} [options] - 返回多少条评测样本。
 * @returns {object} 汇总 + 样本。
 */
export function mapReviews(payload, options = {}) {
  const data = payload && typeof payload === 'object' ? /** @type {any} */ (payload) : {};
  const summary = data.query_summary && typeof data.query_summary === 'object' ? data.query_summary : {};
  const positive = Number.isFinite(summary.total_positive) ? summary.total_positive : 0;
  const negative = Number.isFinite(summary.total_negative) ? summary.total_negative : 0;
  const total = Number.isFinite(summary.total_reviews) ? summary.total_reviews : positive + negative;
  const samples = (Array.isArray(data.reviews) ? data.reviews : [])
    .filter((review) => review && typeof review === 'object')
    .slice(0, options.sampleLimit ?? 5)
    .map((review) => ({
      votedUp: review.voted_up === true,
      text: typeof review.review === 'string' ? review.review.slice(0, 400) : '',
      playtimeMinutes: Number.isFinite(review.author?.playtime_forever) ? review.author.playtime_forever : 0,
      votesUp: Number.isFinite(review.votes_up) ? review.votes_up : 0,
      createdAt: Number.isFinite(review.timestamp_created) ? review.timestamp_created : 0,
    }));
  return {
    success: data.success === 1 || data.success === true,
    summary: {
      total,
      positive,
      negative,
      score: Number.isFinite(summary.review_score) ? summary.review_score : null,
      description: typeof summary.review_score_desc === 'string' ? summary.review_score_desc : '',
      positivePercent: total > 0 ? Math.round((positive / total) * 1000) / 10 : null,
    },
    samples,
  };
}

/**
 * 整理当前在线人数响应。
 * @param {unknown} payload - 原始 JSON。
 * @returns {{ result: number, players: number | null }} 结果码与人数。
 */
export function mapCurrentPlayers(payload) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  if (!response || typeof response !== 'object') return { result: 0, players: null };
  return {
    result: Number.isFinite(response.result) ? response.result : 0,
    players: Number.isFinite(response.player_count) ? response.player_count : null,
  };
}

/**
 * 整理全球成就达成率，并按从难到易排序。
 * v2 的 `percent` 是**字符串**（`"61.1"`），v1 还把数组多包了一层
 * `achievements.achievement`，两种形状都要认。
 * @param {unknown} payload - 原始 JSON。
 * @returns {Array<{ name: string, percent: number }>} 成就列表（percent 升序，先难后易）。
 */
export function mapGlobalAchievements(payload) {
  const block = payload && typeof payload === 'object' ? /** @type {any} */ (payload).achievementpercentages : undefined;
  const raw = block?.achievements;
  const achievements = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.achievement)
      ? raw.achievement
      : [];
  const mapped = [];
  for (const entry of achievements) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue;
    const percent = toNumber(entry.percent);
    if (percent === null) continue;
    mapped.push({ name: entry.name, percent });
  }
  return mapped.sort((left, right) => left.percent - right.percent);
}

/**
 * 造一个商店端点客户端。
 * @param {{ http: { json: Function }, country?: string, language?: string }} options - 取数器与地区设置。
 * @returns {object} 带高层方法客户端。
 */
export function createStoreClient(options) {
  const { http } = options;
  const country = options.country ?? 'cn';
  const language = options.language ?? 'schinese';
  return {
    search(term, signal) {
      return http.json(storeSearchUrl(term, { country, language }), { signal });
    },
    appDetails(appid, signal) {
      return http.json(appDetailsUrl(appid, { country, language }), { signal });
    },
    reviews(appid, signal) {
      return http.json(reviewsUrl(appid, { language: 'all' }), { signal });
    },
    currentPlayers(appid, signal) {
      return http.json(currentPlayersUrl(appid), { signal });
    },
    globalAchievements(appid, signal) {
      return http.json(globalAchievementsUrl(appid), { signal });
    },
  };
}
