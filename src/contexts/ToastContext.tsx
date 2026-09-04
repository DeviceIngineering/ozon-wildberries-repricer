import { createContext, useContext, useReducer, useCallback, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'progress';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  onRetry?: () => void;
}

interface ToastState {
  toasts: Toast[];
}

type ToastAction =
  | { type: 'ADD_TOAST'; toast: Toast }
  | { type: 'REMOVE_TOAST'; id: string }
  | { type: 'UPDATE_TOAST'; id: string; message: string };

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'ADD_TOAST':
      return { toasts: [...state.toasts, action.toast] };
    case 'REMOVE_TOAST':
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'UPDATE_TOAST':
      return {
        toasts: state.toasts.map((t) =>
          t.id === action.id ? { ...t, message: action.message } : t
        ),
      };
    default:
      return state;
  }
}

interface ToastContextValue {
  toasts: Toast[];
  showSuccess: (message: string) => void;
  showError: (message: string, onRetry?: () => void) => void;
  showProgress: (message: string) => string;
  updateProgress: (id: string, message: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;
function generateId(): string {
  return `toast-${++toastCounter}-${Date.now()}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    dispatch({ type: 'REMOVE_TOAST', id });
  }, []);

  const scheduleAutoDismiss = useCallback(
    (id: string, delay: number) => {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        dispatch({ type: 'REMOVE_TOAST', id });
      }, delay);
      timersRef.current.set(id, timer);
    },
    []
  );

  const showSuccess = useCallback(
    (message: string) => {
      const id = generateId();
      dispatch({ type: 'ADD_TOAST', toast: { id, type: 'success', message } });
      scheduleAutoDismiss(id, 3000);
    },
    [scheduleAutoDismiss]
  );

  const showError = useCallback(
    (message: string, onRetry?: () => void) => {
      const id = generateId();
      dispatch({ type: 'ADD_TOAST', toast: { id, type: 'error', message, onRetry } });
      scheduleAutoDismiss(id, 5000);
    },
    [scheduleAutoDismiss]
  );

  const showProgress = useCallback((message: string): string => {
    const id = generateId();
    dispatch({ type: 'ADD_TOAST', toast: { id, type: 'progress', message } });
    return id;
  }, []);

  const updateProgress = useCallback((id: string, message: string) => {
    dispatch({ type: 'UPDATE_TOAST', id, message });
  }, []);

  return (
    <ToastContext.Provider
      value={{
        toasts: state.toasts,
        showSuccess,
        showError,
        showProgress,
        updateProgress,
        dismiss,
      }}
    >
      {children}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
