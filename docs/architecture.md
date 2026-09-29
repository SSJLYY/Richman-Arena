# 架构与代码结构

单进程 Node.js 服务 + 原生前端，**无构建步骤**：改完文件刷新浏览器即生效（服务端改动需重启进程）。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js ≥18 · Express 4（静态资源 + REST）· Socket.IO 4（实时对局） |
| 前端 | 原生 HTML / CSS / JavaScript，模块按文件切分，无框架、无打包器 |
| 持久化 | JSON 文件（`data/`），原子写入 + 每日备份 |
| 进程 | PM2 或 systemd 托管（见 [deployment.md](deployment.md)） |
| 依赖 | 仅 3 个运行时依赖：express / socket.io / compression |

## 目录结构

```
monopoly/
├── server.js              # 服务端全部逻辑（约 2400 行，单文件）
├── public/
│   ├── index.html         # 单页应用骨架（大厅 + 对局两视图）
│   ├── app.js             # 前端全部逻辑（约 2900 行，单文件）
│   ├── manifest.json      # PWA 清单（可安装到主屏，无离线缓存）
│   ├── icon*.svg          # 普通 / maskable 图标
│   └── css/
│       ├── tokens.css     # 设计令牌：颜色/圆角/阴影，仅此文件定义颜色（深/浅两套主题）
│       ├── base.css       # 重置与全局基础样式
│       ├── controls.css   # 按钮 / 输入框 / 滑块等控件
│       ├── panels.css     # 弹窗 / 侧栏 / 设置面板
│       ├── board.css      # 棋盘与格子（刻意保持浅色经典印刷风，不随主题翻转）
│       └── lobby.css      # 大厅布局
├── data/                  # 运行时数据（gitignore，可环境变量改路径）
│   ├── rooms.json         # 全部房间与对局状态（10 秒节流落盘）
│   ├── stats.json         # 真人玩家生涯战绩
│   ├── history.json       # 最近 20 条对局档案
│   └── backup/            # 每日自动备份，保留 7 份
├── smoke-test.js          # 服务端冒烟测试（~140 断言）
├── render-test.js         # 前端渲染回归（jsdom，~70 断言）
├── load-test.js           # 压测脚本（并发操作风暴）
├── ecosystem.config.js    # PM2 配置
├── monopoly.service       # systemd 服务模板
└── docs/                  # 本文档目录
```

## 服务端模块划分（server.js）

单文件按注释分段，自上而下：

1. **静态资源与中间件** — 安全响应头、gzip（>1KB 文本）、`express.static`（`no-cache` 协商缓存，换文件即生效）、`/version` 版本角标。
2. **游戏常量与数据** — 数值常量、色组租金表、棋盘模板、三张地图、机会/基金卡牌。
3. **房间与玩家管理** — `createRoom`（含全部房间字段）、`createPlayer`、房间列表、速率限制（join/start/bid/chat/reset 各有限额）。
4. **游戏逻辑** — 落地结算 `landOn`、移动与过路工资、监狱、租金计算 `calcRent`、建造合法性 `canBuild/canSell`、扣款与筹钱期 `charge/openDebtPeriod`、破产清算 `handleBankruptcy`、拍卖（起拍 / 顺延 / 结算）、交易执行、AI 求购提案。
5. **机器人 AI** — 三档难度决策、托管、掉线接管（见 [bots.md](bots.md)）。
6. **Socket.IO 事件** — 客户端指令入口，详见 [api.md](api.md)。
7. **持久化** — `loadRooms` / `saveRoomsNow`（10 秒节流 + 变更即排队）、`atomicWriteJson`（临时文件 + rename，防写坏）、每日备份、断电恢复（`readLatestRoomsBackup` 兜底回档）。
8. **健康检查与定时任务** — `/health`、`/stats`、10 秒轮询（回合超时、空闲房清理、限速表清理）。
9. **优雅退出** — SIGTERM/SIGINT 先落盘再关 HTTP，1.5 秒兜底强退。

关键设计决策：

- **玩家身份 = token**（前端首次进入随机生成，localStorage 持久）。重连、刷新、换设备均凭 token 认领席位，房间 `players` 用 `Object.create(null)` 防原型污染。
- **权威服务端**：客户端只发意图（roll/buy/build…），全部规则判定与随机数在服务端，`state` 广播为唯一事实来源。
- **测试钩子隔离**：`testHook` 仅在 `MONOPOLY_TEST=1` 环境变量下生效，生产环境不可用。

## 前端模块划分（app.js）

| 模块 | 职责 |
|------|------|
| `state` | 最近一次服务端广播的全量状态 + 本地 UI 状态（回放帧、缩放、弹窗） |
| `Sound` | WebAudio 合成音效（掷骰/收租/建造/拍卖槌/胜利…），无外部音频文件，音量与开关存 localStorage |
| `Theme` | 深/浅双主题切换（`data-theme` 属性 + tokens.css 变量），localStorage 记忆，URL 参数可强制 |
| 弹窗系统 | `modalStack` 栈式管理、焦点陷阱、ESC/遮罩关闭策略、不可跳过弹窗（购地确认/交易） |
| 棋盘渲染 | **增量渲染**：格子骨架复用，静态签名 `cellStaticSig` 未变化的格子不重建 DOM；棋子层独立做逐格跳动动画 |
| 日志渲染 | 内容签名比对，未变化整块跳过 |
| 租金预统计 | `computeMonopolies` 把成套判断一次性算好，广播渲染不再 O(n²) |
| 回放 | 服务端每轮推送棋盘快照，本地滑杆 / ◀▶ 逐帧回看，直播态无缝切回 |

## 状态同步模型

```
客户端指令 ──socket.io──▶ server.js 变更 room 状态 ──▶ broadcast(roomId)
                                                          │
                              getPublicState(room) 全量序列化（含棋盘/玩家/日志尾部/拍卖/欠款…）
                                                          │
                     房间内所有 socket ◀── 'state' 事件 ────┘
```

- 每次任意变更**全量广播**该房间状态，前端以最新快照整体刷新（配合增量渲染控制开销）。
- 大厅数据（房间列表）单独走 `roomList` 事件，只在创建/加入/退出/开局等节点推送。
- 对局中的原子片段（金钱飘字、掷骰动画、抽卡浮层、拍卖出价历史）由前端 diff 相邻两帧状态得出。

## 性能要点

| 优化 | 效果 |
|------|------|
| gzip（compression，>1KB）+ ETag 协商缓存 | app.js ~140KB → ~40KB 传输 |
| 棋盘增量渲染 + 签名比对 | 广播不再销毁重建 40 格 DOM |
| 日志渲染签名 | 内容未变整块跳过 |
| 租金预统计表 | 广播时 rent 计算从 O(n²) → O(n) |
| 无外部字体/CDN 依赖 | 国内网络首屏不被阻塞 |
