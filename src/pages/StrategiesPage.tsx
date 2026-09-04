import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStores } from '../contexts/StoreContext';
import { useToast } from '../contexts/ToastContext';
import PlatformBadge from '../components/PlatformBadge';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import {
    getOverview, getLog, pilotAuto, setExperimentAuto, setStoreKillSwitch, setGlobalKillSwitch, runStrategy, assignStrategy,
    STRATEGY_LABELS, type StrategyOverviewRow, type StrategyLogRow,
} from '../services/strategiesApi';
import styles from './StrategiesPage.module.css';

const STRATEGIES = ['max_profit', 'max_revenue', 'max_units', 'liquidation'];

export default function StrategiesPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { stores } = useStores();
    const { showSuccess, showError } = useToast();

    const storeId = id || stores[0]?.id;
    const store = stores.find(s => s.id === storeId);

    const [overview, setOverview] = useState<StrategyOverviewRow[]>([]);
    const [log, setLog] = useState<StrategyLogRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [pilotStrategy, setPilotStrategy] = useState('max_profit');
    const [pilotLimit, setPilotLimit] = useState(20);

    const load = useCallback(async () => {
        if (!storeId) return;
        setLoading(true);
        try {
            const [ov, lg] = await Promise.all([getOverview(storeId), getLog(storeId, 100)]);
            setOverview(ov); setLog(lg);
        } catch (e: any) {
            showError(e?.response?.data?.error || 'Ошибка загрузки');
        } finally { setLoading(false); }
    }, [storeId, showError]);

    useEffect(() => { load(); }, [load]);

    const handlePilot = async () => {
        if (!storeId) return;
        try {
            const r = await pilotAuto(storeId, { strategy_type: pilotStrategy, limit: pilotLimit, window_days: 30 });
            showSuccess(`Назначено товаров: ${r.assigned} (топ по продажам)`);
            load();
        } catch (e: any) { showError(e?.response?.data?.error || 'Нужна история продаж'); }
    };

    const toggleAuto = async (offer: string, on: boolean) => {
        if (!storeId) return;
        try { await setExperimentAuto(storeId, offer, on); load(); }
        catch (e: any) { showError(e?.response?.data?.error || 'Ошибка'); }
    };

    const removeStrategy = async (offer: string) => {
        if (!storeId) return;
        try { await assignStrategy(storeId, [offer], { strategy_type: 'ref_price' }); showSuccess('Стратегия снята'); load(); }
        catch { showError('Ошибка'); }
    };

    const handleRun = async () => {
        if (!storeId) return;
        try { const r = await runStrategy(storeId); showSuccess(`Прогон: товаров ${r.result?.count ?? 0}, применено ${r.result?.applied ?? 0}`); load(); }
        catch (e: any) { showError(e?.response?.data?.error || 'Ошибка прогона'); }
    };

    // Остановка ценообразования — необратимое для текущего цикла действие:
    // до снятия стопа цены не двигаются ни здесь, ни по расписанию.
    const [killConfirm, setKillConfirm] = useState<null | 'store' | 'global'>(null);

    const handleStoreKill = async (on: boolean) => {
        if (!storeId) return;
        try { await setStoreKillSwitch(storeId, on); showSuccess(on ? 'Магазин остановлен' : 'Магазин активен'); }
        catch { showError('Ошибка'); }
    };
    const handleGlobalKill = async (on: boolean) => {
        try { await setGlobalKillSwitch(on); showSuccess(on ? 'ГЛОБАЛЬНО остановлено' : 'Глобально активно'); }
        catch { showError('Ошибка'); }
    };
    const confirmKill = () => {
        const scope = killConfirm;
        setKillConfirm(null);
        if (scope === 'store') handleStoreKill(true);
        if (scope === 'global') handleGlobalKill(true);
    };

    const fmt = (v: any) => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));

    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <h1>Ценовые стратегии {store ? `— ${store.name}` : ''}</h1>
                <div className={styles.storeSwitch}>
                    {stores.map(s => (
                        <button key={s.id}
                            className={`${styles.storeBtn} ${s.id === storeId ? styles.storeBtnActive : ''}`}
                            onClick={() => navigate(`/strategies/${s.id}`)}>
                            <PlatformBadge platform={s.platform} />
                            {s.name}
                        </button>
                    ))}
                </div>
            </div>

            <div className={styles.banner}>
                Эксперимент по умолчанию в режиме <b>dry-run</b>: движок только предлагает цену (лог ниже),
                цены НЕ меняются, пока не включишь «Авто» на товаре. Floor (безубыточность) — жёсткий низ.
            </div>

            {/* Управление */}
            <div className={styles.controls}>
                <div className={styles.controlBlock}>
                    <label>Пилот: авто-выбор топ-N по продажам</label>
                    <div className={styles.row}>
                        <select value={pilotStrategy} onChange={e => setPilotStrategy(e.target.value)}>
                            {STRATEGIES.map(s => <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>)}
                        </select>
                        <input type="number" min={1} max={100} value={pilotLimit}
                            onChange={e => setPilotLimit(Number(e.target.value))} style={{ width: 70 }} />
                        <button className={styles.primary} onClick={handlePilot}>Выбрать пилот</button>
                    </div>
                </div>
                <div className={styles.controlBlock}>
                    <label>Управление</label>
                    <div className={styles.row}>
                        <button onClick={handleRun}>Прогнать сейчас (dry-run)</button>
                        <button className={styles.danger} onClick={() => setKillConfirm('store')}>Стоп магазин</button>
                        <button onClick={() => handleStoreKill(false)}>Снять стоп</button>
                        <button className={styles.danger} onClick={() => setKillConfirm('global')}>СТОП ВСЁ</button>
                        <button onClick={() => handleGlobalKill(false)}>Снять глоб.</button>
                    </div>
                </div>
            </div>

            {/* Товары в эксперименте */}
            <h2>Товары в эксперименте ({overview.length})</h2>
            {loading ? <div className={styles.muted}>Загрузка…</div> : overview.length === 0 ? (
                <div className={styles.muted}>Нет товаров в эксперименте. Выбери пилот выше (нужна история продаж — собирается ежедневно).</div>
            ) : (
                <table className={styles.table}>
                    <thead><tr>
                        <th>Артикул</th><th>Стратегия</th><th>Текущая</th><th>Лучшая</th>
                        <th>Предложение</th><th>Действие/причина</th><th>Авто</th><th></th>
                    </tr></thead>
                    <tbody>
                        {overview.map(o => (
                            <tr key={o.offer_id}>
                                <td><b>{o.offer_id}</b><br /><span className={styles.muted}>{o.name?.slice(0, 28)}</span></td>
                                <td>{STRATEGY_LABELS[o.strategy_type] || o.strategy_type}</td>
                                <td>{fmt(o.current_price ?? o.cur_price)}</td>
                                <td>{fmt(o.best_price)}</td>
                                <td>{fmt(o.last_proposed)}</td>
                                <td><span className={styles.muted}>{o.last_action || '—'}</span><br />{o.last_reason?.slice(0, 40)}</td>
                                <td>
                                    <button className={o.auto_apply ? styles.autoOn : styles.autoOff}
                                        onClick={() => toggleAuto(o.offer_id, !o.auto_apply)}>
                                        {o.auto_apply ? 'ВКЛ' : 'выкл'}
                                    </button>
                                </td>
                                <td><button className={styles.linkBtn} onClick={() => removeStrategy(o.offer_id)}>снять</button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {/* Лог решений */}
            <h2>Лог решений ({log.length})</h2>
            <table className={styles.table}>
                <thead><tr><th>Время</th><th>Артикул</th><th>Действие</th><th>Старая→Новая</th><th>Метрика</th><th>Причина</th><th>Прим.</th></tr></thead>
                <tbody>
                    {log.map((l, i) => (
                        <tr key={i}>
                            <td className={styles.muted}>{new Date(l.timestamp).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                            <td>{l.offer_id}</td>
                            <td>{l.action}</td>
                            <td>{fmt(l.old_price)} → {fmt(l.new_price)}</td>
                            <td>{l.metric_value != null ? Number(l.metric_value).toFixed(0) : '—'}</td>
                            <td className={styles.muted}>{l.reason?.slice(0, 50)}</td>
                            <td>{l.applied ? '✅' : '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <ConfirmDialog
                isOpen={killConfirm !== null}
                title={killConfirm === 'global' ? 'Остановить ценообразование во всех магазинах?' : 'Остановить ценообразование в этом магазине?'}
                message={killConfirm === 'global'
                    ? 'Стратегии перестанут двигать цены во ВСЕХ магазинах, включая запуски по расписанию. Уже отправленные цены останутся как есть. Снять стоп можно кнопкой «Снять глоб.».'
                    : 'Стратегии перестанут двигать цены в этом магазине, включая запуски по расписанию. Уже отправленные цены останутся как есть. Снять стоп можно кнопкой «Снять стоп».'}
                confirmText={killConfirm === 'global' ? 'Остановить всё' : 'Остановить магазин'}
                cancelText="Отмена"
                variant="danger"
                onConfirm={confirmKill}
                onCancel={() => setKillConfirm(null)}
            />
        </div>
    );
}
