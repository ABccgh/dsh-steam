import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient, explainHttpStatus } from '../lib/http.js';
import {
  appDetailsUrl,
  createStoreClient,
  currentPlayersUrl,
  globalAchievementsUrl,
  mapCurrentPlayers,
  mapGlobalAchievements,
  mapReviews,
  mapStoreSearch,
  pickAppDetails,
  reviewsUrl,
  storeSearchUrl,
} from '../lib/store.js';
import { registerStoreTools } from '../lib/tools/store.js';

/** 需要真实网络时才跑的用例，默认跳过：`DSH_STEAM_LIVE=1 node --test`。 */
const LIVE = process.env.DSH_STEAM_LIVE === '1';

test('URL 构造带上地区与语言参数', () => {
  const search = new URL(storeSearchUrl('Crusader Kings', { country: 'cn', language: 'schinese' }));
  assert.equal(search.origin, 'https://store.steampowered.com');
  assert.equal(search.pathname, '/api/storesearch/');
  assert.equal(search.searchParams.get('term'), 'Crusader Kings');
  assert.equal(search.searchParams.get('cc'), 'cn');
  assert.equal(search.searchParams.get('l'), 'schinese');

  const details = new URL(appDetailsUrl(431960, {}));
  assert.equal(details.searchParams.get('appids'), '431960');
  assert.equal(details.searchParams.get('cc'), 'cn');

  const reviews = new URL(reviewsUrl(431960, { numPerPage: 5 }));
  assert.equal(reviews.origin, 'https://api.steampowered.com');
  assert.equal(reviews.pathname, '/IUserReviewsService/GetAppReviews/v1/');
  const reviewInput = JSON.parse(reviews.searchParams.get('input_json'));
  assert.equal(reviewInput.appid, 431960);
  assert.equal(reviewInput.num_per_page, 5);
  assert.deepEqual(reviewInput.languages, ['all'], '默认看全部语言');
  assert.equal(reviewInput.display_language, 'schinese');
  assert.equal(reviewInput.filter, 0, '默认按 helpful 排序');
  assert.equal(reviewInput.day_range, 0, '0 表示不限制时间窗，汇总才是全时段数字');

  const filtered = JSON.parse(
    new URL(
      reviewsUrl(431960, { numPerPage: 3, languages: ['schinese'], displayLanguage: 'english', filter: 'recent', reviewType: 'negative' }),
    ).searchParams.get('input_json'),
  );
  assert.deepEqual(filtered.languages, ['schinese']);
  assert.equal(filtered.display_language, 'english');
  assert.equal(filtered.filter, 1, 'recent → 1');
  assert.equal(filtered.review_type, 2, 'negative → 2');
  assert.equal(filtered.num_per_page, 3);

  // 旧商店端点已停用（2026-10-22），任何路径里都不该再出现 /appreviews/。
  assert.equal(new URL(reviewsUrl(431960)).pathname.includes('/appreviews/'), false);

  assert.equal(new URL(currentPlayersUrl(431960)).hostname, 'api.steampowered.com');
  assert.equal(new URL(globalAchievementsUrl(431960)).searchParams.get('gameid'), '431960');
});

test('mapStoreSearch 处理正常响应', () => {
  const mapped = mapStoreSearch({
    total: 3,
    items: [
      { id: 431960, name: 'Wallpaper Engine', price: { currency: 'CNY', initial: 1900, final: 1900 }, platforms: { windows: true }, metascore: '' },
      { id: 1158310, name: 'Crusader Kings III', price: { currency: 'CNY', initial: 0, final: 0 }, platforms: { windows: true, mac: true }, metascore: '91' },
      { id: 203770, name: 'Crusader Kings II', platforms: { windows: true } },
    ],
  });
  assert.equal(mapped.total, 3);
  assert.equal(mapped.items[0].appid, 431960);
  assert.equal(mapped.items[0].finalPrice, 1900);
  assert.equal(mapped.items[1].isFree, true);
  assert.equal(mapped.items[1].metascore, '91');
  // 没有 price 字段：既不是免费，也不能谎报 0 元。
  assert.equal(mapped.items[2].priceKnown, false);
  assert.equal(mapped.items[2].isFree, false);
  assert.equal(mapped.items[2].finalPrice, null);
});

test('mapStoreSearch 对空响应与脏数据不抛错', () => {
  assert.deepEqual(mapStoreSearch(null), { total: 0, items: [] });
  assert.deepEqual(mapStoreSearch({ items: 'nope' }), { total: 0, items: [] });
  const dirty = mapStoreSearch({ items: [null, { id: '1', price: 'free' }] });
  assert.equal(dirty.items.length, 1);
  assert.equal(dirty.items[0].finalPrice, null);
  assert.equal(dirty.items[0].priceKnown, false);
});

test('pickAppDetails 认对象形式、数组形式，并对 success:false 给出原因', () => {
  const objectForm = pickAppDetails({ 431960: { success: true, data: { name: 'Wallpaper Engine', type: 'game' } } }, 431960);
  assert.equal(objectForm.found, true);
  assert.equal(objectForm.app.name, 'Wallpaper Engine');

  const arrayForm = pickAppDetails([{ success: true, data: { steam_appid: 1, name: 'X' } }], 999);
  assert.equal(arrayForm.found, true);
  assert.equal(arrayForm.app.name, 'X');

  const denied = pickAppDetails({ 431960: { success: false } }, 431960);
  assert.equal(denied.found, false);
  assert.match(denied.reason, /没有返回/);

  const missing = pickAppDetails({}, 431960);
  assert.equal(missing.found, false);
  assert.match(missing.reason, /没有这个 appid/);
});

test('pickAppDetails 整理价格与发行信息', () => {
  const { app } = pickAppDetails(
    {
      431960: {
        success: true,
        data: {
          steam_appid: 431960,
          name: 'Wallpaper Engine',
          type: 'game',
          is_free: false,
          developers: ['Wallpaper Engine Team'],
          publishers: ['Wallpaper Engine Team'],
          release_date: { date: '2018 年 11 月 16 日', coming_soon: false },
          short_description: '动态壁纸',
          genres: [{ description: '休闲' }, { description: '休闲' }],
          categories: [{ description: 'Steam 创意工坊' }, { description: 'Steam 成就' }, { description: 'Steam 创意工坊' }],
          metacritic: { score: 90 },
          price_overview: { currency: 'CNY', initial: 1900, final: 1900, final_formatted: '¥ 19.00', discount_percent: 0 },
        },
      },
    },
    431960,
  );
  assert.equal(app.appid, 431960);
  assert.equal(app.releaseDate, '2018 年 11 月 16 日');
  assert.equal(app.comingSoon, false);
  assert.equal(app.price.finalFormatted, '¥ 19.00');
  assert.equal(app.metacritic, 90);
  assert.deepEqual(app.genres, ['休闲'], '重复的类型标签要去重');
  assert.deepEqual(app.categories, ['Steam 创意工坊', 'Steam 成就'], '去重同时保持原顺序');
});

test('mapReviews 处理 IUserReviewsService 的新形状', () => {
  const mapped = mapReviews(
    {
      response: {
        query_summary: {
          num_reviews: 3,
          review_score: 8,
          review_score_desc: '特别好评',
          total_positive: 900,
          total_negative: 100,
          total_reviews: 1000,
        },
        reviews: Array.from({ length: 9 }, (unused, index) => ({
          voted_up: index % 2 === 0,
          review: `review ${index}`,
          language: 'schinese',
          author: { playtime_at_review: 60 + index, playtime_forever: 9999 },
          votes_up: index,
          timestamp_created: 1700000000 + index,
          refunded: index === 0,
          primarily_steam_deck: index === 1,
        })),
        cursor: 'abc',
      },
    },
    { sampleLimit: 3 },
  );
  assert.equal(mapped.available, true);
  assert.equal(mapped.summary.positivePercent, 90);
  assert.equal(mapped.summary.description, '特别好评');
  assert.equal(mapped.summary.total, 1000);
  assert.equal(mapped.samples.length, 3);
  assert.equal(mapped.samples[0].playtimeMinutes, 60, '优先用 playtime_at_review');
  assert.equal(mapped.samples[0].refunded, true);
  assert.equal(mapped.samples[1].steamDeck, true);
  assert.equal(mapped.samples[0].language, 'schinese');
  assert.equal(mapped.cursor, 'abc');
});

test('mapReviews 把空响应当成「没有数据」而不是 0 条好评', () => {
  const empty = mapReviews({ response: {} });
  assert.equal(empty.available, false);
  assert.equal(empty.summary, null);
  assert.deepEqual(empty.samples, []);

  assert.equal(mapReviews(undefined).available, false);
  assert.equal(mapReviews(null).available, false);
  assert.equal(mapReviews({}).available, false);
});

test('mapReviews 在缺 query_summary 时保留样本但不瞎算好评率', () => {
  const mapped = mapReviews({
    response: {
      reviews: [{ voted_up: true, review: 'only sample', author: { playtime_forever: 30 } }],
    },
  });
  assert.equal(mapped.available, true);
  assert.equal(mapped.summary, null);
  assert.equal(mapped.samples.length, 1);
  assert.equal(mapped.samples[0].playtimeMinutes, 30, '没有 playtime_at_review 时回退 playtime_forever');
});

test('mapCurrentPlayers 与 mapGlobalAchievements 的边界', () => {
  assert.deepEqual(mapCurrentPlayers({ response: { player_count: 12345, result: 1 } }), { result: 1, players: 12345 });
  assert.deepEqual(mapCurrentPlayers({}), { result: 0, players: null });

  const achievements = mapGlobalAchievements({
    achievementpercentages: {
      achievements: [
        // v2 真实返回：percent 是字符串。
        { name: 'HARD', percent: '1.2' },
        { name: 'EASY', percent: '88.5' },
        { name: 'NUMERIC', percent: 50 },
        { name: 'BROKEN', percent: 'x' },
        { percent: 50 },
        null,
      ],
    },
  });
  assert.deepEqual(achievements, [
    { name: 'HARD', percent: 1.2 },
    { name: 'NUMERIC', percent: 50 },
    { name: 'EASY', percent: 88.5 },
  ]);
  assert.deepEqual(mapGlobalAchievements(null), []);
});

test('mapGlobalAchievements 兼容 v1 把数组再包一层的形状', () => {
  const achievements = mapGlobalAchievements({
    achievementpercentages: { achievements: { achievement: [{ name: 'A', percent: '10' }] } },
  });
  assert.deepEqual(achievements, [{ name: 'A', percent: 10 }]);
});

test('explainHttpStatus 给出可执行建议', () => {
  assert.match(explainHttpStatus(401), /Key/);
  assert.match(explainHttpStatus(429), /限流/);
  assert.match(explainHttpStatus(429), /匿名/);
  assert.equal(explainHttpStatus(200), '');
});

test('fetchJson 把网络失败收敛成结果对象而不是抛异常', async () => {
  const result = await createHttpClient({ timeoutMs: 1500 }).json('http://127.0.0.1:9/never-listening');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.url, 'http://127.0.0.1:9/never-listening');
});

/**
 * 用假的 http 注册公开层工具，并收集请求 URL。
 * @param {(url: string) => any} handler - 按 URL 返回 JSON 数据。
 * @returns {{ tools: Map<string, object>, urls: string[] }} 工具与请求记录。
 */
function makeStoreTools(handler) {
  const urls = [];
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  registerStoreTools(
    ctx,
    { storeCountry: 'cn', storeLanguage: 'schinese', maxListedApps: 200 },
    {
      http: {
        async json(url) {
          urls.push(url);
          return { ok: true, data: handler(url) };
        },
      },
    },
  );
  return { tools, urls };
}

test('steam_search 不把「接口没给价格」说成本区不售', async () => {
  const { tools } = makeStoreTools(() => ({
    total: 3,
    items: [
      // 免费游戏 / Demo 在 storesearch 里根本不带 price。
      { id: 1, name: 'Free To Play', platforms: { windows: true } },
      { id: 2, name: 'Paid', price: { currency: 'CNY', initial: 4200, final: 2100 }, platforms: { windows: true } },
      { id: 3, name: 'Zero', price: { currency: 'CNY', initial: 0, final: 0 }, platforms: {} },
    ],
  }));
  const { text } = await tools.get('steam_search').execute({ term: 'test' }, {});
  assert.match(text, /Free To Play — 无价（免费或本区不售）/);
  assert.match(text, /Paid — ¥21\.00（原价 ¥42\.00）/);
  assert.match(text, /Zero — 免费/);
  assert.equal(text.includes('本地区可能不售'), false, '不能断言本区不售');
});

test('steam_store_app 用 is_free 标注免费应用，不按「没有价格」猜不售', async () => {
  const free = makeStoreTools(() => ({
    431960: { success: true, data: { steam_appid: 431960, name: 'Free Game', type: 'game', is_free: true } },
  }));
  const freeText = await free.tools.get('steam_store_app').execute({ appid: 431960 }, {});
  assert.match(freeText.text, /价格：免费/);
  assert.equal(freeText.text.includes('本地区没有单独列出价格'), false);

  const priceless = makeStoreTools(() => ({
    1: { success: true, data: { steam_appid: 1, name: 'Unknown Price', type: 'game', is_free: false } },
  }));
  const unknownText = await priceless.tools.get('steam_store_app').execute({ appid: 1 }, {});
  assert.match(unknownText.text, /可能是免费游戏、Demo，或本地区不售/);
});

test('mapAppData 用 is_free 与 price.final=0 判定免费', () => {
  const free = pickAppDetails({ 1: { success: true, data: { steam_appid: 1, name: 'F2P', is_free: true } } }, 1);
  assert.equal(free.app.isFree, true);
  assert.equal(free.app.price, null);

  const zero = pickAppDetails(
    { 2: { success: true, data: { steam_appid: 2, name: 'Zero', price_overview: { currency: 'CNY', initial: 0, final: 0 } } } },
    2,
  );
  assert.equal(zero.app.isFree, true, '没有 is_free 时用 price.final=0 兜底');

  const paid = pickAppDetails(
    { 3: { success: true, data: { steam_appid: 3, name: 'Paid', is_free: false, price_overview: { final: 100 } } } },
    3,
  );
  assert.equal(paid.app.isFree, false);
});

test('steam_reviews 把 cursor 传给接口并回显下一次游标', async () => {
  const { tools, urls } = makeStoreTools(() => ({
    response: {
      reviews: [{ voted_up: true, review: '不错的游戏', author: { playtime_forever: 60 } }],
      cursor: 'NEXT==',
    },
  }));
  const { text } = await tools.get('steam_reviews').execute({ appid: 431960, cursor: 'PREV==', sampleLimit: 1 }, {});
  const input = JSON.parse(new URL(urls.at(-1)).searchParams.get('input_json'));
  assert.equal(input.cursor, 'PREV==', 'cursor 必须传给 Steam');
  assert.match(text, /下一页：cursor=NEXT==/, '输出必须回显下一次的 cursor');

  await tools.get('steam_reviews').execute({ appid: 431960, sampleLimit: 1 }, {});
  const plain = JSON.parse(new URL(urls.at(-1)).searchParams.get('input_json'));
  assert.equal('cursor' in plain, false, '第一页不该带 cursor 字段');
});

test('steam_reviews 在评测正文被截断时标出「已截断」', async () => {
  const { tools } = makeStoreTools(() => ({
    response: {
      reviews: [{ voted_up: true, review: '啊'.repeat(600), author: {} }],
      cursor: '',
    },
  }));
  const { text } = await tools.get('steam_reviews').execute({ appid: 1, sampleLimit: 1 }, {});
  assert.match(text, /（已截断）/);
});

test('取消时工具抛 AbortError，而不是普通 Error（0.3.0 取消语义）', async () => {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  registerStoreTools(
    ctx,
    { storeCountry: 'cn', storeLanguage: 'schinese', maxListedApps: 200 },
    {
      http: {
        async json() {
          return { ok: false, aborted: true, error: '请求已被取消' };
        },
      },
    },
  );
  await assert.rejects(
    () => tools.get('steam_app_stats').execute({ appid: 1 }, {}),
    (error) => {
      assert.equal(error.name, 'AbortError', '取消必须保留 AbortError 身份，否则 DSH 会记成普通失败');
      return true;
    },
  );
});

test('活体：真实商店端点', { skip: !LIVE }, async () => {
  const http = createHttpClient({ timeoutMs: 20_000 });
  const store = createStoreClient({ http });

  const details = await store.appDetails(431960);
  assert.equal(details.ok, true, `appdetails 失败：${details.error ?? ''}`);
  const picked = pickAppDetails(details.data, 431960);
  assert.equal(picked.found, true);
  assert.ok(picked.app.name.length > 0);

  const players = await store.currentPlayers(431960);
  assert.equal(players.ok, true);
  assert.ok(mapCurrentPlayers(players.data).players >= 0);

  const search = await store.search('Crusader Kings');
  assert.equal(search.ok, true);
  assert.ok(mapStoreSearch(search.data).items.length > 0);

  // 评测：旧 /appreviews 已于 2026-10-22 停用，这里验证新接口真的能返回汇总。
  const reviews = await store.reviews(431960, { numPerPage: 3, languages: ['all'], displayLanguage: 'schinese' });
  assert.equal(reviews.ok, true, `GetAppReviews 失败：${reviews.error ?? ''}`);
  const mapped = mapReviews(reviews.data, { sampleLimit: 2 });
  assert.equal(mapped.available, true);
  assert.ok(mapped.summary !== null && mapped.summary.total > 0);
  assert.ok(mapped.samples.length > 0);
});
