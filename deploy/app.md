# App 独立服务部署准备

> 状态：仅准备材料，未执行部署、目标 Linux 验证或商店发行。真实 Apple / Google、域名及商店配置尚未就绪；阶段 12 运维验收仍未开始。

## 1. 独立范围

复用现有 Node.js 22.x / 24.x、Express、Socket.IO 和 SQLite，保持单进程、单实例。房间在内存中，重启会结束对局；不使用 PM2 cluster 或多副本。此处目录、账号和服务名与现有微信环境分离，不修改微信配置或部署。

| 项目 | App 专用位置 |
|---|---|
| 服务 / 系统用户 | `qile-wodi-app.service` / `qile-wodi-app` |
| 发布目录 / 当前入口 | `/opt/qile-wodi-app/releases/<修订>/server` / `/opt/qile-wodi-app/server` 符号链接 |
| 长期配置 | `/etc/qile-wodi-app/app.env` |
| 持久库 | `/var/lib/qile-wodi-app/users.sqlite` |
| 备份目录 | `/var/backups/qile-wodi-app` |
| 本机监听 | `127.0.0.1:3011`，执行前确认端口未被其他环境占用 |

## 2. 首次准备清单

以下命令尚未执行。先在目标 Linux 从已验收的服务端提交准备独立发布目录，使用实际运行的 Node 主版本执行 `npm ci --omit=dev` 并检查 `better-sqlite3` 可加载；不复制本机 `node_modules`。创建当前入口符号链接时指向该目录，不覆盖现有实际目录。

首次创建系统用户与长期目录：

```bash
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin qile-wodi-app
sudo install -d -o root -g qile-wodi-app -m 750 /etc/qile-wodi-app
sudo install -d -o qile-wodi-app -g qile-wodi-app -m 700 /var/lib/qile-wodi-app /var/backups/qile-wodi-app
```

从当前 App 服务端发布目录执行以下配置步骤；已有配置直接编辑，不重新覆盖或生成密钥：

```bash
sudo install -o root -g qile-wodi-app -m 640 .env.example /etc/qile-wodi-app/app.env
openssl rand -hex 32
sudoedit /etc/qile-wodi-app/app.env
```

沿用 [环境模板](../.env.example)，显式设置 `APP_CHANNEL=app`、`HOST=127.0.0.1`、`PORT=3011`、上述独立 `USER_DB_PATH`、独立生成且跨发布保留的 `AUTH_TOKEN_SECRET`。数据库和密钥不放发布目录；不能使用微信库或旧微信密钥。首次创建库须人工核实路径，路径拼错可能初始化一个空库。

`APPLE_CLIENT_ID`、`GOOGLE_WEB_CLIENT_ID` 和 Apple 撤销配置填写真实值；未配置的平台会拒绝授权，不能填假值绕过。`APP_VIP_PAYMENT_ENABLED`、`APPLE_STORE_ENABLED`、`GOOGLE_STORE_ENABLED` 保持 `false`，商店验证未验收不得开放；已有交易环境停卖后仍保留验证 / 通知凭证。公开页面配置按实际主体、支持邮箱和域名填写，不能用占位地址发行。App 广告开关在构建配置中另行验收，不由本服务模板开放。

## 3. 服务安装与验证清单

模板为 [qile-wodi-app.service.example](qile-wodi-app.service.example)，通过 `/usr/bin/env APP_CHANNEL=app` 强制渠道后执行 Node，避免模板环境文件中的微信默认值改变运行渠道；数据库、密钥及端口仍须独立配置。确认 `/usr/bin/node` 为已安装依赖对应的版本，并确保独立用户可读取代码、配置及所需证书。

```bash
sudo install -o root -g root -m 644 deploy/qile-wodi-app.service.example /etc/systemd/system/qile-wodi-app.service
sudo systemd-analyze verify /etc/systemd/system/qile-wodi-app.service
sudo systemctl daemon-reload
sudo systemctl enable --now qile-wodi-app
sudo systemctl status qile-wodi-app --no-pager
curl --fail http://127.0.0.1:3011/health
```

以上启动步骤须在目标环境准备就绪后执行；当前没有已运行的独立服务。健康结果应显示 `auth.channel=app`，配置标记仅表明配置状态，不能代替真实登录、删除、支付或持续数据库可用性检查。

域名、海外区域和证书尚待确定。沿用 [代理说明](../deploy.md#5-域名https-与反向代理) 的整站转发模式，将独立域名代理到 `127.0.0.1:3011`，保留 WebSocket Upgrade、`/auth`、`/app/store/events`、公开页面及关联文件路径；不得改写现有微信站点。反代可信来源配置须与实际代理一致，不将 `APP_TRUST_PROXY` 盲设为全信任。

App 收到 SIGTERM / SIGINT 后幂等停止接收新 HTTP / Socket 工作、停止周期任务并关闭内存房间；SQLite 保留至事件循环排空，包含客户端已先断开的在途请求，超过 25 秒则以失败状态退出，不保证超时外部操作完成。此行为已有本机子进程回归，仍待目标 Linux 演练；重启不会恢复旧房间。发布避开活跃对局，旧代码兼容当前协议及数据库时才可回退代码，始终保留最新数据库、账本和长期密钥，不用旧库补偿代码回退。

## 4. 备份期限与恢复限制

[备份脚本](../scripts/backup-users.js) 为 App 提供显式创建 / 清理命令，纯微信库仍使用原单文件命令。源库含 App 身份、交易或删除记录时，即使遗漏渠道环境变量也拒绝导出无期限的单文件。App 目录必须是本用户拥有的 `0700` 专用目录，首次为空，路径不可经过符号链接；不能接管原有散落的 SQLite 文件。以下命令仅为待执行步骤：

```bash
sudo -u qile-wodi-app env APP_CHANNEL=app USER_DB_PATH=/var/lib/qile-wodi-app/users.sqlite \
  /usr/bin/node /opt/qile-wodi-app/server/scripts/backup-users.js app-create /var/backups/qile-wodi-app
sudo -u qile-wodi-app env APP_CHANNEL=app \
  /usr/bin/node /opt/qile-wodi-app/server/scripts/backup-users.js app-prune /var/backups/qile-wodi-app
```

创建命令使用 SQLite 在线备份，并在同一个只读事务中确定快照与期限，不写源库。私有临时包经完整性、外键及 SHA-256 检查后原子发布，包内仅有 `users.sqlite` 和 `manifest.json`，文件权限 `0400`。输出包含包路径及绝对到期时间；源库有过期记录或复制完成时已到期就拒绝发布，先核查主库清理任务，不手工延长期限。

期限固定为 `min(备份开始时间 + 7 天, 快照内各 deleted_at + 7 天)`，复用 [7 天政策常量](../src/user/app-retention.js)。比如删号第 6 天的快照只剩 1 天，不能因备份或复制再保留 7 天。包名与 manifest 绑定同一开始时间、到期时间及随机 ID，发布后均不修改，复制不能重置期限；过期包立即不可用，独立 prune 可在 App 服务停止、源库不可用时清理。

prune 仅处理此工具的标记目录及受管包；轻量验证全部候选的包名 / manifest、文件类型、权限和属主后删除到期包，不跟随链接、不递归删除未知文件或微信备份。定时清理不扫描数据库内容；数据区损坏或截断不会延长已授权包的期限。元数据损坏、权限放宽、额外文件或范围异常会报错并停止本次删除，须及时处理告警。正常失败立即移除临时包；强制中止的 `.partial` 包不可用，有效元数据中的原期限仍适用，无法校验范围的遗留包需人工核查。

首次创建成功后，可在目标 Linux 安装独立 [清理 service](qile-wodi-app-backup-prune.service.example) 和 [清理 timer](qile-wodi-app-backup-prune.timer.example)。它不依赖主服务或登录密钥；每分钟检查一次，恢复开机后补执行，仍需告警和运维验收：

```bash
sudo install -m 644 deploy/qile-wodi-app-backup-prune.service.example /etc/systemd/system/qile-wodi-app-backup-prune.service
sudo install -m 644 deploy/qile-wodi-app-backup-prune.timer.example /etc/systemd/system/qile-wodi-app-backup-prune.timer
sudo systemd-analyze verify /etc/systemd/system/qile-wodi-app-backup-prune.service /etc/systemd/system/qile-wodi-app-backup-prune.timer
sudo systemctl daemon-reload
sudo systemctl enable --now qile-wodi-app-backup-prune.timer
sudo journalctl -u qile-wodi-app-backup-prune --no-pager -n 20
```

本机、异机、演练及临时核查副本都须纳入期限管理。复制受管包时保留目录标识、原包名 / manifest，并恢复同一环境专用目录与包的 `0700`、文件 `0400` 及正确属主；在每个副本位置独立执行 prune。工具不会自动传输异机副本，也不会删除旧单文件或任意目录中的散落副本；备份频率、迁移旧副本、离线介质到期处理与告警责任人仍须运维落实。

完整性、外键、校验和及迁移检查只支持隔离验证。旧快照可能缺少其后确认的删除、到账与退款，主库清理无法补回快照中不存在的删除标记。没有备份之后的权威删除 / 交易增量证据，不得用历史快照替换 App 生产库，不能承诺任意旧备份安全恢复。本工具没有生产恢复命令，也没有新增权威日志；此发行前缺口仍保留。

## 5. 尚待运维决定与验收

待确定主机 / 区域、独立域名、备份介质和频率、可接受恢复窗口、清理 / 告警责任人及灾难恢复依据；再执行目标 Linux 安装、故障与停服演练、真实平台联调。备份检查不会证明已删除账号不复活或新交易不丢失，这两项须单独取得恢复证据。部署、签名构建、商店审核、下载及收费 / 广告放行按 [阶段 12](../../documents/PLAN/app/12-独立部署与商店发行.md) 分别验收。
