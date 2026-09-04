import { Navigate } from 'react-router-dom';
import { useSession } from '../../lib/auth-client';
import { hasPermission } from '../../lib/permissions';

export default function SmartRedirect() {
    const { data: session } = useSession();
    const role = session?.user?.role as string | undefined;

    if (hasPermission(role, 'repricer')) {
        return <Navigate to="/" replace />;
    }
    return <Navigate to="/settings" replace />;
}
