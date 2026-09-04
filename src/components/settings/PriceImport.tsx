import React from 'react';
import { useToast } from '../../contexts/ToastContext';
import styles from './PriceImport.module.css';

interface ImportRecord {
    id: number;
    filename: string;
    uploaded_at: string;
    status: string;
    result_json: string;
}

interface PriceImportProps {
    storeId: string;
}

const PriceImport: React.FC<PriceImportProps> = ({ storeId }) => {
    const { showSuccess, showError } = useToast();
    const [priceFile, setPriceFile] = React.useState<File | null>(null);
    const [uploading, setUploading] = React.useState(false);
    const [importHistory, setImportHistory] = React.useState<ImportRecord[]>([]);

    React.useEffect(() => {
        loadImportHistory();
    }, [storeId]);

    const loadImportHistory = async () => {
        try {
            const res = await fetch(`/api/stores/${storeId}/price-imports`);
            const data = await res.json();
            setImportHistory(data);
        } catch (e) {
            console.error(e);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setPriceFile(e.target.files[0]);
        }
    };

    const handleUpload = async () => {
        if (!priceFile) return;
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', priceFile);
            const res = await fetch(`/api/stores/${storeId}/price-import`, {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();
            if (data.success) {
                showSuccess(`Успешно! Обработано строк: ${data.result.total_rows}. Обновлено: ${data.result.valid_updates}`);
                setPriceFile(null);
                loadImportHistory();
            } else {
                showError('Ошибка: ' + (data.error || 'Неизвестная ошибка'));
            }
        } catch {
            showError('Ошибка сети при загрузке файла');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.uploadCard}>
                <h3 className={styles.cardTitle}>
                    Загрузить новый прайс-лист для магазина ID {storeId}
                </h3>
                <p className={styles.hint}>
                    Формат Excel (xlsx). Обязательные колонки: <strong>Артикул</strong> (или OfferID), <strong>Цена</strong>. Дополнительно: Старая цена, Мин. цена.
                </p>

                <div className={styles.dropZone}>
                    <input
                        type="file"
                        accept=".xlsx, .xls"
                        onChange={handleFileChange}
                        id="fileInput"
                        style={{ display: 'none' }}
                    />
                    <label htmlFor="fileInput" className={`primary-btn ${styles.fileLabel}`}>
                        {priceFile ? priceFile.name : 'Выбрать файл'}
                    </label>
                    {priceFile && <p className={styles.fileSelected}>Файл выбран</p>}
                </div>

                <button
                    onClick={handleUpload}
                    disabled={!priceFile || uploading}
                    className="primary-btn"
                    style={{ width: '100%' }}
                >
                    {uploading ? 'Загрузка и обработка...' : 'Загрузить и обновить цены'}
                </button>
            </div>

            <div className={styles.historySection}>
                <h3 className={styles.historyTitle}>История загрузок (последние 3)</h3>
                {importHistory.length === 0 ? (
                    <p className={styles.emptyText}>Нет загруженных файлов</p>
                ) : (
                    <table className={styles.historyTable}>
                        <thead>
                            <tr className={styles.headerRow}>
                                <th className={styles.th}>Файл</th>
                                <th className={styles.th}>Дата</th>
                                <th className={styles.th}>Статус</th>
                                <th className={styles.th}>Результат</th>
                                <th className={styles.th}>Скачать</th>
                            </tr>
                        </thead>
                        <tbody>
                            {importHistory.map(im => {
                                let res: any = {};
                                try {
                                    res = JSON.parse(im.result_json || '{}');
                                } catch {
                                    // Malformed result payload: render the row with empty stats.
                                }
                                return (
                                    <tr key={im.id} className={styles.dataRow}>
                                        <td className={styles.td}>{im.filename}</td>
                                        <td className={styles.td}>
                                            {new Date(im.uploaded_at).toLocaleString('ru-RU')}
                                        </td>
                                        <td className={styles.td}>
                                            <span className={im.status === 'COMPLETED' ? styles.statusOk : styles.statusErr}>
                                                {im.status}
                                            </span>
                                        </td>
                                        <td className={styles.tdResult}>
                                            {im.status === 'COMPLETED'
                                                ? `Строк: ${res.total_rows || 0}, Обновлено: ${res.valid_updates || 0}`
                                                : (res.error || '-')}
                                        </td>
                                        <td className={styles.td}>
                                            <a
                                                href={`/api/stores/${storeId}/price-imports/${im.id}/download`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="secondary-btn"
                                                style={{ padding: '4px 10px', fontSize: '0.8rem', textDecoration: 'none', color: 'white', display: 'inline-block' }}
                                            >
                                                ⬇
                                            </a>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
};

export default PriceImport;
