'use strict';
/**
 * Nota Sign API 客户端（零依赖，Node 18+）
 * 链路全部按官方开发者文档核实（developers.notasign.com，2026-11-23）：
 *   JWT(RS256) → POST /api/oauth/token 换 accessToken（所有请求带公共参数签名）
 *   GET  /api/file/upload-url?fileType=document → { fileUploadUrl, fileUrl }
 *   PUT  fileUploadUrl 上传文件流（链接 30 分钟有效，源文件必须带扩展名）
 *   POST /api/file/process { fileUrls:[{fileType,fileUrl,fileName}] } → fileId
 *   POST /api/envelope/create { documents, participants, autoSend:true } → 信封
 */
const crypto = require('node:crypto');

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toPem(privateKey) {
  const k = String(privateKey || '').trim();
  if (!k) throw new Error('config.privateKey 未配置');
  if (k.startsWith('-----')) return k;
  // 应用详情页给的是 Base64 PKCS#8，包成 PEM
  const lines = k.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function removeEmptyFields(value) {
  if (Array.isArray(value)) return value.map(removeEmptyFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null && item !== '')
    .map(([key, item]) => [key, removeEmptyFields(item)]));
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      compareAscii(keyA, keyB) || compareAscii(valueA, valueB))
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');
}

class NotaSignClient {
  constructor(config) {
    this.appId = config.appId;
    this.userCode = config.userCode;
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.privateKeyPem = toPem(config.privateKey);
    if (!this.appId || !this.userCode || !this.baseUrl) {
      throw new Error('config 缺少 appId / userCode / baseUrl（见 config.example.json）');
    }
    this._token = null;
    this._tokenExp = 0;
  }

  /** 按官方公共请求头规范发送签名请求 */
  async _request(path, options = {}, token) {
    const method = (options.method || 'GET').toUpperCase();
    const url = new URL(this.baseUrl + path);
    let body = options.body;
    let bizContent = '';
    if (method === 'GET' || method === 'DELETE') {
      bizContent = canonicalQuery(url.searchParams);
      body = undefined;
    } else if (body) {
      const value = typeof body === 'string' ? JSON.parse(body) : body;
      body = JSON.stringify(removeEmptyFields(value));
      bizContent = body;
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-GLOBAL-App-Id': this.appId,
      'X-GLOBAL-Sign-Type': 'RSA-SHA256',
      'X-GLOBAL-Timestamp': String(Date.now()),
      'X-GLOBAL-Nonce': crypto.randomUUID().replace(/-/g, ''),
      'X-GLOBAL-Api-SubVersion': '1.0',
      ...(token ? { Authorization: token } : {}),
      ...(options.headers || {}),
    };
    const signatureParams = {
      Authorization: headers.Authorization || '',
      'X-GLOBAL-Api-SubVersion': headers['X-GLOBAL-Api-SubVersion'],
      'X-GLOBAL-App-Id': headers['X-GLOBAL-App-Id'],
      'X-GLOBAL-Nonce': headers['X-GLOBAL-Nonce'],
      'X-GLOBAL-Sign-Type': headers['X-GLOBAL-Sign-Type'],
      'X-GLOBAL-Timestamp': headers['X-GLOBAL-Timestamp'],
      'X-GLOBAL-Request-Url': url.pathname,
      bizContent,
    };
    const content = Object.keys(signatureParams)
      .filter((key) => signatureParams[key] !== '' && signatureParams[key] != null)
      .sort().map((key) => key + '=' + signatureParams[key]).join('&');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    headers['X-GLOBAL-Sign'] = signer.sign(this.privateKeyPem, 'base64');

    const res = await fetch(url, { ...options, method, headers, body });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    const failed = !res.ok || data.success === false ||
      (data.code && String(data.code) !== '100001001000000');
    if (failed) {
      const requestId = res.headers.get('x-global-request-id');
      throw new Error(`API ${path} HTTP ${res.status}: ` + JSON.stringify(data) +
        (requestId ? ` (requestId: ${requestId})` : ''));
    }
    return data;
  }

  /** 生成 JWT 并换取 accessToken，带缓存 */
  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && now < this._tokenExp - 60) return this._token;

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.appId,          // AppID
      sub: this.userCode,       // User Authorization Code
      aud: this.baseUrl,        // 应用详情页的 Base URL
      iat: now,
      exp: now + 6000,          // 官方建议 iat+6000（100 分钟）
      scope: 'signature',
    };
    const signingInput =
      base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const jwt = signingInput + '.' + base64url(signer.sign(this.privateKeyPem));

    const data = await this._request('/api/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ grantType: 'jwt-bearer', assertion: jwt }),
    });
    const token = data.data && (data.data.accessToken || data.data.access_token);
    if (!token) throw new Error('换取 accessToken 失败: ' + JSON.stringify(data));
    this._token = token;
    this._tokenExp = now + (Number(data.data.expiresIn) || 7200);
    return token;
  }

  async api(path, options = {}) {
    const token = await this.getAccessToken();
    return this._request(path, options, token);
  }

  /** 步骤1+2：拿到上传地址并 PUT 文件流，返回 fileUrl */
  async uploadDocument(fileBuffer, fileName) {
    const up = await this.api('/api/file/upload-url?fileType=document', { method: 'GET' });
    const { fileUploadUrl, fileUrl } = up.data || {};
    if (!fileUploadUrl || !fileUrl) throw new Error('upload-url 返回异常: ' + JSON.stringify(up));
    const put = await fetch(fileUploadUrl, { method: 'PUT', body: fileBuffer });
    if (!put.ok) throw new Error('文件 PUT 上传失败: HTTP ' + put.status);
    return fileUrl;
  }

  /** 步骤3：文件处理（docx 在 Nota Sign 侧转 PDF），返回 { fileId, fileTotalPages } */
  async processDocument(fileUrl, fileName) {
    const res = await this.api('/api/file/process', {
      method: 'POST',
      body: JSON.stringify({
        fileUrls: [{ fileType: 'document', fileUrl, fileName }],
      }),
    });
    const files = res.data && (res.data.files || res.data.fileUrls);
    const item = Array.isArray(files) ? files[0] : null;
    if (!item || !item.fileId) throw new Error('file/process 返回异常: ' + JSON.stringify(res));
    return item;
  }

  /**
   * 步骤4：纯接口创建信封并自动发送。
   * fields: [{ fieldId, fieldName, keyword }] —— 定位统一走 keyword 模式；
   * signers: [{ participantId, name, email, fieldIds:[...] 或 fieldNames:[...] }]
   * 注意：关键字多处匹配时官方要求用 fieldName 关联签署人，故 keyword 模式下 signFields 传 fieldName。
   */
  async createEnvelope({ subject, fileId, fileName, fields, signers }) {
    const documentFields = fields.map((f) => ({
      fieldId: f.fieldId,
      fieldName: f.fieldName,
      fieldType: f.fieldType || 'signature',
      position: f.keyword
        ? {
            positionMode: 'keyword',
            positionKeyword: f.keyword,
            ...(f.offsetX != null ? { keywordOffsetX: String(f.offsetX) } : {}),
            ...(f.offsetY != null ? { keywordOffsetY: String(f.offsetY) } : {}),
          }
        : {
            positionMode: 'pixel',
            positionPageNo: f.pageNo || 1,
            positionX: String(f.x || 0),
            positionY: String(f.y || 0),
          },
    }));

    const participants = signers.map((s) => ({
      participantId: s.participantId,
      participantName: s.name,
      email: s.email,
      signingMode: 'remoteSigning',
      signFields: (s.fieldNames && s.fieldNames.length
        ? s.fieldNames.map((fieldName) => ({ fieldDocId: 'doc_1', fieldName }))
        : (s.fieldIds || []).map((fieldId) => ({ fieldDocId: 'doc_1', fieldId }))),
    }));

    const res = await this.api('/api/envelope/create', {
      method: 'POST',
      body: JSON.stringify({
        subject,
        autoSend: true,
        signInOrder: false,
        documents: [{
          documentId: 'doc_1',
          documentName: fileName,
          documentFileId: fileId,
          documentFields,
        }],
        participants,
      }),
    });
    return res;
  }

  /** 全链路：文件字节 → 上传 → 处理 → 建信封发送，返回每步结果 */
  async sendDocument({ fileBuffer, fileName, subject, fields, signers }) {
    fileName = String(fileName || 'document.docx').replace(/_签署副本(?=\.[^.]+$)/, '');
    subject = String(subject || fileName).replace(/_签署副本(?=\.[^.]+$)/, '');
    const fileUrl = await this.uploadDocument(fileBuffer, fileName);
    const processed = await this.processDocument(fileUrl, fileName);
    const envelope = await this.createEnvelope({
      subject: subject || fileName,
      fileId: processed.fileId,
      fileName,
      fields,
      signers,
    });
    return { fileUrl, fileId: processed.fileId, pages: processed.fileTotalPages, envelope };
  }
}

module.exports = { NotaSignClient };
