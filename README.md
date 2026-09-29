# 🎲 大富翁在线 (Monopoly Online)

经典大富翁的网页版实现 —— 多人联机、三档难度机器人、托管代打、拍卖、团队模式、对局回放，无需登录、打开即玩。

**在线地址**：http://129.211.29.228:8081

## 功能一览

- **经典规则**：40 格棋盘、掷骰移动、双数奖励（3 连双入狱）、购地 / 均匀建造（32 房 12 酒店银行库存）、成套租金 ×2、抵押赎回、机会 / 基金卡、限时拍卖（尾秒顺延）、奖池与免费停车、赌坊（武林图专属）、30 秒筹钱期与破产清算。
- **三张地图**：经典版 / 中国城市版 / 武林风云版（经济六折快速局）。
- **AI 与联机**：三档难度机器人、托管代打、退出/掉线后机器人接管席位、token 断线重连、玩家交易双方确认、AI 主动求购成套缺口地、房间密码。
- **团队模式**：2v2 组队，队友免租通行，整队淘汰判定，团队净资产定胜负。
- **数据与社交**：房间系统 + 观战、聊天 / 表情 / 音效、净资产趋势图、战绩排行榜、8 枚生涯成就徽章、最近对局档案、逐轮回放、结算统计（本局之最 / 到访热力 / 掷骰分布）。
- **工程质量**：多房间、回合超时跳过、速率限制、基础安全响应头、健康检查、服务器重启不丢局、优雅退出落盘、每日数据备份。

细节见 [docs/game-rules.md](docs/game-rules.md)（规则数值）与 [docs/bots.md](docs/bots.md)（AI 行为）。

## 技术栈

Node.js ≥18 · Express + Socket.IO（后端单文件，无构建步骤）· 原生 HTML/CSS/JS + PWA（前端单页，毛玻璃双主题）· JSON 文件持久化 · PM2 / systemd 托管。

架构说明见 [docs/architecture.md](docs/architecture.md)。

## 本地运行

```bash
npm install
npm start          # 默认 8081 端口，PORT=3000 npm start 可换端口
```

打开 `http://localhost:8081`，创建房间即可 —— 单人可添加机器人开局，或点「单人快速开局」。

## 测试

```bash
npm install        # 含 devDependencies（jsdom / socket.io-client）
npm start          # 冒烟测试需要本机 8081 实例
npm test           # 服务端冒烟测试（139 项断言）
npm run test:render # 前端渲染回归（jsdom，76 项断言）
npm run test:all   # 两套一起跑
```

测试策略与覆盖面见 [docs/testing.md](docs/testing.md)。

## 部署

服务器上以 PM2（`ecosystem.config.js`）或 systemd（`monopoly.service`）托管，前端文件替换即生效、无需重启，每日自动备份数据。完整步骤见 [docs/deployment.md](docs/deployment.md)。

## 文档导航

| 文档 | 内容 |
|------|------|
| [docs/game-rules.md](docs/game-rules.md) | 游戏规则详解：数值表、三张地图、卡牌、拍卖、破产清算、团队模式、胜负判定 |
| [docs/bots.md](docs/bots.md) | 机器人与托管 AI：三档难度行为差异、决策清单、掉线接管机制 |
| [docs/architecture.md](docs/architecture.md) | 架构与代码结构：目录、服务端/前端模块划分、状态同步模型、性能优化 |
| [docs/api.md](docs/api.md) | 通信协议：REST 接口、Socket.IO 事件、state 字段、测试钩子 |
| [docs/frontend.md](docs/frontend.md) | 前端设计：主题系统、棋盘增量渲染、弹窗与无障碍、移动端、音效、快捷键、URL 参数 |
| [docs/testing.md](docs/testing.md) | 测试指南：冒烟 / 渲染回归 / 压测的运行方式与覆盖面 |
| [docs/deployment.md](docs/deployment.md) | 部署运维：PM2 / systemd、更新发布、数据目录、监控与自治行为 |

## 快捷键

`空格` 掷骰 · `B` 购买 · `E` 结束回合 · `T` 交易 · `P` 保释 · `1/2/3` 拍卖加价 · `Shift+T` 换主题 · `H` 帮助
