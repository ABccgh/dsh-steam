import test from 'node:test';
import assert from 'node:assert/strict';

import { coerceArguments, defineTool, parametersToJsonSchema, specToJsonSchema } from '../lib/tool-kit.js';

test('specToJsonSchema 编译标量、枚举与默认值', () => {
  assert.deepEqual(specToJsonSchema({ type: 'integer', description: 'x', enum: [1, 2], default: 1 }), {
    type: 'integer',
    description: 'x',
    enum: [1, 2],
    default: 1,
  });
});

test('specToJsonSchema 编译数组与嵌套对象', () => {
  const schema = specToJsonSchema({
    type: 'array',
    required: true,
    description: '列表',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', required: true },
        status: { type: 'string', enum: ['pending', 'done'] },
      },
    },
  });
  assert.equal(schema.type, 'array');
  assert.equal(schema.items.type, 'object');
  assert.deepEqual(schema.items.required, ['content']);
  assert.equal(schema.items.additionalProperties, false);
  assert.equal('required' in schema, false, 'required 是对象层的概念，数组节点不该带');
});

test('parametersToJsonSchema 把 per-spec required 提升到对象层', () => {
  const schema = parametersToJsonSchema({
    appid: { type: 'integer', required: true, description: 'a' },
    filter: { type: 'string' },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      appid: { type: 'integer', description: 'a' },
      filter: { type: 'string' },
    },
    required: ['appid'],
    additionalProperties: false,
  });
  assert.deepEqual(parametersToJsonSchema({}), { type: 'object', properties: {}, additionalProperties: false });
});

test('specToJsonSchema 对非法输入抛错', () => {
  assert.throws(() => specToJsonSchema(null), /必须是/);
  assert.throws(() => specToJsonSchema({ description: '没有 type' }), /缺少 type/);
  assert.throws(() => specToJsonSchema({ type: 'date' }), /不支持/);
});

test('coerceArguments 归一标量并检查必填项', () => {
  const schema = parametersToJsonSchema({
    appid: { type: 'integer', required: true },
    limit: { type: 'integer' },
    term: { type: 'string', required: true },
    flag: { type: 'boolean' },
  });
  assert.deepEqual(coerceArguments(schema, { appid: '431960', term: 42, limit: 3.9, flag: 'true' }), {
    appid: 431960,
    term: '42',
    limit: 3,
    flag: true,
  });
  assert.deepEqual(coerceArguments(schema, { appid: 1, term: 'x' }), { appid: 1, term: 'x' });
  assert.throws(() => coerceArguments(schema, undefined), /缺少必填参数 appid/, 'undefined 视为空对象，随后撞上必填检查');
});

test('coerceArguments 拒绝 schema 之外的参数（否则错参数会被静默丢弃）', () => {
  const schema = parametersToJsonSchema({ appid: { type: 'integer' } });
  assert.throws(() => coerceArguments(schema, { appid: 1, 注入: 'x' }), /不认识的参数：注入/);
  assert.deepEqual(coerceArguments(schema, { appid: 1 }), { appid: 1 });
});

test('coerceArguments 拒绝 enum 之外的值', () => {
  const schema = parametersToJsonSchema({ sort: { type: 'string', enum: ['name', 'size'] } });
  assert.deepEqual(coerceArguments(schema, { sort: 'size' }), { sort: 'size' });
  assert.throws(() => coerceArguments(schema, { sort: 'bogus' }), /参数 sort 只能是："name"、"size"/);
});

test('coerceArguments 对缺必填、坏类型、非对象参数抛错', () => {
  const schema = parametersToJsonSchema({ appid: { type: 'integer', required: true }, tags: { type: 'array' } });
  assert.throws(() => coerceArguments(schema, {}), /缺少必填参数 appid/);
  assert.throws(() => coerceArguments(schema, { appid: 'abc' }), /必须是整数/);
  assert.throws(() => coerceArguments(schema, { appid: 1, tags: 'x' }), /必须是数组/);
  assert.throws(() => coerceArguments(schema, [1, 2]), /必须是一个对象/);
});

test('defineTool 产出注册表直接可用的 definition，并包装 execute', async () => {
  const seen = [];
  const definition = defineTool({
    name: 'demo_tool',
    description: '演示',
    parameters: { count: { type: 'integer', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      seen.push(args);
      return { text: `count=${args.count}` };
    },
  });

  assert.equal(definition.name, 'demo_tool');
  assert.equal(definition.parameters.type, 'object');
  assert.deepEqual(definition.parameters.required, ['count']);
  assert.deepEqual(definition.output.schema.required, ['text']);
  assert.equal(definition.isConcurrencySafe(), true);
  assert.equal(typeof definition.presentCall, 'undefined');

  const value = await definition.execute({ count: '7' }, {});
  assert.deepEqual(seen, [{ count: 7 }], 'execute 收到的是归一后的参数');
  assert.deepEqual(definition.output.render({}, value), [{ type: 'text', text: 'count=7' }]);
});

test('defineTool 在定义本身有问题时立刻失败', () => {
  const base = {
    name: 'x',
    description: 'x',
    parameters: {},
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  };
  assert.throws(() => defineTool({ ...base, name: '' }), /name/);
  assert.throws(() => defineTool({ ...base, name: 'run_code' }), /保留/);
  assert.throws(() => defineTool({ ...base, description: '' }), /description/);
  assert.throws(() => defineTool({ ...base, output: undefined }), /output/);
  assert.throws(() => defineTool({ ...base, output: { schema: { type: 'object' } } }), /render/);
  assert.throws(() => defineTool({ ...base, execute: undefined }), /execute/);
});
