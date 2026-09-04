import './sentry'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './index.css'
import { ToastProvider } from './contexts/ToastContext'
import { StoreProvider } from './contexts/StoreContext'
import router from './router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <StoreProvider>
        <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)', fontFamily: 'var(--font-family)' }}>Загрузка...</div>}>
          <RouterProvider router={router} />
        </Suspense>
      </StoreProvider>
    </ToastProvider>
  </StrictMode>,
)
