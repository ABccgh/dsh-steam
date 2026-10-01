import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVdf, vdfInt, vdfString, VdfError } from '../lib/vdf.js';

test('解析新版 libraryfolders.vdf 的嵌套结构', () => {
  const source = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"D:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"contentid"\t\t"2909953242563285333"
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"143055920"
\t\t\t"431960"\t\t"826275581"
\t\t}
\t}
}
`;
  const root = parseVdf(source, { sourceName: 'libraryfolders.vdf' });
  const library = root.libraryfolders;
  assert.ok(library && typeof library === 'object');
  assert.equal(library['0'].path, 'D:\\Program Files (x86)\\Steam');
  assert.equal(library['0'].label, '');
  assert.equal(library['0'].apps['431960'], '826275581');
  assert.equal(vdfInt(library['0'].apps['228980']), 143055920);
});

test('解析旧版 libraryfolders.vdf：数值键直接就是路径', () => {
  const source = '"libraryfolders"\n{\n\t"1"\t\t"D:\\\\SteamLibrary"\n\t"2"\t\t"E:\\\\Games\\\\Steam"\n}\n';
  const root = parseVdf(source);
  assert.deepEqual(root.libraryfolders, {
    '1': 'D:\\SteamLibrary',
    '2': 'E:\\Games\\Steam',
  });
});

test('解析 appmanifest 的混合类型值', () => {
  const source = `"AppState"
{
\t"appid"\t\t"1787090"
\t"name"\t\t"MyDockFinder"
\t"StateFlags"\t\t"4"
\t"LastPlayed"\t\t"1790828832"
\t"InstalledDepots"
\t{
\t\t"1787091"
\t\t{
\t\t\t"manifest"\t\t"5016341934966195044"
\t\t\t"size"\t\t"176593081"
\t\t}
\t}
\t"UserConfig"
\t{
\t\t"language"\t\t"schinese"
\t}
}`;
  const root = parseVdf(source, { sourceName: 'appmanifest_1787090.acf' });
  assert.equal(root.AppState.appid, '1787090');
  assert.equal(root.AppState.InstalledDepots['1787091'].size, '176593081');
  assert.equal(root.AppState.UserConfig.language, 'schinese');
});

test('处理 BOM、CRLF、行注释与多余空白', () => {
  const source = '\uFEFF// Steam 写出来的文件可能带 BOM\r\n\r\n"root"\r\n{\r\n\t"a" \t "1"   // 行尾注释\r\n\t// 整行注释\r\n\t"b"\t"2"\r\n}\r\n';
  const root = parseVdf(source);
  assert.deepEqual(root, { root: { a: '1', b: '2' } });
});

test('未加引号的裸键值也能解析', () => {
  assert.deepEqual(parseVdf('{ a 1 b 2 }'), { a: '1', b: '2' });
  assert.deepEqual(parseVdf('{ a { b 2 } }'), { a: { b: '2' } });
  assert.deepEqual(parseVdf('root { a 1 }'), { root: { a: '1' } });
});

test('重复键以后写的为准', () => {
  const root = parseVdf('{ "k" "first" "k" "second" }');
  assert.deepEqual(root, { k: 'second' });
});

test('空文件与纯空白文件返回空对象', () => {
  assert.deepEqual(parseVdf(''), {});
  assert.deepEqual(parseVdf('  \r\n\t // 只有注释\n'), {});
});

test('跳过 #base / #include 指令而不去读别的文件', () => {
  const root = parseVdf('#base "shared.vdf"\n"root"\n{\n\t"a"\t"1"\n}\n');
  assert.deepEqual(root, { root: { a: '1' } });
});

test('没有对应 "{" 的 "}" 会被报错而不是被忽略', () => {
  assert.throws(() => parseVdf('"a" "1" }'), VdfError);
});

test('丢弃 __proto__ / constructor / prototype 键', () => {
  const root = parseVdf('{ "__proto__" "polluted" "constructor" "x" "ok" "1" }');
  assert.deepEqual(Object.keys(root), ['ok']);
  assert.equal(Object.getPrototypeOf(root), Object.prototype);
});

test('块缺少闭合括号时抛 VdfError 而不是返回半截对象', () => {
  assert.throws(() => parseVdf('{ "a" "1" ', { sourceName: 'broken.acf' }), (error) => {
    assert.ok(error instanceof VdfError);
    assert.match(error.message, /broken\.acf/);
    assert.match(error.message, /没有闭合/);
    return true;
  });
});

test('字符串引号未闭合时抛 VdfError', () => {
  assert.throws(() => parseVdf('{ "a" "1 }'), VdfError);
});

test('顶层块之后有多余内容时抛 VdfError', () => {
  assert.throws(() => parseVdf('{ "a" "1" } trailing'), VdfError);
});

test('键之后缺少值时报错并指出键名', () => {
  assert.throws(() => parseVdf('{ "a" }'), (error) => {
    assert.match(error.message, /"a"/);
    return true;
  });
});

test('vdfInt / vdfString 对缺失与非法输入给出回退值', () => {
  assert.equal(vdfInt(undefined, -1), -1);
  assert.equal(vdfInt('', -1), -1);
  assert.equal(vdfInt('abc', -1), -1);
  assert.equal(vdfInt('42'), 42);
  assert.equal(vdfInt(7.9), 7);
  assert.equal(vdfString(undefined, 'x'), 'x');
  assert.equal(vdfString('y', 'x'), 'y');
});
