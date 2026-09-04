import { useState } from 'react';
import Modal from '../ui/Modal';
import { errorMessage } from '../../services/apiError';
import styles from './ScheduleDialog.module.css';

interface ScheduleUpdate {
  offer_id: string;
  price?: string;
  old_price?: string;
  min_price?: string;
  currency_code?: string;
}

interface ScheduleDialogProps {
  isOpen: boolean;
  storeId: string;
  updates: ScheduleUpdate[];
  onClose: () => void;
  onScheduled: () => void;
}

const API_BASE = '';

function toLocalDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export default function ScheduleDialog({
  isOpen,
  storeId,
  updates,
  onClose,
  onScheduled,
}: ScheduleDialogProps) {
  const minDate = new Date(Date.now() + 60 * 1000); // минимум +1 минута
  const [scheduledAt, setScheduledAt] = useState<string>(toLocalDatetimeValue(new Date(Date.now() + 5 * 60 * 1000)));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!scheduledAt) {
      setError('Укажите дату и время');
      return;
    }
    const selectedDate = new Date(scheduledAt);
    if (selectedDate <= new Date()) {
      setError('Выберите время в будущем');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/stores/${storeId}/schedule-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_at: selectedDate.toISOString(),
          updates_json: JSON.stringify(updates),
          source: 'mass-edit',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось запланировать обновление');
      }
      onScheduled();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Запланировать обновление цен">
      <div className={styles.body}>
        <p className={styles.description}>
          Запланировать обновление цен для <strong>{updates.length}</strong> товаров.
        </p>

        <div className={styles.field}>
          <label className={styles.label}>Дата и время запуска</label>
          <input
            type="datetime-local"
            className={styles.datetimeInput}
            value={scheduledAt}
            min={toLocalDatetimeValue(minDate)}
            onChange={(e) => {
              setScheduledAt(e.target.value);
              setError(null);
            }}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={isLoading}>
            Отмена
          </button>
          <button
            className={styles.confirmBtn}
            onClick={handleSubmit}
            disabled={isLoading || !scheduledAt}
          >
            {isLoading ? 'Сохранение...' : 'Запланировать'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
