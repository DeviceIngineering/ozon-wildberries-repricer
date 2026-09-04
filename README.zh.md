# Marketplace Repricer

面向 **Ozon**、**Wildberries** 和 **Yandex Market** 卖家的自动调价系统。这三家是俄罗斯最大的电商平台。

它把价格稳定在你设定的基准价上，拒绝以低于保本价的价格出售——保本价按各平台真实费率计算，把会亏本的商品从促销活动中撤出，并且可以选择通过在真实销量上做受控实验来寻找更优价格。

**[English](README.md) · [Русский](README.ru.md)**

> **本软件会修改真实店铺中的真实价格。** 在接入正式账号之前请先阅读 [SECURITY.md](SECURITY.md)。所有写操作默认走 dry-run（试运行），真正下发必须显式请求。

---

## 为什么会有这个项目

平台并不是中立的。它会把你的商品拉进你没有同意的折扣活动；它抽取的佣金随类目和仓库而变；它通过一些接口根本不会告诉你的扣费来收取流量加权（boost）费用。一个在表格里看起来有利润的价格，会悄悄变得无利可图——而你要到月底才会发现。

这个项目是为了运营三家实际在售的店铺而写的。里面的每一条规则，都源于当初缺少这条规则时付出的真金白银。

---

## 功能

### 守住基准价

调价器把平台上的实时价格与你设定的基准价（`ref_price`）比对，并在平台让价格偏移时把它恢复回来。处于促销、价格隔离、实验或清仓模式的商品会被跳过；每个 SKU 都会落入唯一一个结果分类——`ok`、`corrected`、`skipped_promo`、`skipped_quarantine`、`skipped_below_cost`、`rejected`——所以日志绝不会谎报发生了什么。

### 按平台分别计算保本价下限

不是一套公式加一个平台开关，而是三套真正不同的模型，因为经济账本身就不同：

| 平台 | 模型 |
|---|---|
| **Ozon** | 佣金、物流、收单费均取自 `/v5/product/info/prices` 的实时响应，税基于净额 |
| **Yandex Market** | 税基于**毛收入**（简易计税），外加从 `stats/orders` 反推出的实际 boost 费率——费率接口并不返回它 |
| **Wildberries** | 按 `subject_id` 的 FBO 佣金、按箱体体积的物流费、按签收率加权的退货物流费 |

税率为零会被当作「零税率」处理，而不是「未启用」——保护依然生效。

### 把商品撤出促销活动

依据平台上的实时活动列表工作，而不是可能已经过期的本地副本。已冻结的活动会跳过，未删干净的部分由下一轮补上；在 Ozon 上还会设置自动加入的拒绝开关，从源头上阻止平台自行拉入商品。允许活动白名单和最大折扣深度，保证你真正想参加的活动不受影响。

Wildberries 没有「退出活动」的接口，因此退出是通过 Prices API 恢复 `{价格, 折扣}` 组合来实现的。

### 一个主价格，覆盖三个平台

你设定买家应当看到的价格，系统再把它展开成各平台自己的规则：Ozon 的 `price` / `old_price` / `min_price` 及其 50% 与 2× 约束；Wildberries 的「基础价 + 折扣」组合（那里无法直接设定买家价）；Yandex 的 `price` 加上落在允许区间 5–99% 内的 `discountBase`。先 dry-run，下发前留快照，每个店铺一个批次以遵守限流。

### 用实验寻找更优价格

大多数调价器执行的是规则。这一个可以执行搜索。

在单个 SKU 每天 0.3–5 件的销量下，严格的 A/B 测试在统计上不可行——每个价格点需要数百笔成交。因此改用：**单 SKU 内的阶梯搜索（ladder），配合 Gamma-Poisson 贝叶斯需求估计**，事件驱动的停止条件、滞回机制，以及随收敛逐步减小的步长。决策依据是后验强度的**下分位数**而非均值，这样小样本无法把引擎劝进一个它并未挣得的价格。

五种策略类型：`ref_price`（不做实验）、`max_profit`、`max_revenue`、带毛利约束的 `max_units`，以及 `liquidation`（清仓）。因缺货、促销、广告投放骤增或会员折扣变动而受污染的日期会被标记，并从需求估计中剔除。

已用蒙特卡洛仿真对照已知最优解验证（`scripts/simStrategy.cjs`）：与理论最优的差距，`max_profit` 与 `max_units` 约 2%，`max_revenue` 约 12%——营收的最优点本身就很平坦。

设计说明见 [docs/zh/strategies.md](docs/zh/strategies.md)。

### 校验价格是否真的生效了

平台会对并未执行的修改返回成功。每次下发三分钟后，价格会被重新读取，记录标记为 `VERIFIED_OK` 或 `VERIFIED_FAIL`。Ozon 还会在返回 HTTP 200 的同时，把错误藏在单个商品条目里——这些会被解析出来记为拒绝，而不是算作成功。

### 监控第三方 API 是否在脚下变了

一份显式的登记表把调价器的每项功能与它依赖的接口对应起来。每小时执行轻量探测（`limit=1`）——返回 404 就说明 API 变了；同时运行的降级检测器会把当前失败与该接口自身的历史作对比。告警发往 Sentry。

### 决策驾驶舱，而不是指标看板

九类告警，按在险金额排序：基准价低于成本、促销价低于成本、价格低于下限、平台把价格压到下限之下、修改未生效、价格隔离、退出促销失败、缺少成本数据、缺少销量数据。每张卡片都带着在险金额，以及能够解决它的操作。

### 面向 LLM 智能体的 HTTP 控制面

`/api/ext/v1` 是一个机器对机器的 API，前置 Bearer 密钥、IP 白名单和限流。它的设计场景是：**多个 LLM 智能体在多个不同会话中**管理同一份商品目录。

让它们不互相覆盖对方的决策，本质上是并发控制问题，因此也按并发问题来解决：

- **带版本的上下文。** 每次写价格都必须携带当前的 `context_version`。过期的版本以 `409` 拒绝，并在同一个响应里返回最新上下文——与 `ETag` / `If-Match` 是同一个思路。
- **SKU 归属。** 处于 `experiment` 或 `liquidation` 模式的商品，只有持有它的智能体才能写入；处于 `disposal` 的商品完全冻结。
- **策略护栏。** 单次写入的最大变动幅度、超过阈值的批量操作需二次确认、保本价下限校验，以及对下限未知的 SKU 直接拒绝。
- **决策日志与简报。** 智能体记录决策、意图与策略；服务端生成 Markdown 简报，并跟踪哪个智能体确认了哪个版本的上下文。
- **利润的唯一权威口径。** `GET /stores/:id/pnl` 是唯一被认可的计算方式，并且会如实说明自己的口径，包括它没有扣除的项目。

详见 [docs/zh/api-external.md](docs/zh/api-external.md) 与 [docs/zh/llm-agent.md](docs/zh/llm-agent.md)。

---

## 界面预览

**决策驾驶舱** —— 不是指标看板。每张卡片都是一个带着金额的问题，以及一个能解决它的按钮。

![决策驾驶舱](docs/images/cockpit.png)

**商品表** —— 基准价及其偏离、成本、计算出的保本价下限、毛利率、促销标记、库存。调价器据以决策的一切，都在同一行里。

![商品表](docs/images/products.png)

**一个主价格，覆盖三个平台。** 同一个货号同时在 Ozon、Wildberries 和 Yandex Market 上架；你只设定一次买家应看到的价格，系统再把它展开成各平台自己的规则。低于成本的价格在下发之前就会被标红。

![主价格](docs/images/master-prices.png)

**价格实验及其推理过程。** 日志会显示引擎做了什么、为什么这么做：区间扫描、ladder 步进、等待证据积累。在你把某个商品切到「自动」之前，什么都不会真正生效。

![定价策略](docs/images/strategies.png)

深浅两套主题均支持：

![浅色主题](docs/images/cockpit-light.png)

### 无需接入店铺即可试用

```bash
npm run demo
```

它会把一份合成的商品目录 —— 三家店铺、42 个商品、60 天销售数据，其中特意包含低于下限的商品、低于成本的促销、缺少成本价的商品，以及一个正在运行的实验 —— 写入 `demo.db` 并启动应用。全程不涉及任何凭据，也不会访问任何平台。上面的截图正是它生成的样子。

---

## 技术栈

Node.js 20 · Express 5 · better-sqlite3（同步）· node-cron · better-auth
React 19 · Vite 7 · TypeScript 5.9 · CSS Modules —— 不用 UI 组件库，不用状态管理库
SQLite 单文件 + WAL · 多阶段 Dockerfile · Sentry（可选）

约 35 000 行代码。155 个测试，覆盖定价数学、策略引擎、表格解析器、API 密钥鉴权和驾驶舱查询。

---

## 快速开始

**环境要求：** Node 20+，以及编译原生模块所需的工具链（`python3`、`make`、`g++`）——`better-sqlite3` 在安装时需要编译。

```bash
git clone https://github.com/DeviceIngineering/marketplace-repricer.git && cd marketplace-repricer
npm ci

cp .env.example .env
# 生成会话密钥，填入 .env 的 BETTER_AUTH_SECRET：
openssl rand -hex 32

# 创建第一个管理员（密码至少 12 位）
ADMIN_PASSWORD='你的强密码' npm run seed

npm run dev:all          # API 在 :3001，界面在 :5173
```

没有单独的迁移命令。数据库结构和全部迁移会在进程启动时自动执行。

随后打开应用、登录，在**设置**中添加店铺。你需要卖家后台的 API 凭据——各平台分别需要哪些权限，见 [docs/zh/installation.md](docs/zh/installation.md)。

### Docker

```bash
cp .env.example .env      # 设置 BETTER_AUTH_SECRET
docker compose up --build
```

生产环境请在前面放一个终结 TLS 的反向代理，并把 `BETTER_AUTH_URL` 设为 `https://` 地址——会话 Cookie 只有在 HTTPS 下才会带上 `Secure` 标记：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 测试

```bash
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run lint
npm run build
```

---

## 配置

所有变量都在 [`.env.example`](.env.example) 中有说明。必填的只有两个：`BETTER_AUTH_SECRET` 和 `BETTER_AUTH_URL`。

平台 API 密钥**不是**环境变量——它们在界面里按店铺录入，保存在数据库中。这对部署方式意味着什么，请见 [SECURITY.md](SECURITY.md)。

---

## 文档

| | 中文 | English | Русский |
|---|---|---|---|
| 安装 | [zh](docs/zh/installation.md) | [en](docs/en/installation.md) | [ru](docs/ru/installation.md) |
| 用户指南 | [zh](docs/zh/user-guide.md) | [en](docs/en/user-guide.md) | [ru](docs/ru/user-guide.md) |
| 架构 | [zh](docs/zh/architecture.md) | [en](docs/en/architecture.md) | [ru](docs/ru/architecture.md) |
| 定价策略 | [zh](docs/zh/strategies.md) | [en](docs/en/strategies.md) | [ru](docs/ru/strategies.md) |
| 外部 API | [zh](docs/zh/api-external.md) | [en](docs/en/api-external.md) | [ru](docs/ru/api-external.md) |
| LLM 智能体说明 | [zh](docs/zh/llm-agent.md) | [en](docs/en/llm-agent.md) | [ru](docs/ru/llm-agent.md) |

---

## 项目状态与适用范围

这是从一套正在运行的系统中剥离出来的可用软件，不是带支持合同的产品。它是为一位卖家的三家店铺而写的；你的商品结构、税制和仓储组合都会不同，其中一些常数是针对特定商品矩阵标定的。在认定某个默认值适合你之前，请先阅读 [docs/zh/architecture.md](docs/zh/architecture.md)。

界面是俄语的，因为它的使用者是俄罗斯平台的卖家。文档提供三种语言。代码、注释和提交信息正在逐步转为英文。

欢迎贡献代码——见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 免责声明

本工具以你的身份、用你的 API 密钥、在你的账号中执行操作。它在那里做的一切由你负责，包括是否符合各平台的服务条款以及你作为卖家所接受的协议。作者不提供任何担保，也不对利润损失、账号封禁或运行本软件带来的任何其他后果承担责任。

在完整观察它以 dry-run 模式运行一个周期之前，不要把它指向正式店铺。

---

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
