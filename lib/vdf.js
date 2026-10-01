/**
 * Valve KeyValues（VDF / ACF）解析器。
 *
 * Steam 的 `libraryfolders.vdf`、`appmanifest_*.acf`、`loginusers.vdf`、`localconfig.vdf`
 * 都是这套格式：由 `"键" "值"` 对和 `{ }` 嵌套块组成，制表符或空格分隔，`//` 行注释。
 *
 * 设计取舍：
 * - 纯函数、零依赖，方便单测，也方便在 host 侧插件里同步使用。
 * - 重复键按 Valve 的语义「后写的胜出」，不报错（Steam 自己会这么写）。
 * - `__proto__` / `constructor` / `prototype` 三个键会被丢弃，避免解析外部文件时污染原型。
 * - `#base` / `#include` 这类指令连同其参数一起跳过：本模块只读取当前文件的内容，
 *   不跟着指令去读别的文件（Steam 的库文件里目前没有用到，属于防御性处理）。
 * - 括号不配平、字符串引号未闭合一律**显式抛错**，绝不返回半截对象——静默的错误数据
 *   比一个明确的失败更难排查。
 *
 * @module dsh-steam/vdf
 */

/** 解析失败时抛出的错误，带原始偏移量，便于定位损坏的文件。 */
export class VdfError extends Error {
  /**
   * @param {string} message - 人类可读的失败原因。
   * @param {number} offset - 出错的字符偏移量。
   * @param {string} sourceName - 出错的文件名（用于拼接消息）。
   */
  constructor(message, offset, sourceName) {
    super(`${sourceName}: ${message} (offset ${offset})`);
    this.name = 'VdfError';
    this.offset = offset;
    this.sourceName = sourceName;
  }
}

/** 会被丢弃的危险键名。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 判断一个字符码是否为 VDF 的空白字符。
 * @param {number} code - 字符码。
 * @returns {boolean} 是否为空白。
 */
function isSpace(code) {
  return code === 32 || code === 9 || code === 13 || code === 10 || code === 11 || code === 12;
}

/**
 * 解析一段 VDF / ACF 文本。
 * @param {string} source - 文件内容。
 * @param {{ sourceName?: string }} [options] - `sourceName` 只出现在错误消息里。
 * @returns {Record<string, unknown>} 顶层块；空文件返回 `{}`。
 * @throws {VdfError} 文本不是合法的 KeyValues 时。
 */
export function parseVdf(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('parseVdf 需要字符串输入');
  const sourceName = options.sourceName ?? 'vdf';
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const n = text.length;
  let i = 0;

  /**
   * 抛出一个带偏移量的解析错误。
   * @param {string} message - 失败原因。
   * @param {number} [at] - 偏移量，默认当前游标。
   */
  const fail = (message, at = i) => {
    throw new VdfError(message, at, sourceName);
  };

  /** 跳过空白与 `//` 行注释。 */
  const skipTrivia = () => {
    for (;;) {
      while (i < n && isSpace(text.charCodeAt(i))) i += 1;
      if (text.charCodeAt(i) === 0x2f && text.charCodeAt(i + 1) === 0x2f) {
        i += 2;
        while (i < n && text.charCodeAt(i) !== 0x0a) i += 1;
        continue;
      }
      return;
    }
  };

  /**
   * 读一个 token：带引号的字符串，或一段裸词。
   * 带引号的字符串里 `\\` `\"` `\n` `\t` `\r` 会被还原，其余 `\x` 退化为字面 `x`
   * （Windows 路径里 `D:\\Program Files` 正是这种写法）。
   * @returns {string} token 的解码值。
   */
  const readToken = () => {
    if (text[i] === '"') {
      const start = i;
      i += 1;
      let out = '';
      for (;;) {
        if (i >= n) fail('字符串没有闭合的引号', start);
        const c = text[i];
        if (c === '\\') {
          const next = text[i + 1];
          if (next === undefined) fail('字符串以孤立的反斜杠结尾');
          i += 2;
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else out += next;
          continue;
        }
        if (c === '"') {
          i += 1;
          return out;
        }
        out += c;
        i += 1;
      }
    }

    const start = i;
    while (i < n) {
      const c = text[i];
      if (isSpace(text.charCodeAt(i)) || c === '{' || c === '}' || c === '"') break;
      if (c === '/' && text[i + 1] === '/') break;
      i += 1;
    }
    if (i === start) fail('期望一个键或值，却没有可读的内容');
    return text.slice(start, i);
  };

  /**
   * 解析一串 `"键" "值"` / `"键" { ... }` 对，直到遇到终止符或文件结尾。
   * @param {boolean} expectClose - `true` 表示这是 `{` 打开的块，必须遇到 `}`。
   * @param {number} openAt - 该块 `{` 的偏移量，仅用于错误消息。
   * @returns {Record<string, unknown>} 解析出的对象。
   */
  const parsePairs = (expectClose, openAt) => {
    /** @type {Record<string, unknown>} */
    const out = {};

    for (;;) {
      skipTrivia();
      if (i >= n) {
        if (expectClose) fail('块没有闭合的 "}"', openAt);
        return out;
      }
      if (text[i] === '}') {
        if (!expectClose) fail('多出来一个没有对应 "{" 的 "}"');
        i += 1;
        return out;
      }
      if (text[i] === '#') {
        readToken();
        skipTrivia();
        if (i < n && text[i] !== '}' && text[i] !== '{') readToken();
        continue;
      }

      const key = readToken();
      skipTrivia();
      if (i >= n || text[i] === '}') fail(`键 ${JSON.stringify(key)} 之后缺少值`);
      const value = text[i] === '{' ? parseObject() : readToken();
      if (!DANGEROUS_KEYS.has(key)) out[key] = value;
    }
  };

  /**
   * 解析一个 `{ ... }` 块；调用时游标必须停在 `{` 上。
   * @returns {Record<string, unknown>} 该块的内容。
   */
  const parseObject = () => {
    if (text[i] !== '{') fail('期望一个 "{"');
    const openAt = i;
    i += 1;
    return parsePairs(true, openAt);
  };

  skipTrivia();
  if (i >= n) return {};
  // `"root" { ... }` 与裸的 `{ ... }` 都是合法的顶层写法，Steam 两种都用。
  if (text[i] !== '{') return parsePairs(false, 0);
  const root = parseObject();
  skipTrivia();
  if (i < n) fail(`顶层块之后还有多余内容：${JSON.stringify(text.slice(i, i + 24))}`);
  return root;
}

/**
 * 从已解析的 VDF 对象里取一个字符串值。
 * @param {unknown} value - 原始值。
 * @param {string} [fallback] - 不是字符串时的返回值。
 * @returns {string} 字符串值或回退值。
 */
export function vdfString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 从已解析的 VDF 对象里取一个整数值。VDF 里所有标量都是字符串。
 * @param {unknown} value - 原始值。
 * @param {number} [fallback] - 无法解析时的返回值。
 * @returns {number} 整数值或回退值。
 */
export function vdfInt(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
