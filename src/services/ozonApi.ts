import axios from 'axios';

export interface OzonProduct {
    offer_id: string;
    product_id: number;
    name?: string;
    primary_image?: string;
    price?: string;
    currency_code?: string;
    marketing_price?: string; // Marketing Seller Price
    old_price?: string;
    stock?: number;
    // Removed premium_price as it's often missing/calculated
    min_price?: string;
    ref_price?: number | string;
    ref_min_price?: number | string;
    cost_price?: number;
    floor_min_price?: number;
    visibility?: string;
    is_quarantine?: number; // 0 or 1
    is_archived?: number; // 0 or 1
    price_apply_status?: 'applied' | 'pending' | 'rejected';
    price_apply_error?: string;
    in_promo?: number; // 0 or 1
    promo_price?: number;
    promo_action_id?: number;
    has_price?: number; // 0 or 1
    has_stock?: number; // 0 or 1
    ozon_is_created?: number; // 0 or 1; 0 = product not validated ("На доработку")
    moderate_status?: string; // 'can_improve' for YM products that can be improved
    stocks_fbo?: number;
    stocks_fbs?: number;
    stocks_updated_at?: string | null;
    sales_30d?: number;
}

export interface Store {
    id: string;
    name: string;
    client_id: string;
    api_key: string;
    update_interval_minutes: number;
    last_updated_at: string | null;
    antiban_enabled: number;
    repricer_enabled: number;
    repricer_interval_min: number;
    last_repricer_run: string | null;
    threshold_drop_percent: number;
    threshold_rise_percent: number;
    monitor_interval_min?: number;
    last_monitor_run?: string | null;
}

export interface DashboardSummary {
    stores: Array<{
        id: string;
        name: string;
        platform: string;
        repricer_enabled: number;
        repricer_interval_min: number;
        last_repricer_run: string | null;
        product_count: number;
        quarantine_count: number;
        price_rejected_count: number;
        promo_below_cost_count: number;
        invisible_count: number;
        ref_price_count: number;
        promo_count: number;
        below_ref_promo_count: number;
        below_ref_other_count: number;
        verified_fail_count: number;
        last_sync: string | null;
        tax_rate?: number;
        min_margin_percent?: number;
        below_floor_count?: number;
    }>;
    total_alerts: number;
}

// Период агрегации дашборда
export type AnalyticsPeriod = '24h' | '7d' | '30d';

// === Кокпит решений ===
export type TaskSeverity = 'danger' | 'warn' | 'info';

export interface TaskStoreBreakdown {
    store_id: string;
    store_name: string;
    platform: string;
    count: number;
    risk: number;
}

export interface DecisionTask {
    id: string;
    severity: TaskSeverity;
    title: string;
    desc: string;
    count: number;
    risk: number;
    riskKind: 'per_day' | 'per_unit' | null;
    example: string | null;
    action: { label: string; kind: 'import' | 'cabinet' | 'repricer' | 'logs' | 'drill' };
    filter: string | null;
    byStore: TaskStoreBreakdown[];
}

export interface AutomationStore {
    id: string;
    name: string;
    platform: string;
    repricer_enabled: number;
    last_repricer_run: string | null;
    promo_exit_enabled: number;
    held: number;
    corrected: number;
    promo_exited: number;
    corrected_1d: number;
    corrected_7d: number;
    promo_exited_1d: number;
    promo_exited_7d: number;
}

export interface DecisionCockpit {
    period: AnalyticsPeriod;
    tasks: DecisionTask[];
    totalRisk: number;
    moneyKind: 'per_day' | 'per_unit';
    automation: AutomationStore[];
    analytics: {
        lossTrend: Array<{ day: string; cnt: number }>;
        margin: { loss: number; b0: number; b5: number; b15: number; b30: number };
        control: { rrc: number; promo: number };
    };
    platformLabels: Record<string, string>;
}

export const getDecisionCockpit = async (period: AnalyticsPeriod = '7d'): Promise<DecisionCockpit> => {
    const response = await axios.get(`/api/dashboard/cockpit`, { params: { period } });
    return response.data;
};

export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
}

export interface PriceUpdatePending {
    id: number;
    store_id: string;
    product_id: number;
    offer_id: string;
    old_price: number;
    new_price: number;
    status: 'pending' | 'verified' | 'rejected';
    verify_after: string;
    verified_at: string | null;
    actual_price: number | null;
}

export const runRepricerNow = async (storeId: string): Promise<void> => {
    await axios.post(`/api/stores/${storeId}/repricer/run`);
};

export const runMonitorNow = async (storeId: string): Promise<void> => {
    await axios.post(`/api/stores/${storeId}/monitor/run`);
};
