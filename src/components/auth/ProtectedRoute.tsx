import { Navigate } from 'react-router-dom';
import { useSession } from '../../lib/auth-client';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { data: session, isPending } = useSession();

    if (isPending) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '100vh',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-family)',
            }}>
                Загрузка...
            </div>
        );
    }

    if (!session) {
        return <Navigate to="/login" replace />;
    }

    return <>{children}</>;
}
