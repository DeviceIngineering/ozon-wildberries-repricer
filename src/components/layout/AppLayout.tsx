import { Outlet } from 'react-router-dom';
import { SelectionProvider } from '../../contexts/SelectionContext';
import Header from './Header';
import Sidebar from './Sidebar';
import ToastContainer from './ToastContainer';
import styles from './AppLayout.module.css';

export default function AppLayout() {
  return (
    <div className={styles.layout}>
      <Header />
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <SelectionProvider>
            <Outlet />
          </SelectionProvider>
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
