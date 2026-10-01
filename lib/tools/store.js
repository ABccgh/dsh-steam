/**
 * 公开商店与公共端点工具：商店搜索、App 详情、用户评测、在线人数 + 全球成就达成率。
 *
 * 全部走 `store.steampowered.com` / `api.steampowered.com` 的公开接口，**不需要 API Key**，
 * 也不需要在 Steam 客户端登录。
 *
 * @module dsh-steam/tools/store
 */

import {
  appDetailsUrl,
  currentPlayersUrl,
  globalAchievementsUrl,
  mapCurrentPlayers,
  mapGlobalAchievements,
  mapReviews,
  mapStoreSearch,
  pickAppDetails,
  reviewsUrl,
  storeSearchUrl,
} from '../store.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, alwaysSafe, clampLimit } from './shared.js';

/**
 * 注册 4 个公开数据工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {{ storeCountry: string, storeLanguage: string, maxListedApps: number }} config - 生效配置。
 * @param {{ http: { json: Function } }} deps - HTTP 取数器。
 * @returns {string[]} 已注册的工具名。
 */
export function registerStoreTools(ctx, config, deps) {
  const { http } = deps;
  const region = { country: config.storeCountry, language: config.storeLanguage };

  ctx.tools.register(
    defineTool({
      name: 'steam_search',
      description:
        '在 Steam 商店里按关键词搜索游戏/DLC。返回 appid、名称、价格与平台，用 appid 去调 steam_store_app 拿详情。不需要 API Key。',
      parameters: {
        term: { type: 'string', required: true, description: '搜索词，例如 "Crusader Kings"。' },
        limit: { type: 'integer', description: `最多显示多少条，默认 20，上限 ${config.maxListedApps}。` },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const term = String(args.term ?? '').trim();
        if (term === '') throw new Error('term 不能为空。');
        const limit = clampLimit(args.limit, 20, config.maxListedApps);
        const data = await getJson(http, storeSearchUrl(term, region), exec.signal);
        const mapped = mapStoreSearch(data);
        if (mapped.items.length === 0) return { text: `商店里没有搜到「${term}」。换个关键词试试。` };
        const lines = mapped.items
          .slice(0, limit)
          .map((item) => {
            const platforms = Object.entries(item.platforms)
              .filter(([, supported]) => supported === true)
              .map(([name]) => name)
              .join('/');
            return `${item.appid}  ${item.name} — ${formatPrice(item)}${platforms === '' ? '' : ` — ${platforms}`}${item.metascore === '' ? '' : ` — Metacritic ${item.metascore}`}`;
          });
        const tail = mapped.items.length > limit ? `\n…… 共 ${mapped.items.length} 条，只显示前 ${limit} 条。` : '';
        return { text: `商店搜索「${term}」命中 ${mapped.total} 条（本次显示 ${Math.min(mapped.items.length, limit)} 条）：\n${lines.join('\n')}${tail}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_store_app',
      description:
        '按 appid 查 Steam 商店详情：名称、类型、发行日期、是否免费、价格与折扣、开发商/发行商、平台、类型标签、Metacritic 分数、简介。不需要 API Key。',
      parameters: {
        appid: { type: 'integer', required: true, description: 'Steam 应用 ID，例如 431960。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const appid = requireAppId(args.appid);
        const data = await getJson(http, appDetailsUrl(appid, region), exec.signal);
        const picked = pickAppDetails(data, appid);
        if (!picked.found) return { text: `appid ${appid}：${picked.reason}` };
        return { text: renderStoreApp(picked.app) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_reviews',
      description:
        '读一个 appid 的 Steam 用户评测汇总：好评率、正面/负面数量、Steam 的评级描述，外加少量评测样本。不需要 API Key。',
      parameters: {
        appid: { type: 'integer', required: true, description: 'Steam 应用 ID。' },
        sampleLimit: { type: 'integer', description: '返回多少条评测样本，默认 5，上限 20。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const appid = requireAppId(args.appid);
        const sampleLimit = clampLimit(args.sampleLimit, 5, 20);
        const data = await getJson(http, reviewsUrl(appid), exec.signal);
        const mapped = mapReviews(data, { sampleLimit });
        if (!mapped.success || mapped.summary.total === 0) {
          return { text: `appid ${appid} 还没有可读的评测（可能是新上架、未发售，或该地区不售）。` };
        }
        const lines = [
          `评测：${mapped.summary.description || '无评级'} — 好评率 ${mapped.summary.positivePercent}%（正面 ${mapped.summary.positive} / 负面 ${mapped.summary.negative}，共 ${mapped.summary.total} 条）`,
        ];
        for (const sample of mapped.samples) {
          const verdict = sample.votedUp ? '推荐' : '不推荐';
          lines.push(`  [${verdict}｜游戏时长 ${Math.round(sample.playtimeMinutes / 60)} 小时] ${sample.text.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        return { text: lines.join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'steam_app_stats',
      description:
        '查一个游戏的公共统计：当前在线人数，以及全球成就达成率（从最难到最易）。不需要 API Key。',
      parameters: {
        appid: { type: 'integer', required: true, description: 'Steam 应用 ID。' },
        achievementLimit: { type: 'integer', description: '最多显示多少个成就，默认 15，上限 100。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const appid = requireAppId(args.appid);
        const achievementLimit = clampLimit(args.achievementLimit, 15, 100);

        const [players, achievements] = await Promise.all([
          getJson(http, currentPlayersUrl(appid), exec.signal, { optional: true }),
          getJson(http, globalAchievementsUrl(appid), exec.signal, { optional: true }),
        ]);

        const lines = [];
        const playerInfo = mapCurrentPlayers(players);
        lines.push(
          playerInfo.players === null
            ? `当前在线：读不到（该 appid 可能没有公开的玩家统计）`
            : `当前在线：${playerInfo.players.toLocaleString('en-US')} 人`,
        );

        const list = mapGlobalAchievements(achievements);
        if (list.length === 0) {
          lines.push('成就达成率：这个游戏没有公开的成就数据。');
        } else {
          lines.push(`成就达成率（共 ${list.length} 个，从最难到最易，显示前 ${Math.min(list.length, achievementLimit)} 个）：`);
          for (const entry of list.slice(0, achievementLimit)) {
            lines.push(`  ${entry.name} — ${entry.percent}%`);
          }
        }
        return { text: lines.join('\n') };
      },
    }),
  );

  return ['steam_search', 'steam_store_app', 'steam_reviews', 'steam_app_stats'];
}

/**
 * 取一个 JSON 端点，失败时抛出带建议的错误。
 * @param {{ json: Function }} http - 取数器。
 * @param {string} url - 完整 URL。
 * @param {AbortSignal} [signal] - 取消信号。
 * @param {{ optional?: boolean }} [options] - `optional` 为真时把失败降级成 `undefined`。
 * @returns {Promise<any>} 解析后的 JSON。
 */
async function getJson(http, url, signal, options = {}) {
  const result = await http.json(url, { signal });
  if (result.ok) return result.data;
  if (options.optional === true) return undefined;
  throw new Error([result.error, result.hint].filter(Boolean).join('；'));
}

/**
 * 校验并归一 appid。
 * @param {unknown} value - 模型传来的值。
 * @returns {number} 正整数 appid。
 */
function requireAppId(value) {
  const appid = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(appid) || appid <= 0) throw new Error('appid 必须是正整数，例如 431960。');
  return appid;
}

/**
 * 把商店价格渲染成人话。
 * @param {{ priceKnown: boolean, isFree: boolean, finalPrice: number|null, initialPrice: number|null, currency: string }} item
 *   商店条目。
 * @returns {string} 价格文本。
 */
function formatPrice(item) {
  if (!item.priceKnown) return '价格未知（本地区可能不售）';
  if (item.isFree) return '免费';
  if (item.finalPrice === null) return '价格未知';
  const final = formatMoney(item.finalPrice, item.currency);
  if (item.initialPrice !== null && item.initialPrice > item.finalPrice) {
    return `${final}（原价 ${formatMoney(item.initialPrice, item.currency)}）`;
  }
  return final;
}

/**
 * 商店接口的价格以「分」为单位。
 * @param {number} cents - 分值。
 * @param {string} currency - 币种。
 * @returns {string} 文本。
 */
function formatMoney(cents, currency) {
  const amount = (cents / 100).toFixed(2);
  if (currency === 'CNY') return `¥${amount}`;
  if (currency === 'USD') return `$${amount}`;
  return `${amount} ${currency}`;
}

/**
 * 渲染商店详情。
 * @param {any} app - `mapAppData` 的结果。
 * @returns {string} 文本。
 */
function renderStoreApp(app) {
  const lines = [`${app.name}（appid ${app.appid ?? '未知'}）`];
  lines.push(`类型：${app.type || '未知'}${app.isFree ? '（免费）' : ''}`);
  lines.push(`发行日期：${app.comingSoon ? `${app.releaseDate || '未公布'}（尚未发售）` : app.releaseDate || '未知'}`);
  if (!app.isFree) {
    lines.push(
      app.price === null
        ? '价格：本地区没有单独列出价格'
        : `价格：${app.price.finalFormatted || formatMoney(app.price.final ?? 0, app.price.currency)}${app.price.discountPercent > 0 ? `（-${app.price.discountPercent}%）` : ''}`,
    );
  }
  if (app.developers.length > 0) lines.push(`开发商：${app.developers.join('、')}`);
  if (app.publishers.length > 0) lines.push(`发行商：${app.publishers.join('、')}`);
  const platforms = Object.entries(app.platforms)
    .filter(([, supported]) => supported === true)
    .map(([name]) => name);
  if (platforms.length > 0) lines.push(`平台：${platforms.join('、')}`);
  if (app.genres.length > 0) lines.push(`类型标签：${app.genres.join('、')}`);
  if (app.categories.length > 0) lines.push(`功能：${app.categories.join('、')}`);
  if (app.metacritic !== null) lines.push(`Metacritic：${app.metacritic}`);
  if (app.shortDescription !== '') lines.push(`简介：${app.shortDescription.replace(/<[^>]+>/g, '')}`);
  return lines.join('\n');
}
