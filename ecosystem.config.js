// PM2 部署配置 —— 大富翁在线
// 使用方式：
//   pm2 start ecosystem.config.js        # 按本配置启动（进程名 monopoly，端口 8081）
//   pm2 restart ecosystem.config.js      # 重启
//   pm2 logs monopoly                    # 查看日志
//   pm2 save                             # 保存进程列表，配合 `pm2 startup` 实现开机自启
module.exports = {
  apps: [
    {
      name: 'monopoly',
      script: './server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: 8081,
      },
    },
  ],
};