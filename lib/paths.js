/**
 * Steam 安装位置与库根（library folder）的探测。
 *
 * 探测顺序刻意保守：显式配置 → 注册表 → 平台常见路径。任一步失败都不会抛出，
 * 而是继续下一步，最终由调用方决定「没装 Steam」要怎么说。
 *
 * @module dsh-steam/paths
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseVdf, vdfString } from './vdf.js';

const execFileAsync = promisify(execFile);

/** Windows 注册表里可能出现 Steam 路径的键值。 */
const REGISTRY_LOCATIONS = [
  { hive: 'HKCU', key: 'Software\\Valve\\Steam', value: 'SteamPath' },
  { hive: 'HKLM', key: 'SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
  { hive: 'HKLM', key: 'SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
];

/**
 * 把路径归一化成可比较的键。Windows 上大小写不敏感，其它平台保持原样。
 * @param {string} target - 原始路径。
 * @param {NodeJS.Platform} [platform] - 目标平台，默认当前平台。
 * @returns {string} 比较用的键。
 */
export function pathKey(target, platform = process.platform) {
  const normalized = platform === 'win32' ? path.win32.normalize(target) : path.posix.normalize(target);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 平台常见的 Steam 安装目录（不含注册表结果）。
 * @param {NodeJS.Platform} platform - 目标平台。
 * @param {NodeJS.ProcessEnv} env - 环境变量快照。
 * @param {string} home - 用户主目录。
 * @returns {string[]} 候选目录，按优先级排列。
 */
export function candidateSteamRoots(platform, env, home) {
  if (platform === 'win32') {
    return [
      env['ProgramFiles(x86)'] ? path.win32.join(env['ProgramFiles(x86)'], 'Steam') : undefined,
      env.ProgramFiles ? path.win32.join(env.ProgramFiles, 'Steam') : undefined,
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      'D:\\Program Files (x86)\\Steam',
      'D:\\Steam',
    ].filter((entry) => typeof entry === 'string');
  }
  if (platform === 'darwin') {
    return [path.posix.join(home, 'Library', 'Application Support', 'Steam')];
  }
  return [
    path.posix.join(home, '.steam', 'steam'),
    path.posix.join(home, '.steam', 'root'),
    path.posix.join(home, '.local', 'share', 'Steam'),
    path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ];
}

/**
 * 判断一个目录看起来是不是 Steam 根目录。
 * @param {string} dir - 待检查的目录。
 * @returns {boolean} 是否像 Steam 根目录。
 */
export function looksLikeSteamRoot(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return false;
  return (
    existsSync(path.join(dir, 'steam.exe')) ||
    existsSync(path.join(dir, 'steam.sh')) ||
    existsSync(path.join(dir, 'steamapps')) ||
    existsSync(path.join(dir, 'SteamApps'))
  );
}

/**
 * 读 Windows 注册表里的 Steam 路径。非 Windows 或读取失败一律返回 `undefined`。
 * @returns {Promise<{ root: string, source: string } | undefined>} 命中的路径及其来源键。
 */
export async function readRegistrySteamPath() {
  if (process.platform !== 'win32') return undefined;
  for (const location of REGISTRY_LOCATIONS) {
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', `${location.hive}\\${location.key}`, '/v', location.value],
        { encoding: 'latin1', windowsHide: true, timeout: 5000 },
      );
      const match = /REG_SZ\s+(.+?)\s*$/m.exec(stdout);
      if (match && match[1]) {
        const root = path.win32.normalize(match[1]);
        if (looksLikeSteamRoot(root)) {
          return { root, source: `registry:${location.hive}\\${location.key}\\${location.value}` };
        }
      }
    } catch {
      // 键不存在或 reg.exe 不可用：继续查下一个位置。
    }
  }
  return undefined;
}

/**
 * 找到本机的 Steam 根目录。
 * @param {{ steamPath?: string }} [options] - `steamPath` 为显式配置，优先于自动探测。
 * @returns {Promise<{ detected: boolean, root?: string, source?: string, candidates: string[] }>}
 *   探测结果；`candidates` 是实际尝试过的路径，用于「没装 Steam」时的解释。
 */
export async function findSteamRoot(options = {}) {
  const configured = typeof options.steamPath === 'string' ? options.steamPath.trim() : '';
  if (configured !== '') {
    const root = path.normalize(configured);
    if (looksLikeSteamRoot(root)) return { detected: true, root, source: 'config:steamPath', candidates: [root] };
    return { detected: false, candidates: [root] };
  }

  const candidates = [];
  const registry = await readRegistrySteamPath();
  if (registry) {
    candidates.push(registry.root);
    return { detected: true, root: registry.root, source: registry.source, candidates };
  }

  for (const candidate of candidateSteamRoots(process.platform, process.env, homedir())) {
    candidates.push(candidate);
    if (looksLikeSteamRoot(candidate)) {
      return { detected: true, root: candidate, source: 'platform-default', candidates };
    }
  }
  return { detected: false, candidates };
}

/**
 * 找到承载库列表的 `libraryfolders.vdf`。
 * 新版 Steam 放在 `config/` 下，旧版放在 `steamapps/` 下，两者都可能是唯一存在的那份。
 * @param {string} root - Steam 根目录。
 * @returns {string | undefined} 文件路径。
 */
export function findLibraryVdf(root) {
  const candidates = [
    path.join(root, 'config', 'libraryfolders.vdf'),
    path.join(root, 'steamapps', 'libraryfolders.vdf'),
    path.join(root, 'SteamApps', 'libraryfolders.vdf'),
  ];
  return candidates.find((entry) => existsSync(entry));
}

/**
 * 列出所有库根（含 Steam 安装目录自身与显式追加的路径）。
 * @param {string} root - Steam 根目录。
 * @param {string[]} [extraLibraryPaths] - 额外追加的库根。
 * @returns {{ libraries: Array<{ path: string, label: string, source: string }>, vdfFile?: string, error?: string }}
 *   去重后的库根；解析失败时带 `error`，但仍返回已能确定的库根。
 */
export function resolveLibraryRoots(root, extraLibraryPaths = []) {
  /** @type {Map<string, { path: string, label: string, source: string }>} */
  const found = new Map();
  const add = (target, source, label = '') => {
    if (typeof target !== 'string' || target.trim() === '') return;
    const normalized = path.normalize(target.trim());
    const key = pathKey(normalized);
    const existing = found.get(key);
    if (existing === undefined) {
      found.set(key, { path: normalized, label, source });
      return;
    }
    // 同一个库被两种来源报了两次。注册表里的 SteamPath 是小写正斜杠形式，
    // 而 libraryfolders.vdf 里是 Steam 自己写的规范大小写——后者更该出现在输出里，
    // 所以只更新拼写，保留最初的来源标识。
    if (normalized !== existing.path && source !== 'steam-root') existing.path = normalized;
    if (existing.label === '' && label !== '') existing.label = label;
  };

  add(root, 'steam-root');

  const vdfFile = findLibraryVdf(root);
  let error;
  if (vdfFile === undefined) {
    error = 'libraryfolders.vdf 不存在';
  } else {
    try {
      const parsed = parseVdf(readFileUtf8(vdfFile), { sourceName: vdfFile });
      const block = parsed.libraryfolders ?? parsed.LibraryFolders ?? {};
      if (block && typeof block === 'object') {
        for (const [key, value] of Object.entries(block)) {
          // 新格式：每个库是一个带 path/label 的对象。
          if (value && typeof value === 'object') {
            const libraryPath = vdfString(/** @type {Record<string, unknown>} */ (value).path);
            const label = vdfString(/** @type {Record<string, unknown>} */ (value).label);
            add(libraryPath, 'libraryfolders.vdf', label);
            continue;
          }
          // 旧格式：数字键的值直接就是路径。同一份文件里还有
          // TimeNextStatsReport / ContentStatsID 之类的字符串元数据，
          // 它们的键不是数字，必须排除，否则会被当成库根。
          if (typeof value === 'string' && /^\d+$/.test(key)) {
            add(value, 'libraryfolders.vdf:legacy');
          }
        }
      }
    } catch (cause) {
      error = `libraryfolders.vdf 解析失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  for (const extra of extraLibraryPaths) add(extra, 'config:extraLibraryPaths');

  return { libraries: [...found.values()], vdfFile, error };
}

/**
 * 同步读一个 UTF-8 文本文件。库列表本来就只有几百字节，同步读让
 * `resolveLibraryRoots` 保持同步、便于单测。
 * @param {string} file - 文件路径。
 * @returns {string} 文件内容。
 */
function readFileUtf8(file) {
  return readFileSync(file, 'utf8');
}
