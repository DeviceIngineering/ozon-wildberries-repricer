# 🔌 Внешний API репрайсера (для LLM-агента ценообразования)

> Machine-to-machine API для внешнего сервиса: чтение состояния репрайсера, управление ценами, стратегиями и настройками магазинов.
> Namespace: **`/api/ext/v1`**. Отдельный от веб-UI (cookie-сессии здесь не работают).

Последнее обновление: 2026-07-16.

---

## 1. Аутентификация

Единый **мастер-ключ** передаётся в каждом запросе:

```
Authorization: Bearer <EXTERNAL_API_KEY>
```

(альтернатива — заголовок `X-API-Key: <ключ>`).

Ключ задаётся на сервере в env `EXTERNAL_API_KEY` (генерация: `openssl rand -hex 32`).

**Коды состояния аутентификации:**
| Код | Значение |
|---|---|
| `401 unauthorized` | ключ отсутствует или неверный |
| `403 ip_forbidden` | IP не в белом списке (`EXTERNAL_API_ALLOWED_IPS`) |
| `429 rate_limited` | превышен лимит (по умолчанию 120 req/min на IP) |
| `503 not_configured` | `EXTERNAL_API_KEY` не задан на сервере |
| `503 disabled` | внешний API выключен kill-switch'ем |

Формат ошибок: `{ "error": "текст", "code": "машинный_код" }`.

### ⚠️ Безопасность (обязательно к прочтению)
- **Ключ = полный контроль над ценами.** Храните его как секрет, не логируйте, не коммитьте.
- **Только HTTPS.** При пробросе порта в интернет ставьте TLS (reverse-proxy / Let's Encrypt) — иначе Bearer-ключ перехватывается в открытом виде.
- **IP-allowlist** (`EXTERNAL_API_ALLOWED_IPS`) — заполните при внешнем доступе.
- **Sanity-cap отсутствует по решению владельца:** сервер НЕ проверяет разумность цены (нет floor-гарда). Ответственность за корректность цен — на стороне агента. Все мутации пишутся в аудит (`external_api_log`).
- **Токены маркетплейсов недоступны** через API (не отдаются в GET, не принимаются в PATCH). Управление токенами и создание/удаление магазинов — только в веб-UI.
- **Аварийный выключатель:** весь внешний API можно мгновенно отключить (см. `external_api_enabled` в `app_settings`, или через будущую кнопку в UI) без изменения ключа.

---

## 2. Модель данных

- **Изделие связывается между магазинами по `offer_id`** (артикул продавца — один на WB и Ozon).
- **`cost_price`** — себестоимость, глобальна по `offer_id`.
- **`ref_price`** — эталон (целевая цена), пер-магазин. **Репрайсер держит `ref_price`.**
- Платформа магазина — поле `platform`: `ozon` | `wildberries` | `yandex`.

**Важно про удержание цены:** когда вы ставите цену через `POST /stores/:id/prices`, она записывается как `ref_price` — репрайсер будет её **держать** (защищать), а не откатывать. Если у товара активна стратегия-эксперимент (`strategy_type != ref_price`), движок может двигать цену: чтобы зафиксировать цену жёстко, сначала переведите товар в `ref_price` через `PATCH /products/:offerId/strategy`.

---

## 3. Эндпоинты

Базовый URL: `https://<host>/api/ext/v1`

### Чтение

#### `GET /health`
Сводка состояния.
```json
{ "ok": true, "external_api_enabled": true, "stores_count": 4,
  "stores": [{ "id": "...", "name": "OZON-A", "platform": "ozon",
               "repricer_enabled": true, "kill_switch": false, "last_updated_at": "..." }],
  "global_kill_switch": false }
```

#### `GET /stores`
По умолчанию отдаются только поля, нужные для решения: `id, name, platform, repricer_enabled, strategy_kill_switch, tax_rate, min_margin_percent, last_updated_at` плюс признаки наличия ключей. `?full=1` — расширенный вид (по-прежнему без секретов).
Список магазинов **без секретов**. Секретные поля заменены флагами `has_ozon_creds`/`has_wb_creds`/`has_ym_creds`.

#### `GET /stores/:id`
Детали магазина (настройки репрайсера, пороги, kill-switch).

#### `GET /stores/:id/products`
Товары магазина. Query: `page`, `pageSize` (≤500), `sort` (`key:asc|desc`), `search`, `filter` (`all|on_sale|below_ref|no_cost|promo|errors|has_fbo|...`), **`fields`**, **`format`**.

Ответ включает `management_mode`, `managed_by`, `strategy_type` — режим владения виден сразу, отдельный запрос к `/context` ради `sku_states` не нужен.

```json
{ "data": [{ "offer_id": "SKU-0001", "name": "...", "price": "1035",
             "ref_price": 1035, "cost_price": 414, "min_price": "500",
             "stocks_fbo": 0, "strategy_type": "ref_price", "sales_30d": 12,
             "management_mode": "ref_price" }],
  "meta": { "total": 1025, "page": 1, "pageSize": 50 } }
```

##### Экономия контекста

Полная карточка — 31 поле, около **258 токенов на товар**. Каталог в 1 000 SKU в таком виде занимает ~258 000 токенов и в контекст модели просто не помещается. Два параметра решают это:

`fields=a,b,c` — вернуть только перечисленные поля; `null` не отдаются вовсе.
`fields=default` — набор для ценового решения: `offer_id, price, marketing_price, min_price, ref_price, cost_price, floor_min_price, sales_30d, stocks_fbo, in_promo, promo_price, management_mode`.

`format=compact` — имена колонок выносятся из строк:

```json
{ "data": { "cols": ["offer_id", "price", "ref_price", "cost_price", "floor_min_price"],
            "rows": [["SKU-0001", "1035", 1035, 414, 619],
                     ["SKU-0002", "740", 740, 240, 500]] },
  "meta": { "total": 1025, "page": 1, "pageSize": 500, "format": "compact" } }
```

Замер на живых данных (500 товаров в ответе):

| Запрос | Размер | |
|---|---:|---:|
| без параметров | 10 196 Б | — |
| `fields=default` | 2 767 Б | −73% |
| `fields=default&format=compact` | **1 175 Б** | **−88%** |

Формат по умолчанию не изменился — существующие агенты продолжают работать.

#### `GET /stores/:id/sales?window=30`
Дневные продажи. Без `offer_id` — топ-продавцы за окно; с `offer_id` — дневной ряд по SKU. `window` ≤ 90.

#### `GET /stores/:id/repricer-logs`
Лог прогонов репрайсера. Query: `action`, `period`, `page`, `limit` (≤500).

`store_id` и `run_id` из строк убраны: первый есть в URL, второй — UUID ценой около 27 токенов на строку. Список прогонов ответа — в `meta.runs`.

#### `GET /stores/:id/pending`
Статус отправок цен (пост-верификация). Query: `status` (`PENDING|VERIFIED_OK|VERIFIED_FAIL|EXPIRED`), `limit` (по умолчанию 100, ≤500), `since` (ISO-дата), **`summary=1`**.

Таблица накапливается исторически, поэтому у выборки есть предел. После массовой отправки берите сводку, а не все строки:

```json
{ "data": { "by_status": { "VERIFIED_OK": 78, "PENDING": 2, "VERIFIED_FAIL": 20 },
            "failures": [{ "offer_id": "SKU-0007", "sent_price": 1200,
                           "actual_price": 1350, "fail_reason": "..." }] } }
```

Проверка после отправки 1 000 SKU: ~120 000 токенов полным списком против ~400 сводкой.

#### `GET /products/:offerId/cross-store`
Цены изделия по всем магазинам.

### Управление ценами

#### `POST /stores/:id/prices`
Прямая отправка цен в маркетплейс + запись эталона (репрайсер держит).
```json
// запрос
{ "updates": [{ "offer_id": "SKU-0001", "price": 1200, "min_price": 600, "old_price": 2400 }],
  "dry_run": false }
```
`min_price`/`old_price` — опциональны (`old_price` вычисляется автоматически по правилам Ozon). При `dry_run: true` цены не отправляются — возвращается `preview` рассчитанных значений.
```json
// ответ
{ "success": true, "sent": 1, "item_errors": [], "dry_run": false }
```

#### `PUT /products/:offerId/master-price`
Установить эталон (мастер-цену) сразу во все магазины изделия.
```json
{ "master_price": 1200 }
```

#### `POST /stores/:id/repricer/run`
Запустить прогон репрайсера. Требует `repricer_enabled = true` у магазина (иначе `400 repricer_disabled`).

### Стратегии / kill-switch

#### `PATCH /products/:offerId/strategy`
Назначить стратегию. Без `store_id` — применяется ко всем магазинам изделия.
```json
{ "store_id": "...",           // опц.; если нет — все магазины изделия
  "strategy_type": "max_profit", // ref_price | max_profit | max_revenue | max_units | liquidation
  "price_min": 1000, "price_max": 2000,
  "target_margin": 30,          // для max_units, %
  "window_days": 30,            // 14 | 30 | 60
  "liquidation_max_loss_pct": 10 // для liquidation
}
```
`strategy_type: "ref_price"` — снять эксперимент (держать эталон).

#### `POST /stores/:id/kill-switch`
Kill-switch магазина: `{ "enabled": true }` — остановить эксперименты магазина, откат к эталону.

#### `POST /kill-switch/global`
Глобальный kill-switch: `{ "enabled": true }`.

### Настройки магазина

#### `PATCH /stores/:id/settings`
Только настройки репрайсера. Разрешённые поля: `repricer_enabled`, `repricer_interval_min`, `update_interval_minutes`, `threshold_drop_percent`, `threshold_rise_percent`, `antiban_enabled`, `min_margin_percent`, `tax_rate`. Прочие поля (токены, id) **игнорируются**.

---

## 4. Типичный цикл агента

1. `GET /health` — жив ли сервис, какие магазины.
2. `GET /stores/:id/products?filter=on_sale` + `GET /stores/:id/sales?window=30` — собрать состояние и спрос.
3. Рассчитать цены во внешнем сервисе.
4. `POST /stores/:id/prices` с `dry_run: true` — проверить расчёт.
5. `POST /stores/:id/prices` (`dry_run: false`) — отправить. Цена станет эталоном, репрайсер её держит.
6. `GET /stores/:id/pending` — убедиться, что маркетплейс применил (через ~3 мин).
7. При проблеме — `POST /kill-switch/global { "enabled": true }`.

---

## 5. Настройка на сервере

```bash
# 1. Сгенерировать ключ и прописать в .env на сервере
echo "EXTERNAL_API_KEY=$(openssl rand -hex 32)" >> .env
# 2. (внешний доступ) заполнить allowlist
echo "EXTERNAL_API_ALLOWED_IPS=<ip-агента>" >> .env
# 3. Перезапустить контейнер (или ./deploy.sh)
```

Если порт доступен из интернета — обязательно закройте его TLS-прокси и заполните `EXTERNAL_API_ALLOWED_IPS`. Ключ даёт полный контроль над ценами; по голому HTTP он уходит в открытом виде.
