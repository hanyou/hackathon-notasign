'use strict';
/**
 * 命令行自测：不经过 WPS、不经过 HTTP 服务，直接验证 Nota Sign 链路。
 * 调试阶梯（从低到高，逐级排障）：
 *   node test-send.js --token-only
 *       只验证 JWT → accessToken（凭证对不对看这一步）
 *   node test-send.js
 *       自动生成一份含关键字「乙方签字：」的测试 docx，走完 上传→处理→建信封→发送
 *   node test-send.js 我的合同.docx 张三 zhang@example.com 乙方签字：
 *       用自己的文档与签署人全链路发送（UAT 环境，文档带水印）
 */
const fs = require('node:fs');
const path = require('node:path');
const { NotaSignClient } = require('./notasign');

/* ---------- 极简 docx 生成（stored 方式 ZIP，无压缩、无依赖） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStore(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function buildTestDocx(keyword) {
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>测试合同（Nota Sign 联调用）</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>甲方：示例科技有限公司</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>乙方：签署人本人</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>' + esc(keyword) + '</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>签署日期：</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

/* ---------- 主流程 ---------- */
(async () => {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('缺少 config.json：先复制 config.example.json 为 config.json 并填入 UAT 凭证。');
    process.exit(1);
  }
  const client = new NotaSignClient(JSON.parse(fs.readFileSync(configPath, 'utf8')));

  if (process.argv[2] === '--token-only') {
    const token = await client.getAccessToken();
    console.log('accessToken 获取成功（前 24 字符）:', String(token).slice(0, 24) + '…');
    return;
  }

  const [, , fileArg, nameArg, emailArg, keywordArg] = process.argv;
  const signerName = nameArg || '测试签署人';
  const signerEmail = emailArg || 'signer@example.com';
  const keyword = keywordArg || '乙方签字：';

  let fileBuffer, fileName;
  if (fileArg) {
    fileBuffer = fs.readFileSync(fileArg);
    fileName = path.basename(fileArg);
  } else {
    fileBuffer = buildTestDocx(keyword);
    fileName = 'test-contract.docx';
    fs.writeFileSync(path.join(__dirname, fileName), fileBuffer);
    console.log('已生成测试文档 test-contract.docx（内含关键字「' + keyword + '」）');
  }

  console.log('1/3 上传文档…');
  const fileUrl = await client.uploadDocument(fileBuffer, fileName);
  console.log('    fileUrl:', fileUrl);
  console.log('2/3 文件处理（转 PDF）…');
  const processed = await client.processDocument(fileUrl, fileName);
  console.log('    fileId:', processed.fileId, ' 页数:', processed.fileTotalPages);
  console.log('3/3 创建信封并发送给', signerEmail, '…');
  const envelope = await client.createEnvelope({
    subject: fileName,
    fileId: processed.fileId,
    fileName,
    fields: [{ fieldId: 'sign_1', fieldName: signerName + '签名', fieldType: 'signature', keyword }],
    signers: [{
      participantId: 'signer_1', name: signerName, email: signerEmail,
      fieldNames: [signerName + '签名'],
    }],
  });
  console.log('完成。信封接口返回：\n', JSON.stringify(envelope, null, 2));
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
