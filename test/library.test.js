import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeStateFlags,
  directorySize,
  formatBytes,
  formatUnixSeconds,
  readAppManifest,
  scanSteamLibrary,
} from '../lib/library.js';
import { candidateSteamRoots, looksLikeSteamRoot, pathKey, resolveLibraryRoots } from '../lib/paths.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * 建一棵临时目录树，跑完自动删掉。
 * @param {(root: string) => void} build - 建树回调。
 * @param {(root: string) => void | Promise<void>} run - 断言回调。
 * @returns {Promise<void>} 无。
 */
async function withTempRoot(build, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-steam-'));
  try {
    build(root);
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('pathKey 在 Windows 上忽略大小写，其它平台不忽略', () => {
  assert.equal(pathKey('D:\\Program Files\\Steam', 'win32'), pathKey('d:/program files/steam', 'win32'));
  assert.notEqual(pathKey('/opt/steam', 'linux'), pathKey('/opt/Steam', 'linux'));
});

test('candidateSteamRoots 按平台给出常见路径', () => {
  const windows = candidateSteamRoots('win32', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, 'C:\\Users\\x');
  assert.ok(windows.some((entry) => entry.toLowerCase() === 'c:\\program files (x86)\\steam'));
  const mac = candidateSteamRoots('darwin', {}, '/Users/x');
  assert.deepEqual(mac, ['/Users/x/Library/Application Support/Steam']);
  const linux = candidateSteamRoots('linux', {}, '/home/x');
  assert.ok(linux.includes('/home/x/.steam/steam'));
  assert.ok(linux.includes('/home/x/.local/share/Steam'));
});

test('looksLikeSteamRoot 对不存在的目录与空值返回 false', () => {
  assert.equal(looksLikeSteamRoot(''), false);
  assert.equal(looksLikeSteamRoot('   '), false);
  assert.equal(looksLikeSteamRoot(path.join(tmpdir(), 'definitely-not-steam-8f3a')), false);
});

test('describeStateFlags 只给已知位贴标签，其余原样回报', () => {
  assert.deepEqual(describeStateFlags(4).labels, ['已完整安装']);
  assert.deepEqual(describeStateFlags(6).labels, ['需要更新', '已完整安装']);
  assert.deepEqual(describeStateFlags(1024).labels, ['bit1024']);
  assert.deepEqual(describeStateFlags(0).labels, []);
  assert.deepEqual(describeStateFlags(Number.NaN).labels, []);
});

test('formatBytes 处理 0、小数与非法值', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(123456789), '117.7 MiB');
  assert.equal(formatBytes(-1), '未知');
  assert.equal(formatBytes(Number.NaN), '未知');
});

test('formatUnixSeconds 把 0 与非法值说成「从未」', () => {
  assert.equal(formatUnixSeconds(0), '从未');
  assert.equal(formatUnixSeconds(Number.NaN), '从未');
  assert.equal(formatUnixSeconds(1700000000), '2023-11-14T22:13:20Z');
});

test('readAppManifest 读出 acf 的关键字段', () => {
  const manifest = readAppManifest(path.join(fixtures, 'appmanifest_1234560.acf'));
  assert.equal(manifest.appid, 1234560);
  assert.equal(manifest.name, 'Sample Game');
  assert.equal(manifest.installDir, 'SampleGame');
  assert.equal(manifest.sizeBytes, 123456789);
  assert.equal(manifest.buildId, '12345678');
  assert.equal(manifest.stateFlags, 4);
  assert.deepEqual(manifest.stateLabels, ['已完整安装']);
  assert.equal(manifest.language, 'english');
  assert.ok(manifest.lastPlayed > 0);
});

test('readAppManifest 对缺少 AppState 的文件报错', () => {
  assert.throws(() => readAppManifest(path.join(fixtures, 'loginusers.vdf')), /AppState/);
});

test('resolveLibraryRoots 读新版格式，并把 Steam 根目录也算作一个库', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'config'), { recursive: true });
      writeFileSync(path.join(root, 'config', 'libraryfolders.vdf'), readFixture('libraryfolders.new.vdf'));
    },
    (root) => {
      const { libraries, error, vdfFile } = resolveLibraryRoots(root, []);
      assert.equal(error, undefined);
      assert.ok(vdfFile?.endsWith(path.join('config', 'libraryfolders.vdf')));
      assert.deepEqual(
        libraries.map((entry) => entry.path),
        [root, 'C:\\Program Files (x86)\\Steam'],
      );
      assert.equal(libraries[1].source, 'libraryfolders.vdf');
    },
  );
});

test('resolveLibraryRoots 兼容旧格式，并合并 config:extraLibraryPaths', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'steamapps'), { recursive: true });
      writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), readFixture('libraryfolders.old.vdf'));
    },
    (root) => {
      const { libraries, error } = resolveLibraryRoots(root, ['F:\\ExtraLibrary']);
      assert.equal(error, undefined);
      const paths = libraries.map((entry) => entry.path);
      assert.deepEqual(paths, [root, 'D:\\SteamLibrary', 'E:\\Games\\Steam', 'F:\\ExtraLibrary']);
      assert.equal(libraries[0].source, 'steam-root');
      assert.equal(libraries[3].source, 'config:extraLibraryPaths');
    },
  );
});

test('resolveLibraryRoots 用库列表里的规范拼写覆盖注册表来源的小写路径', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'config'), { recursive: true });
      // 故意把 VDF 里的 path 写成另一个大小写形式，指向同一个目录。
      // VDF 的字符串里反斜杠是转义符，必须写成 \\ 才是字面反斜杠。
      const variant = root.toUpperCase().replace(/\\/g, '\\\\');
      writeFileSync(
        path.join(root, 'config', 'libraryfolders.vdf'),
        `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${variant}"\n\t\t"label"\t\t"我的库"\n\t}\n}\n`,
      );
    },
    (root) => {
      const { libraries } = resolveLibraryRoots(root, []);
      assert.equal(libraries.length, 1, '大小写不同的同一路径不该算成两个库');
      assert.equal(libraries[0].source, 'steam-root', '来源标识保留最初探测到的那个');
      assert.equal(libraries[0].path, root.toUpperCase());
      assert.equal(libraries[0].label, '我的库');
    },
  );
});

test('resolveLibraryRoots 在 libraryfolders.vdf 损坏时保留根目录并带上错误', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'config'), { recursive: true });
      writeFileSync(path.join(root, 'config', 'libraryfolders.vdf'), '"libraryfolders" { "0" { "path" "D:\\x"');
    },
    (root) => {
      const { libraries, error } = resolveLibraryRoots(root, []);
      assert.match(error ?? '', /解析失败/);
      assert.deepEqual(libraries.map((entry) => entry.path), [root]);
    },
  );
});

test('resolveLibraryRoots 在没有 libraryfolders.vdf 时给出明确错误', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'steamapps'), { recursive: true });
    },
    (root) => {
      const { libraries, error } = resolveLibraryRoots(root, []);
      assert.match(error ?? '', /不存在/);
      assert.deepEqual(libraries.map((entry) => entry.path), [root]);
    },
  );
});

test('directorySize 递归统计文件数与字节数', async () => {
  await withTempRoot(
    (root) => {
      mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      writeFileSync(path.join(root, 'a', 'one.bin'), Buffer.alloc(100));
      writeFileSync(path.join(root, 'a', 'b', 'two.bin'), Buffer.alloc(23));
    },
    (root) => {
      const size = directorySize(root);
      assert.equal(size.files, 2);
      assert.equal(size.bytes, 123);
      assert.equal(size.truncated, false);
    },
  );
});

test('directorySize 在 maxEntries 用尽时报 truncated', async () => {
  await withTempRoot(
    (root) => {
      for (let index = 0; index < 10; index += 1) writeFileSync(path.join(root, `f${index}.bin`), 'x');
    },
    (root) => {
      assert.equal(directorySize(root, { maxEntries: 3 }).truncated, true);
    },
  );
});

test('活体扫描：本机 Steam 安装', async (t) => {
  const scan = await scanSteamLibrary({});
  if (!scan.detected) {
    t.skip('本机没有装 Steam，跳过活体扫描');
    return;
  }
  assert.ok(path.isAbsolute(scan.root ?? ''), 'root 应是绝对路径');
  assert.ok(scan.libraries.length >= 1);
  assert.ok(scan.games.length >= 1, '至少应识别出一个已安装游戏');
  assert.ok(scan.games.some((game) => game.sizeBytes > 0), '至少一个游戏应有非零占用');
  assert.ok(scan.accounts.length >= 1, 'loginusers.vdf 应至少给出一个账号');
  for (const game of scan.games) {
    assert.ok(Number.isFinite(game.appid) && game.appid > 0);
    assert.equal(typeof game.missing, 'boolean');
    assert.ok(Array.isArray(game.stateLabels));
  }
  assert.ok(!('accountName' in scan.accounts[0]), '不应把登录名带进结果');
  assert.ok(Array.isArray(scan.health.orphanDirs));
  assert.ok(Array.isArray(scan.workshop));
});

test('活体扫描：显式给出的错误 steamPath 不会静默退回自动探测', async () => {
  const scan = await scanSteamLibrary({ steamPath: path.join(tmpdir(), 'nope-not-steam') });
  assert.equal(scan.detected, false);
  assert.deepEqual(scan.games, []);
  assert.ok(scan.candidates.length >= 1);
});

/**
 * 读一个 fixture 文件。
 * @param {string} name - 文件名。
 * @returns {string} 内容。
 */
function readFixture(name) {
  return readFileSync(path.join(fixtures, name), 'utf8');
}
