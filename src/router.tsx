import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import ErrorBoundary from './components/ui/ErrorBoundary';
import ProtectedRoute from './components/auth/ProtectedRoute';
import ProductTablePage from './pages/ProductTablePage';
import LoginPage from './pages/LoginPage';
import SmartRedirect from './components/auth/SmartRedirect';
import StoreRedirect from './components/auth/StoreRedirect';

const MassEditPage = lazy(() => import('./pages/MassEditPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DocsPage = lazy(() => import('./pages/DocsPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const StrategiesPage = lazy(() => import('./pages/StrategiesPage'));
const MasterPricesPage = lazy(() => import('./pages/MasterPricesPage'));

const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    element: (
      <ErrorBoundary>
        <ProtectedRoute>
          <AppLayout />
        </ProtectedRoute>
      </ErrorBoundary>
    ),
    children: [
      {
        path: '/',
        element: <StoreRedirect />,
      },
      {
        path: '/dashboard',
        element: <DashboardPage />,
      },
      {
        path: '/store/:id',
        element: <ProductTablePage />,
      },
      {
        path: '/store/:id/mass-edit',
        element: <MassEditPage />,
      },
      {
        path: '/settings',
        element: <SettingsPage />,
      },
      {
        path: '/settings/:id',
        element: <SettingsPage />,
      },
      {
        path: '/master-prices',
        element: <MasterPricesPage />,
      },
      {
        path: '/strategies',
        element: <StrategiesPage />,
      },
      {
        path: '/strategies/:id',
        element: <StrategiesPage />,
      },
      {
        path: '/docs',
        element: <DocsPage />,
      },
      {
        path: '*',
        element: <SmartRedirect />,
      },
    ],
  },
]);

export default router;
