# 城市飞奔 · 幕后指挥系统（CRP）

给「城市飞奔」（City Run Project）比赛用的幕后管理网站：主办排赛程、排班、结算；跟队和站点人员在手机上记录队伍到达/完成时间、加减货币；所有人实时看到同一份数据。

- 前端：Vue 3 + Vite + TypeScript（`web/`）
- 后端：Node.js + Hono + `node:sqlite`（`server/`），Socket.IO 实时推送
- 数据：单个 SQLite 文件 + 附件目录（`DATA_DIR`，默认 `server/data/`）
- 设计文档：[PLAN.md](PLAN.md)；旧版单页原型：`docs/prototype/BJ20_CommandCenter.html`

## 本地开发

需要 Node.js ≥ 22.13（本机 25 亦可）。

```bash
npm install
npm run dev        # 后端 http://localhost:3000 ，前端 http://localhost:5173（已代理 /api 与 /socket.io）
```

打开 http://localhost:5173 ，用主办名单里的 ID（默认 `阳秋` / `云缨` / `云影`）注册，即为主办。其他人需要主办先在「主办后台 → 准入名单」里添加 ID 才能注册。

```bash
npm run typecheck  # 前后端类型检查
npm run build      # 打包前端并复制到 server/public，编译后端到 server/dist
npm start          # 生产模式：单进程同时提供页面与 API（默认 3000 端口）
```

## 部署到服务器（Vultr / 任意 Ubuntu 22.04+ 机器）

一台 1 核 1G 的机器足够。以 root 登录后：

```bash
git clone https://github.com/yituoren/crp.git /opt/crp
bash /opt/crp/deploy/install.sh
```

脚本会安装 Node 22 与 sqlite3、创建 `crp` 用户、构建、注册 systemd 服务 `crp`（监听 80 端口）、加每日 04:00 自动备份。完成后在手机上关掉 Wi-Fi 用流量访问 `http://服务器IP` 验证。

常用命令：

```bash
systemctl status crp            # 状态
journalctl -u crp -f            # 实时日志
bash /opt/crp/deploy/update.sh  # 拉取最新代码、重建、重启
bash /opt/crp/deploy/backup.sh  # 立即备份到 /opt/crp/backups
```

数据都在 `/opt/crp/data/`（`crp.db` 数据库、`uploads/` 附件、`jwt-secret.txt`）。迁移服务器只需复制这个目录。

暂未配置域名与 HTTPS。密码在网络上明文传输，请提醒幕后不要复用重要密码。以后加域名时把 Nginx/Caddy 反代到本服务即可，代码不用改。

### 可选：Docker

```bash
docker compose up -d --build   # 同样监听 80 端口，数据在 ./data
```

## 角色与权限

| 操作 | 主办 | 跟队 | 站点 | 机动幕后 |
|---|---|---|---|---|
| 查看赛程 / 排班 / 队伍 / 货币 | ✅ | ✅ | ✅ | ✅ |
| 编辑赛段、环节、附件 | ✅ | ❌ | 本站点附件 | ❌ |
| 排班 | ✅ | ❌ | ❌ | ❌ |
| 记录到达 / 完成 | 任意 | 仅所跟队伍 | 仅本站点 | ❌ |
| 修改 / 撤销已有记录 | ✅ | ❌ | ❌ | ❌ |
| 货币加减 | ✅ | ❌ | ✅ | ❌ |
| 罚时、终点名次、淘汰 | ✅ | ❌ | ❌ | ❌ |
| 准入名单、账号、备份、重置 | ✅ | ❌ | ❌ | ❌ |

权限在服务端校验；跟队/站点身份来自主办在「排班」里的分配，按赛段生效。

## 目录结构

```
server/src
  index.ts          启动、路由挂载、静态文件
  db.ts             SQLite 连接与建表
  auth.ts           登录态、角色与排班权限判断
  seed.ts           首次启动写入默认赛段/队伍/主办名单
  import-prototype.ts  导入旧版单页系统备份
  routes/           auth episodes teams assignments progress ledger announcements admin dashboard
web/src
  views/            各页面（今日 / 赛段 / 环节详情 / 排班 / 队伍 / 货币 / 大屏 / 结算 / 后台）
  components/       布局、弹窗、记录表格等
  stores/           auth（登录态）、race（比赛数据）、ui（提示与确认）
  realtime.ts       Socket.IO 失效通知 → 自动刷新
deploy/             install.sh / update.sh / backup.sh / crp.service
docs/               操作手册、原型
```

## 从旧版单页系统迁移数据

旧版「导出全部数据备份」得到的 JSON 可在「主办后台 → 备份与重置 → 导入旧版备份」导入；或在服务器上：

```bash
npm run import-prototype --workspace=server -- backup.json 2026-10-01
```

旧版的到达/完成时间只有时分秒，第二个参数指定这些记录所属日期。
