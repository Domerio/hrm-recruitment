# BOSS 指定会话链接与消息传输代码证据

本文件整理 2026-11-20 从公开静态资源取得的代码证据。下载没有携带登录 Cookie，没有调用聊天接口、执行页面脚本或发送消息。

公开来源：[BOSS index v11800 / static/js/789.js](https://static.zhipin.com/zhipin-boss/index/v11800/static/js/789.js)。本地副本：`data/boss-static-route-audit/index-v11800-789.js`，原始下载 SHA-256：`c9b6c0c0e7fbe2631d533b239cfdc71daabbc56f453982b62a6c5c6028afb83e`。

以下偏移均指 UTF-8 解码后、从 0 开始的字符位置附近；压缩源码片段保持原样。

## 指定候选人的聊天链接

路由声明（偏移约 2134709）：

```js
{name:"chat",path:"/web/chat/index"
```

聊天组件的 `$route` 监听器（偏移约 2097900）合并路由参数和 query，读取 `uid/source`：

```js
e=(t=Gi(Gi({},t.params),t.query)).uid,n=t.source
```

同一监听器分支：

```js
i?r.A.getFriendsByLabel({encJobId:i,labelId:0}):e?Ot.A.openChat(e,n)
```

官方 `openChat` 方法主动构建该路由（偏移约 3613093）：

```js
iBossRoot.router.push({name:"chat",query:{uid:n.uid,source:n.source}})
```

据此，已存在的普通候选人会话可使用：

```text
https://www.zhipin.com/web/chat/index?uid=<数值会话ID>&source=0
```

`uid` 是会话候选人的数值 ID，不是 `encryptGeekId`；`source` 需对应真实会话，普通候选人本次为 `0`。不要额外加 `encryptJobId`：上述监听器优先执行岗位筛选分支，可能跳过打开指定候选人。该地址依赖当前登录账号及其会话访问权限，不能称为免登录公开链接或保证永久有效。

## 非好友拒绝逻辑（2026-11-20 补核）

用户打开推荐候选人的 UID 链接后出现「该牛人不在好友列表，无法沟通」。本地官方 `index-v11800-789.js` 在字符偏移 `1669093` 附近的 `openChat` 使用 `friendId + friendSource` 查询好友记录，返回空列表时在 `1669435` 附近显示完全一致的文案；相应好友查询封装指向 `/wapi/zprelation/friend/getBossFriendListV2.json`。

`index-v11800-684.js` 在 `3939689` 附近分别读取 `geekBaseInfo.userId` 和 `resumeInfo.friend`；在 `4050350` 附近的打招呼成功回调中才设置好友关系并调用 `setFriend()`。因此候选人 UID、收藏、转发给同事都不能替代当前招聘账号的沟通关系。这里只读审查本地静态资源，没有调用接口或发送消息。工作台不得把推荐 UID 的存在直接当成可联系证据。

## 普通消息发送链

`iBossRoot.chat.sendMessage`（偏移约 3614395）传给消息处理器：

```js
F.A.sendMessage(n,t,e)
```

消息处理器（偏移约 3567900）将文本构造成协议消息，随后调用 socket 发送：

```js
l=b.A.createMessage.text(c)
```

```js
g.A.send(l)
```

socket 的 `send`（偏移约 3558317）最终执行：

```js
this.client.send("chat",t.toArrayBuffer(),1,!0)
```

因此，该代码路径的正文通过 MQTT/WebSocket 二进制消息传输，`chat` 是 MQTT topic，不是一个 HTTP URL。发送前出现的权限、限额等 HTTP 请求不能仅凭时间相近就认作正文发送接口。

## WebSocket 地址及动态主机池

连接创建（偏移约 3554448）：

```js
new Paho.MQTT.Client(_.server,_.port,"/chatws",this.config.uuid)
```

生产默认配置（偏移约 3549800）：

```js
{useSSL:!0,server:"",port:443,uris:["ws6.zhipin.com","ws2.zhipin.com","ws.zhipin.com"]}
```

当前主机池还会通过配置接口读取（偏移约 3677780）：

```js
at=function(){return(0,n.Jt)("/wapi/zpchat/config/ws",0<arguments.length&&void 0!==arguments[0]?arguments[0]:{})}
```

`fetchWSPool` 使用返回的 `zpData.result` 更新主机池，连接失败时会轮换主机。地址形态为 `wss://<当前池中主机>/chatws`，不能据此声称只有一个固定域名。

## 主任务提供的真实核验结果

下列结果来自主任务的正常浏览器界面操作和被动网络记录，区别于本文件作者的静态分析：

- 新标签页正常打开 `https://www.zhipin.com/web/chat/index?uid=<会话UID>&source=0`，定位到“陈隆 / 工业工程师”及同一历史会话。
- 被动记录捕获 `wss://ws.zhipin.com/chatws`，握手 HTTP 状态为 `101`。原始筛选记录位于 `data/boss-passive-capture-2026-11-20.json`。
- 该轮记录约为 09:56–10:01；用户约 10:03 的发送发生在记录窗口之外。没有捕获该次实际发送载荷；上述发送链结论属于静态代码证据。被动记录器本身只记录 WebSocket 握手，不读取消息帧。
