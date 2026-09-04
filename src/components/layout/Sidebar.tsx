import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useStores } from '../../contexts/StoreContext';
import { useSession } from '../../lib/auth-client';
import { hasPermission } from '../../lib/permissions';
import type { DashboardSummary } from '../../services/ozonApi';
import PlatformBadge from '../PlatformBadge';
import styles from './Sidebar.module.css';

type StoreStatus = 'critical' | 'warning' | 'ok';

function getStoreStatus(
  storeId: string,
  summary: DashboardSummary | null
): StoreStatus {
  if (!summary) return 'ok';
  const s = summary.stores.find((st) => st.id === storeId);
  if (!s) return 'ok';
  if (s.quarantine_count > 0 || s.price_rejected_count > 0) return 'critical';
  if (s.promo_below_cost_count > 0) return 'warning';
  return 'ok';
}

export default function Sidebar() {
  const { stores } = useStores();
  const { data: session } = useSession();
  const role = session?.user?.role as string | undefined;
  const canRepricer = hasPermission(role, 'repricer');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchSummary() {
      try {
        const res = await fetch('/api/dashboard/summary');
        if (!res.ok) return;
        const data: DashboardSummary = await res.json();
        if (!cancelled) setSummary(data);
      } catch {
        // ignore errors in sidebar
      }
    }
    fetchSummary();
    const interval = setInterval(fetchSummary, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <aside className={styles.sidebar}>
      <nav className={styles.nav}>
        {canRepricer && stores.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Магазины</div>
            {stores.map((store) => {
              const status = getStoreStatus(store.id, summary);
              return (
                <NavLink
                  key={store.id}
                  to={`/store/${store.id}`}
                  className={({ isActive }) =>
                    `${styles.navItem} ${isActive ? styles.active : ''}`
                  }
                >
                  <span
                    className={`${styles.dot} ${styles[`dot_${status}`]}`}
                    title={
                      status === 'critical'
                        ? 'Критические проблемы'
                        : status === 'warning'
                          ? 'Предупреждения'
                          : 'Всё в порядке'
                    }
                  />
                  <span className={styles.navLabel}>
                    {store.name}
                    <PlatformBadge platform={store.platform} style={{ marginLeft: 6, verticalAlign: 'middle' }} />
                  </span>
                </NavLink>
              );
            })}
          </div>
        )}
        {canRepricer && (
          <NavLink
            to="/master-prices"
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ''}`
            }
          >
            <span className={styles.navIcon}>&#128181;</span>
            <span className={styles.navLabel}>Управление ценами</span>
          </NavLink>
        )}
        {canRepricer && (
          <NavLink
            to="/strategies"
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ''}`
            }
          >
            <span className={styles.navIcon}>&#127919;</span>
            <span className={styles.navLabel}>Стратегии</span>
          </NavLink>
        )}
        <NavLink
          to="/docs"
          className={({ isActive }) =>
            `${styles.navItem} ${isActive ? styles.active : ''}`
          }
        >
          <span className={styles.navIcon}>📖</span>
          <span className={styles.navLabel}>Документация</span>
        </NavLink>
      </nav>
    </aside>
  );
}
