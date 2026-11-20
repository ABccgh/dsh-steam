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

/** Windows 注册表里可能出现 Steam 路径的键值，按优先级排列。 */
const REGISTRY_LOCATIONS = [
  { psPath: 'HKCU:\\Software\\Valve\\Steam', value: 'SteamPath' },
  { psPath: 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
  { psPath: 'HKLM:\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
];

/** 查注册表的 PowerShell 超时。注册表读取本身是毫秒级，这里只防卡死。 */
const REGISTRY_TIMEOUT_MS = 5000;

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
    // 只保留系统盘常见路径：其它盘符的安装由注册表与 libraryfolders.vdf 覆盖，
    // 写死 D:\ 之类的候选只会在别人的机器上白扫一遍。
    return [
      env['ProgramFiles(x86)'] ? path.win32.join(env['ProgramFiles(x86)'], 'Steam') : undefined,
      env.ProgramFiles ? path.win32.join(env.ProgramFiles, 'Steam') : undefined,
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
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
 * 生成一条 PowerShell 命令：按优先级尝试注册表位置，输出 `<PowerShell 路径>|<值名>|<路径>`。
 *
 * 为什么不用 `reg.exe`：它的 stdout 走控制台代码页（中文 Windows 上是 GBK/CP936），
 * Node 按 latin1 解码会把非 ASCII 的安装路径变成乱码。PowerShell 里先强制
 * `[Console]::OutputEncoding` 为 UTF-8，输出重定向时也生效；Node 再按 UTF-8 解码。
 * @returns {string} PowerShell 命令文本。
 */
export function registryQueryCommand() {
  return [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$locations = @(',
    ...REGISTRY_LOCATIONS.map((location, index) => {
      const comma = index === REGISTRY_LOCATIONS.length - 1 ? '' : ',';
      return `  @('${location.psPath}', '${location.value}')${comma}`;
    }),
    ')',
    'foreach ($location in $locations) {',
    '  $value = (Get-ItemProperty -LiteralPath $location[0] -Name $location[1]).$($location[1])',
    "  if (-not [string]::IsNullOrWhiteSpace($value)) { Write-Output ($location[0] + '|' + $location[1] + '|' + $value); break }",
    '}',
  ].join('\n');
}

/**
 * 解析注册表查询的输出，取第一条有效结果。
 *
 * `stdout` 可能是原始字节（默认执行器的返回值）。必须显式按 UTF-8 解码：
 * Steam 装在中文或带空格的路径下时，按 latin1 / 控制台代码页解码都会得到乱码。
 * @param {string | Buffer} stdout - PowerShell 的 stdout。
 * @returns {{ psPath: string, valueName: string, root: string } | undefined} 命中项。
 */
export function parseRegistryOutput(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (trimmed === '') continue;
    const [psPath, valueName, ...rest] = trimmed.split('|');
    const root = rest.join('|').trim();
    if (psPath === undefined || valueName === undefined || psPath.trim() === '' || valueName.trim() === '' || root === '') continue;
    return { psPath: psPath.trim(), valueName: valueName.trim(), root };
  }
  return undefined;
}

/**
 * 默认的 PowerShell 执行器：返回未解码的 stdout 字节。
 * @param {string} command - PowerShell 命令。
 * @returns {Promise<Buffer>} stdout 原始字节。
 */
async function runPowerShell(command) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'buffer', windowsHide: true, timeout: REGISTRY_TIMEOUT_MS, maxBuffer: 64 * 1024 },
  );
  return stdout;
}

/**
 * 读 Windows 注册表里的 Steam 路径。非 Windows 或读取失败一律返回 `undefined`。
 * @param {{ run?: (command: string) => Promise<string | Buffer>,
 *   looksLike?: (dir: string) => boolean }} [options] - 测试注入用的执行器与根目录判定。
 * @returns {Promise<{ root: string, source: string } | undefined>} 命中的路径及其来源键。
 */
export async function readRegistrySteamPath(options = {}) {
  if (process.platform !== 'win32') return undefined;
  const run = options.run ?? runPowerShell;
  const looksLike = options.looksLike ?? looksLikeSteamRoot;
  let stdout;
  try {
    stdout = await run(registryQueryCommand());
  } catch {
    // PowerShell 不可用：交给平台的常见路径兜底。
    return undefined;
  }
  const parsed = parseRegistryOutput(stdout);
  if (parsed === undefined) return undefined;
  const root = path.win32.normalize(parsed.root);
  if (!looksLike(root)) return undefined;
  // 与旧实现保持同样的来源格式：registry:HKCU\Software\Valve\Steam\SteamPath。
  const hiveKey = parsed.psPath.replace(/^([A-Z]+):/, '$1');
  return { root, source: `registry:${hiveKey}\\${parsed.valueName}` };
}

/**
 * 找到本机的 Steam 根目录。
 *
 * 顺序是「显式配置 → 注册表 → 平台常见路径」。显式配置无效时**继续自动探测**，
 * 而不是直接返回「没装 Steam」——一个写错的 steamPath 不该让插件静默停摆。
 * @param {{ steamPath?: string, readRegistry?: Function }} [options] - `steamPath` 为显式配置，
 *   优先于自动探测；`readRegistry` 仅供测试注入。
 * @returns {Promise<{ detected: boolean, root?: string, source?: string, candidates: string[] }>}
 *   探测结果；`candidates` 是实际尝试过的路径，用于「没装 Steam」时的解释。
 */
export async function findSteamRoot(options = {}) {
  const candidates = [];
  const configured = typeof options.steamPath === 'string' ? options.steamPath.trim() : '';
  if (configured !== '') {
    const root = path.normalize(configured);
    candidates.push(root);
    if (looksLikeSteamRoot(root)) return { detected: true, root, source: 'config:steamPath', candidates };
    // 配置写错：把路径留在 candidates 里解释「找过哪里」，然后继续自动探测。
  }

  const readRegistry = options.readRegistry ?? readRegistrySteamPath;
  const registry = await readRegistry();
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
