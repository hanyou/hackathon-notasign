'use strict';
/**
 * 本地伴随服务：WPS 加载项（浏览器沙箱）不能安全持有 RSA 私钥，
 * 故 JWT 与全部 Nota Sign 调用都收敛到这个本地服务，插件只调 localhost。
 *   GET  /health → { ok:true }
 *   POST /send   → { filePath } 或 { fileName, fileBase64 } + subject + signers
 *     signers: [{ name, email, keyword }] —— 每位签署人一个签名控件，
 *     关键字即其在文档中的定位锚点（如「乙方签字：」）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NotaSignClient } = require('./notasign');

const PORT = process.env.PORT || 3456;
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('缺少 server/config.json，请复制 config.example.json 并填入 UAT 应用凭证。');
  process.exit(1);
}
const client = new NotaSignClient(JSON.parse(fs.readFileSync(configPath, 'utf8')));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/send') {
      const body = await readBody(req);
      let fileBuffer, fileName;
      if (body.filePath) {
        fileBuffer = fs.readFileSync(body.filePath);
        fileName = path.basename(body.filePath);
      } else if (body.fileBase64 && body.fileName) {
        fileBuffer = Buffer.from(body.fileBase64, 'base64');
        fileName = body.fileName;
      } else {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: '需要 filePath 或 fileBase64+fileName' }));
      }
      if (!Array.isArray(body.signers) || body.signers.length === 0) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: 'signers 不能为空' }));
      }
      // 每位签署人生成一个签名控件（关键字定位）+ 参与方，fieldName 关联
      const fields = body.signers.map((s, i) => ({
        fieldId: 'sign_' + (i + 1),
        fieldName: s.name + '签名',
        fieldType: 'signature',
        keyword: s.keyword,
        offsetX: s.offsetX, offsetY: s.offsetY,
      }));
      const signers = body.signers.map((s, i) => ({
        participantId: 'signer_' + (i + 1),
        name: s.name,
        email: s.email,
        fieldNames: [s.name + '签名'],
      }));
      const result = await client.sendDocument({
        fileBuffer, fileName,
        subject: body.subject || fileName,
        fields, signers,
      });
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, ...result }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
});

server.listen(PORT, () => console.log(`Nota Sign 本地服务已启动: http://127.0.0.1:${PORT}`));
