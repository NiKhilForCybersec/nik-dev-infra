import { useEffect, useMemo, useState } from 'react';

type NodeType = 'screen' | 'op' | 'cmd';
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to';
type Node = { id: string; type: NodeType; label: string; file?: string };
type Edge = { from: string; to: string; kind: EdgeKind };
type Graph = { nodes: Node[]; edges: Edge[]; builtAt: number };

const EDGE_COLOR: Record<EdgeKind, string> = {
  reads: 'var(--info)',
  writes: 'var(--warn)',
  dispatches: 'var(--accent)',
  navigates_to: 'var(--ok)',
};

export function GraphPanel({ onClose }: { onClose: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/graph')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => setGraph(typeof data === 'string' ? JSON.parse(data) : data))
      .catch((e) => setError((e as Error).message));
  }, []);

  const grouped = useMemo(() => {
    if (!graph) return [];
    const screens = graph.nodes.filter((n) => n.type === 'screen');
    return screens
      .filter((s) => !filter || s.label.toLowerCase().includes(filter.toLowerCase()))
      .map((screen) => ({
        screen,
        edges: graph.edges.filter((e) => e.from === screen.id),
      }))
      .sort((a, b) => b.edges.length - a.edges.length);
  }, [graph, filter]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass" style={{
        background: 'var(--bg)', width: 'min(900px, 95vw)', height: 'min(700px, 90vh)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
          <div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>PROJECT TOPOLOGY</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
              {graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : 'loading…'}
            </div>
          </div>
          <button onClick={onClose} className="mono" aria-label="close graph" style={{ padding: '4px 10px', fontSize: 12 }}>×</button>
        </div>

        {error && (
          <div style={{ padding: 18, color: 'var(--err)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
            {error}
          </div>
        )}

        {graph && (
          <>
            <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="filter screens…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ flex: 1, minWidth: 160, padding: '4px 8px', fontSize: 12 }}
              />
              <Legend />
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                built {new Date(graph.builtAt).toLocaleTimeString()}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {grouped.length === 0 && (
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  no screens match filter
                </div>
              )}
              {grouped.map(({ screen, edges }) => (
                <div key={screen.id} className="glass" style={{ padding: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>{screen.label}</div>
                    {screen.file && <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>{screen.file}</div>}
                  </div>
                  {edges.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
                      {(['reads', 'writes', 'dispatches', 'navigates_to'] as EdgeKind[]).map((kind) => {
                        const ks = edges.filter((e) => e.kind === kind);
                        if (ks.length === 0) return null;
                        return (
                          <div key={kind} className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                            <span style={{ color: EDGE_COLOR[kind], display: 'inline-block', minWidth: 90 }}>
                              {kind}
                            </span>
                            {ks.map((e) => e.to.replace(/^screen:/, '')).join(' · ')}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 6 }}>(no manifest edges)</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mono" style={{ display: 'flex', gap: 10, fontSize: 10 }}>
      {(['reads', 'writes', 'dispatches', 'navigates_to'] as EdgeKind[]).map((k) => (
        <span key={k} style={{ color: EDGE_COLOR[k] }}>● {k}</span>
      ))}
    </div>
  );
}
