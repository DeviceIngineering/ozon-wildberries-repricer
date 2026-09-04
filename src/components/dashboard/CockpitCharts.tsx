import styles from './CockpitCharts.module.css';

const GRID = '#EEF2F6';

// Линейный тренд (деньги/события под риском по дням)
export function LossTrend({ labels, data }: { labels: string[]; data: number[] }) {
  const W = 520, H = 190, padL = 38, padR = 12, padT = 12, padB = 26;
  const iW = W - padL - padR, iH = H - padT - padB;
  const n = data.length;
  if (n === 0) return <div className={styles.empty}>Нет данных за период</div>;
  const max = Math.max(1, ...data);
  const x = (i: number) => padL + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW);
  const y = (v: number) => padT + iH - (v / max) * iH;
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Тренд риска по дням">
      <defs>
        <linearGradient id="lossGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#DC2626" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#DC2626" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((t, i) => {
        const gy = padT + iH - t * iH;
        return (
          <g key={i}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke={GRID} />
            <text x={padL - 6} y={gy + 3} textAnchor="end" className={styles.axis}>{Math.round(max * t)}</text>
          </g>
        );
      })}
      <polygon points={area} fill="url(#lossGrad)" />
      <polyline points={pts} fill="none" stroke="var(--value-bad)" strokeWidth={2} strokeLinejoin="round" />
      {data.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill="var(--value-bad)" />)}
      {labels.map((lb, i) => (n <= 10 || i % Math.ceil(n / 8) === 0) && (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className={styles.axisMono}>{lb}</text>
      ))}
    </svg>
  );
}

// Вертикальные столбцы распределения маржи
export function MarginBars({ buckets }: { buckets: { label: string; value: number; color: string }[] }) {
  const W = 520, H = 190, padL = 36, padR = 12, padT = 12, padB = 28;
  const iW = W - padL - padR, iH = H - padT - padB;
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const slot = iW / buckets.length;
  const bw = Math.min(54, slot * 0.6);
  const hasData = buckets.some((b) => b.value > 0);
  if (!hasData) return <div className={styles.empty}>Нет товаров с рассчитанным полом</div>;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Распределение маржи">
      {[0, 0.5, 1].map((t, i) => {
        const gy = padT + iH - t * iH;
        return (
          <g key={i}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke={GRID} />
            <text x={padL - 6} y={gy + 3} textAnchor="end" className={styles.axis}>{Math.round(max * t)}</text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const h = (b.value / max) * iH;
        const cx = padL + i * slot + slot / 2;
        return (
          <g key={b.label}>
            <rect x={cx - bw / 2} y={padT + iH - h} width={bw} height={h} rx={5} fill={b.color} />
            {b.value > 0 && <text x={cx} y={padT + iH - h - 5} textAnchor="middle" className={styles.barVal}>{b.value}</text>}
            <text x={cx} y={H - 9} textAnchor="middle" className={styles.axis}>{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Столбцы коррекций цен по магазинам (число corrected за период).
// Нулевой столбец у активного магазина = сигнал «притих» (детектор аномалий).
const OFF_COLOR = '#CBD5E1';
function shortName(name: string, max = 10) {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}
export function StoreActionBars({ bars, onBarClick, emptyText = 'За период цены не менялись — стабильны' }: {
  bars: { id: string; name: string; value: number; color: string; enabled: boolean }[];
  onBarClick?: (id: string) => void;
  emptyText?: string;
}) {
  const W = 520, H = 200, padL = 36, padR = 12, padT = 14, padB = 40;
  const iW = W - padL - padR, iH = H - padT - padB;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = bars.length ? iW / bars.length : iW;
  const bw = Math.min(54, slot * 0.6);
  const hasData = bars.some((b) => b.value > 0);
  if (!hasData) return <div className={styles.empty}>{emptyText}</div>;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Коррекции цен по магазинам">
      {[0, 0.5, 1].map((t, i) => {
        const gy = padT + iH - t * iH;
        return (
          <g key={i}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke={GRID} />
            <text x={padL - 6} y={gy + 3} textAnchor="end" className={styles.axis}>{Math.round(max * t)}</text>
          </g>
        );
      })}
      {bars.map((b, i) => {
        const h = (b.value / max) * iH;
        const cx = padL + i * slot + slot / 2;
        const fill = b.enabled ? b.color : OFF_COLOR;
        const clickable = !!onBarClick;
        return (
          <g key={b.id} className={clickable ? styles.barClickable : undefined}
             onClick={clickable ? () => onBarClick!(b.id) : undefined}>
            <title>{b.name}{b.enabled ? '' : ' · репрайсер выкл'} · {b.value}</title>
            {/* прозрачная зона клика на всю высоту слота */}
            <rect x={cx - slot / 2} y={padT} width={slot} height={iH} fill="transparent" />
            <rect x={cx - bw / 2} y={padT + iH - h} width={bw} height={Math.max(h, b.value > 0 ? 2 : 0)} rx={5} fill={fill} />
            <text x={cx} y={padT + iH - h - 5} textAnchor="middle"
                  className={b.value > 0 ? styles.barVal : styles.axis}>{b.value}</text>
            <text x={cx} y={H - 22} textAnchor="middle" className={styles.axis}>{shortName(b.name)}</text>
            {!b.enabled && <text x={cx} y={H - 9} textAnchor="middle" className={styles.barOff}>выкл</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Кольцевая: под чьим контролем цена
export function ControlDonut({ segments }: { segments: { name: string; value: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = 52, cx = 70, cy = 70, c = 2 * Math.PI * r;
  if (total === 0) return <div className={styles.empty}>Нет данных</div>;

  return (
    <div className={styles.donutWrap}>
      <svg viewBox="0 0 140 140" className={styles.donutSvg} role="img" aria-label="Контроль цены">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--glass-border)" strokeWidth="16" />
        {segments.map((s, i) => {
          const frac = s.value / total;
          const dash = `${c * frac} ${c}`;
          // Each arc starts where the previous ones ended. Derived from the
          // segment list rather than accumulated in a mutable variable, which
          // React forbids during render.
          const startOffset = segments
            .slice(0, i)
            .reduce((acc, prev) => acc + (c * prev.value) / total, 0);
          return (
            <circle key={s.name} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth="16"
              strokeDasharray={dash} strokeDashoffset={-startOffset} transform={`rotate(-90 ${cx} ${cy})`} />
          );
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className={styles.donutPct}>
          {Math.round((segments[0].value / total) * 100)}%
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className={styles.donutSub}>под РРЦ</text>
      </svg>
      <div className={styles.donutLegend}>
        {segments.map((s) => (
          <div key={s.name} className={styles.legendRow}>
            <span className={styles.legendDot} style={{ background: s.color }} />
            <span className={styles.legendName}>{s.name}</span>
            <span className={styles.legendVal}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
