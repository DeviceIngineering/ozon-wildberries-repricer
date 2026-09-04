import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../Modal';

describe('Modal', () => {
  it('renders children when open', () => {
    render(
      <Modal isOpen={true} onClose={() => {}} title="Тестовый заголовок">
        <p>Содержимое модального окна</p>
      </Modal>
    );
    expect(screen.getByText('Содержимое модального окна')).toBeInTheDocument();
    expect(screen.getByText('Тестовый заголовок')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <Modal isOpen={false} onClose={() => {}} title="Заголовок">
        <p>Скрытое содержимое</p>
      </Modal>
    );
    expect(screen.queryByText('Скрытое содержимое')).not.toBeInTheDocument();
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Заголовок">
        <p>Содержимое</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on overlay click', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Заголовок">
        <p>Содержимое</p>
      </Modal>
    );
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking content area', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Заголовок">
        <p>Содержимое</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has aria-modal="true" and role="dialog"', () => {
    render(
      <Modal isOpen={true} onClose={() => {}} title="Заголовок">
        <p>Содержимое</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
