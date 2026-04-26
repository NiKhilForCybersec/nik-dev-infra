import { useEffect, useMemo, useState } from 'react';

type Severity = 'info' | 'warn' | 'error';

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
  lastFindingSeverity: Severity | null;
};

type Edge = { from: string; to: string; kind: EdgeKind; file?: string; line?: number };
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to' | 'calls' | 'invokes_llm' | 'tool_of' | 'persists_to' | 'renders';
type Graph = { nodes: { id: string; type: string; label: string }[]; edges: Edge[]; builtAt: number };

type Finding = {
  id: string; agent: string; kind: string; at: number;
  severity: Severity; summary: string; file?: string;
};

const EDGE_LABEL: Record<EdgeKind, string> = {
  reads: 'reads',
  writes: 'writes',
  dispatches: 'dispatches',
  navigates_to: 'navigates to',
  calls: 'calls',
  invokes_llm: 'invokes LLM',
  tool_of: 'tool of',
  persists_to: 'persists to',
  renders: 'renders',
};

const EDGE_COLOR: Record<EdgeKind, string> = {
  reads:        '#62b5ff',
  writes:       '#ffb86b',
  dispatches:   '#c389ff',
  navigates_to: '#5fd49a',
  calls:        '#c389ff',
  invokes_llm:  '#ff9bd2',
  tool_of:      '#ffe066',
  persists_to:  '#5fd49a',
  renders:      '#a4c4ff',
};

export function ScreensGallery({ onClose }: { onClose: () => void }) {
  const [screens, setScreens] = useState<Entity[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [screenshotPresent, setScreenshotPresent] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    Promise.all([
      fetch('/api/entities-rich').then((r) => r.json()).then((d: { entities: Entity[] }) => d.entities.filter((e) => e.kind === 'screen')),
      fetch('/api/graph').then((r) => r.json()).then((d: unknown) => (typeof d === 'string' ? JSON.parse(d) : d) as Graph),
      fetch('/api/snapshot').then((r) => r.json()).then((d: { findings: Finding[] }) => d.findings),
    ])
      .then(([s, g, f]) => { setScreens(s); setGraph(g); setFindings(f); })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Track which screens have screenshots so we can collapse the
  // placeholder noise when none exist.
  const noteScreenshot = (urn: string, present: boolean) => {
    setScreenshotPresent((prev) => {
      if (prev.get(urn) === present) return prev;
      const next = new Map(prev);
      next.set(urn, present);
      return next;
    });
  };
  const allEmpty = screens.length > 0 && [...screenshotPresent.values()].every((v) => !v) && screenshotPresent.size === screens.length;

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return screens
      .filter((e) => !f || e.label.toLowerCase().includes(f) || (e.segment ?? '').toLowerCase().includes(f))
      .sort((a, b) => (b.findingErr - a.findingErr) || (b.findingWarn - a.findingWarn) || a.label.localeCompare(b.label));
  }, [screens, filter]);

  // Outgoing edges for the selected screen, grouped by kind.
  const outgoing = useMemo(() => {
    if (!selected || !graph) return new Map<EdgeKind, Edge[]>();
    const m = new Map<EdgeKind, Edge[]>();
    for (const e of graph.edges) {
      if (e.from !== selected) continue;
      const list = m.get(e.kind) ?? [];
      list.push(e);
      m.set(e.kind, list);
    }
    return m;
  }, [selected, graph]);

  const incoming = useMemo(() => {
    if (!selected || !graph) return graph?.edges.filter((e) => e.to === selected) ?? [];
    return graph.edges.filter((e) => e.to === selected);
  }, [selected, graph]);

  const selectedEntity = selected ? screens.find((s) => s.urn === selected) ?? null : null;
  const selectedFindings = useMemo(() => {
    if (!selectedEntity) return [];
    return findings.filter((f) => f.file && f.file === selectedEntity.file).slice().reverse().slice(0, 30);
  }, [selectedEntity, findings]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>SCREENS · GALLERY</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{screens.length} screens · {filter ? `${sorted.length} matching` : 'all visible'}</div>
        </div>
        <input
          placeholder="filter by name or segment…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mono"
          style={{ minWidth: 240, padding: '4px 8px', fontSize: 12 }}
        />
        <button onClick={onClose} className="mono" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>×</button>
      </div>

      {error && <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {allEmpty && (
            <div className="glass" style={{ padding: 14, marginBottom: 16, borderColor: 'var(--warn)', background: 'rgba(255,209,102,0.06)' }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--warn)', letterSpacing: 1.5, marginBottom: 6 }}>NO SCREENSHOTS YET</div>
              <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5, marginBottom: 6 }}>
                The screenshots folder is empty. Paste this into your <code className="mono">~/NIK</code> Claude Code session to populate it:
              </div>
              <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', background: 'var(--surface)', padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap' }}>
{`Take screenshots of every screen in this app for the dev-infra dashboard.
The Vite dev server is at http://localhost:5173/. Use computer-use to:
1. Open the app
2. Tap each screen tile in the More menu (and Home, Chat, Profile etc.)
3. Save each as ~/NIK/docs/screenshots/<ScreenName>.png matching the
   class name (e.g. HomeScreen.png, HydrationScreen.png).`}
              </pre>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 8 }}>
                Or flip <code className="mono">writeback.enabled + insertClaudeMdGate</code> in <code className="mono">dev-infra.config.json</code> and the curator will instruct your Claude session to drop screenshots after every <code className="mono">*Screen.tsx</code> edit.
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            {sorted.map((e) => (
              <ScreenCard
                key={e.urn}
                entity={e}
                active={selected === e.urn}
                allEmpty={allEmpty}
                onClick={() => setSelected(e.urn)}
                onScreenshotKnown={(present) => noteScreenshot(e.urn, present)}
              />
            ))}
          </div>
        </div>

        {/* Drawer */}
        {selectedEntity && (
          <div style={{ width: 380, borderLeft: '1px solid var(--hairline)', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>SCREEN</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>{selectedEntity.label}</div>
            </div>

            <img
              src={`/api/screenshots/${encodeURIComponent(selectedEntity.urn)}?t=${Date.now()}`}
              alt={selectedEntity.label}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              style={{ width: '100%', borderRadius: 8, border: '1px solid var(--hairline)' }}
            />

            {selectedEntity.file && (
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-2)' }}>{selectedEntity.file}</div>
            )}
            {selectedEntity.segment && (
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>segment: <span style={{ color: 'var(--fg-2)' }}>{selectedEntity.segment}</span></div>
            )}

            <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              in:{selectedEntity.inDegree} · out:{selectedEntity.outDegree}
              {selectedEntity.findingErr > 0 && <span style={{ color: 'var(--err)' }}> · {selectedEntity.findingErr}e</span>}
              {selectedEntity.findingWarn > 0 && <span style={{ color: 'var(--warn)' }}> · {selectedEntity.findingWarn}w</span>}
            </div>

            {/* Outgoing edges, grouped by kind */}
            {(['reads', 'writes', 'dispatches', 'calls', 'invokes_llm', 'navigates_to', 'renders'] as EdgeKind[]).map((kind) => {
              const list = outgoing.get(kind);
              if (!list || list.length === 0) return null;
              return (
                <div key={kind}>
                  <div className="mono" style={{ fontSize: 10, color: EDGE_COLOR[kind], letterSpacing: 1.5, marginBottom: 4 }}>
                    {EDGE_LABEL[kind].toUpperCase()} · {list.length}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {list.map((e, i) => (
                      <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', cursor: kind === 'navigates_to' ? 'pointer' : 'default' }}
                           onClick={() => kind === 'navigates_to' && setSelected(e.to)}>
                        {e.to.replace(/^[^:]+:/, '')}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Incoming nav from other screens */}
            {(() => {
              const inboundNav = incoming.filter((e) => e.kind === 'navigates_to');
              if (inboundNav.length === 0) return null;
              return (
                <div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>
                    REACHED FROM · {inboundNav.length}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {inboundNav.map((e, i) => (
                      <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', cursor: 'pointer' }}
                           onClick={() => setSelected(e.from)}>
                        {e.from.replace(/^screen:/, '')}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {selectedFindings.length > 0 && (
              <div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>
                  RECENT FINDINGS · {selectedFindings.length}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {selectedFindings.map((f) => (
                    <div key={f.id} className="glass" style={{ padding: 8, borderLeft: `3px solid ${f.severity === 'error' ? 'var(--err)' : f.severity === 'warn' ? 'var(--warn)' : 'var(--info)'}` }}>
                      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>{f.agent} · {f.kind}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg)', marginTop: 2 }}>{f.summary}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScreenCard({ entity, active, allEmpty, onClick, onScreenshotKnown }: {
  entity: Entity;
  active: boolean;
  allEmpty: boolean;
  onClick: () => void;
  onScreenshotKnown: (present: boolean) => void;
}) {
  const status = entity.findingErr > 0 ? 'err' : entity.findingWarn > 0 ? 'warn' : 'unknown';
  const statusColor = status === 'err' ? 'var(--err)' : status === 'warn' ? 'var(--warn)' : 'var(--hairline)';
  return (
    <div
      onClick={onClick}
      className="glass"
      style={{
        padding: 8, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6,
        borderColor: active ? 'var(--accent)' : statusColor,
        borderWidth: active ? 2 : 1,
        background: active ? 'var(--accent-soft)' : 'var(--surface)',
      }}
    >
      <div style={{ aspectRatio: '9 / 16', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)', border: '1px solid var(--hairline)', position: 'relative' }}>
        <img
          src={`/api/screenshots/${encodeURIComponent(entity.urn)}`}
          alt={entity.label}
          loading="lazy"
          onLoad={() => onScreenshotKnown(true)}
          onError={(e) => {
            onScreenshotKnown(false);
            const el = e.currentTarget as HTMLImageElement;
            el.style.display = 'none';
            const sib = el.nextElementSibling as HTMLDivElement | null;
            if (sib && !allEmpty) sib.style.display = 'flex';
          }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <div style={{
          display: 'none', position: 'absolute', inset: 0,
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--fg-3)', fontSize: 9, padding: 8, textAlign: 'center',
        }} className="mono">
          no screenshot · ask Claude to save<br />docs/screenshots/{entity.label}.png
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entity.label}
      </div>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', display: 'flex', justifyContent: 'space-between' }}>
        <span>out:{entity.outDegree}</span>
        <span>
          {entity.findingErr > 0 && <span style={{ color: 'var(--err)' }}>{entity.findingErr}e </span>}
          {entity.findingWarn > 0 && <span style={{ color: 'var(--warn)' }}>{entity.findingWarn}w</span>}
        </span>
      </div>
    </div>
  );
}
