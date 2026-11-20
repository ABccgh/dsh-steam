/**
 * 清单与显示资源契约（Steam）。
 *
 * 对应 DSH 0.2.2 的 bundle 显示规则：标题/描述来自导出的 locale JSON，图标来自
 * `./icon`，README 是插件详情页的回落文档。
 *
 * @module dsh-steam/test/manifest
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/version.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const MAX_ICON_BYTES = 256 * 1024;

test('清单：名字、版本与补丁文件', () => {
  assert.equal(manifest.name, '@local/steam');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, manifest.dsh.bundle.patch)));
  assert.equal(VERSION, manifest.version, 'lib/version.js 必须与 package.json 一致');
});

test('显示资源：locale 与 icon 都已导出并列入 files', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const entry of ['lib/**/*.js', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
    assert.ok(manifest.files.includes(entry), `files 缺少 ${entry}`);
  }
});

test('locale：中英文都有标题与描述', () => {
  for (const language of ['en', 'zh']) {
    const file = path.join(REPO_ROOT, 'locale', `${language}.json`);
    assert.ok(fs.existsSync(file), `缺少 ${language}.json`);
    const locale = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title !== '', `${language} 缺 title`);
    assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 20, `${language} 描述太短`);
    if (locale.meta.detail !== undefined) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, locale.meta.detail)), `${language} 的 meta.detail 指向不存在的文件`);
    }
  }
});

test('图标：36×36 透明底、自包含、无文字与脚本、体积达标', () => {
  const file = path.join(REPO_ROOT, 'icon.svg');
  const svg = fs.readFileSync(file, 'utf8');
  assert.ok(fs.statSync(file).size <= MAX_ICON_BYTES, '图标超过 256 KiB');
  assert.match(svg, /viewBox="0 0 36 36"/);
  for (const forbidden of ['<text', '<style', '<script', '<foreignObject', '<image', 'onload=', 'onclick=']) {
    assert.ok(!svg.includes(forbidden), `图标不应包含 ${forbidden}`);
  }
});

test('README 记录的版本与包版本一致', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(manifest.version), `README 未提到当前版本 ${manifest.version}`);
});

test('cordis.patch.yml：webApi 默认 on，凭据注释按真实优先级且给出 refs 结构', () => {
  const patch = fs.readFileSync(path.join(REPO_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /^\s*webApi: on$/m, '默认应为 on（始终注册密钥层工具）');
  assert.equal(/^\s*webApi: auto$/m.test(patch), false, '默认不该再是 auto');
  // 凭据优先级：已存文件 > 启动环境变量 > 项目 .env > $DSH_HOME/.env。
  const order = [
    patch.indexOf('.credentials.yaml'),
    patch.indexOf('启动 DSH 前的环境变量'),
    patch.indexOf('项目 .env'),
    patch.indexOf('$DSH_HOME\\.env'),
  ];
  for (const index of order) assert.ok(index >= 0, 'cordis.patch.yml 的凭据注释缺少一层来源');
  assert.deepEqual(order, [...order].sort((left, right) => left - right), 'cordis.patch.yml 的凭据优先级写反了');
  assert.match(patch, /version: 1/);
  assert.match(patch, /refs:/);
  assert.match(patch, /裸/, '要说明裸写一行不会被解析');
});

test('README：凭据优先级、翻页参数与默认 on 都已按实际改写', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /version: 1/);
  assert.match(readme, /refs:/);
  const order = [
    readme.indexOf('已存凭据'),
    readme.indexOf('启动 DSH 前的环境变量'),
    readme.indexOf('项目 `.env`'),
    readme.indexOf('$DSH_HOME\\.env'),
  ];
  for (const index of order) assert.ok(index >= 0, 'README 的凭据优先级缺少一层来源');
  assert.deepEqual(order, [...order].sort((left, right) => left - right), 'README 的凭据优先级写反了');
  assert.match(readme, /`webApi` \| `on`/, 'README 的配置表要写默认 on');
  assert.match(readme, /`cursor`/);
  assert.match(readme, /`page`/);
  assert.match(readme, /test\/` 只存在于\*\*仓库\*\*|`test\/` 只存在于/, '测试小节要说明 test/ 只在仓库');
  assert.match(readme, /变更记录（0\.3\.0/);
});
