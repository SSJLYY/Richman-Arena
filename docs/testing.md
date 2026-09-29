# 测试指南

项目有三套互不依赖的测试脚本，全部零测试框架（自带 `check()` 断言，输出 ✅/❌ 清单，非零退出码表示失败）。

## 一览

| 命令 | 文件 | 断言量 | 依赖 |
|------|------|--------|------|
| `npm test` | `smoke-test.js` | 139 | 需先 `npm start`（本机 8081），另自起一个随机端口实例 |
| `npm run test:render` | `render-test.js` | 76 | jsdom（devDependencies），无需服务器 |
| `npm run test:all` | 两个一起跑 | — | — |
| `node load-test.js [并发] [秒]` | `load-test.js` | — | 自起 8096 实例，socket.io-client |
| `npm run lint` | — | — | `node --check` 语法检查 server/app/测试脚本 |

首次运行先 `npm install`（devDependencies 含 jsdom / socket.io-client）。

## 冒烟测试 `npm test`

两段式：

1. **主实例全流程回归**：连接本机 8081 正在运行的服务（**跑之前需先 `npm start`**），开一个带时间戳的临时房间，模拟真人 + 机器人混合对局。
2. **测试实例确定性验证**：自行 `spawn` 一个随机端口的 `node server.js`（环境变量 `MONOPOLY_TEST=1` + 独立 `MONOPOLY_DATA_DIR`），用 `testHook` 构造确定性局面做精确断言。生产环境（无 `MONOPOLY_TEST`）测试钩子不可用，两实例可并行互不干扰。测试结束自动 SIGKILL 清理子进程。

覆盖面：加入/开局/掷骰/双数/购买/建造/酒店/抵押赎回/拍卖（含顺延与流拍）/奖池/卡牌/决策阶段/欠款筹钱期/破产清算与资产移交/托管/机器人接管/重连收回/交易确认/团队模式/银行房源售罄/回合上限/限速/房间密码/服务器重启恢复（口令持久）/成套租金精确值。

## 渲染回归 `npm run test:render`

在 jsdom 真实 DOM 中加载 `index.html` + `app.js`（伪造 socket，不发真实网络请求），验证：

- 棋盘**增量渲染**：买地 / 建房 / 酒店 / 抵押 / 移动闪烁 / 换地图 / 中央面板刷新 / 日志过滤各场景显示正确；
- **状态未变的格子复用同一 DOM 节点**（断言 `dataset` 引用一致，杜绝"每次广播销毁重建"回归）；
- 无障碍结构：弹窗焦点陷阱、aria 属性等。

## 压测 `node load-test.js`

```bash
node load-test.js          # 默认 40 客户端 × 30 秒
node load-test.js 300 60   # 300 并发 × 60 秒
```

自起一个 8096 端口的独立实例（独立数据目录），客户端随机加入/开局/掷骰/买地/聊天制造操作风暴。退出码 0 = 通过（服务存活、延迟达标、无内存爆涨）。历史上 40/100/300 并发均通过。

## 调试小技巧

- `testHook` 全部操作见 [api.md](api.md#测试钩子-testhook)，可在本地开发服（加 `MONOPOLY_TEST=1` 启动）里从浏览器控制台直接 `socket.emit('testHook', { op: 'setMoney', ... })` 造局面。
- 前端视觉回归用 URL 参数：`?demo=1&ui=settings&theme=dark` 一条命令截到稳定画面，见 [frontend.md](frontend.md#url-参数视觉回归--截图对比用)。
- `render-test.js` / `smoke-test.js` 的断言清单本身就是**功能清单**：想确认某规则（如酒店租金、成套 ×2）有没有实现，先 grep 测试文件。
