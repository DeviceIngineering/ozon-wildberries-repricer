import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AnalyticsPeriod, DecisionCockpit, DecisionTask } from '../services/ozonApi';
import { getDecisionCockpit, runRepricerNow } from '../services/ozonApi';
import TaskCard from '../components/dashboard/TaskCard';
import { LossTrend, MarginBars, ControlDonut, StoreActionBars } from '../components/dashboard/CockpitCharts';
import PriceImportModal from '../components/dashboard/PriceImportModal';
import ApiLogsModal from '../components/dashboard/ApiLogsModal';
import RepricerLogModal from '../components/dashboard/RepricerLogModal';
import { useToast } from '../contexts/ToastContext';
import { PLATFORMS } from '../lib/platforms';
import styles from './DashboardPage.module.css';

interface ModalState { storeId: string; storeName: string; platform?: string; }

const PERIODS: { key: AnalyticsPeriod; label: string }[] = [
  { key: '24h', label: '24 часа' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
];

// Источник истины — lib/platforms.
const CABINET_URL: Record<string, string> = Object.fromEntries(
  Object.entries(PLATFORMS).map(([k, m]) => [k, m.cabinetUrl])
);

const PLATFORM_CHIP: Record<string, { s: string; bg: string; fg?: string }> = Object.fromEntries(
  Object.entries(PLATFORMS).map(([k, m]) => [k, { s: m.code, bg: m.bg, fg: m.fg }])
);

function dayLabel(d: string): string {
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}` : d;
}
function timeAgo(s: string | null): string {
  if (!s) return 'никогда';
  const m = Math.floor((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

export default function DashboardPage() {
  const { showSuccess, showError } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<DecisionCockpit | null>(null);
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Локальные жёсткие окна для виджетов «по магазинам» (независимы от общего периода)
  const [corrWindow, setCorrWindow] = useState<'1d' | '7d'>('7d');
  const [promoWindow, setPromoWindow] = useState<'1d' | '7d'>('7d');

  const [importModal, setImportModal] = useState<ModalState | null>(null);
  const [apiLogsModal, setApiLogsModal] = useState<ModalState | null>(null);
  const [repricerModal, setRepricerModal] = useState<ModalState | null>(null);

  const fetchData = useCallback(async (p: AnalyticsPeriod) => {
    try {
      const d = await getDecisionCockpit(p);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неизвестная ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchData(period);
    const interval = setInterval(() => { if (!cancelled) fetchData(period); }, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [fetchData, period]);

  const storeName = (id: string) => data?.automation.find((s) => s.id === id)?.name || 'Магазин';

  const handleAction = async (task: DecisionTask, storeId: string) => {
    const st = task.byStore.find((s) => s.store_id === storeId);
    const platform = st?.platform || 'ozon';
    switch (task.action.kind) {
      case 'import':
        setImportModal({ storeId, storeName: storeName(storeId), platform });
        break;
      case 'cabinet':
        window.open(CABINET_URL[platform] || CABINET_URL.ozon, '_blank', 'noopener');
        break;
      case 'repricer':
        try { await runRepricerNow(storeId); showSuccess('Репрайсер запущен'); fetchData(period); }
        catch { showError('Ошибка запуска репрайсера'); }
        break;
      case 'logs':
        setApiLogsModal({ storeId, storeName: storeName(storeId) });
        break;
      case 'drill':
      default:
        navigate(`/store/${storeId}${task.filter ? `?filter=${task.filter}` : ''}`);
    }
  };

  const handleDrill = (storeId: string, filter: string | null) => {
    navigate(`/store/${storeId}${filter ? `?filter=${filter}` : ''}`);
  };

  const marginBuckets = useMemo(() => {
    const m = data?.analytics.margin;
    return [
      { label: 'Убыток', value: m?.loss || 0, color: '#DC2626' },
      { label: '0–5%', value: m?.b0 || 0, color: '#F59E0B' },
      { label: '5–15%', value: m?.b5 || 0, color: '#3B82F6' },
      { label: '15–30%', value: m?.b15 || 0, color: '#2563EB' },
      { label: '30%+', value: m?.b30 || 0, color: '#16A34A' },
    ];
  }, [data]);

  const correctionBars = useMemo(() => {
    return (data?.automation || []).map((s) => {
      const c = PLATFORM_CHIP[s.platform] || PLATFORM_CHIP.ozon;
      const value = corrWindow === '1d' ? s.corrected_1d : s.corrected_7d;
      return { id: s.id, name: s.name, value: value || 0, color: c.bg, enabled: !!s.repricer_enabled };
    });
  }, [data, corrWindow]);

  const promoExitBars = useMemo(() => {
    return (data?.automation || []).map((s) => {
      const c = PLATFORM_CHIP[s.platform] || PLATFORM_CHIP.ozon;
      const value = promoWindow === '1d' ? s.promo_exited_1d : s.promo_exited_7d;
      return { id: s.id, name: s.name, value: value || 0, color: c.bg, enabled: !!s.promo_exit_enabled };
    });
  }, [data, promoWindow]);

  const controlSegments = useMemo(() => {
    const c = data?.analytics.control;
    return [
      { name: 'РРЦ (под контролем)', value: c?.rrc || 0, color: '#16A34A' },
      { name: 'В акциях', value: c?.promo || 0, color: '#3B82F6' },
    ];
  }, [data]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Кокпит решений</h1>
          <p className={styles.subtitle}>Репрайсер · Ozon · Яндекс.Маркет · Wildberries</p>
        </div>
        <div className={styles.periodSelector}>
          {PERIODS.map((p) => (
            <button key={p.key} className={`${styles.periodBtn} ${period === p.key ? styles.periodActive : ''}`} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {loading && !data && <div className={styles.loading}><span className={styles.spinner} /> Загрузка…</div>}
      {error && !data && <div className={styles.error}>Не удалось загрузить: {error}</div>}

      {data && (
        <>
          {/* LAYER 1 — Требуют решения */}
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionTitleWrap}>
                <span className={`${styles.sectionIcon} ${styles.iconDanger}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>
                </span>
                <div>
                  <h2 className={styles.sectionTitle}>Требуют решения</h2>
                  <p className={styles.sectionSub}>
                    {data.tasks.length} задач
                    {data.totalRisk > 0 && <> · <span className={styles.riskTotal}>≈ {data.totalRisk.toLocaleString('ru-RU')} ₽{data.moneyKind === 'per_day' ? '/день' : ''}</span> на кону</>}
                  </p>
                </div>
              </div>
            </div>
            {data.tasks.length === 0 ? (
              <div className={styles.allClear}>✓ Нет задач, требующих вмешательства — всё под контролем автоматики</div>
            ) : (
              <div className={styles.taskGrid}>
                {data.tasks.map((t) => (
                  <TaskCard key={t.id} task={t} onAction={handleAction} onDrill={handleDrill} />
                ))}
              </div>
            )}
          </section>

          {/* LAYER 2 — Под контролем автоматики */}
          <section className={styles.section}>
            <div className={styles.autoCard}>
              <div className={styles.autoHead}>
                <div className={styles.sectionTitleWrap}>
                  <span className={`${styles.sectionIcon} ${styles.iconOk}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" /></svg>
                  </span>
                  <h2 className={styles.autoTitle}>Под контролем автоматики</h2>
                </div>
                <span className={styles.autoNote}>робот держит цены сам · вмешательство не требуется</span>
              </div>
              <div className={styles.autoGrid}>
                {data.automation.map((s) => {
                  const c = PLATFORM_CHIP[s.platform] || PLATFORM_CHIP.ozon;
                  return (
                    <div key={s.id} className={styles.autoStore}>
                      <span className={styles.chip} style={{ background: c.bg, color: c.fg || '#fff' }}>{c.s}</span>
                      <div>
                        <div className={styles.autoName}>{s.name}</div>
                        <div className={s.repricer_enabled ? styles.autoMeta : styles.autoMetaWarn}>
                          {s.repricer_enabled ? `${timeAgo(s.last_repricer_run)} · ${s.held} на РРЦ` : 'репрайсер выкл'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* LAYER 3 — Аналитика для решений */}
          <section className={styles.section}>
            <div className={styles.sectionTitleWrap} style={{ marginBottom: 14 }}>
              <span className={`${styles.sectionIcon} ${styles.iconPrimary}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M7 14l3-4 4 3 4-6" /></svg>
              </span>
              <h2 className={styles.analyticsTitle}>Аналитика для решений <span className={styles.analyticsHint}>— оценивает человек, не автомат</span></h2>
            </div>
            <div className={styles.analyticsGrid}>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Динамика риска</h3>
                <p className={styles.panelSub}>пропуски репрайсера по дням · тренд ↓ — хорошо</p>
                <LossTrend labels={data.analytics.lossTrend.map((d) => dayLabel(d.day))} data={data.analytics.lossTrend.map((d) => d.cnt)} />
              </div>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Маржинальность портфеля</h3>
                <p className={styles.panelSub}>распределение SKU по марже к полу</p>
                <MarginBars buckets={marginBuckets} />
              </div>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Под чьим контролем цена</h3>
                <p className={styles.panelSub}>товары: РРЦ vs участие в акциях</p>
                <ControlDonut segments={controlSegments} />
              </div>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Коррекции цен по магазинам</h3>
                  <div className={styles.winToggle}>
                    <button className={`${styles.winBtn} ${corrWindow === '1d' ? styles.winActive : ''}`} onClick={() => setCorrWindow('1d')}>1 день</button>
                    <button className={`${styles.winBtn} ${corrWindow === '7d' ? styles.winActive : ''}`} onClick={() => setCorrWindow('7d')}>7 дней</button>
                  </div>
                </div>
                <p className={styles.panelSub}>робот менял цену за {corrWindow === '1d' ? 'сутки' : '7 дней'} · резкое падение у активного магазина = проверь его</p>
                <StoreActionBars
                  bars={correctionBars}
                  onBarClick={(id) => {
                    const st = data.automation.find((s) => s.id === id);
                    if (st) setRepricerModal({ storeId: st.id, storeName: st.name, platform: st.platform });
                  }}
                />
              </div>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Вывод из акций по магазинам</h3>
                  <div className={styles.winToggle}>
                    <button className={`${styles.winBtn} ${promoWindow === '1d' ? styles.winActive : ''}`} onClick={() => setPromoWindow('1d')}>1 день</button>
                    <button className={`${styles.winBtn} ${promoWindow === '7d' ? styles.winActive : ''}`} onClick={() => setPromoWindow('7d')}>7 дней</button>
                  </div>
                </div>
                <p className={styles.panelSub}>робот выводил товары из акций за {promoWindow === '1d' ? 'сутки' : '7 дней'} · резкое падение у активного магазина = проверь его</p>
                <StoreActionBars
                  bars={promoExitBars}
                  emptyText="За период из акций никого не выводили"
                  onBarClick={(id) => {
                    const st = data.automation.find((s) => s.id === id);
                    if (st) setRepricerModal({ storeId: st.id, storeName: st.name, platform: st.platform });
                  }}
                />
              </div>
            </div>
          </section>
        </>
      )}

      {importModal && <PriceImportModal storeId={importModal.storeId} storeName={importModal.storeName} platform={importModal.platform} onClose={() => setImportModal(null)} />}
      {apiLogsModal && <ApiLogsModal storeId={apiLogsModal.storeId} storeName={apiLogsModal.storeName} onClose={() => setApiLogsModal(null)} />}
      {repricerModal && <RepricerLogModal storeId={repricerModal.storeId} storeName={repricerModal.storeName} onClose={() => setRepricerModal(null)} />}
    </div>
  );
}
