# 服务端部署

本文适用于当前持久账号版本，覆盖本地联调、Linux 服务器部署、环境变量、配套上线、更新、备份恢复与排障。入口为 `src/index.js`，运行时支持 Node.js 22.x 或 24.x，服务由 Express + Socket.IO 提供。

2026-10-05 已完成语言 / 肢体 PlayMode、24 对独立情境、页面接入与旧线上阶段退役的本地代码，尚未部署。发布前完成人工验收，并配套切换客户端和服务端；旧协议不兼容，用户更新小程序后重新建房。

## 1. 部署约定

- **单进程运行**。SQLite 保存账号、微信身份与个人资料；房间、游戏和在线会话仍在内存中。不要使用 PM2 cluster、多副本或多个进程共用同一套房间入口。
- **重启会结束所有房间和连接**，账号与已保存资料由原数据库恢复。首次上线及后续更新都需要安排短暂停服。
- 新版客户端与服务端配套交付。Socket 必须携带登录凭证，旧版无凭证客户端不能进入房间；不迁移旧本地昵称、头像或 `playerId`。
- 目标机器使用 **Node.js 22.x 或 24.x**，与 [package.json](package.json) 的 `engines.node` 一致。[.nvmrc](.nvmrc) 保留 `22` 作为默认开发与部署基线，不代表只能使用 22。`better-sqlite3@12.4.1` 含原生模块，必须在目标系统使用实际运行版本安装依赖，不复制 macOS 或其他 Node 主版本的 `node_modules`。
- 推荐 Linux 使用 **systemd + Caddy**；本文也提供 Nginx 和既有 PM2 环境的替代步骤。进程管理器、反向代理分别选择一种。

正式环境采用以下目录，代码按发布版本保留，配置与用户库独立保存：

```text
/opt/qile-wodi/releases/<版本>/server/  # 某次发布的服务端代码及依赖
/opt/qile-wodi/server                  # 指向当前发布目录的符号链接
/etc/qile-wodi/prod.env                # 长期环境配置
/var/lib/qile-wodi/prod/users.sqlite   # 长期用户库，旁边可能有 -wal/-shm 文件
/var/backups/qile-wodi/prod/           # SQLite 在线备份
```

### 1.1 Node.js 版本范围

当前项目支持范围为 **`22.x || 24.x`**，不是连续的 `>=22`：使用所选主版本内的最新安全补丁版本，安装依赖、运行服务和执行备份须使用同一 Node 主版本。

| Node.js 版本 | 当前部署支持 | 说明 |
|---|---|---|
| 22.x | 支持，默认基线 | `.nvmrc` 与本文默认安装示例使用此版本。 |
| 24.x | 支持 | 可用于本地开发和生产部署；切换后须重新安装原生依赖。 |
| 20.x、23.x | 不支持 | 虽在 SQLite 驱动声明范围内，但分别已于 2026-04-30、2025-06-01 停止官方维护，不纳入当前部署支持范围。 |
| 其他主版本 | 不支持 | 不在当前锁定 SQLite 驱动的声明范围内；不能据此推断未来版本可用。 |

依据：锁定的 [`better-sqlite3@12.4.1`](https://github.com/WiseLibs/better-sqlite3/blob/v12.4.1/package.json) 声明支持 `20.x || 22.x || 23.x || 24.x`；结合 [Node.js 官方维护计划](https://github.com/nodejs/Release/blob/main/schedule.json)，当前选择仍在维护的 22.x、24.x。不能把驱动支持范围直接当作项目支持范围。

2026-10-02 在 macOS arm64 上分别使用 Node.js **22.23.3、24.21.0** 和 npm **10.9.9**，在隔离目录独立安装锁定依赖，两者均通过完整服务端 `npm test`，覆盖 SQLite 持久化与备份恢复、启动及健康检查、认证和 Socket 连接。此结果不替代目标 Linux 系统验收，部署时仍须执行第 4.2 节的原生驱动加载检查。

## 2. 环境变量

### 2.1 加载方式与必填项

`src/index.js` 使用 dotenv 读取**进程工作目录**中的 `.env`，已有进程环境变量优先，不会被 `.env` 覆盖。直接运行 npm、Node 或 PM2 时必须设置正确工作目录；systemd 使用 `EnvironmentFile=/etc/qile-wodi/prod.env` 注入配置。

本次新增 `USER_DB_PATH`、`AUTH_TOKEN_SECRET` 两个必填项。微信登录参数为原有配置，但新版缺少 `WECHAT_APP_ID` 也会直接阻止启动。

| 参数 | 必填 / 默认值 | 含义与配置要求 |
|---|---|---|
| `USER_DB_PATH` | 必填，无默认值 | SQLite 文件路径，生产使用绝对路径，如 `/var/lib/qile-wodi/prod/users.sqlite`。父目录必须先创建，并允许运行用户读写；文件不存在时自动创建用户库和表。不要使用 `:memory:` 部署持久账号服务。 |
| `AUTH_TOKEN_SECRET` | 必填，无默认值 | HMAC-SHA256 签名密钥，至少 32 字节。使用下方命令生成，长期保存，测试与正式环境分别生成。缺失或长度不足时启动失败。 |
| `WECHAT_APP_ID` | 必填，无默认值 | 对应小程序的真实 AppID；缺失时启动失败。AppID 是微信身份的隔离范围，随意更换会使相同 openid 对应另一组账号。 |
| `WECHAT_APP_SECRET` | 登录必填，无默认值 | 对应 AppID 的 AppSecret。缺失时进程仍可启动，但微信登录会返回 `503 / WECHAT_AUTH_NOT_CONFIGURED`；错误的值会导致微信换码失败。 |

生成签名密钥：

```bash
openssl rand -hex 32
```

将输出的 64 位十六进制字符串填入 `AUTH_TOKEN_SECRET`。这一步每个环境初始化时执行一次，**不要每次发布或重启重新生成**。更换密钥会让已有登录凭证失效，用户须重新登录；账号资料仍属于原用户库。凭证有效期当前固定为 7 天，没有对应的 env 配置项。

### 2.2 监听、登录和游戏参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。反向代理与 Node 同机时保持默认；局域网联调才按需改为 `0.0.0.0`。 |
| `PORT` | `3010` | Node 监听端口，应与代理上游端口一致。部署使用固定可用端口；`0` 仅适合临时测试。 |
| `CLIENT_ORIGIN` | `*` | CORS 来源列表，逗号分隔，例如 `https://servicewechat.com,https://wodi.server.zhibeii.com`。生产填写实际来源；它不替代微信后台合法域名配置或 Socket 认证。 |
| `WECHAT_LOGIN_TIMEOUT_MS` | `5000` | 服务端调用微信换码接口的超时时间，单位毫秒。 |
| `HOST_TRANSFER_GRACE_MS` | `30000` | 房主断线后转移房主的等待时间，30 秒；不是断线玩家自动离房时间。 |
| `ROOM_ALL_DISCONNECTED_TTL_MS` | `600000` | 全员断线后的房间保留时间，10 分钟。 |
| `ROOM_WAITING_IDLE_MS` | `900000` | 等待房间无人操作时的保留时间，15 分钟。 |
| `ROOM_PLAYING_IDLE_MS` | `600000` | 游戏中既无操作也无有效心跳时的保留时间，10 分钟。 |
| `ROOM_IDLE_WARNING_MS` | `60000` | 房间关闭前的提醒时间，提前 1 分钟。 |
| `NODE_ENV` | 本项目未设置默认值 | 正式运行设为 `production`；systemd 示例已设置。不会选择客户端的 test/prod 环境。 |

时间参数统一使用正整数毫秒，提醒时间应小于对应超时。不要用 `0` 或负数尝试关闭计时器，当前代码不提供统一的禁用语义。修改配置后重启服务生效。

### 2.3 完整正式环境示例

以下内容写入 `/etc/qile-wodi/prod.env`。三个凭证占位值必须替换为真实值；域名按实际部署调整。文件使用 `KEY=value`，不写 shell 命令或动态生成表达式。

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3010
CLIENT_ORIGIN=https://servicewechat.com,https://wodi.server.zhibeii.com

WECHAT_APP_ID=替换为真实AppID
WECHAT_APP_SECRET=替换为真实AppSecret
WECHAT_LOGIN_TIMEOUT_MS=5000

USER_DB_PATH=/var/lib/qile-wodi/prod/users.sqlite
AUTH_TOKEN_SECRET=替换为openssl生成的随机密钥

HOST_TRANSFER_GRACE_MS=30000
ROOM_ALL_DISCONNECTED_TTL_MS=600000
ROOM_WAITING_IDLE_MS=900000
ROOM_PLAYING_IDLE_MS=600000
ROOM_IDLE_WARNING_MS=60000
```

测试与正式环境至少隔离以下内容；同机部署还要使用不同的代码入口、服务名和监听端口：

| 项目 | 测试示例 | 正式示例 |
|---|---|---|
| 外部域名 | `test.wodi.server.zhibeii.com` | `wodi.server.zhibeii.com` |
| 配置文件 | `/etc/qile-wodi/test.env` | `/etc/qile-wodi/prod.env` |
| 用户库 | `/var/lib/qile-wodi/test/users.sqlite` | `/var/lib/qile-wodi/prod/users.sqlite` |
| 签名密钥 | 独立生成 | 独立生成 |
| 同机 Node 端口 | `3011` | `3010` |
| 同机服务名 | `qile-wodi-test` | `qile-wodi` |

如果部署测试实例，从下方 systemd 模板复制另一份 unit，同时调整 `WorkingDirectory`、`ExecStart` 和 `EnvironmentFile`；测试域名代理到测试端口。不要让两个实例共用正式数据库。

## 3. 本地开发与联调

在已安装 Node.js 22.x 或 24.x 的终端，从主仓库目录执行；使用 nvm 时，`nvm use` 默认选择 `.nvmrc` 中的 22，也可明确执行 `nvm install 24 && nvm use 24`：

```bash
cd server
node --version
npm ci
mkdir -p "$HOME/.local/share/qile-wodi/dev"
```

首次配置时复制 `.env.example` 为 `.env`；已有 `.env` 时直接补充参数，不覆盖原配置：

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

编辑 `.env`，填写真实的微信 AppID、AppSecret 和刚生成的密钥，并调整：

```dotenv
HOST=127.0.0.1
PORT=3010
CLIENT_ORIGIN=*
USER_DB_PATH=/Users/你的用户名/.local/share/qile-wodi/dev/users.sqlite
```

`USER_DB_PATH` 填写上方已创建目录的实际绝对路径；Linux 通常是 `/home/你的用户名/...`。dotenv 不会把 `~` 或 `$HOME` 自动展开为用户目录。

启动与检查：

```bash
npm run dev
```

另开终端执行 `curl --fail http://127.0.0.1:3010/health`。不需要自动重启时可用 `npm start`。

在微信开发者工具中联调时，明确将 `client/config.js` 的 `FORCE_ENV` 选为 `dev`，使用 `dev.socketUrl=http://127.0.0.1:3010`。项目当前默认是 `test`，不会自动切换到本地。客户端修改只作为该次联调的明确操作，完成后恢复原环境。

同局域网手机联调时，Node 按需监听 `0.0.0.0`，客户端指向开发机的局域网 IP，并放通本机端口。手机的 `127.0.0.1` 指向手机自身；开发工具的域名校验豁免不能代替真机和发布环境的 HTTPS/WSS 合法域名配置。

## 4. Linux 首次部署

以下以 Ubuntu 22.04/24.04、可使用 sudo 的部署账号为例；Node 运行用户沿用现有 systemd 模板中的 `www-data`。服务器须能访问 npm 下载源及微信 `api.weixin.qq.com`。

### 4.1 安装运行环境

以下默认安装 22.x；若选择 24.x，将 `QILE_NODE_MAJOR` 改为 `24`。

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl python3 build-essential sqlite3
QILE_NODE_MAJOR=22
curl -fsSL "https://deb.nodesource.com/setup_${QILE_NODE_MAJOR}.x" -o /tmp/qile-node-setup.sh
sudo -E bash /tmp/qile-node-setup.sh
sudo apt install -y nodejs
/usr/bin/node --version
/usr/bin/npm --version
```

确认 `/usr/bin/node` 为所选的 `v22.x` 或 `v24.x`。若服务器已使用其他方式安装受支持的 Node 版本，可跳过安装，但需将 systemd 的执行路径改成实际路径；systemd 不会自动加载交互终端的 nvm 配置。Python 与编译工具用于没有适用预编译包时构建 SQLite 驱动。

### 4.2 准备独立的发布目录

以下命令用于新的部署目录。将仓库地址、版本目录名和提交 SHA 替换为实际已验收版本；使用**服务端仓库**，不是主仓库的子模块指针。

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /opt/qile-wodi /opt/qile-wodi/releases
QILE_RELEASE=20261002-01
QILE_RELEASE_DIR="/opt/qile-wodi/releases/$QILE_RELEASE/server"
git clone "替换为服务端仓库地址" "$QILE_RELEASE_DIR"
cd "$QILE_RELEASE_DIR"
git checkout --detach "替换为已验收的提交SHA"
npm ci --omit=dev
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close()"
```

最后一条命令应输出 `{ ok: 1 }`，用来确认目标系统可加载原生驱动。也可以通过 CI 传输已验收源码，但仍须在兼容的目标平台安装依赖，并保留对应 lockfile。

完整回归应在含相邻 `client/` 的工作副本或 CI 执行，两个目录都先 `npm ci`，再分别运行 `npm test`。服务端 `npm test` 会读取客户端事件声明和实际 `weapp.socket.io` bundle，并启动临时本地服务；不能直接在仅安装生产依赖的服务端发布目录执行。

### 4.3 创建数据目录与长期配置

```bash
sudo install -d -o root -g www-data -m 750 /etc/qile-wodi
sudo install -d -o www-data -g www-data -m 700 /var/lib/qile-wodi/prod /var/backups/qile-wodi/prod
openssl rand -hex 32
sudoedit /etc/qile-wodi/prod.env
sudo chown root:www-data /etc/qile-wodi/prod.env
sudo chmod 640 /etc/qile-wodi/prod.env
```

在编辑器中填写第 2.3 节的完整配置。数据库目录须允许运行用户创建和写入数据库及 `-wal`、`-shm` 文件，仅给已有 `users.sqlite` 文件写权限不够。发布前核对 `USER_DB_PATH`；拼错一个不存在的文件名可能创建空用户库。

让直接运行、备份工具和 PM2 能使用同一份配置，并建立当前版本入口：

```bash
ln -s /etc/qile-wodi/prod.env "$QILE_RELEASE_DIR/.env"
ln -s "$QILE_RELEASE_DIR" /opt/qile-wodi/server
sudo -u www-data test -r /etc/qile-wodi/prod.env
sudo -u www-data test -r /opt/qile-wodi/server/src/index.js
sudo -u www-data test -w /var/lib/qile-wodi/prod
```

三个 `test` 命令成功时无输出。此处创建入口只用于首次安装；已有 `/opt/qile-wodi/server` 时按第 8 节更新，不覆盖实际目录。应用没有独立数据库初始化命令，首次启动自动创建表、唯一索引，并启用外键及 WAL。

### 4.4 使用 systemd 启动

复用仓库提供的 [服务模板](deploy/qile-wodi.service.example)：

```bash
sudo cp /opt/qile-wodi/server/deploy/qile-wodi.service.example /etc/systemd/system/qile-wodi.service
sudoedit /etc/systemd/system/qile-wodi.service
```

确认这些字段与实际安装一致，其余启动、重启策略沿用模板：

```ini
WorkingDirectory=/opt/qile-wodi/server
ExecStart=/usr/bin/npm start
User=www-data
Environment=NODE_ENV=production
EnvironmentFile=/etc/qile-wodi/prod.env
```

模板中的 `ExecStart` 也可替换为 `/usr/bin/node /opt/qile-wodi/server/src/index.js`，使用该方式时仍需保留 `WorkingDirectory` 和 `EnvironmentFile`。用户库和签名密钥初始化失败时，进程会在监听端口前退出。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qile-wodi
sudo systemctl status qile-wodi --no-pager
sudo journalctl -u qile-wodi -n 100 --no-pager
curl --fail http://127.0.0.1:3010/health
```

健康响应应包含 `status: "ok"`、`auth.wechatLoginConfigured: true` 和非零 `wordLibrarySize`。`wechatLoginConfigured` 只检查参数是否非空；`/health` 不调用微信、不持续探测数据库，不能代替真实登录和资料保存验收。

## 5. 域名、HTTPS 与反向代理

将目标域名的 DNS 解析到服务器，配置有效的证书；云安全组和主机防火墙允许 `80/443`。Node 保持监听 `127.0.0.1:3010`，不需要对公网开放该端口。下方域名采用项目当前正式域名，部署其他环境时统一替换。

### 5.1 Caddy（推荐）

```bash
sudo apt install -y caddy
sudoedit /etc/caddy/Caddyfile
```

在 Caddyfile 中添加站点；如有其他站点，保留其配置：

```caddy
wodi.server.zhibeii.com {
    encode gzip
    reverse_proxy 127.0.0.1:3010
}
```

Caddy 自动处理 HTTPS 证书和 WebSocket Upgrade。整站代理同时包含 `/health`、`/auth/login`、`/auth/wechat-login` 和 `/socket.io/`，无需改写路径。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl --fail https://wodi.server.zhibeii.com/health
```

### 5.2 Nginx（替代 Caddy）

已有 Nginx 的服务器可沿用它；不要让 Caddy 和 Nginx 同时占用 `80/443`。先配置 HTTP 站点，再由 Certbot 申请证书并添加 HTTPS：

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudoedit /etc/nginx/sites-available/qile-wodi
```

站点初始配置：

```nginx
server {
    listen 80;
    server_name wodi.server.zhibeii.com;

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/qile-wodi /etc/nginx/sites-enabled/qile-wodi
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo certbot --nginx -d wodi.server.zhibeii.com --redirect
sudo certbot renew --dry-run
curl --fail https://wodi.server.zhibeii.com/health
```

启用站点的链接只需创建一次。确认 Certbot 配置后的 HTTPS 站点仍包含上述 WebSocket 转发规则。

## 6. 小程序配套配置与首次切换

1. 在微信小程序后台配置 request 合法域名 `https://wodi.server.zhibeii.com`、socket 合法域名 `wss://wodi.server.zhibeii.com`，并确认 HTTPS 证书有效。测试环境使用对应测试域名。
2. 在客户端目录执行 `npm ci`，在微信开发者工具中导入项目并“构建 npm”。当前 `weapp.socket.io@2.2.1` 实际使用 EIO=4 / Socket.IO 协议 5，支持 `auth`；不恢复 EIO=3 或 URL query 凭证。
3. 明确选择 `client/config.js` 的 `FORCE_ENV`。当前代码为 `test`；正式发布需要主动选择 `prod`，并核对 `prod.socketUrl`。`apiBaseUrl` 由 socket 地址自动映射为 HTTPS，不存在独立服务端 env 可以替代该选择。
4. 先在隔离测试环境完成真机验收，再让新版小程序可供用户更新，安排服务端切换窗口。停止旧服务，启动本版本，结束旧内存房间和所有旧连接。切换期间允许短暂不可用，不保留匿名通道。
5. 用户首次通过微信验证后取得新账号和默认资料；旧昵称、头像、`playerId` 不导入。新版若短暂连接到旧服务、收到缺少凭证的登录响应，需要在服务切换完成后重试；旧版客户端需要更新。

上线验收至少覆盖：

- 两个微信账号完成首页 → 建房/入房 → 发牌 → 再来一局。
- 编辑昵称和普通头像后，同房成员收到更新；退出重登后仍为保存结果。
- 短时断网、前后台切换后恢复本人的房间和词语，其他成员在线标记更新。
- 缺失或无效凭证不能进入房间，客户端可重新登录恢复。
- 在测试环境演练服务重启：用户身份、资料保留，原房间结束；新房可正常创建。
- 在目标 Linux 环境完成一次第 9 节的备份与恢复演练。

## 7. 既有 PM2 环境

如果已经使用 PM2，可以继续沿用，无需同时启动 `qile-wodi.service`。以下命令由固定的 PM2 运行账号执行；将第 4 节数据、备份目录的属主及配置读取权限调整为该账号，确保它能读取发布目录中的 `.env` 链接。

```bash
sudo npm install -g pm2
cd /opt/qile-wodi/server
NODE_ENV=production pm2 start src/index.js --name qile-wodi-server --cwd /opt/qile-wodi/server --time
pm2 status
pm2 logs qile-wodi-server --lines 100 --nostream
pm2 startup
```

执行 `pm2 startup` 输出的、针对该运行账号的系统安装命令，再执行 `pm2 save`。保持默认单进程 fork 模式，不添加 `-i` 扩容。

仅使用 `.env` 时，修改后重启会重新加载。如果配置来自进程环境，先在启动终端更新对应变量，再使用 `pm2 restart qile-wodi-server --update-env` 更新。`--update-env` 不会自动清除所有历史变量；从进程环境改用 `.env` 时，清理启动环境并重建进程定义，避免旧值继续覆盖文件配置。

发布目录切换时，核对 `pm2 describe qile-wodi-server` 的脚本和工作目录；若它们解析到了旧版本实际路径，应停止并删除该进程定义，再从 `/opt/qile-wodi/server` 按上方命令重新创建并 `pm2 save`。

## 8. 日常更新与回滚

### 8.1 更新

1. 在完整工作副本完成回归，确定已验收的服务端提交及配套客户端版本。
2. 按第 9.1 节在线备份正式用户库，同时备份长期 env 文件；检查备份结果。
3. 按第 4.2 节准备一个**新的**版本目录，目标机器执行 `npm ci --omit=dev` 和内存数据库加载检查。为新目录创建 `.env` 链接，继续使用原 `/etc/qile-wodi/prod.env`；不要重新生成密钥、复制运行中的主数据库或清空数据目录。
4. 记录原版本路径，在停服窗口内切换入口。下方假定 `QILE_RELEASE_DIR` 已设为本次新目录：

```bash
QILE_PREVIOUS_RELEASE=$(readlink -f /opt/qile-wodi/server)
printf '%s\n' "$QILE_PREVIOUS_RELEASE"
sudo systemctl stop qile-wodi
ln -sfn "$QILE_RELEASE_DIR" /opt/qile-wodi/server
sudo systemctl start qile-wodi
sudo systemctl status qile-wodi --no-pager
curl --fail http://127.0.0.1:3010/health
curl --fail https://wodi.server.zhibeii.com/health
```

5. 检查日志和真实微信登录，核对更新前已有账号的昵称、头像，再验收建房、发牌、资料保存及重连。旧房间不会恢复。

仅修改 env 或切换代码时，systemd 重启即可；修改 unit 文件时才需先 `sudo systemctl daemon-reload`。PM2 部署按第 7 节替换停启命令，并重新保存进程定义。

如果同时切换 Node 主版本，应先在隔离环境完成回归，在新发布目录使用新主版本重新安装依赖，并核对 systemd/PM2 实际使用的 Node 路径。不要在线复用旧 `node_modules` 或直接替换正在运行的服务所用的 Node；安排停服窗口完成切换。

### 8.2 回滚

只有旧版本仍兼容当前数据库结构和强制认证协议时才回滚代码。不能回退到仅凭 `playerId` 的匿名版本。若更新时切换过 Node 主版本，回滚也须恢复旧发布目录匹配的运行时，或在停服期间使用当前受支持的主版本为旧目录重新安装依赖并完成加载检查；仅切换代码链接不能解决原生模块 ABI 不匹配。确认条件后，使用已记录的旧路径：

```bash
sudo systemctl stop qile-wodi
ln -sfn "$QILE_PREVIOUS_RELEASE" /opt/qile-wodi/server
sudo systemctl start qile-wodi
curl --fail http://127.0.0.1:3010/health
```

跨终端操作时先重新设置 `QILE_PREVIOUS_RELEASE` 为已核实的旧目录。代码回滚通常继续使用当前用户库和密钥；恢复历史备份会丢失备份之后的账号/资料变更，仅在需要恢复数据时按第 9.2 节处理。未来版本若变更数据库结构，应先确认迁移与回滚兼容性。

## 9. 备份与恢复

### 9.1 在线备份

至少在升级前和日常定时任务中执行 [备份脚本](scripts/backup-users.js)。脚本使用 SQLite 在线备份 API，并自动执行 `integrity_check`、`foreign_key_check`；可以在服务运行时执行，目标文件必须尚不存在。

```bash
QILE_BACKUP_FILE="/var/backups/qile-wodi/prod/users-$(date +%Y%m%d-%H%M%S).sqlite"
sudo -u www-data env USER_DB_PATH=/var/lib/qile-wodi/prod/users.sqlite \
  /usr/bin/node /opt/qile-wodi/server/scripts/backup-users.js "$QILE_BACKUP_FILE"
```

预期输出 `用户库在线备份及完整性检查通过`，退出码为 `0`。若实际使用其他用户库路径，备份命令必须指向该路径。不要只复制运行中的 `users.sqlite`，未合并的写入可能仍在 WAL 文件中。

配置和密钥需要单独备份，例如由管理员保存到仅 root 可读的目录：

```bash
sudo install -d -o root -g root -m 700 /root/qile-wodi-env-backups
sudo install -o root -g root -m 600 /etc/qile-wodi/prod.env \
  "/root/qile-wodi-env-backups/prod-$(date +%Y%m%d-%H%M%S).env"
```

数据库备份包含用户身份与资料，env 备份包含微信密钥和签名密钥；按相同的访问权限要求保留异机副本，不提交到 Git。为定时任务设置失败提醒及保留周期，定期执行恢复演练；仅有同机备份不能应对整台机器的数据丢失。

### 9.2 恢复到新目录

先在隔离环境演练。以下正式恢复示例使用新的目录，避免混入原数据库的 WAL/SHM；替换备份文件名和恢复目录日期：

```bash
sudo systemctl stop qile-wodi
QILE_RESTORE_DIR=/var/lib/qile-wodi/prod-restore-20261002
QILE_RESTORE_SOURCE=/var/backups/qile-wodi/prod/users-20261002-120000.sqlite
sudo install -d -o www-data -g www-data -m 700 "$QILE_RESTORE_DIR"
sudo install -o www-data -g www-data -m 600 "$QILE_RESTORE_SOURCE" "$QILE_RESTORE_DIR/users.sqlite"
sudo -u www-data sqlite3 -readonly "$QILE_RESTORE_DIR/users.sqlite" \
  'PRAGMA integrity_check; PRAGMA foreign_key_check; SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS identities FROM user_identities;'
```

完整性检查应输出 `ok`，外键检查不返回记录；后两个结果是用户和身份数量，应与预期备份相符。进一步核对已知账号的资料。

编辑 `/etc/qile-wodi/prod.env`，将 `USER_DB_PATH` 指向恢复文件，保留对应环境的长期 AppID、AppSecret 和签名密钥，然后启动：

```bash
sudoedit /etc/qile-wodi/prod.env
sudo systemctl start qile-wodi
sudo journalctl -u qile-wodi -n 100 --no-pager
curl --fail http://127.0.0.1:3010/health
```

使用已知微信账号登录，确认账号归属、昵称头像和资料保存正常。保留原数据库供核查，同步更新后续备份命令或任务中的路径。恢复账号库不会恢复旧房间，也不会找回备份时间之后的资料变更。

## 10. 常见问题

| 现象 | 检查与处理 |
|---|---|
| 提示必须配置 `AUTH_TOKEN_SECRET`、`USER_DB_PATH` 或 `WECHAT_APP_ID` | 检查实际工作目录、systemd `EnvironmentFile` 和 `.env` 链接；已有环境变量优先于 dotenv。确认不是仍使用旧服务定义。 |
| 数据库无法打开、`SQLITE_CANTOPEN` / `SQLITE_READONLY` | 核对绝对路径、父目录是否存在，以及运行用户对目录、主文件、WAL/SHM 的权限。不要通过删除数据库来“修复”。 |
| `NODE_MODULE_VERSION`、原生模块加载失败 | 对照服务实际 Node 路径确认是受支持的 22.x 或 24.x，并与安装依赖时的主版本一致；在对应平台及实际运行版本下重新 `npm ci --omit=dev`，不能沿用其他系统或 Node 主版本的原生产物。 |
| `EADDRINUSE` | 检查端口是否被旧进程占用，避免同时启动 systemd、PM2 和手动 Node；同机测试与正式实例分配不同端口。 |
| 本地 `/health` 正常，公网失败或 502 | 检查 DNS、TLS、80/443 放行、代理上游 HOST/PORT 和 Node 服务状态。 |
| HTTPS 正常，Socket 连接失败 | 检查 `/socket.io/` WebSocket Upgrade、微信 socket 合法域名、EIO=4，以及客户端是否携带有效 `auth.token`。 |
| `/health` 正常但微信登录失败 | `wechatLoginConfigured` 仅表示参数非空；核对真实 AppID/AppSecret、微信换码响应及服务器对微信 API 的访问。 |
| `AUTH_INVALID` | 凭证缺失、过期、签名不匹配或用户已不存在。先确认环境、数据库和密钥未误切换，客户端重新微信登录；不开放匿名回退。 |
| `USER_STORE_UNAVAILABLE` | 检查数据库可用性、磁盘空间和权限。登录、新连接及资料保存会失败，已有连接的普通游戏仍按内存状态运行。 |
| 重启后昵称头像变回默认值 | 核对是否指向新建空库、改了 AppID 或混用了测试环境；使用正确原库或备份恢复。 |
| 重启后房间消失 | 当前设计如此；账号和资料持久化，房间与会话不持久化。 |
| 修改 env 后没有生效 | 确认改的是实际加载文件，并重启进程；PM2 的旧环境变量可能覆盖 dotenv，按第 7 节刷新配置。 |

排障查看 `journalctl -u qile-wodi` 或对应 PM2/代理日志，不把完整 AppSecret、签名密钥或登录 token 写入日志、截图或问题描述。相关产品和验收记录见 [用户身份与资料验收](../documents/PLAN/10-用户身份与资料验收.md)。

## PlayMode 配套切换

- 先完成 DevTools 多窗口（两种模式三人开局、六人肢体双卧底及重开）、真机隐私 / 长句阅读及推荐规模 3～5 人内容试玩，另验 6～12 人配置，再安排短暂停服并发布配套前后端，不部署到旧客户端仍持续使用的服务上。
- 新版仅接收 `playMode: language | body`，开局带 `{ playMode }`；旧确认看卡、发言、投票、轮次、结算与公开揭晓接口退役，不保留旧协议兼容。
- 服务重启清空内存房间 / 游戏 / 抽词历史，用户更新小程序后重新建房，不迁移旧房间。账号、身份、VIP 与支付数据库不迁移、不改动；保留原 `USER_DB_PATH`、`AUTH_TOKEN_SECRET` 和支付配置，依照现有流程备份。
- 两种模式均为 3～12 人，肢体建议 3～5 人不参与校验；共用卧底分档：3～5 人 1 名，6～8 人可设 1～2 名、默认 1 名，9～12 人可设 1～3 名、默认 2 名。切换保留手动配置，重开保留合法配置，前后端按此规则配套发布。服务端 `MIN_START_PLAYERS`、投票计时器和结算空闲变量已退役。等待、发牌、掉线空闲清理仍保留，客户端 `FORCE_ENV='test'` 本次未改变。
- 未实际发布前，本地修改不代表测试 / 正式服务已开放肢体玩法；回滚时同样配套回滚前后端并重新建房，不回滚或覆盖持久数据库。
