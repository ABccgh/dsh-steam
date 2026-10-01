import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONA_STATES,
  looksLikeSteamId64,
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
} from '../lib/webapi.js';

test('looksLikeSteamId64 只接受 17 位数字', () => {
  assert.equal(looksLikeSteamId64('76561199151703735'), true);
  assert.equal(looksLikeSteamId64('7656119915170373'), false);
  assert.equal(looksLikeSteamId64('765611991517037350'), false);
  assert.equal(looksLikeSteamId64('7656119915170373a'), false);
});

test('normalizeSteamIdInput 认 SteamID64、vanity 与主页链接', () => {
  assert.deepEqual(normalizeSteamIdInput('76561199151703735'), { kind: 'steamid64', value: '76561199151703735' });
  assert.deepEqual(normalizeSteamIdInput('  gaben  '), { kind: 'vanity', value: 'gaben' });
  assert.deepEqual(normalizeSteamIdInput('https://steamcommunity.com/id/gaben/'), { kind: 'vanity', value: 'gaben' });
  assert.deepEqual(normalizeSteamIdInput('https://steamcommunity.com/profiles/76561199151703735'), {
    kind: 'steamid64',
    value: '76561199151703735',
  });
  assert.equal(normalizeSteamIdInput('').kind, 'invalid');
  assert.equal(normalizeSteamIdInput('a'.repeat(200)).kind, 'invalid');
  assert.equal(normalizeSteamIdInput('has space').kind, 'invalid');
});

test('URL 构造把 key 与参数放进 query', () => {
  const summaries = new URL(playerSummariesUrl('KEY', ['1', '2']));
  assert.equal(summaries.pathname, '/ISteamUser/GetPlayerSummaries/v2/');
  assert.equal(summaries.searchParams.get('key'), 'KEY');
  assert.equal(summaries.searchParams.get('steamids'), '1,2');

  assert.equal(new URL(resolveVanityUrl('KEY', 'gaben')).searchParams.get('vanityurl'), 'gaben');
  assert.equal(new URL(ownedGamesUrl('KEY', '99')).searchParams.get('steamid'), '99');
  assert.equal(new URL(ownedGamesUrl('KEY', '99')).searchParams.get('include_appinfo'), '1');
  assert.equal(new URL(recentlyPlayedUrl('KEY', '99', 5)).searchParams.get('count'), '5');
  assert.equal(new URL(recentlyPlayedUrl('KEY', '99', 0)).searchParams.get('count'), null);
  assert.equal(new URL(playerAchievementsUrl('KEY', '99', 431960)).searchParams.get('appid'), '431960');

  const files = new URL(queryFilesUrl('KEY', { appid: 1158310, searchText: ' 法理征服 ', queryType: 'rankedByTotalUniqueSubscriptions', page: 2 }));
  assert.equal(files.pathname, '/IPublishedFileService/QueryFiles/v1/');
  assert.equal(files.searchParams.get('appid'), '1158310');
  assert.equal(files.searchParams.get('search_text'), '法理征服');
  assert.equal(files.searchParams.get('query_type'), '9');
  assert.equal(files.searchParams.get('page'), '2');
  assert.equal(files.searchParams.get('return_tags'), '1');
});

test('queryFilesUrl 对未知 queryType 退回默认排序', () => {
  assert.equal(new URL(queryFilesUrl('KEY', { queryType: 'nonsense' })).searchParams.get('query_type'), '0');
});

test('mapPlayerSummaries 翻译在线状态与游戏', () => {
  const mapped = mapPlayerSummaries({
    response: {
      players: [
        {
          steamid: '76561199151703735',
          personaname: 'Someone',
          profileurl: 'https://steamcommunity.com/id/someone/',
          personastate: 1,
          communityvisibilitystate: 3,
          lastlogoff: 1790000000,
          timecreated: 1600000000,
          loccountrycode: 'CN',
          gameextrainfo: 'Crusader Kings III',
          gameid: '1158310',
        },
      ],
    },
  });
  assert.equal(mapped.players.length, 1);
  assert.equal(mapped.players[0].state, '在线');
  assert.equal(mapped.players[0].inGameName, 'Crusader Kings III');
  assert.equal(mapped.players[0].inGameAppId, 1158310);
  assert.equal(PERSONA_STATES.get(0), '离线');
});

test('mapPlayerSummaries 对空响应返回空列表', () => {
  assert.deepEqual(mapPlayerSummaries(null), { players: [] });
  assert.deepEqual(mapPlayerSummaries({ response: {} }), { players: [] });
});

test('mapOwnedGames 排序并把「空 = 私密」区分出来', () => {
  const mapped = mapOwnedGames({
    response: {
      game_count: 2,
      games: [
        { appid: 1, name: 'Little', playtime_forever: 10 },
        { appid: 2, name: 'Big', playtime_forever: 600, playtime_2weeks: 30, rtime_last_played: 1790000000 },
      ],
    },
  });
  assert.equal(mapped.count, 2);
  assert.equal(mapped.private, false);
  assert.deepEqual(mapped.games.map((game) => game.name), ['Big', 'Little']);
  assert.equal(mapped.games[0].playtimeTwoWeeksMinutes, 30);

  assert.equal(mapOwnedGames({ response: {} }).private, true);
  assert.equal(mapOwnedGames(null).private, true);
  assert.deepEqual(mapOwnedGames({ response: {} }).games, []);
});

test('mapRecentlyPlayed 在 total_count 缺失时退回列表长度', () => {
  const mapped = mapRecentlyPlayed({ response: { games: [{ appid: 3, name: 'A', playtime_2weeks: 5 }] } });
  assert.equal(mapped.total, 1);
  assert.equal(mapped.private, false);
  assert.equal(mapRecentlyPlayed({ response: { total_count: 0, games: [] } }).private, true);
});

test('mapPlayerAchievements 区分「没数据」与「真的没成就」', () => {
  const noData = mapPlayerAchievements({ playerstats: { success: false, error: 'Requested app has no stats' } });
  assert.equal(noData.ok, false);
  assert.match(noData.reason, /no stats/);

  const ok = mapPlayerAchievements({
    playerstats: {
      steamID: '76561199151703735',
      gameName: 'Crusader Kings III',
      achievements: [
        { apiname: 'A', achieved: 1, unlocktime: 1790000000, name: '首个成就', description: '解锁' },
        { apiname: 'B', achieved: 0, unlocktime: 0, name: '未解锁', description: '继续玩' },
      ],
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.achieved, 1);
  assert.equal(ok.total, 2);
  assert.equal(ok.gameName, 'Crusader Kings III');
  assert.equal(mapPlayerAchievements(null).ok, false);
});

test('mapResolveVanity 只接受 success:1 且形如 SteamID64 的结果', () => {
  assert.deepEqual(mapResolveVanity({ response: { success: 1, steamid: '76561199151703735' } }), {
    ok: true,
    steamId64: '76561199151703735',
  });
  assert.equal(mapResolveVanity({ response: { success: 42, message: 'No match' } }).ok, false);
  assert.equal(mapResolveVanity({ response: { success: 1, steamid: 'not-an-id' } }).ok, false);
  assert.equal(mapResolveVanity(null).ok, false);
});

test('mapQueryFiles 整理创意工坊条目', () => {
  const mapped = mapQueryFiles({
    response: {
      total: 1,
      publishedfiledetails: [
        {
          publishedfileid: '3803258931',
          title: '法理征服 / De Jure Conquest',
          consumer_appid: 1158310,
          app_name: 'Crusader Kings III',
          file_size: '123456',
          subscriptions: 900,
          favorited: 30,
          views: 12000,
          time_updated: 1790000000,
          tags: [{ tag: '游戏玩法' }],
          short_description: 'CK3 mod',
        },
      ],
    },
  });
  assert.equal(mapped.total, 1);
  assert.equal(mapped.items[0].title, '法理征服 / De Jure Conquest');
  assert.deepEqual(mapped.items[0].tags, ['游戏玩法']);
  // file_size 是 uint64，Steam 会把它序列化成字符串；这里必须转成数字，否则工具永远显示"大小未知"。
  assert.equal(mapped.items[0].fileSize, 123456);
  assert.equal(mapped.items[0].subscriptions, 900);
  // 真实字段名是 consumer_appid；app_name 优先用于展示。
  assert.equal(mapped.items[0].appid, 1158310);
  assert.equal(mapped.items[0].appName, 'Crusader Kings III');
  assert.deepEqual(mapQueryFiles({}).items, []);
});

test('mapQueryFiles 兼容 consumer_app_id 这种旧拼写', () => {
  const mapped = mapQueryFiles({ response: { publishedfiledetails: [{ publishedfileid: '1', consumer_app_id: 730 }] } });
  assert.equal(mapped.items[0].appid, 730);
  assert.equal(mapped.items[0].appName, '');
});

test('mapQueryFiles 对无法解析的数值字段回退到 0/null 而不是 NaN', () => {
  const mapped = mapQueryFiles({
    response: { publishedfiledetails: [{ publishedfileid: '1', title: 'x', file_size: 'nope', views: null }] },
  });
  assert.equal(mapped.items[0].fileSize, 0);
  assert.equal(mapped.items[0].views, 0);
  assert.equal(mapped.items[0].appid, null);
});
