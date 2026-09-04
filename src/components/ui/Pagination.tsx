import { useState } from 'react';
import styles from './Pagination.module.css';

interface PaginationProps {
  totalItems: number;
  currentPage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export default function Pagination({
  totalItems,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const [jumpPage, setJumpPage] = useState('');

  const totalPages = Math.ceil(totalItems / pageSize);
  const startRecord = totalItems > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const endRecord = Math.min(currentPage * pageSize, totalItems);

  const handleJump = () => {
    const p = parseInt(jumpPage, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      onPageChange(p);
      setJumpPage('');
    }
  };

  const renderPageNumbers = () => {
    const pages: (number | '...')[] = [];

    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 4) {
        for (let i = 1; i <= 5; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 3) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }

    return pages.map((p, idx) => {
      const isDots = p === '...';
      const isActive = p === currentPage;
      const className = [
        styles.pageBtn,
        isActive ? styles.pageBtnActive : '',
        isDots ? styles.pageBtnDots : '',
      ]
        .filter(Boolean)
        .join(' ');

      return (
        <button
          key={idx}
          className={className}
          onClick={() => typeof p === 'number' ? onPageChange(p) : undefined}
          disabled={isDots}
        >
          {p}
        </button>
      );
    });
  };

  return (
    <div className={styles.toolbar}>
      <div className={styles.summary}>
        {totalItems > 0
          ? `${startRecord}–${endRecord} из ${totalItems}`
          : 'Нет данных'}
      </div>

      <div className={styles.nav}>
        <button
          className={styles.navArrow}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label="Предыдущая страница"
        >
          &lt;
        </button>
        <div className={styles.numbers}>{renderPageNumbers()}</div>
        <button
          className={styles.navArrow}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label="Следующая страница"
        >
          &gt;
        </button>
      </div>

      <div className={styles.controls}>
        <select
          className={styles.sizeSelect}
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>

        <input
          type="text"
          className={styles.jumpInput}
          value={jumpPage}
          onChange={(e) => setJumpPage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleJump()}
          placeholder="#"
          aria-label="Перейти к странице"
        />
      </div>
    </div>
  );
}
