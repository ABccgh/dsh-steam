import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 插件是零外部依赖的：这里可以像普通包一样直接 import，不需要任何解析替身。
const { apply, name, normalizeConfig, normalizeConfigWithWarnings } = await import('../lib/index.js');
const { VERSION } = await import('../lib/version.js');
const { TOOL_TIMEOUT_MS, apiKeyHelp } = await import('../lib/tools/shared.js');

/** 需要真实网络时才跑的用例：`DSH_STEAM_LIVE=1 node --test`。 */
const LIVE = process.env.DSH_STEAM_LIVE === '1';

/**
 * 造一个最小的 Cordis 上下文：只需要 `tools.register`、`effect`、可选的 `credentials` 和 `logger`。
 * @param {{ credentials?: object }} [options] - 是否提供凭据服务。
 * @returns {{ ctx: object, tools: Map<string, object>, warnings: string[], disposers: Function[],
 *   registered: string[] }} 上下文与收集到的注册信息。
 */
function makeCtx(options = {}) {
  const tools = new Map();
  const disposers = [];
  const warnings = [];
  const infos = [];
  const registered = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name);
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(key) {
      if (key === 'credentials') return options.credentials;
      return undefined;
    },
    // 真实 Cordis 的 ctx.effect(execute) 会立刻执行并把返回的清理函数挂到 fiber 上；
    // 这里只收集清理函数，测试可以手动调用它模拟插件卸载。
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    logger: {
      info(message) {
        infos.push(String(message));
      },
      warn(message) {
        warnings.push(String(message));
      },
    },
  };
  return { ctx, tools, warnings, infos, disposers, registered };
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

test('VERSION 与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('默认 webApi=on：即使没有凭据服务也注册全部 14 个工具', async () => {
  const { ctx, tools, infos } = makeCtx();
  await apply(ctx, {});
  assert.deepEqual([...tools.keys()].sort(), [
    'steam_achievements',
    'steam_app_stats',
    'steam_game',
    'steam_games',
    'steam_library_health',
    'steam_owned_games',
    'steam_player',
    'steam_recent_games',
    'steam_reviews',
    'steam_search',
    'steam_status',
    'steam_store_app',
    'steam_workshop_local',
    'steam_workshop_search',
  ]);
  assert.ok(infos.some((message) => /本地 5 \+ 公开 4 \+ 密钥 5 个工具/.test(message)), '就绪日志里的密钥工具数要报 5 而不是 0');
  // 缺 Key 时工具照样在，调用才报错并给出完整修复指引。
  await assert.rejects(() => call(tools, 'steam_player', {}), (error) => {
    assert.match(error.message, /STEAM_API_KEY/);
    assert.match(error.message, /version: 1/);
    assert.match(error.message, /refs:/);
    assert.match(error.message, /steamcommunity\.com\/dev\/apikey/);
    return true;
  });
});

test('显式 webApi=auto 且没有 Key 时只注册 9 个不需要 Key 的工具', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, { webApi: 'auto' });
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

test('每个工具都有描述、参数 schema、输出形状与超时兜底', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  for (const [toolName, definition] of tools) {
    assert.equal(definition.name, toolName);
    assert.ok(definition.description.length > 10, `${toolName} 的描述太短`);
    assert.equal(typeof definition.parameters, 'object');
    assert.equal(typeof definition.output.schema, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.timeoutMs, TOOL_TIMEOUT_MS, `${toolName} 应带 60 秒超时兜底`);
    if (toolName === 'steam_status') {
      // 它会在调用中补注册密钥层工具（改父状态），不能声明成并发安全的只读工具。
      assert.equal(definition.isConcurrencySafe, undefined, 'steam_status 不该声明并发安全');
      continue;
    }
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

test('webApi=auto 且凭据服务能给出 Key 时注册密钥层工具', async () => {
  const credentials = {
    async resolve(ref) {
      return ref === 'STEAM_API_KEY' ? { value: 'A'.repeat(24), source: 'test' } : undefined;
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'auto' });
  assert.equal(tools.size, 14);
});

test('apiKeyHelp 按真实优先级列出四条来源，并给出可解析的 credentials.yaml 结构', () => {
  const help = apiKeyHelp('STEAM_API_KEY');
  // 顺序：已存凭据 > 启动环境变量 > 项目 .env > $DSH_HOME/.env。
  const order = [
    help.indexOf('.credentials.yaml'),
    help.indexOf('启动 DSH 前的环境变量'),
    help.indexOf('启动目录下的 .env'),
    help.indexOf('.dsh\\.env'),
  ];
  for (const index of order) assert.ok(index >= 0, `帮助文案缺少某一层来源：${help}`);
  assert.deepEqual(order, [...order].sort((left, right) => left - right), '优先级顺序写反了');
  assert.match(help, /version: 1/, '必须给出带版本的 YAML 结构');
  assert.match(help, /refs:/, 'Key 必须写在 refs: 下');
  assert.match(help, /裸.*会被当作未知顶层键忽略/, '要说明裸写一行无效');
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
  // 0.3.0 起默认 on：始终注册密钥层工具，缺 Key 时调用给指引。
  assert.equal(normalized.webApi, 'on');
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

  assert.equal(normalizeConfig({ webApi: 'auto' }).webApi, 'auto', '显式 auto 的语义保留');
});

test('normalizeConfig 为每个被拒字段收集告警，apply 逐条记 warn', async () => {
  const rejected = {
    steamPath: 42,
    extraLibraryPaths: ['D:\\Games', 42],
    webApi: 'nonsense',
    apiKeyEnv: '',
    trustSystemCa: 'maybe',
    storeCountry: 42,
    storeLanguage: '',
    requestTimeoutMs: -5,
    maxListedApps: 0,
  };
  const { config, warnings } = normalizeConfigWithWarnings(rejected);
  assert.equal(config.webApi, 'on');
  for (const field of Object.keys(rejected)) {
    assert.ok(warnings.some((warning) => warning.includes(field)), `缺少 ${field} 的告警：${warnings.join(' / ')}`);
  }

  const { ctx, warnings: logged } = makeCtx();
  await apply(ctx, rejected);
  for (const field of Object.keys(rejected)) {
    assert.ok(logged.some((message) => message.includes(field)), `日志里缺少 ${field} 的告警`);
    assert.ok(logged.some((message) => message.startsWith('[steam]')), '日志应带插件前缀');
  }
});

test('steam_status 回报 Web API Key 的配置状态', async () => {
  // 默认 on：工具始终注册；没 Key 时如实说明「已注册但未配置」。
  const withoutKey = makeCtx();
  await apply(withoutKey.ctx, {});
  const missing = await call(withoutKey.tools, 'steam_status');
  assert.match(missing.text, /Web API Key（STEAM_API_KEY）：未配置/);
  assert.match(missing.text, /已按 webApi=on 注册/, 'on 模式下工具本来就在，要说明调用时会提示配置');
  assert.match(missing.text, /插件：@local\/steam \d+\.\d+\.\d+/);
  assert.match(missing.text, /系统根证书：/);

  // 显式 auto 且没 Key：工具不注册，要给出可执行的排查路径。
  const auto = makeCtx();
  await apply(auto.ctx, { webApi: 'auto' });
  const unregistered = await call(auto.tools, 'steam_status');
  assert.match(unregistered.text, /不会注册/, '要说明密钥层工具为什么没出现');
  assert.match(unregistered.text, /version: 1/, '要给出正确的 credentials.yaml 结构');
  assert.match(unregistered.text, /refs:/);
  assert.match(unregistered.text, /credentials\.yaml/);

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
  await apply(ctx, { webApi: 'auto' });
  assert.equal(tools.size, 9, '激活时凭据还没就绪，只应注册不需要 Key 的工具');

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(tools.size, 14, '重试后应补上 5 个密钥层工具');
  assert.ok(tools.has('steam_player'));

  const { text } = await tools.get('steam_status').execute({}, {});
  assert.match(text, /已配置（长度 32）—— 5 个密钥层工具已注册/);
});

test('steam_status 报出凭据来源：四层里到底是哪一层供的值', async () => {
  const credentials = {
    async resolve() {
      return { value: 'C'.repeat(32), source: 'test' };
    },
    async describe() {
      return { configured: true, source: 'env:$DSH_HOME/.env', writable: false };
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'on' });
  const { text } = await tools.get('steam_status').execute({}, {});
  assert.match(text, /已配置（长度 32；来源：env:\$DSH_HOME\/\.env（只读））/, '要带出来源与可写性');
});

test('steam_status 在凭据服务没有 describe 时照常工作（不报来源）', async () => {
  const credentials = {
    async resolve() {
      return { value: 'D'.repeat(32), source: 'test' };
    },
  };
  const { ctx, tools } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'on' });
  const { text } = await tools.get('steam_status').execute({}, {});
  assert.match(text, /已配置（长度 32）—— 5 个密钥层工具已注册/);
  const keyLine = text.split('\n').find((line) => line.startsWith('Web API Key（STEAM_API_KEY）')) ?? '';
  assert.ok(keyLine !== '', '状态里应有 Key 那一行');
  assert.ok(!keyLine.includes('来源：'), `没有 describe 时不应报来源：${keyLine}`);
});

test('auto 补注册用 in-flight promise 去重：并发触发只注册一次', async () => {
  let released;
  const gate = new Promise((resolve) => {
    released = resolve;
  });
  let calls = 0;
  const credentials = {
    async resolve() {
      calls += 1;
      if (calls <= 2) return undefined; // 激活时与第一次兜底重试都还没就绪
      return gate.then(() => ({ value: 'E'.repeat(32), source: 'test' })); // 之后卡在「服务初始化中」
    },
  };
  const { ctx, tools, warnings, registered } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'auto' });
  assert.equal(tools.size, 9);

  // 两个并发调用同时走到「越过 keyToolsRegistered 检查、等 getApiKey」的那一步。
  const pending = [call(tools, 'steam_status'), call(tools, 'steam_status')];
  for (let index = 0; index < 300 && calls < 3; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(calls >= 3, '两次 status 调用应至少触发一次 Key 解析');
  released();
  const results = await Promise.all(pending);
  assert.equal(tools.size, 14);
  assert.equal(registered.length, 14, '并发补注册只能注册一次（无重复 register 调用）');
  assert.equal(warnings.filter((warning) => /注册密钥层工具失败/.test(warning)).length, 0);
  for (const result of results) assert.match(result.text, /5 个密钥层工具已注册/);
});

test('auto 补注册的定时器挂 ctx.effect：插件卸载后不再回调', async () => {
  let calls = 0;
  const credentials = {
    async resolve() {
      calls += 1;
      return undefined;
    },
  };
  const { ctx, disposers } = makeCtx({ credentials });
  await apply(ctx, { webApi: 'auto' });
  assert.ok(disposers.length >= 1, '应通过 ctx.effect 注册清理函数');

  // 模拟插件卸载：清掉未触发的定时器并禁止后续调度。
  for (const dispose of disposers) dispose();
  await new Promise((resolve) => setTimeout(resolve, 50)); // 放行仍在等待的微任务
  const afterDispose = calls;
  await new Promise((resolve) => setTimeout(resolve, 900)); // 越过第一个 500ms 重试点
  assert.equal(calls, afterDispose, '卸载后不应再有兜底轮询回调');
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
  await apply(ctx, { webApi: 'auto' });
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
  assert.match(all.text, /最后游玩 (\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}|从未)/, '时间应带本机时区偏移');

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

test('steam_games 过滤无结果时不谎称本机装了 0 个游戏', async (t) => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});
  const all = await call(tools, 'steam_games', {});
  const installed = /已安装 (\d+) 个游戏/.exec(all.text);
  const count = installed === null ? 0 : Number(installed[1]);
  if (count === 0) {
    t.skip('本机没有已安装游戏，无法验证「过滤为空」的措辞');
    return;
  }
  const { text } = await call(tools, 'steam_games', { filter: 'zzz-绝对没有这个游戏-zzz' });
  assert.match(text, /没有匹配「zzz-绝对没有这个游戏-zzz」的游戏（共 \d+ 个已安装）/);
  assert.match(text, new RegExp(`共 ${count} 个已安装`), '应报出真实安装数');
  assert.equal(text.includes('已安装 0 个游戏'), false);
});

test('steam_workshop_local 保留目录遍历截断标记与列表截断提示', async () => {
  const { registerLocalTools } = await import('../lib/tools/local.js');
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  const item = (id, truncated) => ({
    appid: 1158310,
    publishedFileId: String(id),
    path: `C:\\Steam\\steamapps\\workshop\\content\\1158310\\${id}`,
    libraryPath: 'C:\\Steam',
    sizeBytes: 1024,
    files: 3,
    truncated,
    mtimeMs: 1700000000000,
  });
  const deps = {
    library: {
      read: async () => ({
        detected: true,
        root: 'C:\\Steam',
        candidates: ['C:\\Steam'],
        libraries: [],
        games: [{ appid: 1158310, name: 'Crusader Kings III' }],
        workshop: [item(1, true), item(2, false), item(3, false)],
        accounts: [],
        health: { totalSizeBytes: 0, missingInstalls: [], orphanDirs: [], duplicateAppIds: [] },
      }),
    },
  };
  registerLocalTools(ctx, { maxListedApps: 200 }, deps);

  const full = await tools.get('steam_workshop_local').execute({}, {});
  assert.match(full.text, /目录遍历已截断，大小与文件数偏小/);
  assert.equal(full.text.includes('…… 共'), false, '三条都在 limit 内，不该出现列表截断');

  const limited = await tools.get('steam_workshop_local').execute({ limit: 2 }, {});
  assert.match(limited.text, /共 3 项创意工坊内容，只显示了前 2 个/, '列表截断提示不能丢');
});

test('steam_search / steam_store_app / steam_reviews / steam_app_stats 打真实端点', { skip: !LIVE }, async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, {});

  const details = await call(tools, 'steam_store_app', { appid: 431960 });
  assert.match(details.text, /Wallpaper Engine/);

  const search = await call(tools, 'steam_search', { term: 'Crusader Kings', limit: 3 });
  assert.match(search.text, /商店搜索「Crusader Kings」命中 \d+ 条/);

  const reviews = await call(tools, 'steam_reviews', { appid: 1158310, sampleLimit: 2, language: 'schinese', sort: 'recent' });
  assert.match(reviews.text, /好评率/);
  assert.match(reviews.text, /样本 2 条/);
  assert.match(reviews.text, /schinese/);

  const stats = await call(tools, 'steam_app_stats', { appid: 431960, achievementLimit: 3 });
  assert.match(stats.text, /当前在线/);

  const notFound = await call(tools, 'steam_store_app', { appid: 999999999 });
  assert.match(notFound.text, /没有返回|没有这个 appid/);
});

test('工坊上限跟接口单页上限对齐，评测/工坊的翻页参数可被模型发现', async () => {
  const { ctx, tools } = makeCtx();
  await apply(ctx, { webApi: 'on' });

  const workshop = tools.get('steam_workshop_search');
  assert.match(workshop.parameters.properties.limit.description, /100/, '描述里必须写清单页上限');
  assert.equal(workshop.parameters.properties.queryType.enum.length, 6);
  assert.equal(workshop.parameters.properties.page.type, 'integer', '工坊搜索要能翻页');

  const reviews = tools.get('steam_reviews');
  assert.deepEqual(reviews.parameters.properties.sort.enum, ['helpful', 'recent', 'updated', 'funny']);
  assert.deepEqual(reviews.parameters.properties.sentiment.enum, ['all', 'positive', 'negative']);
  assert.equal(reviews.parameters.properties.cursor.type, 'string', '评测要能按 cursor 翻页');
  assert.match(reviews.description, /IUserReviewsService|2026-10-22/);

  assert.match(tools.get('steam_app_stats').description, /本地化/);
  assert.match(tools.get('steam_status').description, /PID/);
  assert.match(tools.get('steam_status').description, /证书/);
  // 0.3.0：描述里的「不联网 / 不需要 API Key」样板收敛，只在 steam_status 说一次。
  for (const toolName of ['steam_games', 'steam_game', 'steam_library_health', 'steam_workshop_local', 'steam_search', 'steam_store_app', 'steam_reviews', 'steam_app_stats']) {
    assert.equal(/不需要 API Key|不联网/.test(tools.get(toolName).description), false, `${toolName} 的描述里不该再重复样板`);
  }
  assert.match(tools.get('steam_status').description, /不联网、不需要 API Key/);
  // 「10 条上限」只在 limit 参数描述里说一次。
  assert.equal(/10 条/.test(tools.get('steam_search').description), false);
  assert.match(tools.get('steam_search').parameters.properties.limit.description, /最多返回 10 条/);
});

test('steam_workshop_search 真的把 limit=200 夹到 100，而不是只改描述', async () => {
  const { registerWebApiTools } = await import('../lib/tools/webapi.js');
  const seen = [];
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  const deps = {
    http: {
      async json(url) {
        seen.push(url);
        return { ok: true, data: { response: { total: 0, publishedfiledetails: [] } } };
      },
    },
    getApiKey: async () => 'F'.repeat(32),
    library: { read: async () => ({ detected: false, games: [], accounts: [] }) },
  };
  registerWebApiTools(ctx, { apiKeyEnv: 'STEAM_API_KEY', maxListedApps: 200, storeLanguage: 'schinese' }, deps);

  await tools.get('steam_workshop_search').execute({ limit: 200 }, {});
  assert.equal(new URL(seen.at(-1)).searchParams.get('numperpage'), '100');

  await tools.get('steam_workshop_search').execute({ limit: 50 }, {});
  assert.equal(new URL(seen.at(-1)).searchParams.get('numperpage'), '50');

  await tools.get('steam_workshop_search').execute({ page: 3, limit: 10 }, {});
  assert.equal(new URL(seen.at(-1)).searchParams.get('page'), '3', 'page 必须真的传给接口');
});

test('steam_workshop_search 翻页：回显下一页页码，不丢既有统计', async () => {
  const { registerWebApiTools } = await import('../lib/tools/webapi.js');
  const seen = [];
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  const details = Array.from({ length: 5 }, (unused, index) => ({
    publishedfileid: String(1000 + index),
    title: `Mod ${index}`,
    consumer_appid: 1158310,
    app_name: 'Crusader Kings III',
    file_size: '1024',
    time_updated: 1700000000,
    tags: [],
  }));
  const deps = {
    http: {
      async json(url) {
        seen.push(url);
        return { ok: true, data: { response: { total: 42, publishedfiledetails: details } } };
      },
    },
    getApiKey: async () => 'F'.repeat(32),
    library: { read: async () => ({ detected: false, games: [], accounts: [] }) },
  };
  registerWebApiTools(ctx, { apiKeyEnv: 'STEAM_API_KEY', maxListedApps: 200, storeLanguage: 'schinese' }, deps);
  const { text } = await tools.get('steam_workshop_search').execute({ page: 2, limit: 5 }, {});
  assert.equal(new URL(seen.at(-1)).searchParams.get('page'), '2');
  assert.match(text, /共 42 条匹配（第 2 页，本页 5 条）/);
  assert.match(text, /下一页：page=3/);
});
