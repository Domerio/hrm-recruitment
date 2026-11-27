# 12:40 打招呼与聊天入口的补充验证

用户指定某位候选人并授权点击一次「打招呼」。通过 Edge 普通网络日志记录（去除隐私信息），未使用 BOSS 开发者工具、CDP 或页面调试器。

- 2026-11-20 12:40:26.280（北京时间）实际请求为 **POST** `https://www.zhipin.com/wapi/zpjob/chat/start`，12:40:26.522 返回 HTTP 200；仅一次。URL 没有查询参数，本次未读取请求正文，不能据此断言正文参数。
- 页面显示已发送招呼，随后正常点击「继续沟通」打开某位候选人聊天，默认问候显示「送达」。
- 第二轮只读记录捕获聊天详情 `GET /wapi/zpjob/chat/geek/info` 的 `uid=<会话UID>` 和历史消息 `GET /wapi/zpchat/boss/historyMsg` 的 `gid=<会话UID>`，均为 200。第二轮未再调用打招呼接口。
- 用户随后确认 `https://www.zhipin.com/web/chat/index?uid=<会话UID>&source=0` 可以聊天。此结论限当前账号与该候选人，未证明跨账号或永久有效。
- 精简证据：`data/boss-greet-netlog-summary-2026-11-20.json`、`data/boss-greet-chat-netlog-summary-2026-11-20.json`。不输出原始网络日志中的其他浏览元数据。

上述真实 POST 记录优先于下方旧静态文件的 GET 封装。普通聊天文字发送的 WebSocket 消息帧仍未采集。

# 早先只读聊天的实际验证结果

- 方式：正常 Edge 界面操作 + 扩展 `webRequest` 被动记录。未使用开发者工具、CDP 或 BOSS 页面调试器。
- 扩展已正常重新加载为 0.5.109，用户当次批准 BOSS 子域访问权限。
- 保存 132 条筛选后的元数据，首条 2026-11-20 09:56:02，末条 2026-11-20 10:00:15（北京时间）。约 09:56 开始，5 分钟自动停止。
- 原始筛选记录：[JSON](../data/boss-passive-capture-2026-11-20.json)。不包含 Cookie、请求头、正文或 WebSocket 消息帧。

## 已验证的候选人专属聊天链接

脱敏格式：`https://www.zhipin.com/web/chat/index?uid=<会话UID>&source=0`（占位符不是可访问的真实会话链接）。

正常新标签页访问此地址后，实际打开某位候选人聊天，沟通职位为工业工程师，历史消息与先前从列表打开的同一会话一致。需要具备该会话权限的已登录招聘账号；本次未证明该链接跨账号、跨岗位或长期有效。

格式：`https://www.zhipin.com/web/chat/index?uid=<数值会话ID>&source=0`。`uid` 来自本次实际请求，而非姓名猜测或加密候选人 ID。

## 实际抓到的接口与连接

| 请求 | 地址 | 结果 |
|---|---|---|
| 聊天详情 GET | `https://www.zhipin.com/wapi/zpjob/chat/geek/info` | 200；本会话 `uid=<会话UID>` |
| 历史消息 GET | `https://www.zhipin.com/wapi/zpchat/boss/historyMsg` | 200；本会话 `gid=<会话UID>` |
| WebSocket 配置 GET | `https://www.zhipin.com/wapi/zpchat/config/ws` | 200 |
| WebSocket 握手 | `wss://ws.zhipin.com/chatws` | 101 Switching Protocols |

连接地址是本轮实际所用端点，并非每位候选人一个固定发送接口。公开主聊天代码显示消息通过 MQTT 的 `chat` topic 传输，WS 域名由配置池决定；静态代码证据另见 [路由与传输证据](boss-chat-route-evidence-2026-11-20.md)。

## 未完成的发送验证

用户随后自行发送，页面显示某位候选人会话 10:03 的消息/简历请求记录。该时间晚于第一轮记录自动停止，未抓到这次发送动作；不能称消息载荷或该次发送调用已验证。被动记录器本身也不读取 WebSocket 帧。

打招呼 `GET /wapi/zpjob/chat/start` 目前仍只有下方静态证据；本轮没有点击打招呼，也未重放发送 API。

---

# BOSS 聊天地址与接口证据（2026-11-20）

## 核验范围

本记录来自本机已保存的 BOSS 页面及 JavaScript 文件静态分析，**不是本次真实网络抓包结果**。未向候选人发送打招呼或聊天消息，未使用 BOSS 页面的开发者工具、调试协议或调试扩展。文件的保存时间、对应线上版本和当前有效性未作确认；以下接口不能据此称为当前线上唯一接口。

未在这些文件中找到并验证“固定 URL 直接打开指定候选人聊天”的永久链接。不能把内部会话 ID、岗位 ID 拼进聊天首页后声称有效。

## 已有证据

| 用途 | 地址/调用方式 | 证据层级 |
| --- | --- | --- |
| 聊天页面入口 | `https://www.zhipin.com/web/chat/index` | 已保存页面中的真实导航链接；非候选人专属链接 |
| 发起沟通/打招呼 | `GET https://www.zhipin.com/wapi/zpjob/chat/start` | 已保存 BOSS JavaScript 的请求封装及调用链；本次未发送验证 |
| 批量发起沟通 | `POST https://www.zhipin.com/wapi/zpboss/h5/chat/batchStart` | 已保存 BOSS JavaScript 的请求封装；本次未发送验证 |
| 聊天历史读取 | `GET https://www.zhipin.com/wapi/zpchat/boss/historyMsg` | 本项目现有扩展实现；不是独立的 BOSS 静态资源证据或本次抓包证据 |
| 打开已存在的候选人会话 | `mediator.publish("OPEN_CHAT", ...)` / `chat.openChat({...})` | 已保存 BOSS JavaScript 的页内调用；未证明对应可复用深链 |
| 普通聊天消息的网络发送地址 | 尚未确认 | 有页内 `SEND_MESSAGE` 调用和 MQTT 库，但缺少当前实际网络端点证据 |

## 静态代码摘录

### 1. 聊天首页

来源：`<本地核验资料>/BOSS直聘.html`，导航元素：

```html
<a href="https://www.zhipin.com/web/chat/index" ... ka="menu-im" ...>
```

页面保存来源注释为 `https://www.zhipin.com/web/chat/geek/manage_v2`。它是当时页面位置，也不是某位候选人的专属聊天地址。

### 2. 发起沟通接口及参数

来源：`<本地核验资料>/523.js.下载` 第 2 行。该文件为压缩文件，下列为原始代码片段：

```js
W=function(){return E("/wapi/zpjob/chat/start",arguments.length>0&&void 0!==arguments[0]?arguments[0]:{},{})}
```

同一模块的 `E` 封装使用 GET，参数放入 `params`：

```js
r.params=D(t,r),r.cancelToken=new o.CancelToken(function(e){i&&(i.source=e)}),b.get(e,r)
```

调用链先执行 `Ho(t)` 再执行 `W(i)`。`Ho` 将输入映射为：

```js
Object.entries({gid:t,suid:n,jid:i,expectId:r,lid:o,greet:a,from:s,securityId:l,entrance:u})
```

对应输入字段依次为 `geekId`、`suid`、`jobId`、`expectId`、`lid`、`greet`、`from`、`securityId`、`entrance`。调用前还检查 `jobId`、`expectId`、`securityId` 和非空 `geekSource`。`securityId` 等值依赖当前页面和登录会话，不能当作永久公开链接参数。没有将任何真实授权值写入本记录。

### 3. 批量发起沟通

来源：`<本地核验资料>/app(1).js.下载` 第 2 行：

```js
t.postBatchChatStartAjax=function(e){return(0,i.post)("/wapi/zpboss/h5/chat/batchStart",e)}
```

这是另一条发起沟通路径，因此单凭静态文件不能声称所有打招呼操作均只访问同一个地址。

### 4. 指定候选人打开会话

来源：`<本地核验资料>/523.js.下载` 第 2 行：

```js
e.openChat({uid:n,source:i,securityId:r,expectId:o,jid:a,from:"geek-manage-resume",hideToast:!1})
```

另有 `openChat` 内部通过事件总线打开会话，并可在 500 毫秒后发送页内消息事件：

```js
o.publish("OPEN_CHAT",R(R({},n),{},{from:i})),
e&&setTimeout(function(){o.publish("SEND_MESSAGE",{selfInfo:a,geekInfo:n,greet:e})},500)
```

来源：`<本地核验资料>/app(1).js.下载` 第 2 行，已是好友时：

```js
a.publish("OPEN_CHAT",d(d({},e),{},{geekId:e.encryptGeekId||e.geekId,jobId:e.encryptJobId}))
```

这些证明“打开谁的聊天”依赖候选人、岗位及会话上下文，**不证明存在固定 HTTP 深链**。`SEND_MESSAGE` 是 JavaScript 事件名，也不是网络 URL。

### 5. 项目现有历史读取实现

来源：`<本地核验资料>/chat-message-source.mjs` 第 403–405 行：

```js
const url = new URL('/wapi/zpchat/boss/historyMsg', location.origin);
url.searchParams.set('gid', target); url.searchParams.set('c', String(count)); url.searchParams.set('src', '0');
const response = await fetch(url.href, {method:'GET', credentials:'include', redirect:'error', signal:abort.signal});
```

这是读取历史消息，不能用于证明普通消息发送接口。实现携带当前登录态，并在读取前后核对会话归属。

### 6. MQTT/网络发送限制

保存页面加载 `mqtt-v1.2.min.js.下载`，该库含 `WebSocket`、`new WebSocket` 及 `Paho`。库的存在只表明具备相关传输能力；当前保存文件未提供可核实的实际 WebSocket 服务域名、连接 URL、普通消息发送帧与参数对应关系。

## 仍待真实操作核验

- 在非调试网络记录中确认打开会话时的实际请求、方法、状态码及会话参数。
- 由真实发送动作产生的记录，才能确认该动作最终访问的打招呼或聊天发送地址；本记录没有进行发送动作。
- 如出现候选人专属 URL，需重新打开并确认仍定位同一候选人和岗位，才可认定可复用；目前没有这个验证结果。

只有网络域名/IP 或建立 WebSocket 连接的记录，仍不足以证明特定消息的发送接口。此记录不包含 Cookie、令牌、聊天正文或真实候选人的会话标识。


## 本次操作与后续抓包入口

本次未完成真实 BOSS 抓包：桌面控制在两个连接中均返回 `get_window_state timed out`，无法正常点击导出或重新加载扩展。只读浏览器标签清单观察到当前聊天入口为 `/web/chat/interaction`，其状态/时间参数不包含已确认的候选人永久深链。

扩展 0.5.109 的「记录聊天网络地址」改为可选 `webRequest` 被动记录，不使用浏览器调试接口。重新加载扩展后，从 BOSS 页打开该入口、开始记录并正常打开聊天即可。WebSocket 只记录握手地址，不能读取帧；已有连接需要刷新 BOSS 后才能重新观察握手。未执行任何打招呼或发送消息操作。该能力依据 [Chrome webRequest 官方说明](https://developer.chrome.com/docs/extensions/reference/api/webRequest)，实际接口结果仍须以用户账号的记录为准。
