'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('签署面板按钮配置并返回可用的签名图标', () => {
  const ribbonXml = fs.readFileSync(path.join(root, 'ribbon.xml'), 'utf8');
  assert.match(ribbonXml, /btnShowTaskPane[^>]+getImage="GetImage"/);

  const context = vm.createContext({ window: { Application: {} } });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/ribbon.js'), 'utf8'), context);
  const imagePath = context.GetImage({ Id: 'btnShowTaskPane' });
  assert.equal(imagePath, 'images/notasign.svg');
  assert.equal(fs.existsSync(path.join(root, imagePath)), true);

  const viteConfig = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /src:\s*'images'/);
});
