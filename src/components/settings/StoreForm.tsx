import React from 'react';
import styles from './StoreForm.module.css';

export interface StoreFormData {
    name: string;
    client_id: string;
    api_key: string;
    update_interval_minutes: number;
    antiban_enabled: boolean;
    repricer_enabled: boolean;
    repricer_interval_min: number;
    threshold_drop_percent: number;
    threshold_rise_percent: number;
    platform: string;
    ym_business_id: string;
    ym_campaign_id: string;
    ym_api_key: string;
    wb_api_key: string;
    tax_rate: number;
    min_margin_percent: number;
    promo_guard_enabled: boolean;
    promo_exit_enabled: boolean;
    promo_max_discount_percent: number;
    ym_boost_cap_percent: number;
    ym_floor_max_raise_percent: number;
    ym_promo_exit_enabled: boolean;
}

interface StoreFormProps {
    formData: StoreFormData;
    onChange: (data: StoreFormData) => void;
    onSubmit: (e: React.FormEvent) => void;
    isEditing: boolean;
    onCancel: () => void;
}

const StoreForm: React.FC<StoreFormProps> = ({ formData, onChange, onSubmit, isEditing, onCancel }) => {
    return (
        <div className={styles.formCard}>
            <h3 className={styles.formTitle}>
                {isEditing ? 'Редактировать магазин' : 'Добавить новый магазин'}
            </h3>
            <form onSubmit={onSubmit} className={styles.form}>
                {/* Platform selector */}
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                    <label className={styles.label}>Платформа</label>
                    <div className={styles.platformToggle}>
                        <button
                            type="button"
                            className={`${styles.platformBtn} ${formData.platform === 'ozon' ? styles.platformBtnActive : ''}`}
                            onClick={() => onChange({ ...formData, platform: 'ozon' })}
                        >
                            Ozon
                        </button>
                        <button
                            type="button"
                            className={`${styles.platformBtn} ${formData.platform === 'yandex' ? styles.platformBtnActiveYm : ''}`}
                            onClick={() => onChange({ ...formData, platform: 'yandex' })}
                        >
                            Яндекс Маркет
                        </button>
                        <button
                            type="button"
                            className={styles.platformBtn}
                            style={formData.platform === 'wildberries' ? { background: '#7c3aed', color: '#fff', borderColor: '#7c3aed' } : undefined}
                            onClick={() => onChange({ ...formData, platform: 'wildberries' })}
                        >
                            Wildberries
                        </button>
                    </div>
                </div>

                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                    <label className={styles.label}>Название магазина</label>
                    <input
                        required
                        value={formData.name}
                        onChange={e => onChange({ ...formData, name: e.target.value })}
                        className={styles.input}
                    />
                </div>

                {formData.platform === 'ozon' && (
                    <>
                        <div className={styles.formGroup}>
                            <label className={styles.label}>Client ID</label>
                            <input
                                required
                                value={formData.client_id}
                                onChange={e => onChange({ ...formData, client_id: e.target.value })}
                                className={styles.input}
                            />
                        </div>

                        <div className={styles.formGroup}>
                            <label className={styles.label}>API Key</label>
                            <input
                                required
                                type="password"
                                value={formData.api_key}
                                onChange={e => onChange({ ...formData, api_key: e.target.value })}
                                className={styles.input}
                            />
                        </div>
                    </>
                )}

                {formData.platform === 'yandex' && (
                    <>
                        <div className={styles.formGroup}>
                            <label className={styles.label}>Business ID</label>
                            <input
                                required
                                value={formData.ym_business_id}
                                onChange={e => onChange({ ...formData, ym_business_id: e.target.value })}
                                className={styles.input}
                            />
                        </div>

                        <div className={styles.formGroup}>
                            <label className={styles.label}>Campaign ID</label>
                            <input
                                required
                                value={formData.ym_campaign_id}
                                onChange={e => onChange({ ...formData, ym_campaign_id: e.target.value })}
                                className={styles.input}
                            />
                        </div>

                        <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                            <label className={styles.label}>API Key (OAuth токен)</label>
                            <input
                                required
                                type="password"
                                value={formData.ym_api_key}
                                onChange={e => onChange({ ...formData, ym_api_key: e.target.value })}
                                className={styles.input}
                            />
                        </div>
                    </>
                )}

                {formData.platform === 'wildberries' && (
                    <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                        <label className={styles.label}>API-токен WB (Контент, Цены и скидки, Аналитика, Продвижение)</label>
                        <input
                            required
                            type="password"
                            value={formData.wb_api_key}
                            onChange={e => onChange({ ...formData, wb_api_key: e.target.value })}
                            className={styles.input}
                        />
                    </div>
                )}

                <div className={styles.formGroup}>
                    <label className={styles.label}>Интервал обновлений</label>
                    <div className={styles.selectWrapper}>
                        <select
                            value={formData.update_interval_minutes}
                            onChange={e => onChange({ ...formData, update_interval_minutes: Number(e.target.value) })}
                            className={styles.select}
                        >
                            <option value={10}>10 минут</option>
                            <option value={60}>1 час</option>
                            <option value={360}>6 часов</option>
                            <option value={1440}>24 часа</option>
                        </select>
                        <div className={styles.selectArrow}>▼</div>
                    </div>
                </div>

                {formData.platform === 'ozon' && (
                    <div className={styles.formGroup}>
                        <div
                            className={styles.checkboxRow}
                            onClick={() => onChange({ ...formData, antiban_enabled: !formData.antiban_enabled })}
                        >
                            <input
                                type="checkbox"
                                checked={formData.antiban_enabled}
                                onChange={() => {}}
                                className={styles.checkbox}
                            />
                            <span className={styles.checkboxLabel}>Включить Антибан</span>
                        </div>
                    </div>
                )}

                {/* Repricer Settings */}
                <div className={`${styles.formGroup} ${styles.fullWidth} ${styles.repricerBlock}`}>
                    <div
                        className={styles.repricerHeader}
                        onClick={() => onChange({ ...formData, repricer_enabled: !formData.repricer_enabled })}
                    >
                        <input
                            type="checkbox"
                            checked={!!formData.repricer_enabled}
                            onChange={() => {}}
                            className={styles.checkbox}
                            style={{ accentColor: '#10b981' }}
                        />
                        <h4 className={formData.repricer_enabled ? styles.repricerTitleActive : styles.repricerTitle}>
                            Авто-контроль цен (Repricer V3.0)
                        </h4>
                    </div>

                    {formData.repricer_enabled && (
                        <div className={styles.repricerFields}>
                            <div>
                                <label className={styles.labelSmall}>Интервал (мин)</label>
                                <input
                                    type="number"
                                    min="15"
                                    value={formData.repricer_interval_min || 15}
                                    onChange={e => onChange({ ...formData, repricer_interval_min: Number(e.target.value) })}
                                    className={styles.inputSmall}
                                />
                            </div>
                            {formData.platform !== 'wildberries' && (
                                <>
                                    <div>
                                        <label className={styles.labelSmall}>Порог падения (%)</label>
                                        <input
                                            type="number"
                                            step="0.1"
                                            value={formData.threshold_drop_percent || 5.0}
                                            onChange={e => onChange({ ...formData, threshold_drop_percent: Number(e.target.value) })}
                                            className={styles.inputSmall}
                                        />
                                    </div>
                                    <div>
                                        <label className={styles.labelSmall}>Порог роста (%)</label>
                                        <input
                                            type="number"
                                            step="0.1"
                                            value={formData.threshold_rise_percent || 5.0}
                                            onChange={e => onChange({ ...formData, threshold_rise_percent: Number(e.target.value) })}
                                            className={styles.inputSmall}
                                        />
                                    </div>
                                </>
                            )}
                            {formData.platform === 'wildberries' && (
                                <div className={styles.fullWidth} style={{ fontSize: 12, color: '#7c3aed' }}>
                                    WB удерживает РРЦ (из импорта Excel) через скидку продавца; floor по юнит-экономике. Пороги падения/роста не используются.
                                </div>
                            )}
                            <div>
                                <label className={styles.labelSmall}>Налоговая ставка (%)</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="99"
                                    step="0.1"
                                    value={formData.tax_rate}
                                    onChange={e => onChange({ ...formData, tax_rate: parseFloat(e.target.value) || 0 })}
                                    className={styles.inputSmall}
                                />
                            </div>
                            <div>
                                <label className={styles.labelSmall}>Мин. маржа (%)</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="99"
                                    step="0.1"
                                    value={formData.min_margin_percent}
                                    onChange={e => onChange({ ...formData, min_margin_percent: parseFloat(e.target.value) || 0 })}
                                    className={styles.inputSmall}
                                />
                            </div>
                            {formData.platform === 'yandex' && (
                                <>
                                    <div>
                                        <label className={styles.labelSmall} title="Максимум буст-расхода (%), который закладывается в floor. Защищает от завышения цены при разовых дорогих бустах.">Потолок буста в floor (%)</label>
                                        <input
                                            type="number"
                                            min="0"
                                            max="99"
                                            step="1"
                                            value={formData.ym_boost_cap_percent ?? 30}
                                            onChange={e => onChange({ ...formData, ym_boost_cap_percent: parseFloat(e.target.value) || 0 })}
                                            className={styles.inputSmall}
                                        />
                                    </div>
                                    <div>
                                        <label className={styles.labelSmall} title="Мягкий предохранитель: максимальный рост цены к floor за один прогон. Floor достигается за несколько прогонов, чтобы не терять buybox разом.">Макс. шаг роста цены (%/прогон)</label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="100"
                                            step="1"
                                            value={formData.ym_floor_max_raise_percent ?? 20}
                                            onChange={e => onChange({ ...formData, ym_floor_max_raise_percent: parseFloat(e.target.value) || 0 })}
                                            className={styles.inputSmall}
                                        />
                                    </div>
                                    <div
                                        className={`${styles.checkboxRow} ${styles.fullWidth}`}
                                        onClick={() => onChange({ ...formData, ym_promo_exit_enabled: !formData.ym_promo_exit_enabled })}
                                        title="ВКЛ: репрайсер реально выводит из акций товары, торгующие ниже floor (POST promos/offers/delete, применяется 4–6 ч). ВЫКЛ: только лог-кандидаты (dry-run, YM_PROMO_EXIT_DRYRUN). Разрешённые акции не трогаются."
                                    >
                                        <input
                                            type="checkbox"
                                            checked={!!formData.ym_promo_exit_enabled}
                                            onChange={() => {}}
                                            className={styles.checkbox}
                                            style={{ accentColor: '#ef4444' }}
                                        />
                                        <span className={styles.checkboxLabel}>Авто-вывод убыточных из акций (иначе dry-run)</span>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {formData.platform === 'ozon' && (
                    <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                        <div
                            className={styles.checkboxRow}
                            onClick={() => onChange({ ...formData, promo_guard_enabled: !formData.promo_guard_enabled })}
                        >
                            <input
                                type="checkbox"
                                checked={!!formData.promo_guard_enabled}
                                onChange={() => {}}
                                className={styles.checkbox}
                                style={{ accentColor: '#f59e0b' }}
                            />
                            <span className={styles.checkboxLabel}>Защита от убыточных акций</span>
                        </div>
                        <div
                            className={styles.checkboxRow}
                            onClick={() => onChange({ ...formData, promo_exit_enabled: !formData.promo_exit_enabled })}
                            title="Каждые 5 минут выводит товары из акций Ozon и запрещает автодобавление. Разрешённые акции (отмеченные в панели «Акции») сохраняются — из них выводятся только товары со скидкой больше порога."
                        >
                            <input
                                type="checkbox"
                                checked={!!formData.promo_exit_enabled}
                                onChange={() => {}}
                                className={styles.checkbox}
                                style={{ accentColor: '#ef4444' }}
                            />
                            <span className={styles.checkboxLabel}>Автовывод из акций (фоном, каждые 5 мин)</span>
                        </div>
                        {formData.promo_exit_enabled && (
                            <div className={styles.repricerFields} style={{ marginTop: 8 }}>
                                <div>
                                    <label className={styles.labelSmall}>Макс. скидка в разрешённых акциях (%)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        max="99"
                                        step="0.1"
                                        value={formData.promo_max_discount_percent}
                                        onChange={e => onChange({ ...formData, promo_max_discount_percent: parseFloat(e.target.value) || 0 })}
                                        className={styles.inputSmall}
                                        title="Товар со скидкой больше этого значения выводится даже из разрешённой акции"
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {formData.platform === 'wildberries' && (
                    <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                        <div
                            className={styles.checkboxRow}
                            onClick={() => onChange({ ...formData, promo_exit_enabled: !formData.promo_exit_enabled })}
                            title="Каждые 5 минут проверяет автоакции WB и восстанавливает РРЦ (выход из акции через Prices API). Для постоянной защиты включите бессрочный самозапрет автоучастия в кабинете WB."
                        >
                            <input
                                type="checkbox"
                                checked={!!formData.promo_exit_enabled}
                                onChange={() => {}}
                                className={styles.checkbox}
                                style={{ accentColor: '#7c3aed' }}
                            />
                            <span className={styles.checkboxLabel}>Анти-автоакции: держать РРЦ (фоном, каждые 5 мин)</span>
                        </div>
                    </div>
                )}

                <div className={`${styles.fullWidth} ${styles.submitRow}`}>
                    <button type="submit" className="primary-btn" style={{ flex: 1, padding: '14px' }}>
                        {isEditing ? 'Сохранить изменения' : 'Добавить магазин'}
                    </button>
                    {isEditing && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="secondary-btn"
                            style={{ flex: 1, padding: '14px' }}
                        >
                            Отмена
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
};

export default StoreForm;
