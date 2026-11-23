'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { NotaSignClient } = require('./notasign');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const originalFetch = global.fetch;

function createClient() {
  return new NotaSignClient({
    appId: 'T10001',
    userCode: 'test-user-code',
    baseUrl: 'https://openapi.example.com',
    privateKey,
  });
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getBizContent(request) {
  const url = new URL(request.url);
  if (request.options.method === 'POST') return request.options.body;
  return [...url.searchParams.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      compareAscii(keyA, keyB) || compareAscii(valueA, valueB))
    .map(([key, value]) =>
      encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');
}

function verifyRequestSignature(request, includeAuthorization) {
  const headers = request.options.headers;
  const params = {
    'X-GLOBAL-Api-SubVersion': headers['X-GLOBAL-Api-SubVersion'],
    'X-GLOBAL-App-Id': headers['X-GLOBAL-App-Id'],
    'X-GLOBAL-Nonce': headers['X-GLOBAL-Nonce'],
    'X-GLOBAL-Sign-Type': headers['X-GLOBAL-Sign-Type'],
    'X-GLOBAL-Timestamp': headers['X-GLOBAL-Timestamp'],
    'X-GLOBAL-Request-Url': new URL(request.url).pathname,
    bizContent: getBizContent(request),
  };
  if (includeAuthorization) params.Authorization = headers.Authorization;
  const content = Object.keys(params).sort()
    .map((key) => key + '=' + params[key]).join('&');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  assert.equal(verifier.verify(publicKey, headers['X-GLOBAL-Sign'], 'base64'), true);
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('getAccessToken 使用官方接口、参数和公共请求签名', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({
      code: '100001001000000',
      data: { accessToken: 'test-access-token', expiresIn: '7200' },
    });
  };

  const token = await createClient().getAccessToken();

  assert.equal(token, 'test-access-token');
  assert.equal(request.url, 'https://openapi.example.com/api/oauth/token');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers['X-GLOBAL-App-Id'], 'T10001');
  assert.equal(request.options.headers['X-GLOBAL-Api-SubVersion'], '1.0');
  assert.equal(request.options.headers['X-GLOBAL-Sign-Type'], 'RSA-SHA256');
  assert.ok(request.options.headers['X-GLOBAL-Timestamp']);
  assert.ok(request.options.headers['X-GLOBAL-Nonce']);
  const body = JSON.parse(request.options.body);
  assert.equal(body.grantType, 'jwt-bearer');
  assert.ok(body.assertion);
  assert.equal('grant_type' in body, false);
  assert.equal(request.options.headers.Authorization, undefined);
  verifyRequestSignature(request, false);
});

test('api 为 GET 业务请求添加令牌并按规范化查询参数签名', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ code: '100001001000000', data: {} });
  };
  const client = createClient();
  client._token = 'cached-access-token';
  client._tokenExp = Math.floor(Date.now() / 1000) + 7200;

  await client.api('/api/example?z=last&a=hello world&B=upper&a=first', { method: 'GET' });

  assert.equal(request.options.headers.Authorization, 'cached-access-token');
  assert.equal(getBizContent(request), 'B=upper&a=first&a=hello%20world&z=last');
  verifyRequestSignature(request, true);
});

test('api 的 POST 请求移除空字段并使用紧凑 JSON 签名', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ code: '100001001000000', data: {} });
  };
  const client = createClient();
  client._token = 'cached-access-token';
  client._tokenExp = Math.floor(Date.now() / 1000) + 7200;

  await client.api('/api/example', {
    method: 'POST',
    body: JSON.stringify({
      name: 'demo', empty: '', nullable: null,
      nested: { keep: 'value', empty: '' },
    }),
  });

  assert.equal(request.options.body, '{"name":"demo","nested":{"keep":"value"}}');
  verifyRequestSignature(request, true);
});

test('processDocument 兼容接口实际返回的 data.files', async () => {
  global.fetch = async () => jsonResponse({
    code: '100001001000000',
    data: {
      files: [{ fileId: 'file-1', fileTotalPages: 1, fileType: 'document' }],
    },
  });
  const client = createClient();
  client._token = 'cached-access-token';
  client._tokenExp = Math.floor(Date.now() / 1000) + 7200;

  const result = await client.processDocument('https://files.example.com/doc', '合同.docx');

  assert.equal(result.fileId, 'file-1');
  assert.equal(result.fileTotalPages, 1);
});

test('上传文件和信封主题移除本地副本后缀', async () => {
  const client = createClient();
  const captured = {};
  client.uploadDocument = async (buffer, fileName) => {
    captured.uploadName = fileName;
    return 'https://files.example.com/doc';
  };
  client.processDocument = async (fileUrl, fileName) => {
    captured.processName = fileName;
    return { fileId: 'file-1', fileTotalPages: 1 };
  };
  client.createEnvelope = async (options) => {
    captured.envelope = options;
    return { code: '100001001000000' };
  };

  await client.sendDocument({
    fileBuffer: Buffer.from('doc'),
    fileName: '合同_签署副本.docx',
    subject: '合同_签署副本.docx',
    fields: [],
    signers: [],
  });

  assert.equal(captured.uploadName, '合同.docx');
  assert.equal(captured.processName, '合同.docx');
  assert.equal(captured.envelope.fileName, '合同.docx');
  assert.equal(captured.envelope.subject, '合同.docx');
});
