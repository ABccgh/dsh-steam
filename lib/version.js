/**
 * 插件版本。`package.json` 与本常量必须一致（`test/plugin.test.js` 会断言）。
 *
 * 单独放一个模块是因为 Host 进程会缓存已加载的 ESM 模块，版本号不能靠读
 * `package.json` 的运行时值来「顺手更新」——它是构建期常量，改版本要改两处。
 *
 * @module dsh-steam/version
 */

export const VERSION = '0.3.0';
