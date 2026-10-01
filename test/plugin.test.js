import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// 插件是零外部依赖的：这里可以像普通包一样直接 import，不需要任何解析替身。
const { apply, name, normalizeConfig } = await import('../lib/index.js');

/** 需要真实网络时才跑的用例：`DSH_STEAM_LIVE=1 node --test`。 */
const LIVE = process.env.DSH_STEAM_LIVE === '1';

/**
 * 造一个最小的 Cordis 上下文：只需要 `tools.register`、可选的 `credentials` 和 `logger`。
 * @param {{ credentials?: object }} [options] - 是否提供凭据服务。
 * @returns {{ ctx: object, tools: Map<string, object> }} 上下文与收集到的工具定义。
 */
function makeCtx(options = {}) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(key) {
      if (key === 'credentials') return options.credentials;
      return undefined;
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, tools };
}

/** 调用一个已注册的工具。 */
function call(tools, toolName, args = {}) {
  const definition = tools.get(toolName);
  assert.ok(definition, `工具 ${toolName} 没有注册`);
  return definition.execute(args, { signal: AbortSignal.timeout(30_000) });
}

test('插件导出 name / inject / apply，且不导出 Config（由 normalizeConfig 兜底）', async () => {
  const module = await import('../lib/index.js');
  assert.equal(name, 'steam');
  assert.equal(typeof apply, 'function');
  assert.deepEqual(module.inject, ['tools']);
  assert.equal('Config' in module, false, '没有 Config 时 cordis 会原样透传配置对象');
});

test('没有凭据服务时只注册 9 个不需要 Key 的工具', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  assert.deepEqual([...tools.keys()].sort(), [
    'steam_app_stats',
    'steam_game',
    'steam_games',
    'steam_library_health',
    'steam_reviews',
    'steam_search',
    'steam_status',
    'steam_store_app',
    'steam_workshop_local',
  ]);
});

test('每个工具都有描述、参数 schema、输出形状与安全的并发标记', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  for (const [toolName, definition] of tools) {
    assert.equal(definition.name, toolName);
    assert.ok(definition.description.length > 10, `${toolName} 的描述太短`);
    assert.equal(typeof definition.parameters, 'object');
    assert.equal(typeof definition.output.schema, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.isConcurrencySafe?.(), true, `${toolName} 应声明为只读并发安全`);
  }
});

test('webApi=on 时注册全部 14 个工具，且缺 Key 的报错给出可执行指引', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, { webApi: 'on' });
  assert.equal(tools.size, 14);
  assert.ok(tools.has('steam_player'));

  await assert.rejects(() => call(tools, 'steam_player', {}), (error) => {
    assert.match(error.message, /STEAM_API_KEY/);
    assert.match(error.message, /\.env/);
    assert.match(error.message, /steamcommunity\.com\/dev\/apikey/);
    return true;
  });
});

test('webApi=off 时不注册密钥层工具', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, { webApi: 'off' });
  assert.equal(tools.has('steam_player'), false);
  assert.equal(tools.size, 9);
});

test('凭据服务能给出 Key 时自动注册密钥层工具', async () => {
  const credentials = {
    async resolve(ref) {
      return ref === 'STEAM_API_KEY' ? { value: 'A'.repeat(24), source: 'test' } : undefined;
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, {});
  assert.equal(tools.size, 14);
});

test('normalizeConfig 把非法值收成默认值', () => {
  const normalized = normalizeConfig({
    steamPath: '   ',
    extraLibraryPaths: ['D:\\Games', 42, ''],
    webApi: 'nonsense',
    apiKeyEnv: '',
    trustSystemCa: 'maybe',
    storeCountry: 'us',
    storeLanguage: 'english',
    requestTimeoutMs: -5,
    maxListedApps: 0,
  });
  assert.equal(normalized.steamPath, '');
  assert.deepEqual(normalized.extraLibraryPaths, ['D:\\Games']);
  assert.equal(normalized.webApi, 'auto');
  assert.equal(normalized.apiKeyEnv, 'STEAM_API_KEY');
  assert.equal(normalized.trustSystemCa, 'auto');
  assert.equal(normalized.storeCountry, 'us');
  assert.equal(normalized.requestTimeoutMs, 15000);
  assert.equal(normalized.maxListedApps, 200);

  const custom = normalizeConfig({ webApi: 'on', trustSystemCa: 'never', requestTimeoutMs: 9000, maxListedApps: 7 });
  assert.equal(custom.webApi, 'on');
  assert.equal(custom.trustSystemCa, 'never');
  assert.equal(custom.requestTimeoutMs, 9000);
  assert.equal(custom.maxListedApps, 7);
});

test('steam_status 回报 Web API Key 的配置状态', async () => {
  const withoutKey = makeCtx();
  await apply(withoutKey.ctx, {});
  const missing = await call(withoutKey.tools, 'steam_status');
  assert.match(missing.text, /Web API Key（STEAM_API_KEY）：未配置/);
  assert.match(missing.text, /不会注册/, '要说明密钥层工具为什么没出现');
  assert.match(missing.text, /\.env/, '要给出可执行的排查路径');

  const credentials = {
    async resolve(ref) {
      return ref === 'STEAM_API_KEY' ? { value: 'A'.repeat(24), source: 'test' } : undefined;
    },
  };
  const withKey = makeCtx({ credentials });
  await apply(withKey.ctx, {});
  const present = await call(withKey.tools, 'steam_status');
  assert.match(present.text, /Web API Key（STEAM_API_KEY）：已配置（长度 24）/);
});

test('steam_status 在自定义 apiKeyEnv 下报告对应的凭据名', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, { apiKeyEnv: 'MY_STEAM_KEY' });
  const { text } = await call(tools, 'steam_status');
  assert.match(text, /Web API Key（MY_STEAM_KEY）：未配置/);
});

test('auto 模式：激活时凭据服务没就绪，稍后拿到 Key 会自动补注册', async () => {
  // 真实桌面版就是这个时序：插件先激活，凭据服务之后才完成初始化。
  // 前两次解析返回空，第三次（兜底重试的第一次）才拿到 Key。
  let calls = 0;
  const credentials = {
    async resolve() {
      calls += 1;
      return calls > 2 ? { value: 'B'.repeat(32), source: 'test' } : undefined;
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, {});
  assert.equal(tools.size, 9, '激活时凭据还没就绪，只应注册不需要 Key 的工具');

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(tools.size, 14, '重试后应补上 5 个密钥层工具');
  assert.ok(tools.has('steam_player'));

  const { text } = await tools.get('steam_status').execute({}, {});
  assert.match(text, /已配置（长度 32）—— 5 个密钥层工具已注册/);
});

test('steam_status 会自愈：凭据就绪后调用一次就补上密钥层工具', async () => {
  // 激活与紧随其后的第一次兜底重试都拿不到 Key，第三次（由 steam_status 触发）才拿到。
  let calls = 0;
  const credentials = {
    async resolve() {
      calls += 1;
      return calls >= 3 ? { value: 'D'.repeat(32), source: 'test' } : undefined;
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, {});
  assert.equal(tools.size, 9, '激活时还没有 Key');

  const { text } = await tools.get('steam_status').execute({}, {});
  assert.equal(tools.size, 14, 'steam_status 应触发补注册');
  assert.match(text, /已配置（长度 32）—— 5 个密钥层工具已注册/);
});

test('webApi=off 且 Key 可用时，steam_status 说明是按配置未注册', async () => {
  const credentials = {
    async resolve() {
      return { value: 'C'.repeat(32) };
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'off' });
  const { text } = await tools.get('steam_status').execute({}, {});
  assert.match(text, /已配置（长度 32），但 webApi=off/);
});

test('steam_status 报出本机真实安装', async (t) => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  const { text } = await call(tools, 'steam_status');
  const rootLine = /Steam 安装目录：(.+)/.exec(text);
  if (rootLine === null) {
    t.skip('本机没有装 Steam');
    return;
  }
  // 不断言具体盘符：这个用例要在任何装了 Steam 的机器上成立。
  assert.ok(rootLine[1].trim().length > 0);
  assert.match(text, /库根（\d+）/);
  assert.match(text, /已安装游戏：\d+ 个/);
});

test('steam_games 列出本机已安装游戏并可过滤', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  const all = await call(tools, 'steam_games', { limit: 50 });
  assert.match(all.text, /已安装 \d+ 个游戏/);

  // 过滤词从真实结果里取（第一行形如 `1234560  游戏名 — …`），
  // 这样不需要写死任何一台机器上装了什么。
  const firstGame = /^(\d+)\s\s(.+?)\s—/m.exec(all.text);
  if (firstGame === null) return; // 本机一个游戏都没装
  const [, appid, name] = firstGame;
  const probe = name.trim().slice(0, 4);

  const byName = await call(tools, 'steam_games', { filter: probe });
  assert.match(byName.text, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const byAppId = await call(tools, 'steam_games', { filter: appid });
  assert.ok(byAppId.text.includes(appid), '按 appid 精确过滤应命中该条目');
});

test('steam_game 查单个 appid，并对未安装的 appid 给出明确答复', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});

  const all = await call(tools, 'steam_games', { limit: 1 });
  const firstGame = /^(\d+)\s\s(.+?)\s—/m.exec(all.text);
  if (firstGame !== null) {
    const installed = await call(tools, 'steam_game', { appid: Number(firstGame[1]) });
    assert.ok(installed.text.includes(firstGame[2].trim()), '详情里应出现游戏名');
    assert.match(installed.text, /安装状态：StateFlags=\d+/);
    assert.match(installed.text, /所在库：/);
  }

  const missing = await call(tools, 'steam_game', { appid: 999999999 });
  assert.match(missing.text, /没有安装在本机/);

  await assert.rejects(() => call(tools, 'steam_game', { appid: 'abc' }), /appid 必须是整数/);
});

test('steam_library_health 给出可读的体检结论', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  const { text } = await call(tools, 'steam_library_health');
  assert.match(text, /总计：/);
  assert.match(text, /安装目录缺失/);
  assert.match(text, /多余目录/);
});

test('steam_workshop_local 在没有任何工坊内容时也给出干净答复', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  const { text } = await call(tools, 'steam_workshop_local', {});
  assert.ok(text.length > 0);
  assert.ok(/共 \d+ 项|没有已下载的创意工坊内容/.test(text));
});

test('steam_search / steam_store_app / steam_reviews / steam_app_stats 打真实端点', { skip: !LIVE }, async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});

  const details = await call(tools, 'steam_store_app', { appid: 431960 });
  assert.match(details.text, /Wallpaper Engine/);

  const search = await call(tools, 'steam_search', { term: 'Crusader Kings', limit: 3 });
  assert.match(search.text, /商店搜索「Crusader Kings」命中 \d+ 条/);

  const reviews = await call(tools, 'steam_reviews', { appid: 431960, sampleLimit: 2 });
  assert.match(reviews.text, /好评率|还没有可读的评测/);

  const stats = await call(tools, 'steam_app_stats', { appid: 431960, achievementLimit: 3 });
  assert.match(stats.text, /当前在线/);

  const notFound = await call(tools, 'steam_store_app', { appid: 999999999 });
  assert.match(notFound.text, /没有返回|没有这个 appid/);
});
