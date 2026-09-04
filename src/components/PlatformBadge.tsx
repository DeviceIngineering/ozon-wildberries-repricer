import React from 'react';
import { platformMeta } from '../lib/platforms';

interface Props {
    platform?: string;
    style?: React.CSSProperties;
    title?: string;
}

// Единый значок площадки OZ/YM/WB. Цвета и код берутся из lib/platforms.
export default function PlatformBadge({ platform, style, title }: Props) {
    const m = platformMeta(platform);
    return (
        <span
            title={title ?? m.label}
            style={{
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                padding: '2px 5px',
                borderRadius: 4,
                letterSpacing: '0.3px',
                whiteSpace: 'nowrap',
                background: m.bg,
                color: m.fg,
                ...style,
            }}
        >
            {m.code}
        </span>
    );
}
