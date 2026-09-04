import axios from 'axios';

// Все вызовы к собственному API приложения идут с session-cookie.
const api = axios.create({ withCredentials: true });

export interface StrategyOverviewRow {
    offer_id: string;
    name: string | null;
    strategy_type: string;
    in_experiment: number;
    strategy_window_days: number;
    ref_price: number | null;
    cost_price: number | null;
    floor_min_price: number | null;
    cur_price: string | number | null;
    current_price: number | null;
    best_price: number | null;
    best_metric: number | null;
    auto_apply: number | null;
    status: string | null;
    last_action: string | null;
    last_proposed: number | null;
    last_reason: string | null;
}

export interface StrategyLogRow {
    offer_id: string;
    timestamp: string;
    strategy_type: string;
    action: string;
    old_price: number | null;
    new_price: number | null;
    metric_name: string | null;
    metric_value: number | null;
    reason: string | null;
    applied: number;
}

export interface AssignConfig {
    strategy_type: string;
    price_min?: number;
    price_max?: number;
    target_margin?: number;
    window_days?: number;
    liquidation_max_loss_pct?: number;
}

/** Ответ на назначение стратегии: `assigned` — сколько товаров реально записано. */
export interface AssignResponse {
    success: boolean;
    assigned: number;
}

/** Пилот дополнительно возвращает выбранный топ по продажам за окно. */
export interface PilotAutoResponse extends AssignResponse {
    offers: Array<{ offer_id: string; units: number }>;
}

/** Роуты-переключатели (auto-apply, kill-switch магазина) отвечают только статусом. */
export interface OkResponse {
    success: boolean;
}

export interface GlobalKillSwitchResponse extends OkResponse {
    global_kill_switch: boolean;
}

/**
 * Итог прогона. `strategyRunner.runStore` возвращает либо `{ skipped }`
 * (kill-switch, нет магазина), либо счётчики — поэтому все поля опциональны.
 */
export interface StrategyRunResult {
    count?: number;
    applied?: number;
    skipped?: string;
    results?: Array<{
        offer: string;
        action: string;
        next: number | null;
        applied: boolean;
    }>;
}

export interface StrategyRunResponse {
    success: boolean;
    result: StrategyRunResult;
}

export const STRATEGY_LABELS: Record<string, string> = {
    ref_price: 'РРЦ (по умолчанию)',
    max_profit: 'Макс. прибыль',
    max_revenue: 'Макс. продажи (выручка)',
    max_units: 'Макс. штук при марже',
    liquidation: 'Слив остатков',
};

export const getOverview = (storeId: string) =>
    api.get<StrategyOverviewRow[]>(`/api/stores/${storeId}/strategy/overview`).then(r => r.data);

export const getLog = (storeId: string, limit = 200) =>
    api.get<StrategyLogRow[]>(`/api/stores/${storeId}/strategy/log?limit=${limit}`).then(r => r.data);

export const assignStrategy = (storeId: string, offerIds: string[], config: AssignConfig) =>
    api.post<AssignResponse>(`/api/stores/${storeId}/strategy/assign`, { offerIds, ...config }).then(r => r.data);

export const pilotAuto = (storeId: string, config: AssignConfig & { limit?: number; window_days?: number }) =>
    api.post<PilotAutoResponse>(`/api/stores/${storeId}/strategy/pilot-auto`, config).then(r => r.data);

export const setExperimentAuto = (storeId: string, offerId: string, on: boolean) =>
    api.post<OkResponse>(`/api/stores/${storeId}/strategy/experiment/${offerId}/auto`, { on }).then(r => r.data);

export const setStoreKillSwitch = (storeId: string, on: boolean) =>
    api.post<OkResponse>(`/api/stores/${storeId}/strategy/kill-switch`, { on }).then(r => r.data);

export const setGlobalKillSwitch = (on: boolean) =>
    api.post<GlobalKillSwitchResponse>(`/api/strategy/kill-switch`, { on }).then(r => r.data);

export const runStrategy = (storeId: string) =>
    api.post<StrategyRunResponse>(`/api/stores/${storeId}/strategy/run`, {}).then(r => r.data);
