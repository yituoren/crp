# 城市飞奔（CRP）赛事幕后管理系统 · 实施计划

> 参考原型：`BJ20_CommandCenter.html`（单文件、Firebase RTDB + localStorage 双写）
> 目标：把原型升级为可多人同时使用、手机上顺手、数据可靠、权限真正受控的 Web 系统。

---

## 1. 业务背景（来自原型 + 公开资料）

城市飞奔（City Run Project）是粉丝自发组织、模仿《极速前进》的城市竞速活动：两人一队，按线索在城市中找到指定地点、完成任务、拿下一条线索，直到终点（Pit Stop）。一场比赛分若干赛段（EP），每赛段有经费限制，末位淘汰。

### 1.1 赛段内的环节类型（原型中的 LEG_TYPES）

| 缩写 | 中文 | 说明 | 系统需要记录的额外信息 |
|---|---|---|---|
| SL | 起跑线 | 赛段出发点，发放第一条线索 | 出发时间（可分批出发/按上段名次错峰） |
| RI | 路线信息 | 只指路，不设任务 | 到达时间 |
| TI | 任务点 | 普通任务，完成后拿线索 | 到达/完成时间、判定人 |
| DT | 绕道 Detour | 二选一任务，可中途换 | 选择了哪一边、是否换边 |
| RB | 路障 Roadblock | 只能一人完成 | 由谁完成（每人次数有上限） |
| FO | 快进 Fast Forward | 全赛程仅一队可用，成功直达终点 | 谁尝试、是否成功 |
| Union | 交叉 Intersection | 两队合并共同完成 | 配对队伍 |
| Trap | 陷阱 / U-Turn / Yield 类 | 让其他队伍额外做任务或罚时 | 施加方、被施加方、罚时 |
| （建议新增）PS | 终点 Pit Stop | 签到定名次、判定淘汰 | 签到时间、罚时结算、名次 |

### 1.2 幕后角色

| 角色 | 原型中的叫法 | 职责 | 权限要点 |
|---|---|---|---|
| 主办 | host | 设计赛程、排班、审核记录、货币最终裁决、淘汰 | 全部读写 + 后台 |
| 跟队 | follow | 每赛段跟一支队伍，记录该队到达/完成时间、监督预算 | 只能改自己所跟队伍的记录 |
| 站点 | station | 驻守某个环节，判定任务完成、发放线索、加减货币 | 只能改自己站点的记录与货币 |
| 普通幕后 | crew | 机动/摄影/后勤 | 只读 |

### 1.3 原型已有功能（必须保留）

- 准入名单 → 注册 → 登录；主办改密；主办可看账号库
- 5 个 EP × 可增删的环节；环节说明；图片/PDF 附件
- 每 EP 排班：幕后 → 跟队某队 / 驻守某站点
- 12 支队伍：改名、淘汰/恢复、货币余额（初始 1000）
- 到达/完成时间记录（带确认弹窗）；主办可手工修正
- 货币增减 + 原因 + 操作人 + 日志
- 数据导出/导入 JSON，一键重置
- 在线/离线状态指示，localStorage 兜底

### 1.4 原型的硬伤（新系统要解决）

1. 密码明文存储且在后台表格里直接显示。
2. 权限全在前端判断，任何人打开控制台都能改数据。
3. 附件以 base64 塞进数据库，几张图就撑爆同步。
4. Firebase 在国内移动网络下不稳定，比赛现场很可能变成"离线模式"。
5. 时间记录用本机时钟，不同手机时间不一致，名次会错。
6. 没有操作审计，记录被改了查不到是谁改的。
7. 单场赛事写死（BJ20、12 队、5 EP），换一场比赛要改代码。

---

## 2. 技术方案（推荐）

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vue 3 + Vite + TypeScript + Tailwind CSS，PWA | 移动端优先，幕后全在手机上操作；PWA 可加到主屏、可离线缓存 |
| 后端 | Node.js + Hono（或 Fastify）+ TypeScript | 轻、单进程够用；和前端同语言 |
| 数据库 | SQLite（better-sqlite3 + Drizzle ORM） | 单机、零运维、一场比赛几万条记录绰绰有余；备份就是复制一个文件 |
| 实时 | Socket.IO（WebSocket，自动降级轮询） | 主办大屏和跟队手机要实时看到彼此的记录 |
| 认证 | 用户名 + 密码（bcrypt）→ JWT，HttpOnly Cookie | 服务端校验角色；主办可重置任何人密码 |
| 文件 | 本地磁盘（或阿里云 OSS） | 附件走 URL，不进数据库 |
| 部署 | Docker Compose，Vultr 东京 VPS（用户已有；1C1G 起步够用），暂用 IP + HTTP（80 端口）访问 | 境内手机访问延迟约 80–150ms；后续如需 PWA/离线队列再加域名 + Caddy HTTPS |

备选：若你完全不想维护服务器，可用 Supabase（Postgres + Auth + Realtime + Storage），代码量更少；代价是境内访问偶发不稳、权限规则要写 RLS。**建议自建**，比赛现场对网络的容忍度最低。

---

## 3. 数据模型

```
events            赛事（BJ20 全明星赛…）：name, status(筹备/进行中/已结束), initialCurrency
users             幕后账号：username, passwordHash, displayName, isHost, disabled
access_list       准入名单：eventId, username, addedBy
episodes          赛段：eventId, code(EP1…), name, budget, startAt, status
legs              环节：episodeId, order, type, name, desc, address, mapUrl,
                  openTime/closeTime, judgeCriteria, clueText, penaltyRule
attachments       附件：legId, filename, mime, url, uploadedBy
teams             队伍：eventId, code(T1…), name, members(JSON), status(alive/eliminated/withdrawn), currency
assignments       排班：episodeId, userId, role(follow/station/crew), teamId?, legId?
progress          进度：episodeId, teamId, legId, arrivedAt, completedAt, status,
                  detourChoice?, roadblockBy?, ffAttempt?, note, recordedBy
penalties         罚时：episodeId, teamId, minutes, reason, appliedBy, appliedAt
pitstop_results   终点：episodeId, teamId, checkinAt, penaltyMinutes, finalTime, rank, eliminated
currency_ledger   货币流水：eventId, episodeId, teamId, delta, balanceAfter, reason, operatorId, at
announcements     公告：eventId, content, level, createdBy
audit_logs        审计：userId, action, targetType, targetId, before, after, at
```

所有时间戳由服务端写入（UTC），前端只负责"点了按钮"。

---

## 4. 权限矩阵

| 操作 | 主办 | 跟队 | 站点 | 普通幕后 |
|---|---|---|---|---|
| 查看赛程 / 排班 / 队伍 / 货币 | ✅ | ✅ | ✅ | ✅ |
| 编辑赛段、环节、附件 | ✅ | ❌ | 本站点附件 | ❌ |
| 排班 | ✅ | ❌ | ❌ | ❌ |
| 记录到达/完成 | ✅ 任意 | 仅所跟队伍 | 仅本站点 | ❌ |
| 修改已有记录 | ✅ | ❌（可申请修正） | ❌ | ❌ |
| 货币加减 | ✅ | ❌ | 仅本站点 | ❌ |
| 罚时、淘汰、终点名次 | ✅ | ❌ | ❌ | ❌ |
| 准入名单 / 账号 / 重置密码 | ✅ | ❌ | ❌ | ❌ |
| 导出 / 导入 / 重置赛事 | ✅ | ❌ | ❌ | ❌ |

权限在服务端按 assignments 表校验，前端只负责隐藏按钮。

---

## 5. 页面清单

**通用**
- 登录 / 注册（需在准入名单）/ 改密
- 顶栏：当前赛事、当前 EP、我的身份（主办 / 跟队 T3 / 站点 EP2-DT）、在线状态、待同步条数

**幕后端（手机优先）**
1. 我的今日：我在本 EP 的分工、要去的地点、地图链接、要盯的队伍、一键记录按钮
2. 赛段信息：EP 选择 → 环节卡片 → 环节详情（说明、附件、线索、判定标准、队伍完成表）
3. 记录面板：到达 / 完成 / 绕道选边 / 路障选人 / 加减货币，每次操作二次确认，离线时排队
4. 队伍：状态、余额、当前所在环节
5. 货币中心：余额一览 + 流水
6. 公告

**主办端（平板 / 电脑）**
7. 实时大屏：队伍 × 环节 进度矩阵、各队当前位置、实时名次、异常提醒（某队 30 分钟无记录）
8. 赛程编辑：赛段、环节（拖拽排序）、附件、经费、开放时间
9. 排班：按 EP 分配跟队/站点，支持一站多人，冲突检查
10. 终点结算：签到、罚时合计、自动排名、标记淘汰、生成本 EP 战报
11. 队伍管理：增删改、成员、淘汰/恢复、重置
12. 后台：准入名单、账号、重置密码、审计日志、导出/导入、赛事归档 / 新建赛事

---

## 6. 分阶段实施

### 阶段 0 · 确认需求（0.5 天）
- 见第 7 节决策点。

### 阶段 1 · 骨架 + 账号（2 天）
- monorepo：`apps/web`（Vue）、`apps/server`（Hono）、`packages/shared`（类型、常量）
- 数据库 schema + 迁移；seed 一场示例赛事
- 注册 / 登录 / 改密 / 准入名单 / 主办重置密码
- 角色中间件；审计日志基础设施
- Docker Compose 本地一键启动

### 阶段 2 · 与原型功能对齐（3 天）
- 赛事 / 赛段 / 环节 CRUD，附件上传（走文件存储，限制 10 MB，图片自动压缩）
- 排班（跟队 / 站点）
- 队伍管理、淘汰、货币流水
- 进度记录（到达 / 完成 / 主办修正），服务端时间戳
- 迁移脚本：把原型导出的 JSON 导入新库

### 阶段 3 · 实时与比赛逻辑（3 天）
- Socket.IO 推送：进度、货币、排班、公告
- 主办实时大屏
- 绕道选边、路障选人、快进、Trap/U-Turn 记录
- 罚时、终点签到、自动排名与淘汰
- 异常提醒（长时间无记录、预算超支）

### 阶段 4 · 现场可靠性（1–2 天）
- 手机端交互打磨：大按钮、防误触、深色模式、弱网提示
- 断网时的请求自动重试（不依赖 HTTPS）：提交失败自动重发 3 次，仍失败则提示用户稍后重按
- 导出 CSV / JSON、赛事归档
- （可选，需域名 + HTTPS）PWA 安装到主屏、静态资源离线缓存、IndexedDB 离线操作队列

### 阶段 5 · 上线与演练（1–2 天）
- 上线前检查：手机关 Wi-Fi 走流量（移动/联通/电信各测一次）确认 Vultr IP 在境内可达，不通则在后台换 IP 或重建实例
- 建议新开一台实例，与原代理机器分开：避免 80 端口冲突，避免代理流量导致 IP 被封连累系统
- Docker Compose 部署（web + server + Nginx 反代，监听 80）；幕后通过 http://IP 访问
- 密码走 HTTP 明文传输，提醒幕后不要复用重要密码；后续加域名后切 HTTPS 只需改 Nginx 为 Caddy
- 每日 cron 备份 SQLite 与附件目录到对象存储或另一台机器
- 用 3 台手机 + 1 台电脑做一次模拟赛段，压测 50 个并发连接
- 写一页「幕后操作手册」

合计约 12 个工作日；如果只做到阶段 2（功能对齐原型但更安全），约 5 天。

---

## 7. 需要你拍板的决策点

1. ~~**部署方式**~~ 已定：Vultr 东京 VPS（建议新开实例，与代理分开），暂不买域名，IP + HTTP 访问；PWA/离线队列推迟。
2. **单场还是多场**：系统只服务 BJ20，还是要能开新赛事重复用？（推荐多场，成本很低）
3. **选手是否登录**：目前只有幕后登录。要不要给参赛队一个只读页面看自己的线索/余额？
4. **附件规模**：每环节大约几张图？是否需要视频？决定用本地磁盘还是 OSS。
5. **名次规则**：终点名次按签到时间 + 罚时算，还是主办手工排？绕道/路障次数上限要不要系统硬性校验？
6. **UI 风格**：延续原型的蓝色卡片风，还是重新设计？

---

## 8. 参考资料

- 百度百科 · 城市飞奔：https://baike.baidu.com/item/%E5%9F%8E%E5%B8%82%E9%A3%9E%E5%A5%94/7570092
- 城市飞奔 Wiki（Fandom，需科学上网）：https://cityrunproject.fandom.com/wiki/%E5%9F%8E%E5%B8%82%E9%A3%9E%E5%A5%94_Wikia
- 极速前进任务卡说明（知乎）：https://www.zhihu.com/question/49492856
- 极速前进 · 维基百科：https://zh.wikipedia.org/zh-my/%E6%9E%81%E9%80%9F%E5%89%8D%E8%BF%9B
