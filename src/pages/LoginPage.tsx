import { useState, type FormEvent } from 'react';
import { signIn } from '../lib/auth-client';
import styles from './LoginPage.module.css';

export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        const { error: err } = await signIn.email({ email, password });

        if (err) {
            setError(err.message || 'Неверный email или пароль');
            setLoading(false);
        } else {
            // Full reload ensures useSession() fetches fresh session with new cookie
            window.location.href = '/';
        }
    };

    return (
        <div className={styles.wrapper}>
            <form className={styles.card} onSubmit={handleSubmit}>
                <h1 className={styles.title}>Ozon Viewer</h1>
                <p className={styles.subtitle}>Войдите для продолжения</p>

                {error && <div className={styles.error}>{error}</div>}

                <div className={styles.field}>
                    <label className={styles.label}>Email</label>
                    <input
                        className={styles.input}
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoFocus
                    />
                </div>

                <div className={styles.field}>
                    <label className={styles.label}>Пароль</label>
                    <input
                        className={styles.input}
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                </div>

                <button className={styles.button} type="submit" disabled={loading}>
                    {loading ? 'Вход...' : 'Войти'}
                </button>
            </form>
        </div>
    );
}
