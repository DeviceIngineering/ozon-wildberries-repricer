import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useStores } from '../../contexts/StoreContext';

export default function StoreRedirect() {
  const { stores, isLoading, loadStores } = useStores();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadStores().finally(() => setLoaded(true));
  }, [loadStores]);

  if (!loaded || isLoading) return null;

  if (stores.length > 0) {
    return <Navigate to={`/store/${stores[0].id}`} replace />;
  }

  return <Navigate to="/settings" replace />;
}
