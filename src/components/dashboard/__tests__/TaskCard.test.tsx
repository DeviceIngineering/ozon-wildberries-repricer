import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskCard from '../TaskCard';
import type { DecisionTask } from '../../../services/ozonApi';

const baseTask = (over: Partial<DecisionTask> = {}): DecisionTask => ({
  id: 'below_floor',
  severity: 'warn',
  title: 'Цена ниже пола',
  desc: 'Текущая цена ниже расчётной безубыточности.',
  count: 6,
  risk: 0,
  riskKind: null,
  example: null,
  action: { label: 'Запустить репрайсер', kind: 'repricer' },
  filter: 'below_floor',
  byStore: [
    { store_id: 's1', store_name: 'Маг A', platform: 'ozon', count: 2, risk: 0 },
    { store_id: 's2', store_name: 'Маг B', platform: 'wildberries', count: 4, risk: 0 },
  ],
  ...over,
});

const renderCard = (task: DecisionTask, onAction = vi.fn(), onDrill = vi.fn()) => {
  render(
    <MemoryRouter>
      <TaskCard task={task} onAction={onAction} onDrill={onDrill} />
    </MemoryRouter>
  );
  return { onAction, onDrill };
};

describe('TaskCard', () => {
  it('рендерит заголовок и бейджи площадок', () => {
    renderCard(baseTask());
    expect(screen.getByText('Цена ниже пола')).toBeInTheDocument();
    expect(screen.getByText('OZ')).toBeInTheDocument();
    expect(screen.getByText('WB')).toBeInTheDocument();
  });

  it('метрика: риск 0 → показывает количество SKU', () => {
    renderCard(baseTask({ risk: 0 }));
    expect(screen.getByText(/6\s*SKU/)).toBeInTheDocument();
  });

  it('метрика: риск per_day → ₽/д', () => {
    renderCard(baseTask({ risk: 100, riskKind: 'per_day' }));
    expect(screen.getByText(/₽\/д/)).toBeInTheDocument();
  });

  it('метрика: риск per_unit → ₽ без /д', () => {
    renderCard(baseTask({ risk: 50, riskKind: 'per_unit' }));
    const metric = screen.getByText(/₽/);
    expect(metric.textContent).not.toMatch(/\/д/);
  });

  it('первичное действие вызывает onAction с магазином с наибольшим count', () => {
    const { onAction } = renderCard(baseTask());
    fireEvent.click(screen.getByText('Запустить репрайсер'));
    expect(onAction).toHaveBeenCalledTimes(1);
    // primaryStore = магазин с count=4 (s2)
    expect(onAction.mock.calls[0][1]).toBe('s2');
  });

  it('«Список SKU» раскрывает разбивку и drill зовёт onDrill с фильтром', () => {
    const { onDrill } = renderCard(baseTask());
    fireEvent.click(screen.getByText(/Список SKU/));
    expect(screen.getByText('Маг A')).toBeInTheDocument();
    expect(screen.getByText('Маг B')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Маг A'));
    expect(onDrill).toHaveBeenCalledWith('s1', 'below_floor');
  });

  it('пример SKU отображается, когда задан', () => {
    renderCard(baseTask({ example: 'OF-1: РРЦ 300 < с/с 350' }));
    expect(screen.getByText(/OF-1: РРЦ 300 < с\/с 350/)).toBeInTheDocument();
  });
});
