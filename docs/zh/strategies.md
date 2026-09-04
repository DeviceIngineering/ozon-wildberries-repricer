# 🎯 定价策略 — 设计规格

> 「用实验动态寻优价格」这一功能的唯一权威文档。

## 问题
在设定毛利率（例如 30%）的前提下，保本价下限（floor）会把部分 SKU 的价格顶得过高，直接把销量打没。我们需要依据真实销售数据来寻优价格，而不是死守静态基准价（РРЦ / `ref_price`）。

## 思路（论证依据见 `docs/` 中的调研与方法论）
在低销量（λ=0.3–5 件/天）条件下，严格的 A/B 测试在统计上不可行（每个价格点需要数百笔销售）。因此采用：
**within-SKU ladder（同 SKU 阶梯搜索）+ Gamma-Poisson 贝叶斯 + 事件驱动的停止条件 + 滞回（hysteresis）。**
- 每个价格点保持到 **N_min≈12 笔销售 或 T_max**（分析窗口）为止，然后再决策。
- 决策依据是 **后验期望指标**（Gamma-Poisson），取下分位（p25）→ 对小样本保持风险厌恶。
- 步长取大（±7–10%，coarse-to-fine 收敛到 ±3–5%），滞回 δ≥5%，连续 2 次差结果即回退。
- 价格区间是围绕当前工作价的窄窗口，**floor 是硬下限**（`liquidation` 除外）。
- λ<0.3/天 的 SKU **不**纳入实验（无有效信号）。

## 策略（`products.strategy_type`）
| 类型 | 目标 | 最优点位置 |
|---|---|---|
| `ref_price`（默认） | 守住基准价，不做实验 | — |
| `max_profit` | 最大化 `(价格 − 成本价 − 佣金(价格)) × 件数` | 区间内部 |
| `max_revenue`（「最大销量额」） | 最大化 `价格 × 件数`（营收） | 区间内部（弹性≈1） |
| `max_units` | 在毛利率 ≥ 目标值的前提下最大化件数 | 趋向带目标毛利率的 floor |
| `liquidation`（「清仓」） | 以最低价清掉 FBO 库存 | 向下，**允许亏损低于成本价** |

### `liquidation` 策略 —— 特殊模式
- 由用户**手动**指定 SKU 及**可接受亏损幅度**（允许低于成本价多少）。
- 它是唯一被允许突破 floor 的策略，突破幅度以可接受亏损为限。
- 🔴 **关键：** 清仓期间的日期会在 `sales_daily` 中标记 `is_dirty=1` + `liquidation_flag=1`，并保留清仓历史。引擎以及未来的 LLM **必须**把这些天从需求估计中剔除 —— 否则清仓带来的销量激增会被误判为对价格的正常反应。

## 分析窗口
可选：**14 / 30 / 60 天**（可按商品或按店铺设置）。影响 λ 与各项指标的计算。

## 安全机制
- **Gate（放行闸）：** 前 N 个周期为 dry-run（引擎只**建议**价格，需人工审批），之后才转为自动应用。
- **Kill-switch（紧急停止）：** 三级 —— 全局 / 按店铺 / 按 SKU。可立即中止实验并回退到 `ref_price` 或最近一次安全价格。
- **Floor 护栏：** 除 liquidation 外，任何价格都不得低于 floor。
- **试点：** 按销量自动挑选 Top-N（约 20 个）SKU，也支持手动追加。
- **冻结其他杠杆：** 试点 SKU 上不得改动促销活动和广告（只留价格这一个杠杆）。

## 混杂因素 → `is_dirty_flag`（该日不用于价格结论）
断货、促销日、广告/流量加权（boost）激增、WB 会员折扣（SPP）变动、清仓。需求只按「干净」的日子统计。

## 数据：`sales_daily`（append-only，每个 SKU×日 一行）
必须精确到天（聚合会破坏混杂因素的解耦）。它既是引擎的输入，也是给 LLM 用的数据集。
字段：`store_id, product_id, offer_id, marketplace, date, units, revenue, profit, price_seller, price_buyer_est, cost_unit, commission_pct, floor, ceiling, promo_flag, promo_price, ad_spend, boost_pct, stock_qty, in_stock_flag, spp_pct(WB,null), comp_price(null), experiment_id, step_idx, is_dirty_flag, liquidation_flag, posterior_lambda_mean, posterior_lambda_p25`。

## 各平台销售数据来源
- **Ozon：** `/v1/analytics/data`（metrics：ordered_units/revenue；dimension：sku, day）。
- **WB：** `nm-report`（按 nmID/日 的下单量/签收量）。⚠️ 必须按**签收量**统计，而不是下单量（有退货）。
- **Yandex：** 扩展 `fetchOrdersEconomics`（已有，7 天 → 扩到分析窗口）。
⚠️ 可观测的需求响应的是**买家侧价格**（WB：×(1−SPP)；Ozon：marketing_price；YM：boost），而我们调整的是卖家侧价格。两个价格要分别记录。

## 引擎验证（蒙特卡洛）
用 `scripts/simStrategy.cjs` 在合成泊松需求上做仿真，对比指标**数值**与理论最优的差距：
- **max_profit：约 2%**，**max_units：约 2%** —— 表现优秀。
- **max_revenue：约 12%** —— 可以接受：营收最优点本身平坦，加上低销量的本质噪声（单个价格点的一次观测会被 ±2σ 的波动带偏）。缓解手段：人工 gate、随时间积累数据（后验逐步收紧）、λ 阈值。
引擎流程：先做价格区间的初扫（把最优点夹在中间）→ 再做 ladder 精调；先验要弱，并保证最少观测天数（否则低价点会被低估）。

## 已实现的部分
- **数据模型：** `sales_daily`、`experiments`、`strategy_log`、`products` 上的策略字段、kill-switch。
- **销售数据采集：** 覆盖三个平台，含 backfill 与每日任务，由 `salesCollector.cjs` 和各平台 fetcher 完成。
- **引擎：** `lib/bayesPoisson.cjs`（Gamma-Poisson、Wilson–Hilferty 分位数、Acklam 逆正态）与 `lib/strategyEngine.cjs`（区间扫描、ladder、滞回、目标函数、dirty 日过滤）。纯数学实现，不涉及网络与数据库——因此可测试、可仿真。
- **编排：** `strategyRunner.cjs` —— 单件经济测算、Wildberries 价格隔离上限、`auto_apply` 放行闸、按店铺与全局的 kill-switch。
- **可观测性：** `strategy_log` 记录每次运行中每个 SKU 的决策；`/strategies` 面板。
- **测试：** 引擎与贝叶斯部分的单元测试、ladder 收敛性的确定性测试、安全性质测试（区间上限、清仓边界、floor > 0、`max_units` 不可达毛利率），以及蒙特卡洛仿真。

## 试点启动流程（历史数据积累够之后）
1. `/strategies` → 选店铺 → 「选择试点」（按销量 Top-N）或手动指定。
2. 引擎连续若干天积累干净日数据，并写入建议日志（dry-run，价格**不**变）。
3. 复核日志 → 若建议合理 → 对该商品点「自动」按钮 = 真实生效（floor 仍是硬下限）。
4. 兜底：按店铺或全局 kill-switch 可立即停止。

## 演进规划（v1 之外的未来工作）
LLM 推荐 Agent（数据结构已为其预留）；竞品价格监控；把广告/boost 也变成可调**杠杆**（当前仅采集）；**促销对销量影响的分析**（目前只采标记，尚未进入决策逻辑）；低销量 SKU 的池化（分层贝叶斯）。
