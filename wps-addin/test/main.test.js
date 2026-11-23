'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadPanel({ app, fetch }) {
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) target[key] = { textContent: '' };
      return target[key];
    },
  });
  const inputs = [
    { value: '张三' },
    { value: 'zhang@example.com' },
    { value: '乙方签字：' },
  ];
  const created = [];
  const document = {
    getElementById: (id) => elements[id],
    querySelectorAll: () => [{ querySelectorAll: () => inputs }],
    createElement: () => {
      const button = {};
      const row = { innerHTML: '', querySelector: () => button };
      created.push({ row, button });
      return row;
    },
  };
  const wps = { WpsApplication: () => app };
  const window = { wps };
  const context = vm.createContext({ window, document, fetch, console, wps });
  const source = fs.readFileSync(require.resolve('../js/main.js'), 'utf8');
  vm.runInContext(source, context);
  return { context, elements, created };
}

test('签署副本保存到 WPS 默认文档目录，而不是原文件所在的只读目录', async () => {
  let savedPath;
  const app = {
    Options: { DefaultFilePath: () => '/writable/Documents' },
    ActiveDocument: {
      Path: '/restricted/WeWorkCache',
      Name: '合同.docx',
      Content: {
        Find: {
          Replacement: { Font: {}, ClearFormatting: () => {} },
          ClearFormatting: () => {},
          Execute: () => true,
        },
      },
      SaveAs2: (path) => { savedPath = path; },
    },
  };
  const fetch = async () => ({ json: async () => ({ ok: true }) });
  const { context } = loadPanel({ app, fetch });

  context.sendForSignature();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(savedPath, '/writable/Documents/合同_签署副本.docx');
});

test('发起前保留定位文本并将其字体替换为白色', async () => {
  let executeArgs;
  const find = {
    Replacement: { Font: {}, ClearFormatting: () => {} },
    ClearFormatting: () => {},
    Execute: (...args) => { executeArgs = args; return true; },
  };
  const app = {
    Options: { DefaultFilePath: () => '/writable/Documents' },
    ActiveDocument: {
      Path: '/writable/Documents',
      Name: '合同.docx',
      Content: { Find: find },
      SaveAs2: () => {},
    },
  };
  const fetch = async () => ({ json: async () => ({ ok: true }) });
  const { context } = loadPanel({ app, fetch });

  context.sendForSignature();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(find.Replacement.Font.Color, 16777215);
  assert.equal(executeArgs[0], '乙方签字：');
  assert.equal(executeArgs[8], true);
  assert.equal(executeArgs[9], '乙方签字：');
  assert.equal(executeArgs[10], 2);
});

test('插入标记使用当前签署人行的关键字', () => {
  let insertedText;
  const app = {
    ActiveDocument: {
      ActiveWindow: { Selection: { TypeText: (text) => { insertedText = text; } } },
    },
  };
  const { context } = loadPanel({ app, fetch: async () => {} });
  const secondRow = {
    querySelectorAll: () => [
      { value: '' }, { value: '' }, { value: '丙方签字：' },
    ],
  };

  context.insertMarker(secondRow);

  assert.equal(insertedText, '丙方签字：');
});

test('每个签署人行都有独立的插入标记按钮', () => {
  let insertedText;
  const app = {
    ActiveDocument: {
      ActiveWindow: { Selection: { TypeText: (text) => { insertedText = text; } } },
    },
  };
  const { context, elements, created } = loadPanel({ app, fetch: async () => {} });
  elements.signers.appendChild = () => {};

  context.addSignerRow('李四', 'li@example.com', '丙方签字：');
  created[0].row.querySelectorAll = () => [
    { value: '李四' }, { value: 'li@example.com' }, { value: '丙方签字：' },
  ];

  assert.match(created[0].row.innerHTML, /insert-marker/);
  assert.equal(typeof created[0].button.onclick, 'function');
  created[0].button.onclick();
  assert.equal(insertedText, '丙方签字：');
});
