import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DecisionTask } from '../../services/ozonApi';
import styles from './TaskCard.module.css';
import { PLATFORMS } from '../../lib/platforms';

// Цвета/коды из единого источника lib/platforms (форма {s,bg,fg} сохранена для разметки ниже).
const PLATFORM_CHIP: Record<string, { s: string; bg: string; fg?: string }> = Object.fromEntries(
  Object.entries(PLATFORMS).map(([k, m]) => [k, { s: m.code, bg: m.bg, fg: m.fg }])
);

function fmtRub(v: number): string {
  return v.toLocaleString('ru-RU');
}

interface Props {
  task: DecisionTask;
  onAction: (task: DecisionTask, storeId: string) => void;
  onDrill: (storeId: string, filter: string | null) => void;
}

export default function TaskCard({ task, onAction, onDrill }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const stores = [...task.byStore].sort((a, b) => b.count - a.count);
  const primaryStore = stores[0];
  const platforms = Array.from(new Set(stores.map((s) => s.platform)));

  return (
    <article className={`${styles.card} ${styles[task.severity]}`}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          {platforms.map((p) => {
            const c = PLATFORM_CHIP[p] || PLATFORM_CHIP.ozon;
            return <span key={p} className={styles.chip} style={{ background: c.bg, color: c.fg || '#fff' }}>{c.s}</span>;
          })}
          <h3 className={styles.title}>{task.title}</h3>
        </div>
        <span className={`${styles.metric} ${task.severity === 'danger' ? styles.mDanger : task.severity === 'warn' ? styles.mWarn : styles.mInfo}`}>
          {task.risk > 0 ? `≈ ${fmtRub(task.risk)} ₽${task.riskKind === 'per_day' ? '/д' : ''}` : `${task.count} SKU`}
        </span>
      </div>

      <p className={styles.desc}>
        {task.desc}
        {task.example && <span className={styles.example}> Пример: <code>{task.example}</code>.</span>}
      </p>

      <div className={styles.actions}>
        <button className={styles.primaryBtn} onClick={() => onAction(task, primaryStore.store_id)}>
          {task.action.label}
        </button>
        <button className={styles.secondaryBtn} onClick={() => setOpen((o) => !o)}>
          Список SKU ({task.count}) {open ? '▲' : '▼'}
        </button>
        {task.risk > 0 && (
          <span
            className={styles.riskNote}
            title={task.riskKind === 'per_day'
              ? 'Оценка ₽/день: разрыв цены × средние дневные продажи (sales_daily, «чистые» дни).'
              : 'Оценка: сумма разрыва цены по SKU. Точный ₽/день — после накопления данных о продажах.'}
          >
            оценка ⓘ
          </span>
        )}
      </div>

      {open && (
        <div className={styles.breakdown}>
          {stores.map((s) => {
            const c = PLATFORM_CHIP[s.platform] || PLATFORM_CHIP.ozon;
            return (
              <button
                key={s.store_id}
                className={styles.storeRow}
                onClick={() => (task.filter ? onDrill(s.store_id, task.filter) : navigate(`/store/${s.store_id}`))}
              >
                <span className={styles.chipSm} style={{ background: c.bg, color: c.fg || '#fff' }}>{c.s}</span>
                <span className={styles.storeName}>{s.store_name}</span>
                <span className={styles.storeCount}>
                  {s.count} {s.risk > 0 ? `· ≈${fmtRub(s.risk)} ₽${task.riskKind === 'per_day' ? '/д' : ''}` : ''}
                </span>
                <span className={styles.storeArrow}>→</span>
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}
