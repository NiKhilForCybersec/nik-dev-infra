import { useEffect, useMemo, useState } from 'react';

type Entity = {
  urn: string;
  kind: string;
  label: string;
  segment?: string;
  file?: string;
  evidence?: string[];
  confidence: number;
  agent: string;
  at: number;
  inDegree: number;
  outDegree: number;
  findingTotal: number;
  findingErr: number;
  findingWarn: number;
  lastFindingAt: number | null;
  lastFindingKind: string | null;
  lastFindingSeverity: 'info' | 'warn' | 'error' | null;
};

const KIND_ORDER: string[] = [
  'screen', 'op', 'cmd', 'endpoint', 'llm_provider',
  'mcp_server', 'mcp_tool', 'table', 'component', 'self',
];

const KIND_LABEL: Record<string, string> = {
  screen: 'Screens', op: 'Ops', cmd: 'Commands', endpoint: 'Endpoints',
  llm_provider: 'LLM Providers', mcp_server: 'MCP Servers', mcp_tool: 'MCP Tools',
  table: 'Tables', component: 'Components', self: 'Self',
};

const KIND_COLOR: Record<string, string> = {
  screen: '#62b5ff', op: '#7eb6a3', cmd: '#c389ff', endpoint: '#ffb86b',
  llm_provider: '#ff9bd2', mcp_server: '#ffe066', mcp_tool: '#fff0a3',
  table: '#5fd49a', component: '#a4c4ff', self: '#888',
};

export function EntitiesPanel({ onClose }: { onClose: () => void }) {
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/entities-rich')
      .then((r) => r.json())
      .then((d: { entities: Entity[] }) => setEntities(d.entities))
      .catch((e) => setError((e as Error).message));
  }, []);

  const byKind = useMemo(() => {
    const m = new Map<string, Entity[]>();
    if (!entities) return m;
    for (const e of entities) {
      const list = m.get(e.kind) ?? [];
      list.push(e);
      m.set(e.kind, list);
    }
    for (const list of m.values()) list.sort((a, b) => (b.findingErr - a.findingErr) || (b.findingWarn - a.findingWarn) || (b.findingTotal - a.findingTotal) || a.label.localeCompare(b.label));
    return m;
  }, [entities]);

  const orderedKinds = useMemo(() => {
    const present = [...byKind.keys()];
    return [...KIND_ORDER, ...present.filter((k) => !KIND_ORDER.includes(k))].filter((k) => byKind.has(k));
  }, [byKind]);

  const currentKind = activeKind && byKind.has(activeKind) ? activeKind : (orderedKinds[0] ?? null);
  const visible = currentKind ? (byKind.get(currentKind) ?? []) : [];
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? visible.filter((e) => e.label.toLowerCase().includes(f) || e.urn.toLowerCase().includes(f) || (e.file ?? '').toLowerCase().includes(f))
    : visible;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>ENTITIES · DRILL-DOWN</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {entities ? `${entities.length} total` : (error ? 'error' : 'loading…')}
          </div>
        </div>
        <input
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mono"
          style={{ minWidth: 200, padding: '4px 8px', fontSize: 12 }}
        />
        <button onClick={onClose} className="mono" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>×</button>
      </div>

      {error && <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>}

      {entities && (
        <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          {/* Tabs (left) */}
          <div style={{ width: 200, borderRight: '1px solid var(--hairline)', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {orderedKinds.map((k) => {
              const list = byKind.get(k) ?? [];
              const errs = list.reduce((a, e) => a + e.findingErr, 0);
              const warns = list.reduce((a, e) => a + e.findingWarn, 0);
              return (
                <button
                  key={k}
                  onClick={() => setActiveKind(k)}
                  className="mono"
                  style={{
                    textAlign: 'left', padding: '8px 10px', fontSize: 11,
                    borderColor: currentKind === k ? KIND_COLOR[k] ?? 'var(--accent)' : 'var(--hairline)',
                    background: currentKind === k ? `${KIND_COLOR[k] ?? '#fff'}22` : 'transparent',
                    color: currentKind === k ? (KIND_COLOR[k] ?? 'var(--fg)') : 'var(--fg-2)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                >
                  <span>{KIND_LABEL[k] ?? k}</span>
                  <span style={{ fontSize: 9, color: 'var(--fg-3)' }}>
                    {errs > 0 && <span style={{ color: 'var(--err)' }}>{errs}e </span>}
                    {warns > 0 && <span style={{ color: 'var(--warn)' }}>{warns}w </span>}
                    {list.length}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Rows (right) */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {filtered.length === 0 ? (
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>no entities match</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {filtered.map((e) => (
                  <EntityRow key={e.urn} e={e} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EntityRow({ e }: { e: Entity }) {
  const lastSevColor = e.lastFindingSeverity === 'error' ? 'var(--err)'
    : e.lastFindingSeverity === 'warn' ? 'var(--warn)' : 'var(--fg-3)';
  return (
    <div className="glass" style={{ padding: 8, borderLeft: `3px solid ${KIND_COLOR[e.kind] ?? 'var(--hairline)'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>{e.label}</div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', display: 'flex', gap: 10 }}>
          <span>in:{e.inDegree}</span>
          <span>out:{e.outDegree}</span>
          {e.findingErr > 0 && <span style={{ color: 'var(--err)' }}>{e.findingErr}e</span>}
          {e.findingWarn > 0 && <span style={{ color: 'var(--warn)' }}>{e.findingWarn}w</span>}
          {e.findingTotal > 0 && <span>{e.findingTotal}f</span>}
          {e.segment && <span>seg:{e.segment}</span>}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 2, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span>{e.urn}</span>
        {e.file && <span>{e.file}</span>}
      </div>
      {e.lastFindingAt && (
        <div className="mono" style={{ fontSize: 9, marginTop: 2, color: lastSevColor }}>
          last finding: {e.lastFindingKind} · {ago(e.lastFindingAt)}
        </div>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
