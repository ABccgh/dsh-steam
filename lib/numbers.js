/**
 * Steam 的 JSON 接口里，数值字段的类型并不统一：同一个概念在 v1/v2 版本、
 * 不同接口之间可能是数字、也可能是字符串（protobuf-JSON 会把 64 位整数序列化成字符串）。
 *
 * 例如 `GetGlobalAchievementPercentagesForApp/v2` 的 `percent` 是 `"61.1"`，
 * 而 `GetNumberOfCurrentPlayers` 的 `player_count` 是 `76779`。
 *
 * 只认 `Number.isFinite` 会让前者被整体丢弃——所以统一走这里。
 *
 * @module dsh-steam/numbers
 */

/**
 * 把可能是数字、数字字符串、null 的值转成有限数字。
 * @param {unknown} value - 原始值。
 * @returns {number | null} 有限数字，或 `null`。
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 与 {@link toNumber} 相同，但给出回退值。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 无法转换时的返回值。
 * @returns {number} 数字。
 */
export function toNumberOr(value, fallback) {
  const parsed = toNumber(value);
  return parsed === null ? fallback : parsed;
}
