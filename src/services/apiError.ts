import axios from 'axios';

/**
 * Тело ответа при ошибке. Все express-роуты приложения отвечают одинаково:
 * `res.status(4xx|5xx).json({ error: '...' })` — других полей в теле ошибки нет.
 */
export interface ApiErrorBody {
    error?: string;
}

/**
 * Сообщение из тела ответа API, если сервер его прислал, иначе `fallback`.
 * Повторяет прежнее выражение `err?.response?.data?.error || fallback`:
 * не-axios ошибка (сетевой сбой, баг в обработчике) даёт fallback.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
    if (axios.isAxiosError<ApiErrorBody>(err)) {
        const fromBody = err.response?.data?.error;
        if (fromBody) return fromBody;
    }
    return fallback;
}

/**
 * Текст брошенной ошибки — для веток на `fetch`, где код сам делает
 * `throw new Error(...)` и раньше читал `err.message` из `any`.
 */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
