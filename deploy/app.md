# App 独立服务部署准备

> 状态：App 域名已有可访问的线上实例。2026-10-31 经用户确认，已加载 Google 登录 / Play 通知和验单配置并重启；VIP 售卖仍关闭，真实 Google 登录、交易及通知端到端验收、完整运维验收和商店发行仍未完成。下述部署命令仅供用户后续执行，不代表其他仓库修改均已部署。

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

以下为目标环境准备步骤，不代表已在现有线上实例执行。先在目标 Linux 从已验收的服务端提交准备独立发布目录，使用实际运行的 Node 主版本执行 `npm ci --omit=dev` 并检查 `better-sqlite3` 可加载；不复制本机 `node_modules`。创建当前入口符号链接时指向该目录，不覆盖现有实际目录。

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

`APPLE_CLIENT_ID`、`GOOGLE_WEB_CLIENT_ID` 和 Apple 撤销配置填写真实值；未配置的平台会拒绝授权，不能填假值绕过。通用环境模板默认停卖；用户要求的 Google Play 生产开关及增量配置见下方 2.2，已有交易环境停卖后仍保留验证 / 通知凭证。公开页面配置按实际主体、支持邮箱和域名填写，不能用占位地址发行。App 广告开关在构建配置中另行验收，不由本服务模板开放。

### 2.1 运营支持与公开页面

已确认运营团队为 **inpole studio**，官网为 **https://inpole.com**，支持邮箱为 **geek@inpole.com**；App 功能域名为 **https://iwodi.284264172.xyz**，隐私政策生效日期为 **2026-10-31**。2026-10-31 对官网执行 HTTPS HEAD 请求返回 HTTP/2 200，官网内容尚未验证；用户确认邮箱可收发及处理支持，本次未独立测试邮箱。团队名称不代表法律主体已核验，运营资料在现网是否生效仍须核验。

在独立 App 环境的 `/etc/qile-wodi-app/app.env` 中确认或填写：

```dotenv
APP_OPERATOR_NAME="inpole studio"
APP_OPERATOR_WEBSITE=https://inpole.com
APP_SUPPORT_EMAIL=geek@inpole.com
INVITATION_ORIGIN=https://iwodi.284264172.xyz
APP_POLICY_EFFECTIVE_DATE=2026-10-31
```

`APP_OPERATOR_WEBSITE` 是支持页上的可选 HTTPS 官网链接，不影响页面发布门控；`APP_OPERATOR_NAME` 和 `APP_SUPPORT_EMAIL` 仍须显式配置。`INVITATION_ORIGIN` 为承载 App 邀请、支持、隐私政策和关联文件的 HTTPS 源站，与运营官网分开；现有域名可通过 HTTPS 访问，仍须核对 DNS、证书、反向代理和关联文件是否满足正式部署要求。`APP_POLICY_EFFECTIVE_DATE=2026-10-31` 与当前 App 内置政策日期一致；商店链接和平台关联 ID / 签名指纹分别按实际发行配置填写。

预定公开页面地址：

| 用途 | 地址 |
|---|---|
| 支持 | `https://iwodi.284264172.xyz/support` |
| 隐私政策 | `https://iwodi.284264172.xyz/privacy` |
| 服务条款 | `https://iwodi.284264172.xyz/terms` |
| 账号删除 | `https://iwodi.284264172.xyz/account-deletion` |

这些地址为已确定的配置目标；部分页面已有线上响应，运营资料和政策配置是否已生效须逐一复验。

2026-10-31 外网检查：`/health` 返回 `status=ok`、`service=qile-wodi-server`、`auth.channel=app`，公开页面政策配置报告缺少 `APP_POLICY_EFFECTIVE_DATE`，说明已有 App 实例在运行；`/support` 和 `/account-deletion` 返回 HTTP 200，但响应中 Cloudflare 混淆后的邮箱解码为 `i@inpole.com`，与本次确认的 `geek@inpole.com` 不一致；`/privacy` 和 `/terms` 返回 HTTP 503。以上是检查时的线上结果，不代表仓库的新配置已部署。须在目标环境核对并写入 App 配置、部署匹配的服务端版本、重启服务后，再从外网检查四个页面的 HTTP 状态、显示内容与支持邮箱，并验证隐私政策日期；确认实际配置、反向代理或缓存问题已经解决后才能作为发行地址使用。

上线前确认运营团队对应的法律主体及商店开发者资料、邮箱收发与支持流程、官网可访问性，并核对 `/support`、`/privacy`、`/terms`、`/account-deletion` 实际内容。对外公开链接应来自实际已部署的 HTTPS 源站；不因模板中已有资料就视为网站已上线或政策已生效。

### 2.2 Google Play 登录、验单与通知

2026-10-31 已创建 Google Cloud 项目 `iwodi-play`；Play 包名为 `com.zhibeii.iwodi`，一次性可消耗商品 ID 为 `vip`，每次购买增加 30 天，不自动续费。项目内部逻辑商品仍为 `vip_month`，两者用途不同。

Google Play Developer API 和 Pub/Sub API 已启用。验单服务账号 `iwodi-play-verifier@iwodi-play.iam.gserviceaccount.com` 获本应用财务查看和订单管理权限；本机验单凭据 JSON 位于仓库外的 `/Users/dorok/.config/iwodi/google-play/verifier-a05866c2a2aa.json`，权限为 `0600`。该路径只适用于保管该文件的本机，不是服务器路径；私钥不得提交 Git、贴入聊天、写入日志或放入 `EXPO_PUBLIC_*`。

Google Play RTDN 使用主题 `projects/iwodi-play/topics/play-billing-events`，已授权 Google 官方发布者；推送订阅 `play-billing-push` 使用推送身份 `iwodi-play-push@iwodi-play.iam.gserviceaccount.com`，目标和 OIDC audience 均为 `https://iwodi.284264172.xyz/app/store/events/google`。

经用户确认，现网已加载此次 Google 配置并重启：健康检查显示 Google 登录配置为 `true`，无认证的伪造通知返回 `403`；这只证明配置标记与拒绝匿名请求，不能证明真实登录或验单成功。VIP 售卖开关保持 `false`。Play Console 提示测试通知已发出；随后 Pub/Sub 监控出现推送确认指标，未确认消息为零。该聚合数据支持推送已被确认，但现有日志不足以将单条消息与服务端 `204` 精确关联，真实购买 / 退款通知仍待验。

此次操作前已通过受管在线备份工具生成 App 数据库备份，原定最晚到期时间为 `2026-11-07 10:47:26 UTC`，受现有备份清理规则约束；不能将旧备份直接用于覆盖生产库。服务器 `/etc/qile-wodi-app/.google-play-20261031.staged.env` 是本次暂存配置，`/etc/qile-wodi-app/.app.env.pre-google-play-20261031` 是原配置备份，两者均为 `root:root`、权限 `0600`，包含敏感配置。用户在完成核验和回退窗口后应安全处理这些临时副本，不得提交或公开。

**后续由用户操作服务器**。下面是用户要求启用 Google Play 的生产环境非秘密配置，与 [增量模板](google-play-production.env.example) 相同；先确认实际 systemd unit、环境文件、运行用户、数据库与备份路径，不假设与本文件示例路径相同。只修改已核实的 App 环境文件，保留原 `USER_DB_PATH`、`AUTH_TOKEN_SECRET`、已有私钥和网站设置，不复制模板覆盖现有文件：

```dotenv
GOOGLE_WEB_CLIENT_ID=299375445471-dtll3k3o73sne55b5k9j3mcsk4864i0o.apps.googleusercontent.com
APP_VIP_PAYMENT_ENABLED=true
APPLE_STORE_ENABLED=false
GOOGLE_STORE_ENABLED=true
GOOGLE_STORE_PACKAGE_NAME=com.zhibeii.iwodi
GOOGLE_STORE_PRODUCT_ID=vip
GOOGLE_STORE_ENVIRONMENT=production
GOOGLE_STORE_CLIENT_EMAIL=iwodi-play-verifier@iwodi-play.iam.gserviceaccount.com
GOOGLE_STORE_NOTIFICATION_AUDIENCE=https://iwodi.284264172.xyz/app/store/events/google
GOOGLE_STORE_NOTIFICATION_EMAIL=iwodi-play-push@iwodi-play.iam.gserviceaccount.com
```

`GOOGLE_STORE_PRIVATE_KEY` 也须通过服务器受限配置安全提供，值是上述验单服务账号 JSON 的 `private_key` 内容；当前代码读取的是密钥值，不读取 JSON 文件路径。环境文件应仅允许服务运行用户及必要管理员读取；用受保护的编辑器或既有密钥注入方式填入，PEM 换行可写为字面 `\n`，不要经命令行参数、聊天、终端回显或 Git 传递。更换服务器时由用户安全传输凭据并按服务器实际权限配置；不得把上方本机 JSON 路径直接作为私钥值。

上述增量配置打开 Google Play 售卖并保持 Apple 关闭；仓库通用 `.env.example` 的默认值未更改，仓库配置不会自动修改现网。用户部署时在没有活跃对局的维护窗口备份并更新实际环境文件，重启对应 App 服务后核对健康状态、商品报价与购买流程；重启会结束该实例的内存房间。

若需停卖，将 `APP_VIP_PAYMENT_ENABLED` 或 `GOOGLE_STORE_ENABLED` 设回 `false` 并在维护窗口重启；保留当前数据库、签名密钥、Google 生产验单和通知凭证，以继续处理已产生的订单、退款和补偿。已完整配置的通知验证在停卖状态仍可运行，历史交易补偿也会在服务启动和定时执行；不能把停卖误解为所有账本处理关闭。成功的 Google 测试通知应返回 HTTP `204`；伪造或无效签名应拒绝。服务端默认不记录成功通知，须结合既有反向代理访问日志或 Pub/Sub 投递监控核实，不记录认证头或消息正文。

#### 同一地址的许可测试与正式模式

两个模式均使用 `https://iwodi.284264172.xyz` 和已有 Google Play 包名 / 商品；不需要新增域名，由用户在维护窗口操作：

| 模式 | 配置 | 数据与用途 |
|---|---|---|
| 许可测试 | [测试增量模板](google-play-license-test.env.example)，`GOOGLE_STORE_ENVIRONMENT=sandbox` | 切换到使用独立测试数据库和独立 `AUTH_TOKEN_SECRET` 的测试实例，使用 Play 许可测试账号；测试环境不承载生产用户数据。 |
| 正式 | [生产增量模板](google-play-production.env.example)，`GOOGLE_STORE_ENVIRONMENT=production` | 恢复原生产配置、原生产数据库及原生产 `AUTH_TOKEN_SECRET`；处理真实交易。 |

测试模板中数据库路径仅为示例，须先创建测试专用目录、设置服务用户权限并生成独立测试密钥。将模板合并到单独受保护的测试环境配置，安全注入 Google 验单私钥；不要覆盖生产环境文件、数据库或密钥。切换到测试时，将同一域名的请求临时指向独立测试实例，或在保留完整生产配置的前提下切换服务实例；正式服务与测试服务不能同时占用同一监听端口。切换前记录正在使用的生产服务、反代配置、数据库路径及密钥的安全保管方式；切回时恢复原生产服务和配置，保留两个环境各自最新数据库，绝不以备份或测试库覆盖生产库。

切换会中断现有 Socket 连接并结束被停止实例的内存对局；测试期间普通用户可能连接到测试账号和空房间，无法看到生产账号 / 对局，非许可测试的真实购买也会被 sandbox 环境拒绝。应安排用户可感知的维护窗口，避免将测试环境当作正常线上服务开放。Play 许可测试账号的购买带有测试标记，production 配置会拒绝；`sandbox` 模式才能验证测试交易。

同一 Play 应用的正式和测试通知共享 RTDN topic。测试期间正式交易通知到达 sandbox 会因环境不匹配返回 `503` 并由 Pub/Sub 重试；反之切回 production 后仍未处理的测试通知也可能失败重试。测试期间既有正式订单的通知、查单和退款处理可能延迟，消息超出订阅保留期限可能丢失；用户应监控积压及失败，切回生产后核对正式订单、通知和补偿，不能承诺自动全部恢复。单独的 Play 测试通知不包含交易，只能验证推送签名与路由。

Google OAuth 同意页当前为 testing，暂用当前 Google 账号邮箱，用户已同意；正式发行前改为 `geek@inpole.com` 并验证真实 Google 登录与相关发布要求。售价、地区、Play 签名发布构建、购买 / 取消 / 待处理 / 恢复 / 退款及 RTDN 的真实端到端验证仍待用户执行，模板本身不证明验收通过。客户端的 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` 必须与服务端一致，付款构建门控需设置 `EXPO_PUBLIC_IAP_CONFIGURED=1`。

Play Console 当前的 `VIP 30 day` / `vip` 商品有一个有效购买选项，界面显示覆盖 174 个国家 / 地区；这只是现有商店配置，不代表这些地区均已完成发行验收。Google OAuth 当前处于 testing；已创建正式 Play 签名对应的 Android 客户端，SHA-1 为 `97:DB:08:77:C3:3D:3B:DA:D6:E2:98:C9:DB:1D:7F:27:96:A7:FE:A2`。App 的 `google-login-test` 构建配置仅用于登录验证，不能代替真实支付验证。

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

以上启动步骤须在目标环境准备就绪后执行，不能据此认定现有线上实例已采用这些路径或 systemd 配置。公网已有 App 服务响应，健康结果应显示 `auth.channel=app`；配置标记仅表明配置状态，不能代替真实登录、删除、支付或持续数据库可用性检查。

现有实例的主机区域、源站和证书配置仍待核实。部署或调整时沿用 [代理说明](../deploy.md#5-域名https-与反向代理) 的整站转发模式，将 `iwodi.284264172.xyz` 对应的独立 App 服务代理到其实际监听地址（本示例为 `127.0.0.1:3011`），保留 WebSocket Upgrade、`/auth`、`/app/store/events`、公开页面及关联文件路径；不得改写现有微信站点。反代可信来源配置须与实际代理一致，不将 `APP_TRUST_PROXY` 盲设为全信任。

App 收到 SIGTERM / SIGINT 后幂等停止接收新 HTTP / Socket 工作、停止周期任务并关闭内存房间；SQLite 保留至事件循环排空，包含客户端已先断开的在途请求，超过 25 秒则以失败状态退出，不保证超时外部操作完成。此行为已有本机子进程回归，仍待目标 Linux 演练；重启不会恢复旧房间。发布避开活跃对局，旧代码兼容当前协议及数据库时才可回退代码，始终保留最新数据库、账本和长期密钥，不用旧库补偿代码回退。

## 4. 备份期限与恢复限制

[备份脚本](../scripts/backup-users.js) 为 App 提供显式创建 / 清理命令，纯微信库仍使用原单文件命令。源库含 App 身份、交易或删除记录时，即使遗漏渠道环境变量也拒绝导出无期限的单文件。App 目录必须是本用户拥有的 `0700` 专用目录，首次为空，路径不可经过符号链接；不能接管原有散落的 SQLite 文件。以下命令仅为待执行步骤：

```bash
sudo -u qile-wodi-app env APP_CHANNEL=app USER_DB_PATH=/var/lib/qile-wodi-app/users.sqlite \
  /usr/bin/node /opt/qile-wodi-app/server/scripts/backup-users.js app-create /var/backups/qile-wodi-app
sudo -u qile-wodi-app env APP_CHANNEL=app \
  /usr/bin/node /opt/qile-wodi-app/server/scripts/backup-users.js app-prune /var/backups/qile-wodi-app
```

创建命令使用 SQLite 在线备份，并在同一个只读事务中确定快照与期限，不写源库。两个备份入口共用副本整理步骤：检查完整性及外键、切换独立文件模式、执行 `VACUUM` 清除已删除数据的页内残留，再次检查。App 私有临时包继续核对期限、计算 SHA-256 后原子发布，包内仅有 `users.sqlite` 和 `manifest.json`，文件权限 `0400`。输出包含包路径及绝对到期时间；源库有过期记录或复制完成时已到期就拒绝发布，先核查主库清理任务，不手工延长期限。源库已无 App 逻辑记录时，原单文件命令也须先整理副本才可发布，详见[在线备份](../deploy.md#91-在线备份)。

期限固定为 `min(备份开始时间 + 7 天, 快照内各 deleted_at + 7 天)`，复用 [7 天政策常量](../src/user/app-retention.js)。比如删号第 6 天的快照只剩 1 天，不能因备份或复制再保留 7 天。包名与 manifest 绑定同一开始时间、到期时间及随机 ID，发布后均不修改，复制不能重置期限；过期包立即不可用，独立 prune 可在 App 服务停止、源库不可用时清理。

prune 仅处理此工具的标记目录及受管包；轻量验证全部候选的包名 / manifest、文件类型、权限和属主后删除到期包，不跟随链接、不递归删除未知文件或微信备份。数据库及临时文件先删，`manifest.json` 最后删，再移除空目录；中途失败恢复后可重试。到期且元数据合法的包允许数据库已被前次清理删除；清理末尾留下的空目录按已校验的包名及原期限处理，期限仍不得超过开始时间后七天，未到期不删除。

定时清理不扫描数据库内容；数据区损坏或截断不会延长已授权包的期限。元数据损坏、权限放宽、额外文件或范围异常会报错并停止本次删除，须及时处理告警；非空但缺少元数据的旧遗留包仍需人工核查。

正常失败立即移除临时包。SIGKILL、断电等强制中止会跳过清理；若副本尚未完成整理，`.partial` 中可能仍含源库已逻辑删除的页残留。未完成包不可用于恢复，prune 仍按有效元数据中的原期限清理，该期限不证明临时副本已清除页残留。发生强制中止后，运维须先确认对应备份进程已退出，再核查并移除遗留临时包。此类故障采用人工处理，工具保持简单，不另设进程锁、存活探测或任务追踪。

成功发布保证副本已清除删除残留，不涵盖强制中止的临时副本、源库及介质物理擦除。

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

待核实现有主机 / 区域、DNS / 证书及部署配置，确定备份介质和频率、可接受恢复窗口、清理 / 告警责任人及灾难恢复依据；再执行目标 Linux 运维验收、故障与停服演练、真实平台联调。备份检查不会证明已删除账号不复活或新交易不丢失，这两项须单独取得恢复证据。部署、签名构建、商店审核、下载及收费 / 广告放行按 [阶段 12](../../documents/PLAN/app/12-独立部署与商店发行.md) 分别验收。
