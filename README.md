# WPS × Nota Sign 一键签署插件（黑客松项目）

在 WPS 里写完 Word → 文档内标记签名域 → 绑定签署人邮箱 → 一键调用 Nota Sign API 发起签署。
省掉「开浏览器 → 登录 Nota Sign → 上传文档 → 逐个划签署域」的整套操作。

## 架构

```
WPS 加载项（任务窗格）                本地伴随服务（Node，零依赖）            Nota Sign
wps-addin/                          server/
  收集签署人/关键字  ──POST /send──▶  JWT 鉴权、上传、处理、建信封  ──REST──▶  转 PDF、渲染签署域
  插入标记、另存副本                   RSA 私钥只留在这里                      发邮件、状态 Webhook
```

为什么要本地服务：WPS 加载项跑在浏览器沙箱里，不能也不该持有 RSA 私钥；
官方文档同样把上传设计为「通过应用后端」执行。

## 已核实的 API 链路（developers.notasign.com，2026-11-23）

1. **JWT 授权**：payload `iss=AppID, sub=UserCode, aud=BaseURL, exp=iat+6000, scope=signature`，
   RSA 私钥 RS256 签名 → `POST /oauth/token`（grant_type=jwt-bearer）换 accessToken。
2. **上传**：`GET /api/file/upload-url?fileType=document` → PUT 文件流到 `fileUploadUrl`
   （30 分钟有效，源文件必须带扩展名，≤50MB）。
3. **文件处理**：`POST /api/file/process` → `fileId`（docx 在 Nota Sign 侧转成 PDF）。
4. **创建信封**：`POST /api/envelope/create`，`documents[].documentFields` 定义控件，
   `position.positionMode` 支持 `pixel` 与 `keyword` 两种定位；`participants[].signFields`
   关联控件；`autoSend=true` 创建即发送。
5. **模板路径**（可选）：`templateId + templateRoles` 把模板角色映射到签署人。

**定位主方案 = keyword**：关键字（≤50 字）由系统自动匹配、定位在关键字中心点，可加偏移；
同一关键字多处出现会自动生成多个控件，此时签署人关联必须用 `fieldName`（代码已按此实现）。
这样 Word→PDF 的分页漂移与插件无关。pixel 坐标模式保留在客户端里作兜底。

## 本地调试（阶梯式排障，从低到高）

```bash
# 0) 准备凭证（UAT）：https://account.uat.notasign.com 注册开发者账号
#    → 集成-应用管理 创建应用 → 保存 AppID / RSA 私钥 / User Authorization Code / Base URL
cp server/config.example.json server/config.json   # 填入上面四项（config.json 已在 .gitignore，勿外发）

# 1) 只验凭证：JWT 换 accessToken，通了说明四项配置都对
node server/test-send.js --token-only

# 2) 全链路自测：自动生成一份含关键字「乙方签字：」的测试 docx，
#    走完 上传 → 文件处理 → 建信封 → 发送（签署人邮箱默认 signer@example.com，可传参换）
node server/test-send.js
node server/test-send.js 我的合同.docx 张三 zhang@example.com 乙方签字：

# 3) 起本地服务（供 WPS 窗格调用）
cd server && npm start      # http://127.0.0.1:3456 ，GET /health 自检

# 4) WPS 侧：用 WPS 加载项开发工具（wpsjs 脚手架）新建项目，
#    把 wps-addin/index.html 与 wps-addin/js/ 拷入其 web 目录后调试；
#    窗格逻辑也可先单独在浏览器打开 index.html 看表单（发起动作需 WPS 环境取文档路径）
```

## 待确认/注意

- `/oauth/token` 返回的 token 字段名以 UAT 首次实测为准（客户端已做多字段兼容解析）。
- 官方提示：docx 经文件处理转 PDF 可能有格式误差/耗时，生产建议本地先转 PDF；
  黑客松演示用 docx 直传即可，路演时可把这点讲成「后续优化项」。
- UAT 发出的文档带水印、无法律效力，正适合演示。
- Webhook 状态回调（已查看/已签/已拒签）尚未接：演示后如需在 WPS 内显示签署进度，
  在本地服务加一个回调端点，并在应用配置里填 Callback URL。
