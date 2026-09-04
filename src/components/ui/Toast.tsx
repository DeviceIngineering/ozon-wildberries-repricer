import type { Toast as ToastType } from '../../contexts/ToastContext';
import styles from './Toast.module.css';

interface ToastProps {
  toast: ToastType;
  onDismiss: (id: string) => void;
}

function SpinnerIcon() {
  return (
    <span className={styles.spinner} aria-hidden="true" />
  );
}

function Toast({ toast, onDismiss }: ToastProps) {
  const { id, type, message, onRetry } = toast;

  const icon =
    type === 'success' ? '✓' :
    type === 'error' ? '✕' :
    null;

  return (
    <div className={`${styles.toast} ${styles[type]}`} role="alert" aria-live="polite">
      <div className={styles.iconWrap}>
        {type === 'progress' ? <SpinnerIcon /> : (
          <span className={styles.icon}>{icon}</span>
        )}
      </div>
      <span className={styles.message}>{message}</span>
      <div className={styles.actions}>
        {type === 'error' && onRetry && (
          <button
            className={styles.retryBtn}
            onClick={() => {
              onRetry();
              onDismiss(id);
            }}
          >
            Повторить
          </button>
        )}
        <button
          className={styles.closeBtn}
          onClick={() => onDismiss(id)}
          aria-label="Закрыть уведомление"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default Toast;
