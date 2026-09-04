import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { LossTrend, MarginBars, ControlDonut, StoreActionBars } from '../CockpitCharts';

describe('LossTrend', () => {
  it('пустые данные → заглушка', () => {
    render(<LossTrend labels={[]} data={[]} />);
    expect(screen.getByText(/Нет данных за период/)).toBeInTheDocument();
  });
  it('с данными → рисует svg', () => {
    const { container } = render(<LossTrend labels={['01.06', '02.06']} data={[10, 20]} />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelectorAll('circle').length).toBe(2);
  });
});

describe('MarginBars', () => {
  it('всё по нулям → заглушка', () => {
    render(<MarginBars buckets={[{ label: 'Убыток', value: 0, color: '#000' }]} />);
    expect(screen.getByText(/Нет товаров с рассчитанным полом/)).toBeInTheDocument();
  });
  it('с данными → рисует столбцы и подписи значений', () => {
    const { container } = render(<MarginBars buckets={[
      { label: 'Убыток', value: 3, color: '#DC2626' },
      { label: '30%+', value: 7, color: '#16A34A' },
    ]} />);
    expect(container.querySelectorAll('rect').length).toBe(2);
    expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1); // значение столбца (+ возможна подпись оси)
  });
});

describe('ControlDonut', () => {
  it('сумма 0 → заглушка', () => {
    render(<ControlDonut segments={[{ name: 'РРЦ', value: 0, color: '#16A34A' }]} />);
    expect(screen.getByText(/Нет данных/)).toBeInTheDocument();
  });
  it('считает процент первого сегмента', () => {
    render(<ControlDonut segments={[
      { name: 'РРЦ', value: 75, color: '#16A34A' },
      { name: 'Акции', value: 25, color: '#3B82F6' },
    ]} />);
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('РРЦ')).toBeInTheDocument();
  });
});

describe('StoreActionBars', () => {
  const bars = [
    { id: 'a', name: 'Магазин А', value: 12, color: '#005BFF', enabled: true },
    { id: 'b', name: 'Магазин Б', value: 0, color: '#FFCC00', enabled: true },
    { id: 'c', name: 'Магазин В', value: 0, color: '#CB11AB', enabled: false },
  ];

  it('все нули → заглушка «цены стабильны»', () => {
    render(<StoreActionBars bars={[{ id: 'a', name: 'А', value: 0, color: '#000', enabled: true }]} />);
    expect(screen.getByText(/цены не менялись/)).toBeInTheDocument();
  });

  it('кастомный emptyText (для графика акций)', () => {
    render(<StoreActionBars bars={[{ id: 'a', name: 'А', value: 0, color: '#000', enabled: true }]}
                           emptyText="из акций никого не выводили" />);
    expect(screen.getByText(/из акций никого не выводили/)).toBeInTheDocument();
  });

  it('рисует столбец на каждый магазин, включая нулевой (детектор «притих»)', () => {
    const { container } = render(<StoreActionBars bars={bars} />);
    // у каждого магазина 2 rect: прозрачная зона клика + видимый столбец
    expect(container.querySelectorAll('g rect').length).toBeGreaterThanOrEqual(bars.length * 2);
    expect(screen.getByText('Магазин А')).toBeInTheDocument();
    expect(screen.getByText('выкл')).toBeInTheDocument(); // выключенный репрайсер помечен
  });

  it('клик по магазину вызывает onBarClick с его id', () => {
    const onBarClick = vi.fn();
    render(<StoreActionBars bars={bars} onBarClick={onBarClick} />);
    fireEvent.click(screen.getByText('Магазин А').closest('g')!);
    expect(onBarClick).toHaveBeenCalledWith('a');
  });
});
