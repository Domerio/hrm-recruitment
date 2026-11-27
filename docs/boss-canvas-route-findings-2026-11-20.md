# BOSS 电脑端 Canvas 简历入口核验（2026-11-20）

**结论：已验证官方页面可正常打开 Canvas 在线简历并显示联系入口；尚未验证可从工作台用永久候选人链接一次打开同样界面的路线。** 这不等于断言此类入口不存在。目前不能把移动分享页、内部简历 iframe 或猜测的 URL 当作已完成的一键联系功能。

## 正常界面及网络记录

以下是主任务通过正常 Edge 界面操作、原生网络记录提供的实测结果；没有调试 BOSS 页面或重放接口：

- 从推荐列表打开一位候选人，看到真实 Canvas 简历及“打招呼”按钮，浏览器父页面仍为 `/web/chat/recommend`。
- `GET /web/frame/c-resume/?source=recommend`：HTTP 200。
- `GET /wapi/zpjob/wasm-auth/challenge`：HTTP 200。
- `GET /wapi/zpjob/view/geek/info/v2`：HTTP 200，观察到的参数名称为 `encryptJid`、`expectId`、`securityId`、`lid`、`entrance`、`wayType`、`sourceType`、`challenge`。

本地记录为 `data/boss-canvas-netlog-2026-11-20.json`，筛选摘要为同前缀的 `summary` 文件。本文不复制原始头、登录凭据、授权参数值或候选人简历正文。

HTTP 200 证明这次正常操作中的请求成功，不证明这些内部地址可脱离父页面、登录态和授权上下文长期重用。

## 公开前端代码中的真正父容器

已保存 `<本地核验资料>/app(1).js.下载` 第 2 行，字符偏移约 `989603`，确实声明：

```js
{name:"resume",path:"/web/frame/recommend/resume"
```

同文件约 `700330` 的 `ResumeContainer` 监听 `$route.query`，把 query 作为单个候选人数据传入 `getRecommendResume`，选项明确为：

```js
{singleViewer:!0, ... ,useWasm:(0,r.isSupportWasmResume)("email")}
```

这是有代码依据的独立查看父容器，不是直接访问 Canvas 空壳。但它**不是已验证的“查看并联系”路线**：

- `523.js.下载` 约 `1742286`：`singleViewer` 模式将 Canvas 的 `source` 设为 `email`。
- 同文件约 `1758571`：右侧组件选择 `RightSideSingleViewer`，而不是普通 `RightSide`。
- 同文件约 `17345xx`：`RightSideSingleViewer` 的定义只渲染 `ResumeSummary`，没有普通右栏的“打招呼 / 继续沟通”控件。

因此，即使独立查看父容器可加载特定简历，也不能据此承诺它保留推荐页的联系操作。该路线尚未进行真实账号、目标候选人的重新打开验证。

## 参数与 Canvas 初始化边界

`523.js.下载` 约 `1224148` 的 `getResumtQueryParams` 从当前候选人/岗位上下文构造请求，包括：

```js
encryptJid:r||o,jid:r?null:i,encryptExpectId:s||c,expectId:s?null:a,securityId:l,lid:u
```

约 `1747362` 的推荐简历父组件随后调用：

```js
postMessageToIframe("SET_RESUME",{requestParams: ... ,dataSourceParams: ...})
```

这说明 `/web/frame/c-resume/` 是受父组件初始化的渲染页面，不能仅往地址栏加一个候选人 ID 就认定会出现目标简历。`encryptJid` 是岗位上下文字段，不能用分享页 `encryptId` 替代；`securityId`、`lid` 和实测中的 `challenge` 也不是已验证可永久重用的候选人标识。现有证据没有给出这些字段的确切有效期，不能擅自假定永久有效或固定时长失效。

## 移动分享链接与电脑端联系

主任务对目标档案已有的 `zpurl.cn` 分享链接进行了无 Cookie 跳转核实，落到 `m.zhipin.com/web/h5/resume/detail?encryptId=...`。保存的 H5 加载代码显示，它同样加载 `/web/frame/c-resume?source=h5`，再通过 `SET_RESUME` 传入上下文。其联系操作指向 App。

这可以作为“原始分享来源”保存，但没有证据可将该 `encryptId` 直接转换为电脑端推荐页的 `securityId`、岗位上下文或可联系父容器。不能把移动分享地址标成“电脑端在线简历并联系”。

在已审查的主站 `index-v11800-789.js`、公共组件 `index-v11800-684.js` 及本地推荐页脚本中，未找到可据以验证 `/web/geek/detail` 或 `/web/chat/geek/resume` 的候选人参数路由；这只是本次材料的审查结果，不是对所有官方入口的否定。

## 当前可交付与待核验项

已验证的 `https://www.zhipin.com/web/chat/index?uid=<会话ID>&source=0` 可以进入对应已有会话；它与“自动展开 Canvas 在线简历”是两个不同结果，详见 `boss-chat-route-evidence-2026-11-20.md`。

在正式增加“一键打开在线简历并联系”之前，需要用真实候选人验证候选链接重新打开后仍定位同一人、加载 Canvas，并保留可用联系入口；同时确认所需字段来自正常授权页面，不能靠猜测、错用分享 ID 或复用未经核验的授权参数。当前建议不发布尚未验证的跳转功能。

## 本次修复与部署验证

扩展已更新到 0.5.110 并通过 Edge 普通扩展管理界面重新加载。`communications-reader.mjs` 补读当前会话的 `toPositionId` 与 `toPosition`，`chat-actions.mjs` 同步岗位 ID 校验。116 项针对性测试通过。实际在已确认 UID 的工业工程师聊天中点击“读取当前页面”，界面显示“工业工程师”，状态为“已读取，自动归档到工业工程师”，未再次出现原 ID 形式不一致错误。仅完成只读预览，未点击导入、简历采集、评估或发送消息。

某位候选人 当前档案的 `link` 为空，只保存二维码短链；该短链实际跳转到 BOSS 移动端 `/web/h5/resume/detail`。打开该移动分享页后的桌面无障碍读取持续超时，未声称已核实该页可在电脑端直接沟通。没有为此新增猜测的工作台 Canvas 跳转按钮。
