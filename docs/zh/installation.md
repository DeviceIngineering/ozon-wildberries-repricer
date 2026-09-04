# 安装部署

从 `git clone` 到第一个可用店铺的完整路径。每一步都已对照代码核实。

> 本应用会修改**真实店铺中的真实价格**。在生产账号上启用调价器之前，请务必完成「首次接入后的操作」与「上线前检查」两节。

---

## 1. 环境要求

- **Node.js 20 或更高版本。** `package.json` 中声明了 `"engines": { "node": ">=20" }`，`.nvmrc` 固定为 `20`。
- **原生模块的编译工具链。** `better-sqlite3` 在安装时通过 node-gyp 编译，因此需要 `python3`、`make` 和 `g++`：

| 系统 | 安装命令 |
|---|---|
| macOS | `xcode-select --install`（Command Line Tools，自带 Python 3） |
| Debian / Ubuntu | `sudo apt install build-essential python3` |
| Alpine | `apk add python3 py3-setuptools make g++` |

  在 Python 3.12 上可能还需要 **`py3-setuptools` / `python3-setuptools`**：3.12 移除了 `distutils`，而旧版 node-gyp 仍在 import 它，setuptools 自带的副本可将其补回。`Dockerfile` 出于同样原因显式安装了该包。

- 除此之外别无所需：不需要数据库服务、消息队列或外部缓存，全部状态就是一个 SQLite 文件。

---


## 先看效果 —— 无需接入店铺

在配置真实凭据之前，你可以先用合成数据看到整个应用的运行效果：

```bash
npm run demo
```

该命令会向 `demo.db` 写入三家店铺（Ozon、Wildberries、Yandex Market）、42 个商品和
60 天的销售数据，然后启动应用。这份目录刻意覆盖了最值得看的场景：价格低于下限的商品、
低于成本的促销、缺少成本价的商品、价格隔离，以及一个正在运行的价格实验。

演示数据不会访问任何平台：其中的凭据都是占位符，并且这些店铺的调价器处于关闭状态。
可以用上面创建的管理员登录，也可以针对演示数据库单独创建一个：

```bash
DB_PATH=./demo.db ADMIN_PASSWORD='至少12位' npm run seed
```

随时可以重建或删除演示数据：

```bash
DB_PATH=./demo.db npm run seed:demo -- --reset
```

如果数据库中已经存在真实店铺，演示数据脚本会拒绝运行。

## 2. 安装依赖

```bash
git clone https://github.com/DeviceIngineering/ozon-wildberries-repricer.git && cd ozon-wildberries-repricer
npm ci
```

使用 `npm ci` 而非 `npm install`，以保证版本与 `package-lock.json` 一致。`better-sqlite3` 正是在这一步编译；若编译失败，见「故障排查」。

---

## 3. `.env` 配置文件

```bash
cp .env.example .env
```

**必填变量只有两个。**

### `BETTER_AUTH_SECRET`

用于签名会话 Cookie 的密钥。生成方式：

```bash
openssl rand -hex 32
```

缺失时的行为（见 `auth.mjs`）：在 `NODE_ENV=production` 下进程会**抛出异常并拒绝启动**；其他情况下只打印警告，并以未签名的会话继续运行 —— 这仅适用于本地开发。

### `BETTER_AUTH_URL`

应用的公开基础地址 —— 必须与你在浏览器中打开的地址完全一致。默认为 `http://localhost:3001`。

**若该值与真实访问地址不符，登录会静默失败。** 症状很典型：登录表单接受密码、不报任何错误，刷新页面后又回到未登录状态。原因是 better-auth 按 `baseURL` 下发 Cookie，浏览器既不会保存也不会回传。由此有两条实用规则：

- 生产环境必须使用 `https://` —— 只有走 HTTPS，会话 Cookie 才会带上 `Secure` 标记；
- 若通过公网域名访问应用，`BETTER_AUTH_URL` 就应是该域名，而不是 `http://localhost:3001`，也不是 IP 地址。

同一变量还是 CORS 白名单的默认来源：未显式设置时 `TRUSTED_ORIGINS` 取自它。绝不能填 `*` —— 与 `credentials: true` 组合会把会话 Cookie 暴露给任意网站。

### 其余变量（均有默认值）

| 变量 | 用途 |
|---|---|
| `PORT` | API 端口，默认 `3001` |
| `NODE_ENV` | `development` / `production` |
| `DB_PATH` | SQLite 文件路径，默认 `./ozon.db`，自动创建 |
| `UPLOAD_DIR` | 上传价格表的存放目录 |
| `TRUSTED_ORIGINS` | 允许的 Origin 列表（逗号分隔），默认取 `BETTER_AUTH_URL` |
| `FORCE_PUBLIC_DNS` | 设为 `1` 时，进程的所有 DNS 查询走 8.8.8.8 / 1.1.1.1 |
| `EXTERNAL_API_KEY` | 外部 API 的 Bearer 密钥。**留空 = 外部 API 关闭**（返回 `503`） |
| `EXTERNAL_API_ALLOWED_IPS` | 允许的 IP 列表（逗号分隔）；留空表示接受任意来源 |
| `EXTERNAL_API_RATE_PER_MIN` | 每 IP 每分钟请求数上限，默认 `120` |
| `S3_*`、`BACKUP_RETAIN`、`BACKUP_HOUR` | 每日备份至 S3 兼容存储；`S3_ENDPOINT` 为空即关闭 |
| `SENTRY_DSN_BACKEND`、`VITE_SENTRY_DSN` | Sentry；留空即关闭 |
| `VITE_API_TARGET` | 仅开发环境：Vite 开发服务器把 `/api` 代理到哪里 |

---

## 4. 无需执行迁移命令

**项目中没有迁移命令。** 既没有 `npm run migrate`，也没有迁移文件目录和 schema 版本表。

表结构在**进程启动时自动创建与更新**：加载 `db/connection.cjs` 时会调用 `initSchema()`（全部 `CREATE TABLE IF NOT EXISTS` 与索引）和 `runMigrations()`（幂等的 `ALTER TABLE … ADD COLUMN`，「duplicate column name」错误被吞掉）。鉴权相关的表由 better-auth 在导入 `auth.mjs` 时于同一数据库文件中自行创建。

实际含义：

- 在空目录首次启动只会创建 `ozon.db`，无需任何准备步骤；
- 升级应用版本无需手工操作数据库，重启进程即可；
- 应用本身无法回滚迁移 —— 唯一的退路是数据库文件的备份。

细节见[架构](architecture.md)的「迁移方式」一节。

---

## 5. 创建首个管理员

界面中没有自助注册：登录页只有登录表单，后续用户由管理员创建（**设置 → 用户**，基于 better-auth 的 admin 插件）。因此第一个账号需要通过命令行创建：

```bash
ADMIN_PASSWORD='你的强密码' npm run seed
```

`seed-admin.mjs` 的行为：

- **要求 `ADMIN_PASSWORD` 至少 12 个字符**，否则打印提示并以退出码 1 结束。刻意不设默认密码：该账号可以修改所有已接入店铺的价格；
- 读取 `ADMIN_EMAIL`（默认 `admin@example.com`）与 `ADMIN_NAME`（默认 `Admin`）；
- 通过 better-auth 创建用户，随后用直接 SQL 将其 `role` 置为 `'admin'`；
- 重复执行是安全的：若用户已存在则打印「Admin user already exists, skipping」。

这些变量也可以写进 `.env` —— 脚本与应用从同一处读取。

---

## 6. 开发模式启动

```bash
npm run dev:all
```

它通过 `concurrently` 同时启动两个进程：

- `npm run server` → `node server.cjs`，API 与调度器监听 **:3001**；
- `npm run dev` → Vite，界面监听 **:5173**。

需要打开的是 **:5173**。Vite 开发服务器会把 `/api` 代理到后端，目标由 `VITE_API_TARGET` 指定（默认 `http://localhost:3001`）。若 API 在其他端口或其他机器上，请修改该变量。

也可以在两个终端里分别启动：

```bash
npm run server   # 仅 API + 调度器
npm run dev      # 仅前端
```

需要注意：**调度器随 API 一起启动**，并非独立进程。只要 `npm run server` 起来，且数据库中存在启用了调价器的店铺，系统就会开始与平台交互。面对不熟悉的数据库时，建议先关闭调价器再启动。

生产构建：`npm run build`（`tsc -b && vite build`）将静态文件输出到 `dist/`，由 Express 自行分发 —— 生产环境无需为前端单独部署 Web 服务器。

---

## 7. Docker

本地环境只需两条命令：

```bash
cp .env.example .env      # 填入 BETTER_AUTH_SECRET
docker compose up --build
```

镜像内部：基于 `node:20-alpine` 的多阶段构建，第一阶段构建前端，第二阶段只保留生产依赖；数据存放于命名卷 `repricer_data`（`/app/data/repricer.db`）与 `repricer_uploads`。端口映射为 `${PORT_PUBLISHED:-3001}:3001`。`stop_grace_period: 30s` 与代码中的优雅退出相匹配（超过 25 秒会强制退出）。

生产环境请叠加 overlay：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

overlay 要求显式提供 `BETTER_AUTH_URL`（`:?set the public https:// URL`），并把 Sentry 切换到 `production`。

**必须启用 TLS。** 容器只监听普通 HTTP，自身不做 TLS 终结。请在其前面部署反向代理（nginx、Caddy、Traefik），并把 `BETTER_AUTH_URL` 设为 `https://` 地址 —— 只有这样会话 Cookie 才会带 `Secure` 标记。不要把 3001 端口直接暴露到公网。

若宿主机的解析器无法访问平台 API，`docker-compose.prod.yml` 中有一段被注释掉的 `dns: 8.8.8.8 / 1.1.1.1`，应用侧还有 `FORCE_PUBLIC_DNS=1`。

---

## 8. 接入店铺

店铺在界面中添加：**设置 → 添加新店铺**。第一步选择平台，后续字段随之变化（`src/components/settings/StoreForm.tsx`）。

各平台通用的字段：店铺名称、更新间隔（10 分钟 / 1 小时 / 6 小时 / 24 小时）、调价器设置（间隔、偏差阈值）、税率 `tax_rate` 与最低毛利 `min_margin_percent`，以及促销活动相关开关。

### Ozon

| 字段 | 获取位置 |
|---|---|
| **Client ID** | Ozon 卖家后台 → **设置 → API 密钥** |
| **API Key** | 同一页面，创建 Seller API 密钥时获得 |

密钥需具备商品与价格相关方法的权限：调价器读取 `/v5/product/info/prices`（价格、佣金、物流、收单费）并写入 `/v1/product/import/prices`，监控任务还会拉取可见性与促销活动。

「防封（Antiban）」复选框（`antiban_enabled`）仅 Ozon 有，用于放慢目录遍历：每批商品数由 100 降为 50，批次间隔由 500 毫秒增至 3 秒。

### Wildberries

| 字段 | 获取位置 |
|---|---|
| **WB API 令牌** | 卖家后台 → **设置 → API 访问** |

令牌只有一个，但必须勾选**四类访问权限**。表单中的字段说明与 `db/connection.cjs` 中 `wb_api_key` 列的注释所列一致：

- **内容（Контент）** —— 商品卡（`content-api`）：`nmID`、`vendorCode`、类目 `subjectID`、尺寸（据此换算物流所需体积）；
- **价格与折扣** —— 读写 `price`/`discount` 组合，以及价格隔离区列表（`discounts-prices-api`）；
- **分析** —— WB 仓库库存（异步报表 `warehouse_remains`）与其他报表（`seller-analytics-api`）；
- **推广** —— 促销活动（`dp-calendar-api`）。

令牌原样粘贴即可；客户端同时接受 `<token>` 与 `Bearer <token>` 两种形式。

关于标识符的重要提示：WB 的 `products.ozon_id` 存放 **nmID**，`offer_id` 存放 **vendorCode**。你的价格表必须以 `vendorCode` 为键。

### Yandex Market

| 字段 | 获取位置 |
|---|---|
| **Business ID** | 卖家后台：业务（账户）标识 |
| **Campaign ID** | 该账户下的店铺/推广活动标识 |
| **Api-Key（OAuth 令牌）** | 卖家后台 → 合作伙伴 API 区域 |

三者缺一不可：Yandex 的访问权限绑定 campaign 而非卖家账号，因此价格更新调用带的是 `campaignId`，而不是 Ozon 那样的「client_id + 密钥」。

Yandex 店铺另有专属设置：`ym_boost_cap_percent`（推广缓冲上限，默认 30%）、`ym_floor_max_raise_percent`（单轮最大涨价幅度，20%）与 `ym_promo_exit_enabled`。

### Ozon Performance API（广告）—— 单独配置

Ozon 广告位于另一主机，使用**另一套凭据**：`client_id` 与 `client_secret` 在**广告后台 → 设置 → API 密钥**中创建，与 Seller API 密钥不同。店铺表单里没有对应字段，需写入 `app_settings` 的 `perf_api_<store_id>` 键：

```bash
node -e "require('./db/strategies.cjs').setAppSetting('perf_api_<store_id>', JSON.stringify({client_id:'...',client_secret:'...'}))"
```

配置完成后即可使用广告 CLI：

```bash
node scripts/adsCut.cjs <store_id> --list               # 仅列出广告计划
node scripts/adsCut.cjs <store_id>                      # dry-run：只打印方案，不做任何改动
node scripts/adsCut.cjs <store_id> --apply --factor=0.5 # 实际执行：预算砍半
```

主机为 `api-performance.ozon.ru`（旧的 `performance.ozon.ru` 不再使用）；`client_credentials` 令牌有效期 30 分钟，缓存在进程内存中。

---

## 9. 首次接入后的操作

### 9.1. 同步

对店铺触发一次同步（或等待自动执行 —— 调度器每分钟检查一次 `update_interval_minutes`）。同步会把商品、当前价格、库存与状态拉入本地数据库。在同步完成前不要做任何后续操作：调价器是按数据库中的 `offer_id` 匹配商品的。

### 9.2. 基准价与成本价

下载 Excel 模板（**设置 → 价格导入 → 模板**），服务端会依据店铺当前目录生成。模板各列及代码中的说明：

| 列 | 是否必填 |
|---|---|
| `Артикул`（货号） | 不要修改 |
| `Название`（名称） | 仅供参考 |
| `Цена сейчас`（当前价格） | 仅供参考，不会导入 |
| `Цена`（价格） | **必填** —— 基准价，价格下跌时调价器恢复到该值 |
| `Старая цена`（划线价） | 选填 |
| `Мин. цена`（最低价） | 选填 |
| `Себестоимость`（成本价） | 选填，但见下文 —— 调价器不会把价格定到成本价之下 |

解析器对格式很宽容：`"1 300,50"`（包括不换行空格与窄空格）会被读成 `1300.5`；列名按正则匹配，因此 `offer_id` / `price` / `cost` 之类的表头同样可用。

上传有两种模式：仅保存基准（`ref-only`，不向平台发送任何内容）和完整导入。对 **Wildberries，即使完整导入也不会下发价格**：它只写入基准价与成本价，价格由调价器发送 —— 直接推送会破坏 `price`/`discount` 组合，并可能把商品送进价格隔离区。

### 9.3. 调价器不会处理哪些商品

被问得最多的两个条件：

- **没有 `ref_price` 的商品完全不在处理范围内。** 调价器只把有基准价的商品纳入工作集；若一个都没有，本轮会以警告结束：`Нет эталонных цен в БД. Загрузите цены через импорт Excel.`（数据库中没有基准价，请通过 Excel 导入）。
- **没有 `cost_price` 就不会计算 floor。** 商品仍会被处理（价格照样恢复到基准价），但**「不低于成本价出售」的保护对它不生效**。此外，在 `policy_require_floor` 策略生效时，外部 API 会以 `no_floor` 拒绝对此类 SKU 的价格写入。

调价器还会跳过：参加促销的商品（`skipped_promo`）、隔离区中的商品（`skipped_quarantine`）、基准价低于成本价的商品（`skipped_below_cost` —— 几乎总是表格中的录入错误）、处于 `disposal` 模式的 SKU，以及由策略引擎接管的商品（`in_experiment`）。

还有一处 Ozon 专属细节：只有在 `tax_rate > 0` 时才会计算 floor。若店铺税率留作 0，Ozon 的保本价根本不会被计算。Wildberries 与 Yandex 则把 0 视为「0%」，保护继续生效。

---

## 10. 上线前检查

在生产店铺启用调价器之前，请逐项确认。

**1. Dry-run（空跑）** 在多个层面都有：

- **外部 API：** `POST /api/ext/v1/stores/:id/prices` 的 `dry_run` 参数**默认为 `true`** —— 被遗忘的字段不应改动真实价格。响应中会返回 `preview`，即本应发送的内容。
- **价格导入：** 先 `preview`（解析文件并在界面中以表格预览），确认后再保存；`ref-only` 模式只写基准，不向平台发送。
- **广告：** `node scripts/adsCut.cjs <store_id>` 不加 `--apply` 时只打印方案。
- **Yandex 的 floor：** `node scripts/ymFloorDryCheck.cjs "<店铺名称>"` 为只读操作：基于真实数据计算 floor 并打印表格，不写入任何内容。

**2. 急停开关（kill-switch）** 分为几个层级：

| 层级 | 关闭方式 |
|---|---|
| 店铺调价器 | 在店铺设置中取消 `repricer_enabled` |
| 定价策略（单店铺） | `POST /api/stores/:id/strategy/kill-switch`（或 `POST /api/ext/v1/stores/:id/kill-switch`）—— 该店铺全部实验停止，价格回到基准价 |
| 定价策略（全局） | `POST /api/strategy/kill-switch`（或 `POST /api/ext/v1/kill-switch/global`）—— 写入 `app_settings` 的标志位 |
| 整个外部 API | 移除 `EXTERNAL_API_KEY`（返回 `503 not_configured`），或关闭 `app_settings` 中的运行时开关 `external_api_enabled`（返回 `503 disabled`） |

**3. 快照回滚。** 每次批量操作前，系统会自动把受影响商品的当前价格存入 `price_snapshots`。查看与回滚：

```
GET  /api/stores/:id/snapshots
GET  /api/stores/:id/snapshots/:snapshotId
POST /api/stores/:id/snapshots/:snapshotId/rollback
```

界面中对应商品页的快照历史。回滚会把快照中的价格重新发往平台 —— 这本身也是一次价格写入，同样受平台的全部限制约束。

**4. 生效校验。** 价格发送 3 分钟后，回验器会重新读取并标记 `VERIFIED_OK` / `VERIFIED_FAIL`（容差 1%）。首次生产下发后请查看 pending 列表 —— 这是确认平台真正接受了价格、而不是敷衍地回了个 `200` 的最快方式。

**5. 备份。** 配置了 `S3_*` 后，数据库每天在 `BACKUP_HOUR`（默认 03:00）上传一次，保留 `BACKUP_RETAIN` 份。没有 S3 时，请在进程停止的状态下复制 `DB_PATH` 文件（连同 `-wal` 与 `-shm`）。

---

## 11. 故障排查

### `better-sqlite3` 编译失败

症状：`npm ci` 在 node-gyp 阶段失败，日志中出现 `gyp ERR!`、`Python not found` 或 `ModuleNotFoundError: No module named 'distutils'`。

- 安装第 1 节列出的构建工具。
- Python 3.12 环境下补装 `setuptools`（`python3-setuptools` / `py3-setuptools`），它能补回被移除的 `distutils`。
- 检查 Node 版本：18 及更早版本可能无法编译，需要 20+。
- 更换 Node 主版本后必须重新编译：`rm -rf node_modules && npm ci`。

### 登录无反应且无报错

几乎总是 `BETTER_AUTH_URL` 的问题。它必须与**浏览器中实际打开的地址完全一致** —— 协议、域名、端口都要对上。请检查：

- 位于反向代理之后时，应填外部的 `https://` 地址，而不是 `http://localhost:3001`；
- 登录后浏览器中是否真的出现了会话 Cookie；
- 若前端来自不同地址（例如 `:5173` 的 Vite 指向另一台机器的 API），需把该地址以逗号追加到 `TRUSTED_ORIGINS`，否则 CORS 会以 `Origin not allowed` 拒绝请求；
- 生产环境下没有 `BETTER_AUTH_SECRET` 时进程根本不会启动 —— 请查看日志开头几行。

### 平台 API 域名解析失败

症状：`api_logs` 中出现没有 HTTP 状态码的记录，错误码为 `EAI_AGAIN`、`ENOTFOUND`、`ENODATA`。常见元凶是 Docker 内置的 DNS 代理（`127.0.0.11`），它对部分 Ozon/Yandex 域名的解析并不稳定。

解决办法是 `FORCE_PUBLIC_DNS=1`：进程会把所有查询发往 8.8.8.8 / 1.1.1.1。该开关默认关闭，因为它会改变整个进程的解析行为。容器层面的替代方案是取消 `docker-compose.prod.yml` 中 `dns:` 段的注释。

Yandex 是一个已被特殊处理的情况：客户端内置了强制 IPv4 解析（`dns.resolve4`，重试 5 次、间隔 200 毫秒），因为某些主机上 `dns.lookup` 只返回 IPv6，而 Yandex 的 `ENODATA` 往往是瞬时的。

### Wildberries 返回 `429`

WB 对整个卖家账号施加严格限额。客户端内已实现**进程级**队列：任意两个 WB 请求之间至少间隔 1200 毫秒（约每 6 秒 5 个），并最多重试 3 次，优先遵循 `X-Ratelimit-Retry`，否则指数退避。

若 `429` 仍然频繁：

- 检查是否有**其他**工具在使用同一个令牌 —— 限流只在本进程内生效；
- 确认没有两个应用实例连着同一个数据库（这本身就是不允许的，见[架构](architecture.md)）；
- 调大店铺的同步与调价间隔：运行次数少了，请求自然就少了。

### 其他

- **`/api/ext/v1/*` 返回 `503 not_configured`** —— 未设置 `EXTERNAL_API_KEY`。返回 `503 disabled` 则表示运行时开关 `external_api_enabled` 已关闭。
- **写价格时返回 `409 context_stale`** —— 上下文已变更。错误响应体中已经带有 `current_version` 和 `changed`（具体变了什么）；只有在这些信息不够用时，才需要做一次完整的 `GET /context`。这是正常行为，参见[外部 API](api-external.md)。
- **「调价器什么都没做」** —— 请查看日志中的运行汇总：`REPRICER_SUMMARY` 一行按原因给出全部分类（`ok`、`corrected`、`skipped_promo`、`skipped_quarantine`、`skipped_below_cost`、`skipped_no_price`、`fetch_errors`），每个商品都恰好落入其中一类。
- **Ozon 返回 200 但价格没变** —— 在 `api_logs` 中查找包含 `items rejected by Ozon` 的记录：单条商品的拒绝信息藏在成功响应内部，由代码单独解析。

---

## 相关文档

- [架构](architecture.md)
- [用户指南](user-guide.md)
- [外部 API](api-external.md)
- [LLM 智能体说明](llm-agent.md)
- [定价策略](strategies.md)
