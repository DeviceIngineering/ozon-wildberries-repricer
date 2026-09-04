import React from 'react';
import Modal from '../ui/Modal';
import styles from './SyncLogModal.module.css';

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

interface SyncLogModalProps {
    isOpen: boolean;
    logs: SyncLog[];
    onClose: () => void;
    expandedLogId: number | null;
    logDetails: LogDetail[];
    onToggleDetails: (logId: number) => void;
}

const SyncLogModal: React.FC<SyncLogModalProps> = ({
    isOpen,
    logs,
    onClose,
    expandedLogId,
    logDetails,
    onToggleDetails,
}) => {
    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Логи синхронизации">
            <div className={styles.tableContainer}>
                {logs.length === 0 ? (
                    <p className={styles.emptyText}>Логов пока нет</p>
                ) : (
                    <table className={styles.logsTable}>
                        <thead className={styles.stickyHead}>
                            <tr className={styles.headerRow}>
                                <th className={styles.thId}>#</th>
                                <th className={styles.thLeft}>Дата</th>
                                <th className={styles.thLeft}>Статус</th>
                                <th className={styles.thRight}>Изменено</th>
                                <th className={styles.thCenter}>Дет.</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <React.Fragment key={log.id}>
                                    <tr className={expandedLogId === log.id ? styles.expandedRow : styles.dataRow}>
                                        <td className={styles.tdId}>{log.id}</td>
                                        <td className={styles.td}>
                                            {new Date(log.started_at).toLocaleString('ru-RU')}
                                        </td>
                                        <td className={styles.td}>
                                            <span
                                                className={
                                                    log.status === 'SUCCESS'
                                                        ? styles.statusSuccess
                                                        : log.status === 'ERROR'
                                                            ? styles.statusError
                                                            : styles.statusWarning
                                                }
                                            >
                                                {log.status}
                                            </span>
                                        </td>
                                        <td className={styles.tdRight}>
                                            <span className={styles.changedCount}>{log.items_changed}</span>
                                        </td>
                                        <td className={styles.tdCenter}>
                                            <button
                                                onClick={() => onToggleDetails(log.id)}
                                                className="secondary-btn"
                                                style={{ padding: '2px 8px', fontSize: '0.8rem' }}
                                            >
                                                {expandedLogId === log.id ? '▲' : '▼'}
                                            </button>
                                        </td>
                                    </tr>
                                    {expandedLogId === log.id && (
                                        <tr>
                                            <td colSpan={5} className={styles.detailsCell}>
                                                <div className={styles.detailsContainer}>
                                                    {logDetails.length === 0 ? (
                                                        <p className={styles.noDetails}>Нет детальных записей</p>
                                                    ) : (
                                                        <div className={styles.detailsTableWrapper}>
                                                            <table className={styles.detailsTable}>
                                                                <tbody>
                                                                    {logDetails.map((detail) => (
                                                                        <tr
                                                                            key={detail.id}
                                                                            className={styles.detailRow}
                                                                        >
                                                                            <td className={styles.detailTime}>
                                                                                {new Date(detail.timestamp).toLocaleTimeString()}
                                                                            </td>
                                                                            <td className={styles.detailStage}>
                                                                                [{detail.stage}]
                                                                            </td>
                                                                            <td
                                                                                className={
                                                                                    detail.level === 'ERROR'
                                                                                        ? styles.detailError
                                                                                        : detail.level === 'WARNING'
                                                                                            ? styles.detailWarning
                                                                                            : styles.detailMessage
                                                                                }
                                                                            >
                                                                                {detail.message}
                                                                            </td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </Modal>
    );
};

export default SyncLogModal;
