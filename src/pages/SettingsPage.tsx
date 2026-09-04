import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStores } from '../contexts/StoreContext';
import { useToast } from '../contexts/ToastContext';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import StoreForm, { type StoreFormData } from '../components/settings/StoreForm';
import SyncLogModal from '../components/settings/SyncLogModal';
import UserManagement from '../components/settings/UserManagement';
import PlatformBadge from '../components/PlatformBadge';
import type { Store } from '../contexts/StoreContext';
import styles from './SettingsPage.module.css';

interface PromoGroup {
    action_id: number;
    title: string;
    date_start: string | null;
    date_end: string | null;
    count: number;
    potential_count?: number;
    action_type?: string | null;
    allowed?: boolean;
    frozen?: boolean;
    freeze_date?: string | null;
    min_price: number | null;
    max_price: number | null;
}

interface PromoData {
    total_products: number;
    groups: PromoGroup[];
    promo_exit_enabled?: boolean;
    promo_max_discount_percent?: number;
    last_promo_exit_run?: string | null;
}

interface DiagProbe {
    key: string;
    label: string;
    endpoint: string;
    ok: boolean | null;
    latencyMs?: number;
    statusCode?: number | null;
    hint?: string;
    note?: string;
    error?: string;
}

interface DiagDegradation {
    endpoint: string;
    lastSuccess: string;
    consecutiveErrors: number;
    lastError: string;
    affectedFunction: string | null;
}

interface DiagData {
    storeName: string;
    checkedAt: string;
    healthy: boolean;
    probes: DiagProbe[];
    degradations: DiagDegradation[];
}

interface SyncLog {
    id: number;
    store_id: string;
    started_at: string;
    completed_at?: string;
    status: string;
    items_processed: number;
    items_changed: number;
    log_text?: string;
}

interface LogDetail {
    id: number;
    timestamp: string;
    level: string;
    stage: string;
    message: string;
}

const DEFAULT_FORM: StoreFormData = {
    name: '',
    client_id: '',
    api_key: '',
    update_interval_minutes: 60,
    antiban_enabled: false,
    repricer_enabled: false,
    repricer_interval_min: 15,
    threshold_drop_percent: 5.0,
    threshold_rise_percent: 5.0,
    platform: 'ozon',
    ym_business_id: '',
    ym_campaign_id: '',
    ym_api_key: '',
    wb_api_key: '',
    tax_rate: 0,
    min_margin_percent: 0,
    promo_guard_enabled: false,
    promo_exit_enabled: false,
    promo_max_discount_percent: 5,
    ym_boost_cap_percent: 30,
    ym_floor_max_raise_percent: 20,
    ym_promo_exit_enabled: false,
};

export default function SettingsPage() {
    const navigate = useNavigate();
    const { stores, activeStoreId, loadStores } = useStores();
    const { showSuccess, showError, showProgress, dismiss } = useToast();

    const [formData, setFormData] = useState<StoreFormData>(DEFAULT_FORM);
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);

    // Confirm dialog
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

    // Logs modal
    const [showLogs, setShowLogs] = useState(false);
    const [currentLogs, setCurrentLogs] = useState<SyncLog[]>([]);
    const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
    const [logDetails, setLogDetails] = useState<LogDetail[]>([]);

    // Promo panel
    const [promoStoreId, setPromoStoreId] = useState<string | null>(null);
    const [promoData, setPromoData] = useState<PromoData | null>(null);
    const [promoLoading, setPromoLoading] = useState(false);
    const [promoExiting, setPromoExiting] = useState(false);
    const [allowedSet, setAllowedSet] = useState<Set<number>>(new Set());
    const [allowedSaving, setAllowedSaving] = useState(false);

    // Diagnostics panel
    const [diagStoreId, setDiagStoreId] = useState<string | null>(null);
    const [diagData, setDiagData] = useState<DiagData | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);

    const handleShowDiagnostics = async (storeId: string) => {
        if (diagStoreId === storeId) {
            setDiagStoreId(null);
            setDiagData(null);
            return;
        }
        setDiagStoreId(storeId);
        setDiagData(null);
        setDiagLoading(true);
        try {
            const res = await fetch(`/api/stores/${storeId}/diagnostics`, { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setDiagData(await res.json());
        } catch (e) {
            showError(`Диагностика не удалась: ${e instanceof Error ? e.message : e}`);
            setDiagStoreId(null);
        } finally {
            setDiagLoading(false);
        }
    };

    useEffect(() => {
        loadStores();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const url = isEditing && editId
            ? `/api/stores/${editId}`
            : '/api/stores';
        const method = isEditing ? 'PUT' : 'POST';

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });
            if (res.ok) {
                resetForm();
                await loadStores();
                showSuccess(isEditing ? 'Магазин обновлён' : 'Магазин добавлен');
            } else {
                const data = await res.json().catch(() => null);
                showError(data?.error || 'Ошибка сохранения магазина');
            }
        } catch {
            showError('Ошибка сети при сохранении');
        }
    };

    const handleDeleteRequest = (id: string) => {
        setPendingDeleteId(id);
        setConfirmOpen(true);
    };

    const handleDeleteConfirm = async () => {
        if (!pendingDeleteId) return;
        setConfirmOpen(false);
        try {
            await fetch(`/api/stores/${pendingDeleteId}`, { method: 'DELETE' });
            await loadStores();
            showSuccess('Магазин удалён');
        } catch {
            showError('Ошибка удаления магазина');
        } finally {
            setPendingDeleteId(null);
        }
    };

    const handleEdit = (store: Store) => {
        setFormData({
            name: store.name,
            client_id: store.client_id,
            api_key: store.api_key,
            update_interval_minutes: store.update_interval_minutes || 60,
            antiban_enabled: !!store.antiban_enabled,
            repricer_enabled: !!store.repricer_enabled,
            repricer_interval_min: store.repricer_interval_min || 15,
            threshold_drop_percent: store.threshold_drop_percent || 5.0,
            threshold_rise_percent: store.threshold_rise_percent || 5.0,
            platform: store.platform || 'ozon',
            ym_business_id: store.ym_business_id || '',
            ym_campaign_id: store.ym_campaign_id || '',
            ym_api_key: store.ym_api_key || '',
            wb_api_key: store.wb_api_key || '',
            tax_rate: store.tax_rate || 0,
            min_margin_percent: store.min_margin_percent || 0,
            promo_guard_enabled: !!store.promo_guard_enabled,
            promo_exit_enabled: !!store.promo_exit_enabled,
            promo_max_discount_percent: store.promo_max_discount_percent ?? 5,
            ym_boost_cap_percent: store.ym_boost_cap_percent ?? 30,
            ym_floor_max_raise_percent: store.ym_floor_max_raise_percent ?? 20,
            ym_promo_exit_enabled: !!store.ym_promo_exit_enabled,
        });
        setEditId(store.id);
        setIsEditing(true);
    };

    const resetForm = () => {
        setFormData(DEFAULT_FORM);
        setIsEditing(false);
        setEditId(null);
    };

    const handleSync = async (id: string) => {
        const progressId = showProgress('Запуск синхронизации...');
        try {
            const res = await fetch(`/api/stores/${id}/sync`, { method: 'POST' });
            if (res.ok) {
                dismiss(progressId);
                showSuccess('Синхронизация завершена успешно!');
                await loadStores();
            } else {
                dismiss(progressId);
                showError('Ошибка синхронизации');
            }
        } catch {
            dismiss(progressId);
            showError('Ошибка сети при синхронизации');
        }
    };

    const handleViewLogs = async (storeId: string) => {
        try {
            const res = await fetch(`/api/stores/${storeId}/logs`);
            const logs = await res.json();
            setCurrentLogs(logs);
            setExpandedLogId(null);
            setLogDetails([]);
            setShowLogs(true);
        } catch {
            showError('Ошибка загрузки логов');
        }
    };

    const toggleLogDetails = async (logId: number) => {
        if (expandedLogId === logId) {
            setExpandedLogId(null);
            return;
        }
        setExpandedLogId(logId);
        try {
            const res = await fetch(`/api/logs/${logId}/details`);
            const data = await res.json();
            setLogDetails(data);
        } catch (e) {
            console.error(e);
        }
    };

    const handleShowPromos = async (storeId: string) => {
        if (promoStoreId === storeId) {
            setPromoStoreId(null);
            setPromoData(null);
            return;
        }
        setPromoStoreId(storeId);
        setPromoData(null);
        setPromoLoading(true);
        try {
            const res = await fetch(`/api/stores/${storeId}/promos`);
            const data: PromoData = await res.json();
            setPromoData(data);
            setAllowedSet(new Set((data.groups || []).filter(g => g.allowed).map(g => g.action_id)));
        } catch {
            showError('Ошибка загрузки акций');
        } finally {
            setPromoLoading(false);
        }
    };

    const toggleAllowed = (actionId: number) => {
        setAllowedSet(prev => {
            const next = new Set(prev);
            if (next.has(actionId)) next.delete(actionId); else next.add(actionId);
            return next;
        });
    };

    const handleSaveAllowed = async () => {
        if (!promoStoreId) return;
        setAllowedSaving(true);
        try {
            const res = await fetch(`/api/stores/${promoStoreId}/allowed-promos`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allowed: [...allowedSet] }),
            });
            const data = await res.json();
            if (data.success) {
                showSuccess(`Сохранено: разрешено акций — ${data.allowed.length}.`);
                if (promoData) {
                    setPromoData({
                        ...promoData,
                        groups: promoData.groups.map(g => ({ ...g, allowed: allowedSet.has(g.action_id) })),
                    });
                }
            } else {
                showError(data.error || 'Ошибка сохранения');
            }
        } catch {
            showError('Ошибка сети');
        } finally {
            setAllowedSaving(false);
        }
    };

    // Массовый вывод из акций: необратимо и занимает до минуты.
    const [exitPromosConfirm, setExitPromosConfirm] = useState(false);

    const handleExitAllPromos = async () => {
        if (!promoStoreId || !promoData) return;
        setExitPromosConfirm(false);
        setPromoExiting(true);
        try {
            const res = await fetch(`/api/stores/${promoStoreId}/promos/exit-all`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                // Обновляем список после выхода
                setPromoLoading(true);
                const res2 = await fetch(`/api/stores/${promoStoreId}/promos`);
                const updated = await res2.json();
                setPromoData(updated);
                setPromoLoading(false);

                const parts = [`выведено: ${data.removed}`];
                if (data.rejected > 0) parts.push(`отклонено Ozon: ${data.rejected}`);
                if (data.frozen_actions?.length > 0) parts.push(`заморожено акций: ${data.frozen_actions.length} (выход невозможен до их окончания)`);
                if (data.errors?.length > 0) parts.push(`ошибок: ${data.errors.length}`);
                showSuccess(`Готово — ${parts.join(', ')}.`);
            } else {
                showError(data.error || 'Ошибка');
            }
        } catch {
            showError('Ошибка сети');
        } finally {
            setPromoExiting(false);
        }
    };

    const handleBack = () => {
        if (activeStoreId) {
            navigate(`/store/${activeStoreId}`);
        } else {
            navigate('/');
        }
    };

    return (
        <div className={styles.container}>
            <h2 className={styles.title}>Управление магазинами</h2>

            <div className={styles.navRow}>
                <button onClick={handleBack} className="text-btn">
                    &larr; Назад к товарам
                </button>
            </div>

            <>
                {/* Store List — compact grid tiles */}
                <div className={styles.storeList}>
                        {stores.map(store => (
                            <div key={store.id} className={styles.storeCard}>
                                <div className={styles.storeHeader}>
                                    <h3 className={styles.storeName}>{store.name}</h3>
                                    <PlatformBadge platform={store.platform} style={{ flexShrink: 0 }} />
                                </div>
                                <div className={styles.storeMeta}>
                                    <div className={styles.storeMetaRow}>
                                        <span>{store.platform === 'yandex' ? `Business: ${store.ym_business_id}` : store.platform === 'wildberries' ? 'Wildberries' : `ID: ${store.client_id}`}</span>
                                        <span>{store.update_interval_minutes} мин</span>
                                        <span className={store.antiban_enabled ? styles.antiBanOn : styles.antiBanOff}>
                                            {store.antiban_enabled ? 'Антибан' : ''}
                                        </span>
                                    </div>
                                    <div className={styles.lastSync}>
                                        {store.last_updated_at || 'Не синхр.'}
                                    </div>
                                </div>
                                <div className={styles.storeActions}>
                                    <button onClick={() => handleSync(store.id)} className={styles.actionBtnSync}>
                                        Sync
                                    </button>
                                    <button onClick={() => handleEdit(store)} className={styles.actionBtn}>
                                        Настр.
                                    </button>
                                    <button onClick={() => handleViewLogs(store.id)} className={styles.actionBtn}>
                                        Логи
                                    </button>
                                    {store.platform === 'ozon' && (
                                        <button
                                            onClick={() => handleShowPromos(store.id)}
                                            className={promoStoreId === store.id ? styles.actionBtnPromoActive : styles.actionBtn}
                                        >
                                            Акции
                                        </button>
                                    )}
                                    {store.platform === 'ozon' && (
                                        <button
                                            onClick={() => handleShowDiagnostics(store.id)}
                                            className={diagStoreId === store.id ? styles.actionBtnPromoActive : styles.actionBtn}
                                            title="Проверка функций репрайсера: доступность эндпоинтов Ozon API"
                                        >
                                            Тест API
                                        </button>
                                    )}
                                    <button onClick={() => handleDeleteRequest(store.id)} className={styles.actionBtnDelete}>
                                        🗑
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Promo Panel */}
                    {promoStoreId && (
                        <div className={styles.promoPanel}>
                            <div className={styles.promoPanelHeader}>
                                <span className={styles.promoPanelTitle}>
                                    Акции магазина {stores.find(s => s.id === promoStoreId)?.name}
                                </span>
                                <button onClick={() => setExitPromosConfirm(true)} className={styles.promoBtnExit} disabled={promoExiting || promoLoading || !promoData?.total_products}>
                                    {promoExiting ? 'Выходим...' : `Выйти из всех акций${promoData ? ` (${promoData.total_products} товаров)` : ''}`}
                                </button>
                            </div>
                            {promoLoading && <div className={styles.promoLoading}>Загрузка...</div>}
                            {promoExiting && (
                                <div className={styles.promoProgress}>
                                    Выходим из акций... Это может занять до минуты.
                                </div>
                            )}
                            {promoData && !promoLoading && !promoExiting && (
                                <>
                                    {promoData.promo_exit_enabled && (
                                        <div className={styles.promoExitStatus}>
                                            🤖 Автовывод включён — товары выводятся из акций фоном каждые 5 минут.
                                            {' '}Разрешённые акции (✓) сохраняются; из них выводятся только товары со скидкой больше {promoData.promo_max_discount_percent ?? 5}%.
                                            {promoData.last_promo_exit_run && ` Последний цикл: ${promoData.last_promo_exit_run.slice(0, 16).replace('T', ' ')}`}
                                        </div>
                                    )}
                                    {promoData.groups.length === 0
                                        ? <div className={styles.promoEmpty}>
                                            Товаров в акциях нет. Проверьте в <a href="https://seller.ozon.ru/app/marketing/actions" target="_blank" rel="noreferrer">кабинете Ozon</a>.
                                          </div>
                                        : <>
                                            <table className={styles.promoTable}>
                                                <thead>
                                                    <tr>
                                                        <th title="Разрешить акцию — товары из неё не выводятся (кроме скидки больше порога)">Разреш.</th>
                                                        <th>Название акции</th>
                                                        <th>Период</th>
                                                        <th title="Участвует / потенциально">Товаров</th>
                                                        <th>Цена акции</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {promoData.groups.map(g => (
                                                        <tr key={g.action_id} className={allowedSet.has(g.action_id) ? styles.promoRowAllowed : undefined}>
                                                            <td style={{ textAlign: 'center' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={allowedSet.has(g.action_id)}
                                                                    onChange={() => toggleAllowed(g.action_id)}
                                                                    title="Разрешить эту акцию"
                                                                />
                                                            </td>
                                                            <td>
                                                                {g.title}
                                                                {g.frozen && (
                                                                    <span className={styles.promoFrozenBadge} title={`Ozon заморозил акцию — выйти нельзя до ${g.date_end ? g.date_end.slice(0,10) : 'её окончания'}`}>
                                                                        🧊 заморожена
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td className={styles.promoDate}>
                                                                {g.date_start ? g.date_start.slice(0,10) : '?'} — {g.date_end ? g.date_end.slice(0,10) : '∞'}
                                                            </td>
                                                            <td><strong>{g.count}</strong>{g.potential_count ? ` / ${g.potential_count}` : ''}</td>
                                                            <td>{g.min_price ?? '—'} – {g.max_price ?? '—'} ₽</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            <div className={styles.promoPanelHeader} style={{ marginTop: 10 }}>
                                                <span className={styles.promoPanelTitle}>
                                                    Разрешено акций: {allowedSet.size}
                                                </span>
                                                <button onClick={handleSaveAllowed} className="primary-btn" disabled={allowedSaving} style={{ padding: '8px 14px' }}>
                                                    {allowedSaving ? 'Сохранение...' : 'Сохранить разрешённые'}
                                                </button>
                                            </div>
                                            <div className={styles.promoHint}>
                                                Отметьте акции, которые нужно оставить. Из неотмеченных автовывод удаляет все товары; из отмеченных — только товары со скидкой больше порога (настраивается в «Настр.» магазина).
                                                {' '}После изменений проверьте статус в <a href="https://seller.ozon.ru/app/marketing/actions" target="_blank" rel="noreferrer">кабинете Ozon</a> через 5–10 минут.
                                                {promoData.groups.some(g => g.frozen) && ' Из замороженных (🧊) акций выйти через API невозможно до их окончания.'}
                                            </div>
                                        </>
                                    }
                                </>
                            )}
                        </div>
                    )}

                    {/* Diagnostics Panel — контроль функций репрайсера */}
                    {diagStoreId && (
                        <div className={styles.promoPanel}>
                            <div className={styles.promoPanelHeader}>
                                <span className={styles.promoPanelTitle}>
                                    Тест функций Ozon API — {stores.find(s => s.id === diagStoreId)?.name}
                                    {diagData && (
                                        diagData.healthy
                                            ? <span style={{ color: '#22863a', marginLeft: 8 }}>✅ все функции работают</span>
                                            : <span style={{ color: '#cb2431', marginLeft: 8 }}>⛔ есть проблемы</span>
                                    )}
                                </span>
                            </div>
                            {diagLoading && <div className={styles.promoLoading}>Проверяем эндпоинты Ozon (~10 сек)...</div>}
                            {diagData && !diagLoading && (
                                <>
                                    {diagData.degradations.length > 0 && (
                                        <div className={styles.promoExitStatus} style={{ background: '#fdecea', color: '#cb2431' }}>
                                            ⛔ Деградации по логам вызовов (функция работала — теперь стабильно падает):
                                            {diagData.degradations.map(d => (
                                                <div key={d.endpoint}>
                                                    <code>{d.endpoint}</code> ({d.affectedFunction || '?'}) — {d.consecutiveErrors} ошибок подряд,
                                                    последний успех {d.lastSuccess}. {d.lastError}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <table className={styles.promoTable}>
                                        <thead>
                                            <tr>
                                                <th>Функция репрайсера</th>
                                                <th>Эндпоинт Ozon</th>
                                                <th>Статус</th>
                                                <th>Время</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {diagData.probes.map(p => (
                                                <tr key={p.key}>
                                                    <td>{p.label}</td>
                                                    <td><code>{p.endpoint}</code></td>
                                                    <td>
                                                        {p.ok === true && <span style={{ color: '#22863a' }}>OK{p.note ? ` (${p.note})` : ''}</span>}
                                                        {p.ok === false && (
                                                            <span style={{ color: '#cb2431' }} title={p.error}>
                                                                {p.statusCode || 'СЕТЬ'}{p.hint ? ` — ${p.hint}` : ''}
                                                            </span>
                                                        )}
                                                        {p.ok === null && <span style={{ color: '#888' }}>{p.note}</span>}
                                                    </td>
                                                    <td>{p.latencyMs != null ? `${p.latencyMs} мс` : '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className={styles.promoHint}>
                                        Проверено: {diagData.checkedAt.slice(0, 16).replace('T', ' ')}.
                                        Деградации также отслеживаются автоматически каждый час по логам реальных вызовов.
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* Store Form */}
                    <StoreForm
                        formData={formData}
                        onChange={setFormData}
                        onSubmit={handleSubmit}
                        isEditing={isEditing}
                        onCancel={resetForm}
                    />
                </>

            {/* User Management (admin only) */}
            <UserManagement />

            {/* Confirm Delete Dialog */}
            <ConfirmDialog
                isOpen={confirmOpen}
                title="Удалить магазин?"
                message="Это действие необратимо. Все данные магазина будут удалены."
                confirmText="Удалить"
                cancelText="Отмена"
                variant="danger"
                onConfirm={handleDeleteConfirm}
                onCancel={() => { setConfirmOpen(false); setPendingDeleteId(null); }}
            />

            <ConfirmDialog
                isOpen={exitPromosConfirm}
                title="Выйти из всех акций?"
                message={`Товары (${promoData?.total_products ?? 0} шт.) будут выведены из всех активных акций магазина. Вернуть их обратно можно только вручную через кабинет площадки. Операция занимает до минуты.`}
                confirmText="Выйти из акций"
                cancelText="Отмена"
                variant="danger"
                onConfirm={handleExitAllPromos}
                onCancel={() => setExitPromosConfirm(false)}
            />

            {/* Sync Logs Modal */}
            <SyncLogModal
                isOpen={showLogs}
                logs={currentLogs}
                onClose={() => setShowLogs(false)}
                expandedLogId={expandedLogId}
                logDetails={logDetails}
                onToggleDetails={toggleLogDetails}
            />
        </div>
    );
}
