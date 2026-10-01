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
  assert.equal(reviews.pathname, '/appreviews/431960');
  assert.equal(reviews.searchParams.get('json'), '1');
  assert.equal(reviews.searchParams.get('num_per_page'), '5');

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

test('mapReviews 计算好评率并截断样本', () => {
  const mapped = mapReviews(
    {
      success: 1,
      query_summary: { total_reviews: 1000, total_positive: 900, total_negative: 100, review_score: 8, review_score_desc: '特别好评' },
      reviews: Array.from({ length: 9 }, (unused, index) => ({
        voted_up: index % 2 === 0,
        review: `review ${index}`,
        author: { playtime_forever: 60 + index },
        votes_up: index,
        timestamp_created: 1700000000 + index,
      })),
    },
    { sampleLimit: 3 },
  );
  assert.equal(mapped.success, true);
  assert.equal(mapped.summary.positivePercent, 90);
  assert.equal(mapped.summary.description, '特别好评');
  assert.equal(mapped.samples.length, 3);
});

test('mapReviews 在缺 query_summary 时不崩且不瞎算好评率', () => {
  const mapped = mapReviews({ success: 1 });
  assert.equal(mapped.summary.total, 0);
  assert.equal(mapped.summary.positivePercent, null);
  assert.equal(mapReviews(undefined).samples.length, 0);
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
  assert.equal(explainHttpStatus(200), '');
});

test('fetchJson 把网络失败收敛成结果对象而不是抛异常', async () => {
  const result = await createHttpClient({ timeoutMs: 1500 }).json('http://127.0.0.1:9/never-listening');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.url, 'http://127.0.0.1:9/never-listening');
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
});
