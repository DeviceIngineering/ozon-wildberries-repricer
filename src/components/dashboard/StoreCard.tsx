import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { DashboardSummary } from '../../services/ozonApi';
import Tooltip from '../ui/Tooltip';
import styles from './StoreCard.module.css';

type StoreData = DashboardSummary['stores'][number];

interface StoreCardProps {
  store: StoreData;
  onImportPrices: (storeId: string) => void;
  onViewHistory: (storeId: string) => void;
  onViewApiLogs: (storeId: string) => void;
  onViewRepricerLogs: (storeId: string) => void;
  onRunRepricer?: (storeId: string) => Promise<void>;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Никогда';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} дн`;
}

function ageMinutes(dateStr: string | null): number {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export default function StoreCard({ store, onImportPrices, onViewHistory, onViewApiLogs, onViewRepricerLogs, onRunRepricer }: StoreCardProps) {
  const navigate = useNavigate();
  const [repricerRunning, setRepricerRunning] = useState(false);

  const hasCritical = store.quarantine_count > 0 || store.price_rejected_count > 0;
  const hasWarning = store.promo_below_cost_count > 0;

  const stopProp = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  // Repricer health calculations
  const syncAgeMin = ageMinutes(store.last_sync);
  const repricerAgeMin = ageMinutes(store.last_repricer_run);
  const expectedIntervalMin = store.repricer_interval_min || 15;

  // Sync freshness: green <10min, yellow <60min, red otherwise
  const syncFresh = syncAgeMin < 10;
  const syncOld = syncAgeMin >= 60;

  // Repricer running on time?
  const repricerLate = store.repricer_enabled && repricerAgeMin > expectedIntervalMin * 2 + 5;

  // Price confidence: red if non-promo products sell below ref, yellow if promo products below ref
  const hasUnexpectedDrop = (store.below_ref_other_count ?? 0) > 0;
  const hasPromoDrop = (store.below_ref_promo_count ?? 0) > 0;
  const hasVerifyFail = (store.verified_fail_count ?? 0) > 0;

  const noRef = (store.ref_price_count ?? 0) === 0;

  return (
    <div
      className={`${styles.card} ${hasCritical ? styles.cardCritical : hasWarning ? styles.cardWarning : ''}`}
      onClick={() => navigate(`/store/${store.id}`)}
    >
      <div className={styles.header}>
        <span className={styles.storeName}>{store.name}</span>
        <span className={styles.productCount}>
          {store.product_count} товаров
        </span>
      </div>

      <div className={styles.badges}>
        {store.quarantine_count > 0 && (
          <span className={`${styles.badge} ${styles.badgeDanger}`}>
            🚫 {store.quarantine_count} карантин
          </span>
        )}
        {store.price_rejected_count > 0 && (
          <span className={`${styles.badge} ${styles.badgeDanger}`}>
            ❌ {store.price_rejected_count} цены отклонены
          </span>
        )}
        {store.promo_below_cost_count > 0 && (
          <span className={`${styles.badge} ${styles.badgeWarning}`}>
            ⚠️ {store.promo_below_cost_count} промо ниже себестоимости
          </span>
        )}
        {store.invisible_count > 0 && (
          <span className={`${styles.badge} ${styles.badgeInfo}`}>
            👁 {store.invisible_count} скрыто
          </span>
        )}
        {store.quarantine_count === 0 &&
          store.price_rejected_count === 0 &&
          store.promo_below_cost_count === 0 &&
          store.invisible_count === 0 && (
            <span className={`${styles.badge} ${styles.badgeOk}`}>
              ✅ Всё в порядке
            </span>
          )}
      </div>

      {/* Repricer health panel */}
      {store.repricer_enabled ? (
        <div className={`${styles.repricerPanel} ${hasUnexpectedDrop || hasVerifyFail ? styles.repricerPanelAlert : ''}`}>
          <div className={styles.repricerHeader}>
            <span className={styles.repricerTitle}>Репрайсер</span>
            <span className={styles.repricerMeta}>
              <span className={`${styles.dot} ${syncFresh ? styles.dotGreen : syncOld ? styles.dotRed : styles.dotYellow}`} />
              Данные: {timeAgo(store.last_sync)} назад
              {repricerLate && <span className={styles.repricerWarnTag}> · запаздывает</span>}
            </span>
          </div>
          <div className={styles.repricerGrid}>

            {/* Ref price coverage */}
            <div className={styles.repricerStat}>
              <span className={styles.repricerLabel}>Эталоны</span>
              <span className={`${styles.repricerValue} ${noRef ? styles.repricerValueDanger : styles.repricerValueMuted}`}>
                {noRef ? '⚠ не заданы' : `${store.ref_price_count} / ${store.product_count}`}
              </span>
            </div>

            {/* Verification failures */}
            <div className={styles.repricerStat}>
              <span className={styles.repricerLabel}>Не применилось</span>
              <span className={`${styles.repricerValue} ${hasVerifyFail ? styles.repricerValueDanger : styles.repricerValueOk}`}>
                {hasVerifyFail ? `${store.verified_fail_count} ❌` : '0 ✓'}
              </span>
            </div>

            {/* Promo products */}
            <div className={styles.repricerStat}>
              <span className={styles.repricerLabel}>Промо Озон</span>
              <span className={`${styles.repricerValue} ${styles.repricerValueMuted}`}>
                {store.promo_count} тов.
              </span>
            </div>

            {/* Prices below ref */}
            <div className={styles.repricerStat}>
              <span className={styles.repricerLabel}>Ниже эталона</span>
              <span className={`${styles.repricerValue} ${hasUnexpectedDrop ? styles.repricerValueDanger : hasPromoDrop ? styles.repricerValueWarn : styles.repricerValueOk}`}>
                {hasUnexpectedDrop
                  ? `${store.below_ref_other_count} ❌`
                  : hasPromoDrop
                    ? `${store.below_ref_promo_count} промо`
                    : '0 ✓'}
              </span>
            </div>

            {/* Prices below floor */}
            {(store.below_floor_count || 0) > 0 && (
              <div className={styles.repricerStat}>
                <span className={styles.repricerLabel}>Ниже пола</span>
                <Tooltip text="Товары, у которых min_price ниже ценового пола. Репрайсер исправит при следующем запуске." position="top">
                  <span className={`${styles.repricerValue} ${styles.repricerValueDanger}`}>
                    {store.below_floor_count} ⚠
                  </span>
                </Tooltip>
              </div>
            )}

          </div>
        </div>
      ) : null}

      <div className={styles.actions}>
        <button className={styles.actionBtn} onClick={stopProp(() => onImportPrices(store.id))} title="Загрузить цены">
          📥
        </button>
        <button className={styles.actionBtn} onClick={stopProp(() => onViewHistory(store.id))} title="История цен">
          📋
        </button>
        <button className={styles.actionBtn} onClick={stopProp(() => onViewApiLogs(store.id))} title="API логи">
          📡
        </button>
        {store.repricer_enabled ? (
          <button className={styles.actionBtn} onClick={stopProp(() => onViewRepricerLogs(store.id))} title="Repricer логи">
            🔄
          </button>
        ) : null}
        {store.repricer_enabled && onRunRepricer ? (
          <button
            className={styles.actionBtn}
            disabled={repricerRunning}
            title={repricerRunning ? 'Репрайсер запущен...' : 'Запустить репрайсер'}
            onClick={stopProp(async () => {
              setRepricerRunning(true);
              try { await onRunRepricer(store.id); } finally { setRepricerRunning(false); }
            })}
          >
            {repricerRunning ? '⏳' : '▶'}
          </button>
        ) : null}
      </div>

      <div className={styles.footer}>
        <span className={styles.syncLabel}>Синхронизация:</span>
        <span className={styles.syncTime}>{timeAgo(store.last_sync)} назад</span>
      </div>
    </div>
  );
}
