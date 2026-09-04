// API «Управление ценами» (мастер-цена = эталон изделия, группировка по offer_id).

export interface MasterStoreRow {
  store_id: string;
  store_name: string;
  platform: string;
  ozon_id: number | null;
  ref_price: number | null;
  ref_min_price: number | null;
  cost_price: number | null;
  wb_discount: number | null;
  wb_price_base: number | null;
  stocks_fbo: number | null;
  is_archived: number | null;
  price: string | number | null;
  marketing_price: string | number | null;
  old_price: string | number | null;
  image: string | null;
}

export interface MasterGroup {
  offer_id: string;
  name: string | null;
  image: string | null;
  cost_price: number | null;
  master_price: number | null;
  stores_count: number;
  updated_at: string | null;
  stores: MasterStoreRow[];
}

export interface MasterGroupsResponse {
  items: MasterGroup[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApplyStoreResult {
  store_id: string;
  store_name: string;
  platform: string;
  ok: boolean;
  belowCost: boolean;
  reason?: string;
  before: { price: number | null };
  after: { buyerPrice: number; priceNoDiscount: number; discountPercent: number } | null;
  sent: boolean;
}

export interface ApplyGroupResult {
  offer_id: string;
  master_price: number;
  stores: ApplyStoreResult[];
}

export interface ApplyResponse {
  summary: {
    dry_run: boolean;
    groups: number;
    stores_sent?: number;
    stores_failed?: number;
  };
  results: ApplyGroupResult[];
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchMasterGroups(params: {
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<MasterGroupsResponse> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.search) qs.set('search', params.search);
  const res = await fetch(`/api/master-prices?${qs.toString()}`);
  return jsonOrThrow(res);
}

export async function saveMasterPrice(offerId: string, masterPrice: number): Promise<void> {
  const res = await fetch(`/api/master-prices/${encodeURIComponent(offerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ master_price: masterPrice }),
  });
  await jsonOrThrow(res);
}

export async function applyMasterPrices(
  items: { offer_id: string; master_price?: number }[],
  opts: { dry_run: boolean; allow_below_cost?: boolean }
): Promise<ApplyResponse> {
  const res = await fetch(`/api/master-prices/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, dry_run: opts.dry_run, allow_below_cost: opts.allow_below_cost || false }),
  });
  return jsonOrThrow(res);
}
