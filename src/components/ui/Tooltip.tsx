import { useState, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string;
  children: ReactNode;
  delay?: number;
  position?: 'bottom' | 'top';
}

export default function Tooltip({ text, children, delay = 400, position = 'bottom' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const timer = useRef<number>(0);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    timer.current = window.setTimeout(() => {
      if (wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        setCoords({
          top: position === 'top' ? rect.top - 6 : rect.bottom + 6,
          left: rect.left + rect.width / 2,
        });
      }
      setVisible(true);
    }, delay);
  }, [delay, position]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setVisible(false);
  }, []);

  return (
    <span
      ref={wrapperRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      style={{ display: 'inline-flex' }}
    >
      {children}
      {visible && createPortal(
        <span
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: position === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
            padding: '5px 10px',
            borderRadius: '6px',
            background: 'var(--bg-secondary, #1e293b)',
            border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
            color: 'var(--text-primary, #e2e8f0)',
            fontSize: '0.65rem',
            lineHeight: '1.4',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            maxWidth: '300px',
            pointerEvents: 'none',
            zIndex: 10000,
            animation: 'tooltipFadeIn 0.15s ease',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {text}
          <style>{`@keyframes tooltipFadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
        </span>,
        document.body
      )}
    </span>
  );
}
