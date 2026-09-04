import { createContext, useContext, useReducer, useCallback, useMemo, useRef, useEffect } from 'react';

export interface Store {
  id: string;
  name: string;
  client_id: string;
  api_key: string;
  update_interval_minutes: number;
  last_updated_at: string | null;
  antiban_enabled: number;
  repricer_enabled: number;
  repricer_interval_min?: number;
  threshold_drop_percent?: number;
  threshold_rise_percent?: number;
  last_repricer_run?: string | null;
  monitor_interval_min?: number;
  last_monitor_run?: string | null;
  platform?: string;
  ym_business_id?: string;
  ym_campaign_id?: string;
  ym_api_key?: string;
  wb_api_key?: string;
  tax_rate?: number;
  min_margin_percent?: number;
  promo_guard_enabled?: number;
  promo_exit_enabled?: number;
  promo_allowed_actions?: string;
  promo_max_discount_percent?: number;
  last_promo_exit_run?: string;
  ym_boost_cap_percent?: number;
  ym_floor_max_raise_percent?: number;
  ym_promo_exit_enabled?: number;
}

interface StoreState {
  stores: Store[];
  activeStoreId: string | null;
  isLoading: boolean;
}

type StoreAction =
  | { type: 'SET_STORES'; stores: Store[] }
  | { type: 'SET_ACTIVE_STORE'; id: string | null }
  | { type: 'SET_LOADING'; isLoading: boolean };

function storeReducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case 'SET_STORES':
      return { ...state, stores: action.stores };
    case 'SET_ACTIVE_STORE':
      return { ...state, activeStoreId: action.id };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    default:
      return state;
  }
}

interface StoreContextValue {
  stores: Store[];
  activeStoreId: string | null;
  activeStore: Store | null;
  isLoading: boolean;
  setActiveStore: (id: string) => void;
  loadStores: () => Promise<void>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(storeReducer, {
    stores: [],
    activeStoreId: null,
    isLoading: false,
  });

  // Ref to track current activeStoreId without adding it as a dependency
  const activeStoreIdRef = useRef<string | null>(null);
  activeStoreIdRef.current = state.activeStoreId;

  const setActiveStore = useCallback((id: string) => {
    dispatch({ type: 'SET_ACTIVE_STORE', id });
  }, []);

  const loadStores = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', isLoading: true });
    try {
      const res = await fetch('/api/stores');
      if (!res.ok) throw new Error('Не удалось загрузить магазины');
      const data: Store[] = await res.json();
      dispatch({ type: 'SET_STORES', stores: data });

      // Auto-select first store if no active store is currently set
      if (data.length > 0 && activeStoreIdRef.current === null) {
        dispatch({ type: 'SET_ACTIVE_STORE', id: data[0].id });
      }
    } catch (err) {
      console.error('Ошибка загрузки магазинов:', err);
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false });
    }
  }, []);

  // Auto-load stores on mount
  useEffect(() => {
    loadStores();
  }, [loadStores]);

  const activeStore = useMemo(
    () => state.stores.find((s) => s.id === state.activeStoreId) ?? null,
    [state.stores, state.activeStoreId]
  );

  return (
    <StoreContext.Provider
      value={{
        stores: state.stores,
        activeStoreId: state.activeStoreId,
        activeStore,
        isLoading: state.isLoading,
        setActiveStore,
        loadStores,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStores(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error('useStores must be used within StoreProvider');
  }
  return ctx;
}
