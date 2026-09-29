# 部署与运维

线上环境：腾讯云 CentOS 7.9，代码位于 `/opt/monopoly`，进程名 `monopoly`，端口 `8081`。两种方式任选其一（也可 systemd 只负责开机拉起 PM2，见 `monopoly.service` 内注释）。

> CentOS 7 自带源没有新版 Node，需先安装 Node.js ≥18（如 NodeSource 或二进制包）。

## 方式一：PM2（推荐）

仓库内置开箱即用的 `ecosystem.config.js`（进程名 `monopoly`、fork 单实例、`max_memory_restart=400M`、默认端口 8081）：

```bash
cd /opt/monopoly
npm install --omit=dev
pm2 start ecosystem.config.js
pm2 save                # 保存进程列表
pm2 startup             # 生成开机自启命令（按打印提示执行一条命令）
```

日常运维：

```bash
pm2 restart monopoly    # 重启（仅 server.js / package.json 变更时需要）
pm2 logs monopoly       # 日志
pm2 monit               # 交互式资源监控
curl :8081/health       # 健康检查
```

## 方式二：systemd

`monopoly.service` 为 systemd 服务模板（适配 CentOS 7 / systemd v219 语法），既支持直跑 node，也支持经 PM2 启动：

```bash
cp /opt/monopoly/monopoly.service /etc/systemd/system/monopoly.service
systemctl daemon-reload
systemctl start monopoly
systemctl enable monopoly     # 开机自启
systemctl status monopoly
journalctl -u monopoly -f     # 查看日志
```

直跑方式请核对 `ExecStart` 里的 node 路径（`/usr/bin/node`）。

## 更新发布

```bash
cd /opt/monopoly
git pull                     # 或本地打包上传
npm install --omit=dev       # 依赖有变时
pm2 restart monopoly         # 仅当 server.js / package.json 变了
curl -s :8081/health | head  # 确认 status:"ok"
```

**前端文件（public/）不用重启**：`express.static` 响应头为 `no-cache, must-revalidate` + ETag，替换文件即生效。只有 `server.js` / `package.json` 变更才需要重启进程。

版本核对：`curl -s :8081/version` 应等于 package.json 的 `version`；前端页面左上角版本角标即来自该接口。

## 数据目录

`/opt/monopoly/data/`（可用环境变量 `MONOPOLY_DATA_DIR` 改路径，测试脚本均用独立目录避免污染生产数据）：

| 文件 | 内容 | 写入时机 |
|------|------|----------|
| `rooms.json` | 全部房间与对局状态 | 10 秒节流落盘 + 每次广播排队保存 + 退出前强制落盘 |
| `stats.json` | 真人玩家生涯战绩 | 每局结束 |
| `history.json` | 最近 20 条对局档案 | 每局结束 |
| `backup/` | 每日备份（`YYYY-MM-DD-rooms.json` 等），**保留 7 份** | 每日首次落盘时 |

**服务器重启不丢局**：对局状态落盘后重启自动恢复（含机器人接管、房间密码、卡牌剩余序）。文件损坏时启动自动回退到最近一份备份。

## 健康检查与监控

- `GET :8081/health` —— 存活 + 房间/玩家/连接数/内存，适合拨测。
- `GET :8081/stats` —— 更细的运营统计（在线真人 / 存活机器人 / 进行中对局数）。

字段说明见 [api.md](api.md#rest-接口)。

## 内置的自治行为（无需人工干预）

- 回合超时（30/60/120 秒可配）自动结束回合；
- 全员掉线且 30 分钟无活动的房间自动销毁；
- 掉线玩家先托管、5 分钟后由机器人接管；
- join/start/bid/chat/reset 各有速率限制；
- 结束的房间保留 30 分钟供回看战绩，随后清理。

## 安全基线

- 安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: same-origin`（CSP 因历史内联样式暂未启用）。
- token / 房间号正则白名单校验，聊天与昵称转义，防存储型 XSS。
- 无登录体系：凭 localStorage token 识别身份，不要在前端存放敏感数据。
