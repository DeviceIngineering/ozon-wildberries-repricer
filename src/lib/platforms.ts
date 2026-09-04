// Единый источник истины по площадкам: код-значок, подпись, цвета, кабинет.
// До этого значок OZ/YM/WB дублировался ~6 раз в трёх несогласованных цветовых
// схемах (Sidebar/Settings — пастель, Strategies — сплошной, Dashboard — другой сплошной).

export type PlatformKey = 'ozon' | 'yandex' | 'wildberries';

export interface PlatformMeta {
    code: string;   // короткий значок: OZ / YM / WB
    label: string;  // человекочитаемое имя площадки
    bg: string;     // фон значка
    fg: string;     // цвет текста значка
    cabinetUrl: string;
}

export const PLATFORMS: Record<string, PlatformMeta> = {
    ozon: { code: 'OZ', label: 'Ozon', bg: '#005bff', fg: '#fff', cabinetUrl: 'https://seller.ozon.ru' },
    yandex: { code: 'YM', label: 'Яндекс Маркет', bg: '#fc3f1d', fg: '#fff', cabinetUrl: 'https://partner.market.yandex.ru' },
    wildberries: { code: 'WB', label: 'Wildberries', bg: '#7c3aed', fg: '#fff', cabinetUrl: 'https://seller.wildberries.ru' },
};

export function platformMeta(platform?: string): PlatformMeta {
    return PLATFORMS[platform || 'ozon'] || PLATFORMS.ozon;
}
