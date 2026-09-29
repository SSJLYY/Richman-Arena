# 通信协议参考（REST + Socket.IO）

全部接口与事件的权威实现见 `server.js`。本文按「客户端 → 服务端指令」与「服务端 → 客户端推送」整理。

## REST 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/version` | `{ version }`，来自 package.json，前端头部版本角标数据源 |
| GET | `/health` | 健康检查，见下表 |
| GET | `/stats` | 运维统计：`{ status, rooms, playing(进行中对局数), humans(在线真人), bots(存活机器人), heapMB, uptimeSec, ts }` |

`/health` 返回字段：

| 字段 | 含义 |
|------|------|
| `status` | 固定 `"ok"` |
| `uptime` | 进程运行秒数 |
| `rooms` | 房间总数（含未开局） |
| `players` | 所有房间席位总数（含机器人、含掉线） |
| `connections` | 实时 WebSocket 连接数 |
| `memMB` / `heapMB` | 进程 RSS / V8 堆（MB） |
| `roomsPlaying` | 已开局未结束的房间数 |
| `ts` | 服务器时间戳（ms） |

静态资源由 `express.static` 直出（`Cache-Control: no-cache, must-revalidate` + ETag），替换文件即生效，无需重启。

## Socket.IO：客户端 → 服务端

连接后首个动作通常是 `join`。带 `★` 的事件有房主/本人校验，带 `⏱` 的事件有速率限制。

| 事件 | 载荷 | 说明 |
|------|------|------|
| `getRooms` | – | 拉取房间列表（响应走 `roomList`） |
| `join` ⏱ | `{ roomId, name, avatar, token, password }` | 加入/重连。token 6~64 位安全字符（服务端正则白名单校验，防 XSS）；房间已开局凭已有 token 重连，人满则成为观战者；带密码的房间校验 `password`（重连豁免） |
| `addBot` ★ | `{ difficulty }` | 添加机器人：`easy` / `normal` / `hard`（缺省 normal），仅开局前 |
| `kickBot` ★ | `{ token }` | 移除指定机器人，仅开局前 |
| `start` ★ ⏱ | – | 开局（仅房主；团队模式下按座位分队、随机先手可打乱顺序） |
| `roll` | – | 掷骰（本人回合、未掷、无待决弹窗时有效） |
| `buy` | – | 购买脚下无主地产 |
| `build` ★ | `{ cellId, action }` | `action: 'build'` 盖房 / `'sell'` 卖房 |
| `mortgage` ★ / `unmortgage` ★ | `{ cellId }` | 抵押 / 赎回（赎回价 = 抵押价 × 1.1） |
| `payBail` | – | 支付 ¥1000 保释出狱 |
| `endTurn` | – | 结束回合（脚下无主地未买 → 触发拍卖后交棒） |
| `auctionBid` ⏱ | `{ amount }` | 拍卖出价（必须 ≥ 当前最高 + ¥100 且 ≤ 现金） |
| `trade` | `{ targetId, giveMoney, getMoney, giveProps, getProps }` | 发起交易，30 秒内待确认 |
| `tradeResp` | `{ seq, accept }` | 对方应答交易 |
| `proposalResp` | `{ seq, accept }` | 应答 AI 求购提案 |
| `setAutoBuy` ★ | `{ on }` | 落地自动购买开关（个人偏好，随时可改） |
| `toggleDelegation` | – | 托管 / 取消托管 |
| `chat` ⏱ | `text` | 聊天（5 条/10 秒），≤120 字 |
| `setSettings` ★ | `{ startMoney, jackpotOn, auctionOn, map, randomFirst, turnTimeoutMs, password, teamMode, botSpeed }` | 房间设置，仅开局前；取值范围见 [game-rules.md](game-rules.md) |
| `setMaxRounds` ★ | `{ value }` | 回合上限：0(不限) / 20 / 30 / 50 / 80 |
| `reset` ★ ⏱ | – | 重开一局（保留房间与席位，清空对局状态） |
| `leave` | – | 返回大厅（对局中席位由机器人接管） |
| `disconnect` | – | 掉线：立即自动托管，5 分钟未归由机器人接管 |
| `testHook` | `{ op, ... }` | **仅 `MONOPOLY_TEST=1` 时生效**，见文末 |

## Socket.IO：服务端 → 客户端

| 事件 | 载荷 | 说明 |
|------|------|------|
| `state` | 房间全量状态（见下） | 任意变更后的全量广播，前端唯一事实来源 |
| `roomList` | `[{ id, playerCount, started, ended, spectators, mapName, locked }]` | 大厅房间列表（创建/加入/退出/开局/结束节点推送，全局广播） |
| `joined` | `{ roomId, token, spectator }` | 加入确认；`spectator=true` 表示人满转观战 |
| `stats` | `{ top(排行榜前10), mine(我的生涯数据), recent(最近8条对局) }` | 大厅战绩数据（响应 `getStats` / `join`） |
| `msg` | `string` | 操作被拒 / 提示类消息，前端 Toast 展示 |

## `state` 主要字段

```
id, hostToken, started, ended, roundCount, turnIndex, winnerToken
players{token → 玩家}（含 money/pos/jailTurns/bankrupt/properties/delegated/isBot/botLevel/team…）
order[token]                # 行动顺序
board[40]                   # 含实时计算的 rent（公用事业 = -1 哨兵，表示按骰点计）
dice, diceAnim, currentRolled
auction                     # 进行中拍卖（含出价历史末 5 条、endsAt）
debt                        # 筹钱期（谁、欠谁、多少、截止时间）
trade / proposal            # 待确认交易 / AI 求购提案（含 expiresAt）
jackpot, bank{houses,hotels}, maxRounds, settings, groups(色系表)
mapId, mapName, rentMul, houseMul
nwHistory                   # 净资产走势（末 100 轮）
landingStats, diceHistory   # 到访热力 / 掷骰分布（结算统计用）
replay                      # 每轮棋盘快照（回放用）
lastCard, lastRentPaid, maxRent, startedAt, turnStartedAt
spectatorCount
logs[50], chats[50]
```

玩家敏感字段（`origName` 等接管痕迹）不下发删减，但 token 仅本人可见用途；对局数据整体无隐私假设。

## 测试钩子 `testHook`

启动服务时设置 `MONOPOLY_TEST=1` 才可用（生产环境直接 return），供冒烟测试构造确定性局面：

`teleport`（传送玩家）· `resolve`（立即结算落地）· `auction`（强开拍卖）· `jackpot`（设置奖池）· `setMoney` · `save`（强制落盘）· `setMax`（银行房源）· `setRounds`（回合数）· `lastCard`（伪造抽卡）· `addBotSide` / `addBotForce`（造 bot）· `setOwner`（设地块归属）· `setBank` · `bankrupt`（强制破产）· `landAs`（模拟落地）· `setLevel`（设建筑等级）· `mkproposal`（伪造 AI 求购）
