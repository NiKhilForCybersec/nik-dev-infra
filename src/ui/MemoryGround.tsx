import { useEffect, useMemo, useState } from 'react';

/* MEMORY GROUND — full-screen overlay panel showing the live state of
 * dev-infra's per-project memory. Polls /api/memory/feed every 5s and
 * lets the user filter by layer / search / time-range, drill into any
 * row, and drop a note inline.
 *
 * Layers surfaced:
 *   notes      — agent K/V scratchpad
 *   facts      — S-P-O triples (the graph)
 *   wiki       — long-form per (segment, topic)
 *   register   — URN-keyed entity catalog
 *   approvals  — pending decisions waiting for human review
 */

type Layer = 'all' | 'notes' | 'facts' | 'wiki' | 'register' | 'approvals';
type TimeRange = 'all' | '1h' | '24h' | '7d';

type FeedRow = {
  layer: Layer;
  at: number;
  at_iso: string;
  primary: string;
  secondary: string;
  raw: Record<string, unknown>;
};

type FeedResponse = {
  rows: FeedRow[];
  counts: { notes: number; facts: number; wiki: number; register: number; approvals_pending: number };
};

const LAYER_COLORS: Record<Layer, string> = {
  all:       'var(--accent)',
  notes:     '#62b5ff',
  facts:     '#7eb6a3',
  wiki:      '#a4c4ff',
  register:  '#c389ff',
  approvals: '#ffd166',
};

function ago(ts: number): string {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86_400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86_400)}d ago`;
}

export function MemoryGround({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [layer, setLayer] = useState<Layer>('all');
  const [search, setSearch] = useState('');
  const [time, setTime] = useState<TimeRange>('24h');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline note-drop
  const [noteText, setNoteText] = useState('');
  const [noteScope, setNoteScope] = useState('session');
  const [noteSaving, setNoteSaving] = useState(false);

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (layer !== 'all') params.set('layer', layer);
      if (search.trim()) params.set('query', search.trim());
      if (time !== 'all') params.set('hours', time === '1h' ? '1' : time === '24h' ? '24' : '168');
      params.set('limit', '100');
      const r = await fetch(`/api/memory/feed?${params.toString()}`);
      // Daemon may briefly 500 during hot-reload; surface but keep polling.
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as FeedResponse;
      setData(d);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, search, time]);

  const dropNote = async () => {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    try {
      const r = await fetch('/api/memory/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: noteText.trim(), scope: noteScope.trim() || 'session' }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
      setNoteText('');
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setNoteSaving(false); }
  };

  const counts = data?.counts;
  const rows = data?.rows ?? [];

  // Group by layer for the right-pane breakdown
  const byLayer = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.layer] = (m[r.layer] ?? 0) + 1;
    return m;
  }, [rows]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>MEMORY GROUND · LIVE</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {counts ? `${counts.notes + counts.facts + counts.wiki + counts.register} rows total · ${counts.approvals_pending} pending approval${counts.approvals_pending === 1 ? '' : 's'}` : 'loading…'}
          </div>
        </div>
        <input
          type="search"
          placeholder="search across layers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mono"
          style={{ flex: 1, minWidth: 220, padding: '4px 8px', fontSize: 12 }}
        />
        <button onClick={onClose} className="mono" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>×</button>
      </div>

      {/* Filter row */}
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['all', 'notes', 'facts', 'wiki', 'register', 'approvals'] as Layer[]).map((l) => {
            const active = layer === l;
            const labelCount = l === 'all' ? '' : (
              counts ? ` ${l === 'approvals' ? counts.approvals_pending : (counts as Record<string, number>)[l] ?? 0}` : ''
            );
            return (
              <button
                key={l}
                onClick={() => setLayer(l)}
                className="mono"
                style={{
                  padding: '3px 8px', fontSize: 10, letterSpacing: 0.5,
                  background: active ? LAYER_COLORS[l] + '22' : 'transparent',
                  borderColor: active ? LAYER_COLORS[l] : 'var(--hairline)',
                  color: active ? LAYER_COLORS[l] : 'var(--fg-2)',
                }}
              >{l.toUpperCase()}{labelCount}</button>
            );
          })}
        </div>
        <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>WINDOW</span>
        {(['1h', '24h', '7d', 'all'] as TimeRange[]).map((t) => (
          <button
            key={t}
            onClick={() => setTime(t)}
            className="mono"
            style={{
              padding: '3px 8px', fontSize: 10,
              background: time === t ? 'var(--accent-soft)' : 'transparent',
              borderColor: time === t ? 'var(--accent)' : 'var(--hairline)',
              color: time === t ? 'var(--accent)' : 'var(--fg-2)',
            }}
          >{t === 'all' ? 'ALL' : t.toUpperCase()}</button>
        ))}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-3)' }}>
          {rows.length} matching
        </span>
      </div>

      {/* Inline note drop */}
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--surface)' }}>
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1.5 }}>DROP NOTE</span>
        <input
          placeholder="something to remember…"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !noteSaving) void dropNote(); }}
          className="mono"
          style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
        />
        <input
          placeholder="scope"
          value={noteScope}
          onChange={(e) => setNoteScope(e.target.value)}
          className="mono"
          title="memory segment, e.g. project:memory_os / session / global"
          style={{ width: 140, padding: '4px 8px', fontSize: 11 }}
        />
        <button
          onClick={() => void dropNote()}
          disabled={noteSaving || !noteText.trim()}
          className="mono"
          style={{
            padding: '4px 12px', fontSize: 11,
            color: noteSaving || !noteText.trim() ? 'var(--fg-3)' : 'var(--accent)',
            borderColor: noteSaving || !noteText.trim() ? 'var(--hairline)' : 'var(--accent)',
            cursor: noteSaving ? 'wait' : 'pointer',
          }}
        >{noteSaving ? 'SAVING…' : 'SAVE'}</button>
      </div>

      {error && <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>}

      {/* Live feed */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        {rows.length === 0 ? (
          <div className="glass" style={{ padding: 24, textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: 1 }}>NO MEMORY ROWS</div>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 8 }}>
              {search || time !== 'all' || layer !== 'all'
                ? 'No memory matches your current filters.'
                : 'Memory is empty. Wait for the agents to populate, or drop a note above.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((r, i) => {
              const id = `${r.layer}-${r.at}-${i}`;
              const isOpen = expanded === id;
              return (
                <div
                  key={id}
                  onClick={() => setExpanded(isOpen ? null : id)}
                  className="glass"
                  style={{
                    padding: 10,
                    cursor: 'pointer',
                    borderLeft: `3px solid ${LAYER_COLORS[r.layer]}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 9, color: LAYER_COLORS[r.layer], letterSpacing: 1 }}>
                      {r.layer.toUpperCase()}
                    </span>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>{ago(r.at)}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg)', flex: 1, wordBreak: 'break-all' }}>{r.primary}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
                    {r.secondary}
                  </div>
                  {isOpen && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
                      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1, marginBottom: 4 }}>RAW ROW</div>
                      <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto', background: 'var(--surface)', padding: 8, borderRadius: 4 }}>
                        {JSON.stringify(r.raw, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer counts */}
      {Object.keys(byLayer).length > 0 && (
        <div style={{ padding: '8px 18px', borderTop: '1px solid var(--hairline)', display: 'flex', gap: 14, fontSize: 10 }} className="mono">
          {Object.entries(byLayer).map(([l, n]) => (
            <span key={l} style={{ color: LAYER_COLORS[l as Layer] ?? 'var(--fg-3)' }}>
              ● {l} {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
