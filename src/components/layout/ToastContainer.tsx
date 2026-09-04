import { useToast } from '../../contexts/ToastContext';
import Toast from '../ui/Toast';
import styles from './ToastContainer.module.css';

function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container} aria-label="Уведомления">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}

export default ToastContainer;
