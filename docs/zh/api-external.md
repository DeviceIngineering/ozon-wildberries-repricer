# 🔌 调价器对外 API（面向 LLM 定价 Agent）

> 面向外部服务的 machine-to-machine API：读取调价器状态，管理价格、策略和店铺设置。
> Namespace：**`/api/ext/v1`**。与 Web UI 相互独立（cookie 会话在这里无效）。

最后更新：2026-07-16。

---

## 1. 认证

每个请求都要携带统一的**主密钥（master key）**：

```
Authorization: Bearer <EXTERNAL_API_KEY>
```

（也可以改用请求头 `X-API-Key: <密钥>`。）

密钥在服务端通过环境变量 `EXTERNAL_API_KEY` 配置（生成方式：`openssl rand -hex 32`）。

**认证相关状态码：**
| 状态码 | 含义 |
|---|---|
| `401 unauthorized` | 密钥缺失或不正确 |
| `403 ip_forbidden` | IP 不在白名单中（`EXTERNAL_API_ALLOWED_IPS`） |
| `429 rate_limited` | 超出限流（默认每个 IP 120 req/min） |
| `503 not_configured` | 服务端未配置 `EXTERNAL_API_KEY` |
| `503 disabled` | 对外 API 已被 kill-switch 关闭 |

错误格式：`{ "error": "文本描述", "code": "机器可读的代码" }`。

### ⚠️ 安全须知（必读）
- **密钥 = 对价格的完全控制权。** 请当作机密保管：不要打印到日志，不要提交到仓库。
- **只走 HTTPS。** 若把端口暴露到公网，务必套一层 TLS（反向代理 / Let's Encrypt）—— 否则 Bearer 密钥会以明文被截获。
- **IP 白名单**（`EXTERNAL_API_ALLOWED_IPS`）—— 对外开放时必须填写。
- **按所有者决定，不设置 sanity-cap：** 服务端**不**校验价格是否合理（没有 floor 护栏）。价格正确性完全由 Agent 侧负责。所有写操作都会记入审计表（`external_api_log`）。
- **平台 token 不通过 API 暴露**（GET 不返回，PATCH 不接受）。token 管理以及店铺的创建/删除只能在 Web UI 中完成。
- **紧急开关：** 整个对外 API 可以被立即关闭（见 `app_settings` 中的 `external_api_enabled`，或未来 UI 中的按钮），无需更换密钥。

---

## 2. 数据模型

- **同一件商品在各店铺之间通过 `offer_id` 关联**（卖家货号 —— WB 与 Ozon 共用同一个）。
- **`cost_price`** —— 成本价，按 `offer_id` 全局唯一。
- **`ref_price`** —— 基准价（目标价），按店铺各自维护。**调价器负责守住 `ref_price`。**
- 店铺所属平台在 `platform` 字段中：`ozon` | `wildberries` | `yandex`。

**关于「守价」的重要说明：** 当你通过 `POST /stores/:id/prices` 设置价格时，该价格会被写入 `ref_price` —— 调价器随后会**守住**（保护）它，而不是把它回滚掉。如果商品上启用了实验型策略（`strategy_type != ref_price`），引擎仍可能改动价格：想把价格彻底锁死，请先通过 `PATCH /products/:offerId/strategy` 把商品切回 `ref_price`。

---

## 3. 接口

Base URL：`https://<host>/api/ext/v1`

### 读取

#### `GET /health`
状态概览。
```json
{ "ok": true, "external_api_enabled": true, "stores_count": 4,
  "stores": [{ "id": "...", "name": "OZON-A", "platform": "ozon",
               "repricer_enabled": true, "kill_switch": false, "last_updated_at": "..." }],
  "global_kill_switch": false }
```

#### `GET /stores`
店铺列表，**不含密钥**。敏感字段被替换为 `has_ozon_creds`/`has_wb_creds`/`has_ym_creds` 标志位。

#### `GET /stores/:id`
店铺详情（调价器设置、阈值、kill-switch）。

#### `GET /stores/:id/products`
店铺商品。Query：`page`、`pageSize`（≤500）、`sort`（`key:asc|desc`）、`search`、`filter`（`all|on_sale|below_ref|no_cost|promo|errors|has_fbo|...`）。
```json
{ "data": [{ "offer_id": "SKU-0001", "name": "...", "price": "1035",
             "ref_price": 1035, "cost_price": 414, "min_price": "500",
             "stocks_fbo": 0, "strategy_type": "ref_price", "sales_30d": 12 }],
  "meta": { "total": 1025, "page": 1, "pageSize": 50 } }
```

#### `GET /stores/:id/sales?window=30`
按天的销售数据。不传 `offer_id` —— 返回窗口内的畅销榜；传 `offer_id` —— 返回该 SKU 的日序列。`window` ≤ 90。

#### `GET /stores/:id/repricer-logs`
调价器运行批次日志。Query：`action`、`period`、`page`、`limit`（≤500）。

#### `GET /stores/:id/pending`
价格推送状态（推送后校验）。Query：`status`（`PENDING|VERIFIED_OK|VERIFIED_FAIL|EXPIRED`）。

#### `GET /products/:offerId/cross-store`
该商品在所有店铺中的价格。

### 价格管理

#### `POST /stores/:id/prices`
直接向平台推送价格，同时写入基准价（调价器会守住）。
```json
// 请求
{ "updates": [{ "offer_id": "SKU-0001", "price": 1200, "min_price": 600, "old_price": 2400 }],
  "dry_run": false }
```
`min_price`/`old_price` 为可选（`old_price` 会按 Ozon 规则自动计算）。当 `dry_run: true` 时不会推送价格，只返回计算结果的 `preview`。
```json
// 响应
{ "success": true, "sent": 1, "item_errors": [], "dry_run": false }
```

#### `PUT /products/:offerId/master-price`
一次性把基准价（主价格）设置到该商品所在的全部店铺。
```json
{ "master_price": 1200 }
```

#### `POST /stores/:id/repricer/run`
触发一次调价器运行批次。要求店铺 `repricer_enabled = true`（否则返回 `400 repricer_disabled`）。

### 策略 / kill-switch

#### `PATCH /products/:offerId/strategy`
指定策略。不传 `store_id` —— 应用到该商品所在的全部店铺。
```json
{ "store_id": "...",           // 可选；不传则应用到该商品的全部店铺
  "strategy_type": "max_profit", // ref_price | max_profit | max_revenue | max_units | liquidation
  "price_min": 1000, "price_max": 2000,
  "target_margin": 30,          // 用于 max_units，单位 %
  "window_days": 30,            // 14 | 30 | 60
  "liquidation_max_loss_pct": 10 // 用于 liquidation
}
```
`strategy_type: "ref_price"` —— 取消实验（改为守住基准价）。

#### `POST /stores/:id/kill-switch`
店铺级 kill-switch：`{ "enabled": true }` —— 停止该店铺的全部实验，回退到基准价。

#### `POST /kill-switch/global`
全局 kill-switch：`{ "enabled": true }`。

### 店铺设置

#### `PATCH /stores/:id/settings`
仅限调价器设置。允许的字段：`repricer_enabled`、`repricer_interval_min`、`update_interval_minutes`、`threshold_drop_percent`、`threshold_rise_percent`、`antiban_enabled`、`min_margin_percent`、`tax_rate`。其余字段（token、id）会被**忽略**。

---

## 4. Agent 的典型工作循环

1. `GET /health` —— 服务是否存活，有哪些店铺。
2. `GET /stores/:id/products?filter=on_sale` + `GET /stores/:id/sales?window=30` —— 采集当前状态与需求。
3. 在外部服务中计算价格。
4. `POST /stores/:id/prices` 带 `dry_run: true` —— 校验计算结果。
5. `POST /stores/:id/prices`（`dry_run: false`）—— 正式推送。价格会成为基准价，由调价器守住。
6. `GET /stores/:id/pending` —— 确认平台已生效（约 3 分钟后）。
7. 出现问题时 —— `POST /kill-switch/global { "enabled": true }`。

---

## 5. 服务端配置

```bash
# 1. 生成密钥并写入服务器上的 .env
echo "EXTERNAL_API_KEY=$(openssl rand -hex 32)" >> .env
# 2. （对外访问）填写 IP 白名单
echo "EXTERNAL_API_ALLOWED_IPS=<agent 的 ip>" >> .env
# 3. 重启容器（或执行 ./deploy.sh）
```

如果该端口可从公网访问，务必用 TLS 代理把它挡住，并填好 `EXTERNAL_API_ALLOWED_IPS`。密钥意味着对价格的完全控制权；走裸 HTTP 时它会以明文传输。
