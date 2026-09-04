import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useStores } from '../../contexts/StoreContext';
import { signOut, useSession } from '../../lib/auth-client';
import PriceImportModal from '../dashboard/PriceImportModal';
import PriceHistoryModal from '../dashboard/PriceHistoryModal';
import ApiLogsModal from '../dashboard/ApiLogsModal';
import RepricerLogModal from '../dashboard/RepricerLogModal';
import Tooltip from '../ui/Tooltip';
import styles from './Header.module.css';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

type ModalType = 'import' | 'history' | 'apiLogs' | 'repricer' | null;

export default function Header() {
  const { stores, activeStoreId, activeStore, isLoading } = useStores();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const [modal, setModal] = useState<ModalType>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  const handleStoreChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id) navigate(`/store/${id}`);
  };

  const storeName = activeStore?.name || 'Магазин';

  return (
    <>
      <header className={styles.header}>
        <NavLink to="/dashboard" className={styles.logo}>
          Ozon Viewer
        </NavLink>

        <div className={styles.controls}>
          <select
            className={styles.storeSelector}
            value={activeStoreId ?? ''}
            onChange={handleStoreChange}
            disabled={isLoading || stores.length === 0}
          >
            {stores.length === 0 && (
              <option value="">
                {isLoading ? 'Загрузка...' : 'Нет магазинов'}
              </option>
            )}
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>

          {/* Store action buttons */}
          {activeStoreId && (
            <div className={styles.storeActions}>
              <Tooltip text="Загрузить цены и себестоимость из Excel">
                <button className={styles.actionBtn} aria-label="Загрузить цены из Excel" onClick={() => setModal('import')}>
                  📥
                </button>
              </Tooltip>
              <Tooltip text="Снимки цен — сравнение и откат">
                <button className={styles.actionBtn} aria-label="Снимки цен и откат" onClick={() => setModal('history')}>
                  📋
                </button>
              </Tooltip>
              <Tooltip text="Все запросы к Ozon API с фильтрами">
                <button className={styles.actionBtn} aria-label="Журнал запросов к API" onClick={() => setModal('apiLogs')}>
                  📡
                </button>
              </Tooltip>
              {activeStore?.repricer_enabled ? (
                <Tooltip text="Что и когда изменил репрайсер">
                  <button className={styles.actionBtn} aria-label="Журнал репрайсера" onClick={() => setModal('repricer')}>
                    🔄
                  </button>
                </Tooltip>
              ) : null}
            </div>
          )}

          <Tooltip text={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            <button className={styles.themeToggle} aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={toggleTheme}>
              {theme === 'dark' ? '\u2600' : '\u263E'}
            </button>
          </Tooltip>

          <Tooltip text="Магазины и пользователи">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `${styles.settingsLink}${isActive ? ` ${styles.active}` : ''}`
              }
            >
              ⚙️
            </NavLink>
          </Tooltip>

          {session && (
            <Tooltip text={`Выход (${session.user.email})`}>
              <button
                className={styles.logoutBtn}
                aria-label="Выйти из аккаунта"
                onClick={async () => {
                  await signOut();
                  navigate('/login', { replace: true });
                }}
              >
                ⏻
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Modals */}
      {modal === 'import' && activeStoreId && (
        <PriceImportModal storeId={activeStoreId} storeName={storeName} platform={activeStore?.platform} onClose={() => setModal(null)} />
      )}
      {modal === 'history' && activeStoreId && (
        <PriceHistoryModal storeId={activeStoreId} storeName={storeName} onClose={() => setModal(null)} />
      )}
      {modal === 'apiLogs' && activeStoreId && (
        <ApiLogsModal storeId={activeStoreId} storeName={storeName} onClose={() => setModal(null)} />
      )}
      {modal === 'repricer' && activeStoreId && (
        <RepricerLogModal storeId={activeStoreId} storeName={storeName} onClose={() => setModal(null)} />
      )}
    </>
  );
}
