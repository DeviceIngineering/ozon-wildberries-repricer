import { useState, useEffect, useRef } from 'react';

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export default function DocsPage() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/docs')
      .then(r => r.text())
      .then(setText)
      .catch(() => setText('Не удалось загрузить документацию'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div style={{ padding: '24px', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Загрузка...</div>;
  }

  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  const toc: TocItem[] = [];
  let i = 0;
  let key = 0;

  const makeId = (text: string) => text.replace(/[^a-zа-яё0-9]/gi, '-').toLowerCase();

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={key++} style={{ background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: '6px', fontSize: '0.68rem', overflow: 'auto', margin: '4px 0' }}>
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    if (line.startsWith('# ')) {
      const txt = line.slice(2);
      const id = makeId(txt);
      toc.push({ id, text: txt, level: 1 });
      elements.push(<h1 key={key++} id={id} style={{ fontSize: '1.1rem', marginTop: '20px', marginBottom: '6px' }}>{txt}</h1>);
    } else if (line.startsWith('## ')) {
      const txt = line.slice(3);
      const id = makeId(txt);
      toc.push({ id, text: txt, level: 2 });
      elements.push(<h2 key={key++} id={id} style={{ fontSize: '0.88rem', marginTop: '16px', marginBottom: '4px', borderBottom: '1px solid var(--glass-border)', paddingBottom: '3px' }}>{txt}</h2>);
    } else if (line.startsWith('### ')) {
      const txt = line.slice(4);
      const id = makeId(txt);
      toc.push({ id, text: txt, level: 3 });
      elements.push(<h3 key={key++} id={id} style={{ fontSize: '0.78rem', marginTop: '10px', marginBottom: '2px', color: 'var(--accent-color)' }}>{txt}</h3>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={key++} style={{ fontSize: '0.73rem', marginLeft: '14px', lineHeight: '1.5' }}>{formatInline(line.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(line)) {
      elements.push(<li key={key++} style={{ fontSize: '0.73rem', marginLeft: '14px', lineHeight: '1.5', listStyleType: 'decimal' }}>{formatInline(line.replace(/^\d+\.\s/, ''))}</li>);
    } else if (line.trim() === '') {
      elements.push(<div key={key++} style={{ height: '4px' }} />);
    } else {
      elements.push(<p key={key++} style={{ fontSize: '0.73rem', lineHeight: '1.5', margin: '1px 0' }}>{formatInline(line)}</p>);
    }
    i++;
  }

  return (
    <div style={{ padding: '12px 20px', maxWidth: '800px', color: 'var(--text-primary)' }} ref={contentRef}>
      {/* TOC */}
      {toc.length > 0 && (
        <nav style={{
          background: 'rgba(0,0,0,0.2)',
          border: '1px solid var(--glass-border)',
          borderRadius: '8px',
          padding: '10px 14px',
          marginBottom: '16px',
        }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
            Содержание
          </div>
          {toc.map((item, idx) => (
            <a
              key={idx}
              href={`#${item.id}`}
              style={{
                display: 'block',
                fontSize: item.level === 1 ? '0.73rem' : item.level === 2 ? '0.7rem' : '0.67rem',
                paddingLeft: item.level === 1 ? '0' : item.level === 2 ? '12px' : '24px',
                lineHeight: '1.7',
                color: item.level <= 2 ? 'var(--text-primary)' : 'var(--text-secondary)',
                textDecoration: 'none',
              }}
            >
              {item.text}
            </a>
          ))}
        </nav>
      )}
      {elements}
    </div>
  );
}

function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
