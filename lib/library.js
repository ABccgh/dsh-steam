/**
 * 本机 Steam 库的扫描：已安装游戏、占用、账号、创意工坊内容，以及库自身的健康问题。
 *
 * 这一层只做「读文件 + 汇总」，不发任何网络请求，也不修改任何东西。所有失败都
 * 收敛成结构化的 error 字段，让上层的工具能把「哪一步没读到」讲清楚。
 *
 * @module dsh-steam/library
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { findLibraryVdf, findSteamRoot, pathKey, resolveLibraryRoots } from './paths.js';
import { parseVdf, vdfInt, vdfString } from './vdf.js';

const execFileAsync = promisify(execFile);

/**
 * 已确认含义的 StateFlags 位。含义未经确认的位一律原样回报成 `bit<N>`，
 * 而不是猜一个听起来合理的标签。
 */
export const STATE_FLAG_LABELS = new Map([
  [1, '未安装'],
  [2, '需要更新'],
  [4, '已完整安装'],
  [8, '更新已开始'],
  [16, '正在更新'],
  [32, '更新已暂停'],
  [128, '文件缺失'],
  [256, '仅共享'],
  [512, '正在运行'],
]);

/**
 * 把 appmanifest 的 StateFlags 拆成原值与标签。
 * @param {number} flags - 原始 StateFlags。
 * @returns {{ raw: number, labels: string[] }} 原值与已识别的位。
 */
export function describeStateFlags(flags) {
  const raw = Number.isFinite(flags) ? Math.trunc(flags) : 0;
  const labels = [];
  for (const [bit, label] of STATE_FLAG_LABELS) if ((raw & bit) === bit) labels.push(label);
  for (let bit = 1; bit <= 4096; bit <<= 1) {
    if ((raw & bit) === bit && !STATE_FLAG_LABELS.has(bit)) labels.push(`bit${bit}`);
  }
  return { raw, labels };
}

/**
 * 把字节数格式化成人类可读的字符串。
 * @param {number} bytes - 字节数。
 * @returns {string} 例如 `1.23 GiB`；非法输入返回 `未知`。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${value} B`;
  return `${value.toFixed(value >= 100 ? 1 : 2)} ${units[unit]}`;
}

/**
 * 把 Unix 秒时间戳格式化成本机时区的时间，并带上偏移量。
 *
 * 工具输出一律用它：`2026-11-19 22:34 +08:00`。原来的 UTC ISO 字符串（`…T14:34:52Z`）
 * 对 UTC+8 的读者要心算六小时，模型也得先换算才能说「几小时前」。
 *
 * @param {number} seconds - Unix 秒；0 或非法表示从未发生。
 * @returns {string} `YYYY-MM-DD HH:mm ±HH:mm`，或 `从未`。
 */
export function formatUnixLocal(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '从未';
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * 读一个 `appmanifest_<appid>.acf`。
 * @param {string} acfFile - 文件路径。
 * @returns {{ appid: number, name: string, installDir: string, sizeBytes: number, lastPlayed: number,
 *   lastUpdated: number, buildId: string, stateFlags: number, stateLabels: string[], language: string }}
 *   解析结果。
 * @throws {Error} 文件不是合法的 AppState 块时。
 */
export function readAppManifest(acfFile) {
  const parsed = parseVdf(readFileSync(acfFile, 'utf8'), { sourceName: acfFile });
  const state = parsed.AppState;
  if (!state || typeof state !== 'object') throw new Error('缺少 AppState 块');
  const stateFlags = vdfInt(state.StateFlags, 0);
  const userConfig = state.UserConfig && typeof state.UserConfig === 'object' ? state.UserConfig : {};
  return {
    appid: vdfInt(state.appid, Number.NaN),
    name: vdfString(state.name, '(未命名)'),
    installDir: vdfString(state.installdir),
    sizeBytes: vdfInt(state.SizeOnDisk, 0),
    lastPlayed: vdfInt(state.LastPlayed, 0),
    lastUpdated: vdfInt(state.LastUpdated, 0),
    buildId: vdfString(state.buildid),
    stateFlags,
    stateLabels: describeStateFlags(stateFlags).labels,
    language: vdfString(userConfig.language),
  };
}

/**
 * 安全地列目录；目录不存在或不可读时返回空数组。
 * @param {string} dir - 目录路径。
 * @param {{ withFileTypes?: boolean }} [options] - 透传给 `readdirSync`。
 * @returns {any[]} 目录项，失败时为空数组。
 */
function safeReaddir(dir, options = {}) {
  try {
    return readdirSync(dir, options);
  } catch {
    return [];
  }
}

/**
 * 统计一个目录的占用。用显式栈迭代，避免深目录把调用栈打爆。
 * @param {string} dir - 目录路径。
 * @param {{ maxEntries?: number }} [options] - 最多遍历多少个目录项。
 * @returns {{ bytes: number, files: number, truncated: boolean }} 统计结果。
 */
export function directorySize(dir, options = {}) {
  const maxEntries = options.maxEntries ?? 50_000;
  let bytes = 0;
  let files = 0;
  let visited = 0;
  let truncated = false;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReaddir(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return { bytes, files, truncated };
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += statSync(full).size;
        files += 1;
      } catch {
        // 单个文件读不到（权限、竞态）不该让整次统计失败。
      }
    }
  }
  return { bytes, files, truncated };
}

/**
 * 从 `tasklist /FI "IMAGENAME eq steam.exe" /FO CSV /NH` 的输出里抠出 PID。
 *
 * 新版 Steam 不一定写 `steam.pid`（本机就没有），所以只剩 tasklist 这条路；
 * 以前只判断「输出里有没有 steam.exe」，PID 永远是未知。
 *
 * @param {string} stdout - tasklist 输出。
 * @returns {number | undefined} PID，找不到时 undefined。
 */
export function parseTasklistSteamPid(stdout) {
  const text = String(stdout ?? '');
  for (const line of text.split(/\r?\n/)) {
    const csv = /^"?steam\.exe"?\s*,\s*"?(\d+)"?/i.exec(line.trim());
    if (csv !== null) {
      const pid = Number.parseInt(csv[1], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  // 兜底：非 CSV 的表格输出（steam.exe   18540 Console ...）。
  const table = /\bsteam\.exe\s+(\d+)/i.exec(text);
  if (table === null) return undefined;
  const pid = Number.parseInt(table[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * 判断 Steam 客户端当前是否在运行。
 * 优先读 `steam.pid`；文件缺失时在 Windows 上退回 `tasklist`（CSV 输出里能拿到 PID）。
 * @param {string} root - Steam 根目录。
 * @returns {Promise<{ running: boolean, pid?: number, source: string }>} 运行状态。
 */
export async function steamRunning(root) {
  const pidFile = path.join(root, 'steam.pid');
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return { running: true, pid, source: 'steam.pid' };
      } catch (error) {
        if (error && error.code === 'EPERM') return { running: true, pid, source: 'steam.pid' };
        return { running: false, pid, source: 'steam.pid' };
      }
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'latin1', windowsHide: true, timeout: 5000 },
      );
      const pid = parseTasklistSteamPid(stdout);
      if (pid !== undefined) return { running: true, pid, source: 'tasklist' };
      if (/steam\.exe/i.test(stdout)) return { running: true, source: 'tasklist' };
    } catch {
      // tasklist 不可用：只能说「没观察到」。
    }
  }
  return { running: false, source: 'none' };
}

/**
 * 扫描整台机器上的 Steam 安装。
 * @param {{ steamPath?: string, extraLibraryPaths?: string[], includeWorkshop?: boolean,
 *   includeAccounts?: boolean, workshopMaxEntries?: number,
 *   readRegistry?: Function }} [options] - 扫描参数；`readRegistry` 仅供测试注入。
 * @returns {Promise<object>} 见 README 的「数据形状」一节。
 */
export async function scanSteamLibrary(options = {}) {
  const extraLibraryPaths = Array.isArray(options.extraLibraryPaths) ? options.extraLibraryPaths : [];
  const includeWorkshop = options.includeWorkshop !== false;
  const includeAccounts = options.includeAccounts !== false;

  const detection = await findSteamRoot({ steamPath: options.steamPath, readRegistry: options.readRegistry });
  /** @type {any} */
  const result = {
    detected: detection.detected,
    candidates: detection.candidates,
    root: detection.root,
    rootSource: detection.source,
    steamExe: undefined,
    running: false,
    runningSource: 'none',
    pid: undefined,
    libraryVdf: undefined,
    libraryError: undefined,
    libraries: [],
    manifestErrors: [],
    games: [],
    accounts: [],
    accountError: undefined,
    workshop: [],
    health: { totalSizeBytes: 0, orphanDirs: [], missingInstalls: [], duplicateAppIds: [] },
  };
  if (!detection.detected || detection.root === undefined) return result;

  const root = detection.root;
  const steamExe = path.join(root, 'steam.exe');
  if (existsSync(steamExe)) result.steamExe = steamExe;

  const running = await steamRunning(root);
  result.running = running.running;
  result.runningSource = running.source;
  result.pid = running.pid;

  const { libraries, vdfFile, error } = resolveLibraryRoots(root, extraLibraryPaths);
  result.libraryVdf = vdfFile;
  result.libraryError = error;
  // 注册表给的 SteamPath 是小写正斜杠形式；如果库列表里有同一个库的规范拼写，
  // 就用它来显示，免得输出里出现 d:\program files (x86)\steam 这种别扭的路径。
  const canonicalRoot = libraries.find((library) => pathKey(library.path) === pathKey(root));
  if (canonicalRoot !== undefined) {
    result.root = canonicalRoot.path;
    result.libraryVdf = findLibraryVdf(canonicalRoot.path) ?? vdfFile;
  }

  for (const library of libraries) {
    const steamapps = path.join(library.path, 'steamapps');
    /** @type {any} */
    const entry = { path: library.path, label: library.label, source: library.source, apps: 0, sizeBytes: 0 };
    if (!existsSync(steamapps)) {
      entry.error = 'steamapps 目录不存在';
      result.libraries.push(entry);
      continue;
    }

    const installDirs = new Set();
    const manifests = safeReaddir(steamapps).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
    for (const name of manifests) {
      const full = path.join(steamapps, name);
      let manifest;
      try {
        manifest = readAppManifest(full);
      } catch (cause) {
        result.manifestErrors.push({ file: full, error: cause instanceof Error ? cause.message : String(cause) });
        continue;
      }
      const installPath = manifest.installDir === '' ? '' : path.join(steamapps, 'common', manifest.installDir);
      const missing = installPath === '' || !existsSync(installPath);
      const game = { ...manifest, libraryPath: library.path, installPath, missing };
      result.games.push(game);
      entry.apps += 1;
      entry.sizeBytes += manifest.sizeBytes;
      result.health.totalSizeBytes += manifest.sizeBytes;
      if (manifest.installDir !== '') installDirs.add(pathKey(manifest.installDir));
      if (missing) {
        result.health.missingInstalls.push({ appid: game.appid, name: game.name, expected: installPath || '(manifest 里没有 installdir)' });
      }
    }

    // 有目录没 manifest —— 手动删过 acf、或者是第三方工具留下的残留。
    const common = path.join(steamapps, 'common');
    for (const child of safeReaddir(common, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      if (child.name === 'Steamworks Shared' || child.name === 'Steam Controller Configs') continue;
      if (installDirs.has(pathKey(child.name))) continue;
      result.health.orphanDirs.push({ path: path.join(common, child.name), libraryPath: library.path });
    }

    result.libraries.push(entry);
  }

  const seenAppIds = new Set();
  for (const game of result.games) {
    if (seenAppIds.has(game.appid)) result.health.duplicateAppIds.push(game.appid);
    else seenAppIds.add(game.appid);
  }
  result.games.sort((left, right) => right.sizeBytes - left.sizeBytes);

  if (includeWorkshop) {
    for (const library of libraries) {
      const content = path.join(library.path, 'steamapps', 'workshop', 'content');
      if (!existsSync(content)) continue;
      for (const appEntry of safeReaddir(content, { withFileTypes: true })) {
        if (!appEntry.isDirectory()) continue;
        const appid = Number.parseInt(appEntry.name, 10);
        const appDir = path.join(content, appEntry.name);
        for (const item of safeReaddir(appDir, { withFileTypes: true })) {
          if (!item.isDirectory()) continue;
          const itemPath = path.join(appDir, item.name);
          const size = directorySize(itemPath, { maxEntries: options.workshopMaxEntries ?? 20_000 });
          let mtime = 0;
          try {
            mtime = statSync(itemPath).mtimeMs;
          } catch {
            // mtime 拿不到不算失败。
          }
          result.workshop.push({
            appid: Number.isFinite(appid) ? appid : 0,
            publishedFileId: item.name,
            path: itemPath,
            libraryPath: library.path,
            sizeBytes: size.bytes,
            files: size.files,
            truncated: size.truncated,
            mtimeMs: mtime,
          });
        }
      }
    }
    result.workshop.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  if (includeAccounts) {
    const loginUsers = path.join(root, 'config', 'loginusers.vdf');
    if (existsSync(loginUsers)) {
      try {
        const parsed = parseVdf(readFileSync(loginUsers, 'utf8'), { sourceName: loginUsers });
        const users = parsed.users ?? parsed.Users ?? {};
        if (users && typeof users === 'object') {
          for (const [steamId64, value] of Object.entries(users)) {
            if (!value || typeof value !== 'object') continue;
            result.accounts.push({
              // 只回报显示名与 ID，不回登录名（本工具是只读查询，不需要登录名进日志）。
              steamId64,
              personaName: vdfString(value.PersonaName),
              autoLogin: vdfString(value.AutoLogin) === '1',
              timestamp: vdfInt(value.Timestamp, 0),
            });
          }
          result.accounts.sort((left, right) => right.timestamp - left.timestamp);
        }
      } catch (cause) {
        result.accountError = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }

  return result;
}
