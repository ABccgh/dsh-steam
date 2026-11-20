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
 * 评测排序：工具参数 → `GetAppReviews` 的 `filter` 枚举。
 *
 * 0 = helpfulness（Steam 默认），1 = 最新，2 = 最近更新，3 = 最搞笑。
 */
export const REVIEW_FILTERS = new Map([
  ['helpful', 0],
  ['recent', 1],
  ['updated', 2],
  ['funny', 3],
]);

/** 评测情感：工具参数 → `review_type` 枚举。 */
export const REVIEW_TYPES = new Map([
  ['all', 0],
  ['positive', 1],
  ['negative', 2],
]);

/**
 * 用户评测的 URL（`IUserReviewsService/GetAppReviews`）。
 *
 * Valve 于 **2026-10-22** 停用了 `store.steampowered.com/appreviews/<appid>?json=1`：
 * 旧地址现在一律 302 回商店首页，跟随重定向只能拿到 HTML。新接口在 `api.steampowered.com`
 * 上，参数集中在 `input_json` 里，字符串排序/筛选值改成了数字枚举。
 *
 * 匿名调用不需要 Key（Steam 会缓存约 10 分钟，配额比带 Key 的调用低）；
 * `day_range: 0` 表示不限制时间窗，保证汇总拿到的是全时段数字。
 *
 * @param {number} appid - 应用 ID。
 * @param {{ numPerPage?: number, languages?: string[], displayLanguage?: string,
 *   filter?: string, reviewType?: string, cursor?: string }} [options] - 分页与过滤。
 * @returns {string} 完整 URL。
 */
export function reviewsUrl(appid, options = {}) {
  const input = {
    appid,
    num_per_page: options.numPerPage ?? 5,
    // 接口要的是数组；空数组会被 Steam 当成缺省（英语），所以至少给 all。
    languages: Array.isArray(options.languages) && options.languages.length > 0 ? options.languages : ['all'],
    display_language: options.displayLanguage ?? 'schinese',
    filter: REVIEW_FILTERS.get(options.filter ?? 'helpful') ?? 0,
    day_range: 0,
  };
  if (typeof options.cursor === 'string' && options.cursor !== '') input.cursor = options.cursor;
  if (typeof options.reviewType === 'string') {
    input.review_type = REVIEW_TYPES.get(options.reviewType) ?? 0;
  }
  const url = new URL('/IUserReviewsService/GetAppReviews/v1/', API_ORIGIN);
  url.searchParams.set('input_json', JSON.stringify(input));
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
        // 实测：price 是一个 { currency, initial, final } 对象；当该条目没有价格时
        // price 字段整个缺失（而不是 0）。**免费游戏与 Demo 也不返回 price**，
        // 所以「没有 price」只能说明「接口没给价格」，不能断言本地区不售，也不能据此
        // 认定它免费——渲染层必须写成「无价（免费或本区不售）」。
        const price = item.price && typeof item.price === 'object' ? item.price : null;
        return {
          appid: Number.parseInt(String(item.id ?? ''), 10) || null,
          name: typeof item.name === 'string' ? item.name : '',
          type: typeof item.type === 'string' ? item.type : '',
          // priceKnown:false 表示接口没给价格（免费 / Demo / 本区不售都可能）。
          priceKnown: price !== null,
          // isFree 只在「接口明确给了 final=0」时为真；免费游戏在 storesearch 里
          // 根本不会带 price，因此这里为 false 不代表它是收费游戏。
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
    // `is_free` 是 appdetails 对免费应用的明确标注（免费游戏通常没有 price_overview）。
    // 少数响应不带 is_free，但 price_overview.final=0 同样表示免费，兜住这种形状。
    isFree: data.is_free === true || (price !== null && price.final === 0),
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
 * 整理用户评测响应（`IUserReviewsService/GetAppReviews`）。
 *
 * 与旧商店端点相比有几处必须处理的差异：
 * - 成功响应**没有** `success` 字段，失败（无效/下架 appid）返回的是 `{"response":{}}`，
 *   所以「有没有数据」只能看 `response` 是否为空；
 * - 汇总只在「全部情感、第一页」时才有 `query_summary`（按 positive/negative 过滤时不返回），
 *   这时不能瞎算好评率；
 * - `weighted_vote_score` 是数字而不是字符串，`refunded` 与 `primarily_steam_deck` 是新字段。
 *
 * @param {unknown} payload - 原始 JSON。
 * @param {{ sampleLimit?: number }} [options] - 返回多少条评测样本。
 * @returns {{ available: boolean, summary: object | null, samples: Array<object>, cursor: string }}
 *   结果；`available:false` 表示响应里没有任何评测数据。
 */
export function mapReviews(payload, options = {}) {
  const response = payload && typeof payload === 'object' ? /** @type {any} */ (payload).response : undefined;
  if (!response || typeof response !== 'object' || Object.keys(response).length === 0) {
    return { available: false, summary: null, samples: [], cursor: '' };
  }

  const block = response.query_summary && typeof response.query_summary === 'object' ? response.query_summary : null;
  const positive = block && Number.isFinite(block.total_positive) ? block.total_positive : 0;
  const negative = block && Number.isFinite(block.total_negative) ? block.total_negative : 0;
  const total = block && Number.isFinite(block.total_reviews) ? block.total_reviews : positive + negative;
  const summary = block === null
    ? null
    : {
        total,
        positive,
        negative,
        score: Number.isFinite(block.review_score) ? block.review_score : null,
        description: typeof block.review_score_desc === 'string' ? block.review_score_desc : '',
        positivePercent: total > 0 ? Math.round((positive / total) * 1000) / 10 : null,
      };

  const samples = (Array.isArray(response.reviews) ? response.reviews : [])
    .filter((review) => review && typeof review === 'object')
    .slice(0, options.sampleLimit ?? 5)
    .map((review) => {
      const author = review.author && typeof review.author === 'object' ? review.author : {};
      const playtime = Number.isFinite(author.playtime_at_review)
        ? author.playtime_at_review
        : Number.isFinite(author.playtime_forever)
          ? author.playtime_forever
          : 0;
      const rawText = typeof review.review === 'string' ? review.review : '';
      return {
        votedUp: review.voted_up === true,
        // 工具输出还会再截一次；两者都要能被渲染层标成「已截断」，不能悄悄丢内容。
        text: rawText.slice(0, 400),
        textTruncated: rawText.length > 400,
        language: typeof review.language === 'string' ? review.language : '',
        playtimeMinutes: playtime,
        votesUp: Number.isFinite(review.votes_up) ? review.votes_up : 0,
        createdAt: Number.isFinite(review.timestamp_created) ? review.timestamp_created : 0,
        refunded: review.refunded === true,
        steamDeck: review.primarily_steam_deck === true,
      };
    });

  return {
    available: true,
    summary,
    samples,
    cursor: typeof response.cursor === 'string' ? response.cursor : '',
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
    reviews(appid, options = {}, signal) {
      return http.json(reviewsUrl(appid, { displayLanguage: language, ...options }), { signal });
    },
    currentPlayers(appid, signal) {
      return http.json(currentPlayersUrl(appid), { signal });
    },
    globalAchievements(appid, signal) {
      return http.json(globalAchievementsUrl(appid), { signal });
    },
  };
}
