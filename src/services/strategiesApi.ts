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
    api.post(`/api/stores/${storeId}/strategy/assign`, { offerIds, ...config }).then(r => r.data);

export const pilotAuto = (storeId: string, config: AssignConfig & { limit?: number; window_days?: number }) =>
    api.post(`/api/stores/${storeId}/strategy/pilot-auto`, config).then(r => r.data);

export const setExperimentAuto = (storeId: string, offerId: string, on: boolean) =>
    api.post(`/api/stores/${storeId}/strategy/experiment/${offerId}/auto`, { on }).then(r => r.data);

export const setStoreKillSwitch = (storeId: string, on: boolean) =>
    api.post(`/api/stores/${storeId}/strategy/kill-switch`, { on }).then(r => r.data);

export const setGlobalKillSwitch = (on: boolean) =>
    api.post(`/api/strategy/kill-switch`, { on }).then(r => r.data);

export const runStrategy = (storeId: string) =>
    api.post(`/api/stores/${storeId}/strategy/run`, {}).then(r => r.data);
