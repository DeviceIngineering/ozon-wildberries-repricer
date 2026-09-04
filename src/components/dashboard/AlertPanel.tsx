import { useNavigate } from 'react-router-dom';
import type { DashboardSummary } from '../../services/ozonApi';
import styles from './AlertPanel.module.css';

interface Alert {
  priority: 'critical' | 'warning' | 'info';
  storeId: string;
  storeName: string;
  count: number;
  description: string;
  filter: string;
  icon: string;
}

interface AlertPanelProps {
  summary: DashboardSummary;
}

function buildAlerts(summary: DashboardSummary): Alert[] {
  const alerts: Alert[] = [];
  for (const store of summary.stores) {
    if (store.quarantine_count > 0) {
      alerts.push({
        priority: 'critical',
        storeId: store.id,
        storeName: store.name,
        count: store.quarantine_count,
        description: 'товаров на карантине',
        filter: 'quarantine',
        icon: '🚫',
      });
    }
    if (store.price_rejected_count > 0) {
      alerts.push({
        priority: 'critical',
        storeId: store.id,
        storeName: store.name,
        count: store.price_rejected_count,
        description: 'цен отклонено',
        filter: 'price_rejected',
        icon: '❌',
      });
    }
    if (store.promo_below_cost_count > 0) {
      alerts.push({
        priority: 'warning',
        storeId: store.id,
        storeName: store.name,
        count: store.promo_below_cost_count,
        description: 'промо ниже себестоимости',
        filter: 'promo_below_cost',
        icon: '⚠️',
      });
    }
    if (store.invisible_count > 0) {
      alerts.push({
        priority: 'info',
        storeId: store.id,
        storeName: store.name,
        count: store.invisible_count,
        description: 'товаров скрыто',
        filter: 'invisible',
        icon: '👁',
      });
    }
  }
  return alerts;
}

const PRIORITY_LABEL: Record<Alert['priority'], string> = {
  critical: 'Критические',
  warning: 'Предупреждения',
  info: 'Информация',
};

export default function AlertPanel({ summary }: AlertPanelProps) {
  const navigate = useNavigate();
  const alerts = buildAlerts(summary);

  if (alerts.length === 0) {
    return (
      <div className={styles.allOk}>
        <span className={styles.okIcon}>✅</span>
        <span>Все в порядке — проблем не обнаружено</span>
      </div>
    );
  }

  const priorities: Alert['priority'][] = ['critical', 'warning', 'info'];

  return (
    <div className={styles.panel}>
      {priorities.map((priority) => {
        const group = alerts.filter((a) => a.priority === priority);
        if (group.length === 0) return null;
        return (
          <div key={priority} className={`${styles.group} ${styles[priority]}`}>
            <div className={styles.groupTitle}>{PRIORITY_LABEL[priority]}</div>
            <div className={styles.alertList}>
              {group.map((alert, idx) => (
                <button
                  key={idx}
                  className={styles.alertItem}
                  onClick={() =>
                    navigate(`/store/${alert.storeId}?filter=${alert.filter}`)
                  }
                >
                  <span className={styles.alertIcon}>{alert.icon}</span>
                  <span className={styles.alertStore}>{alert.storeName}</span>
                  <span className={styles.alertCount}>{alert.count}</span>
                  <span className={styles.alertDesc}>{alert.description}</span>
                  <span className={styles.alertArrow}>→</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
