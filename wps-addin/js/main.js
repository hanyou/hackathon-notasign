'use strict';
/**
 * WPS 加载项任务窗格逻辑。
 * 职责只有三件（转换/发送/状态都在 Nota Sign 与本地服务侧）：
 *   1) 在光标处插入签署标记文字（作为 keyword 定位锚点）；
 *   2) 把当前文档另存一份副本，拿到本地路径；
 *   3) 把 { filePath, subject, signers } 交给本地服务 POST /send。
 * 注：WPS JS API 的具体方法名以 WPS 加载项开发文档为准，
 *     下方用到的 ActiveDocument / Selection / SaveAs 是文字模块的常规入口，
 *     首次在 WPS 开发者工具里加载时按控制台报错微调即可。
 */
var SERVER = 'http://127.0.0.1:3456';

function $(id) { return document.getElementById(id); }
function log(msg) { $('status').textContent = msg; }

function addSignerRow(name, email, keyword) {
  var wrap = document.createElement('div');
  wrap.className = 'signer';
  wrap.innerHTML =
    '<input placeholder="签署人姓名" value="' + (name || '') + '" />' +
    '<input placeholder="签署人邮箱" value="' + (email || '') + '" />' +
    '<input placeholder="定位关键字（如 乙方签字：）" value="' + (keyword || '') + '" />' +
    '<button type="button" class="secondary insert-marker">在光标处插入标记</button>';
  wrap.querySelector('.insert-marker').onclick = function () { insertMarker(wrap); };
  $('signers').appendChild(wrap);
}

function collectSigners() {
  var rows = document.querySelectorAll('.signer');
  var out = [];
  rows.forEach(function (row) {
    var inputs = row.querySelectorAll('input');
    var name = inputs[0].value.trim();
    var email = inputs[1].value.trim();
    var keyword = inputs[2].value.trim();
    if (name && email && keyword) out.push({ name: name, email: email, keyword: keyword });
  });
  return out;
}

function getApp() {
  // WPS 文字加载项入口
  return window.wps && wps.WpsApplication ? wps.WpsApplication() : null;
}

/** 在光标处插入当前签署人行的标记文字 */
function insertMarker(row) {
  var app = getApp();
  if (!app) return log('未检测到 WPS 环境，请在 WPS 加载项中打开本面板。');
  var text = row.querySelectorAll('input')[2].value.trim();
  if (!text) return log('请先填写该签署人的定位关键字。');
  try {
    var sel = app.ActiveDocument.ActiveWindow.Selection;
    sel.TypeText(text);
    log('已在光标处插入标记：' + text);
  } catch (e) {
    log('插入失败：' + e.message);
  }
}

/** 保留定位文本供 API 识别，但在上传副本中将其显示为白色 */
function hideKeywords(doc, signers) {
  signers.forEach(function (signer) {
    var find = doc.Content.Find;
    find.ClearFormatting();
    find.Replacement.ClearFormatting();
    find.Replacement.Font.Color = 16777215;
    find.Execute(signer.keyword, false, false, false, false, false,
      true, 0, true, signer.keyword, 2);
  });
}

/** 另存副本并拿到路径，然后调本地服务发起签署 */
function sendForSignature() {
  var app = getApp();
  if (!app) return log('未检测到 WPS 环境，请在 WPS 加载项中打开本面板。');
  var signers = collectSigners();
  if (!signers.length) return log('请至少填一位签署人（姓名/邮箱/关键字都要填）。');

  var doc = app.ActiveDocument;
  var copyPath;
  try {
    hideKeywords(doc, signers);
    // 企业微信等缓存目录可能对 WPS 沙箱只读，副本统一保存到 WPS 默认文档目录。
    var dir = doc.Path || '';
    if (app.Options && typeof app.Options.DefaultFilePath === 'function') {
      dir = app.Options.DefaultFilePath(0) || dir;
    }
    dir = dir.replace(/[\\/]+$/, '');
    var base = (doc.Name || 'document.docx').replace(/\.(docx?|wps)$/i, '');
    copyPath = (dir ? dir + '/' : '') + base + '_签署副本.docx';
    if (doc.SaveAs2) doc.SaveAs2(copyPath); else if (doc.SaveAs) doc.SaveAs(copyPath);
  } catch (e) {
    return log('文档另存失败：' + e.message);
  }

  log('正在发起签署…');
  fetch(SERVER + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: copyPath,
      subject: doc.Name || '待签署文档',
      signers: signers,
    }),
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.ok) {
        log('发起成功！fileId=' + data.fileId + '（共 ' + data.pages + ' 页）\n信封返回：' +
          JSON.stringify(data.envelope && (data.envelope.data || data.envelope)));
      } else {
        log('发起失败：' + (data.error || JSON.stringify(data)));
      }
    })
    .catch(function (e) { log('调用本地服务失败（服务起了吗？）: ' + e.message); });
}

window.onload = function () {
  addSignerRow('', '', '');
  $('btnAdd').onclick = function () { addSignerRow('', '', ''); };
  $('btnSend').onclick = sendForSignature;
};
