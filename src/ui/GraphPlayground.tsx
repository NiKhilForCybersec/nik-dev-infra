import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
// @ts-expect-error — fcose has no bundled types
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

type NodeType = 'screen' | 'op' | 'cmd' | 'endpoint' | 'llm_provider' | 'mcp_server' | 'mcp_tool';
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to' | 'calls' | 'invokes_llm' | 'tool_of';

type Node = { id: string; type: NodeType; label: string; file?: string };
type Edge = { from: string; to: string; kind: EdgeKind; file?: string; line?: number };
type Graph = { nodes: Node[]; edges: Edge[]; builtAt: number };

type Severity = 'info' | 'warn' | 'error';
type Finding = {
  id: string; agent: string; kind: string; at: number; severity: Severity;
  summary: string; file?: string; line?: number;
};

type Entity = {
  urn: string; kind: string; label: string; segment?: string;
  file?: string; evidence?: string[]; confidence: number; agent: string; at: number;
};

const NODE_COLOR: Record<NodeType, string> = {
  screen:       '#62b5ff',
  op:           '#7eb6a3',
  cmd:          '#c389ff',
  endpoint:     '#ffb86b',
  llm_provider: '#ff9bd2',
  mcp_server:   '#ffe066',
  mcp_tool:     '#fff0a3',
};

const EDGE_COLOR: Record<EdgeKind, string> = {
  reads:        '#62b5ff',
  writes:       '#ffb86b',
  dispatches:   '#c389ff',
  navigates_to: '#5fd49a',
  calls:        '#c389ff',
  invokes_llm:  '#ff9bd2',
  tool_of:      '#ffe066',
};

type Status = 'ok' | 'warn' | 'error' | 'unknown';
const STATUS_COLOR: Record<Status, string> = {
  ok:      '#5fd49a',
  warn:    '#ffd166',
  error:   '#ff6b6b',
  unknown: '#555568',
};

export function GraphPlayground({ onClose }: { onClose: () => void }) {
  const cyRef = useRef<HTMLDivElement | null>(null);
  const cyInstance = useRef<Core | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<Set<NodeType>>(new Set(Object.keys(NODE_COLOR) as NodeType[]));
  const [selected, setSelected] = useState<{ id: string; entity?: Entity; touching: Finding[] } | null>(null);

  // Load all three feeds in parallel.
  useEffect(() => {
    Promise.all([
      fetch('/api/graph').then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `graph: HTTP ${r.status}`);
        return r.json();
      }).then((d: unknown) => (typeof d === 'string' ? JSON.parse(d) : d) as Graph),
      fetch('/api/snapshot').then((r) => r.json()).then((d: { findings: Finding[] }) => d.findings),
      fetch('/api/register').then((r) => r.json()).then((d: { entities: Entity[] }) => d.entities),
    ])
      .then(([g, f, e]) => {
        setGraph(g);
        setFindings(f);
        setEntities(e);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Per-URN status: error if any error finding mentions the URN's file or label;
  // warn if any warn finding does; unknown otherwise. Hard-path: unknown stays
  // unknown — we don't paint green by default.
  const statusByUrn = useMemo<Map<string, Status>>(() => {
    const m = new Map<string, Status>();
    if (!graph) return m;
    const byFile = new Map<string, { e: number; w: number; i: number }>();
    for (const f of findings) {
      if (!f.file) continue;
      const cur = byFile.get(f.file) ?? { e: 0, w: 0, i: 0 };
      if (f.severity === 'error') cur.e++;
      else if (f.severity === 'warn') cur.w++;
      else cur.i++;
      byFile.set(f.file, cur);
    }
    for (const n of graph.nodes) {
      const ent = entities.find((x) => x.urn === n.id);
      const file = n.file ?? ent?.file ?? null;
      if (!file) { m.set(n.id, 'unknown'); continue; }
      const c = byFile.get(file);
      if (!c) { m.set(n.id, 'unknown'); continue; }
      if (c.e > 0) m.set(n.id, 'error');
      else if (c.w > 0) m.set(n.id, 'warn');
      else m.set(n.id, 'ok');
    }
    return m;
  }, [graph, findings, entities]);

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!graph) return [];
    const f = filter.trim().toLowerCase();
    const nodeMatches = (n: Node) =>
      selectedTypes.has(n.type) &&
      (!f || n.label.toLowerCase().includes(f) || n.id.toLowerCase().includes(f));
    const visibleNodeIds = new Set(graph.nodes.filter(nodeMatches).map((n) => n.id));
    const els: ElementDefinition[] = [];
    for (const n of graph.nodes) {
      if (!visibleNodeIds.has(n.id)) continue;
      const status = statusByUrn.get(n.id) ?? 'unknown';
      els.push({
        data: {
          id: n.id,
          label: n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label,
          type: n.type,
          status,
        },
      });
    }
    for (const e of graph.edges) {
      if (!visibleNodeIds.has(e.from) || !visibleNodeIds.has(e.to)) continue;
      els.push({
        data: { id: `${e.from}->${e.to}->${e.kind}`, source: e.from, target: e.to, kind: e.kind },
      });
    }
    return els;
  }, [graph, filter, selectedTypes, statusByUrn]);

  // Mount cytoscape once; rebuild elements + relayout on filter change.
  useEffect(() => {
    if (!cyRef.current) return;
    if (!cyInstance.current) {
      cyInstance.current = cytoscape({
        container: cyRef.current,
        elements: [],
        wheelSensitivity: 0.2,
        minZoom: 0.1,
        maxZoom: 4,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': (ele: any) => NODE_COLOR[ele.data('type') as NodeType] ?? '#888',
              'border-width': 3,
              'border-color': (ele: any) => STATUS_COLOR[ele.data('status') as Status] ?? '#555',
              'label': 'data(label)',
              'color': '#e8e8ec',
              'font-family': 'JetBrains Mono, monospace',
              'font-size': 9,
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-outline-width': 2,
              'text-outline-color': '#0a0a0e',
              'width': 18,
              'height': 18,
            },
          },
          {
            selector: 'node:selected',
            style: { 'border-width': 5, 'border-color': '#ffffff' },
          },
          {
            selector: 'edge',
            style: {
              'width': 1.4,
              'line-color': (ele: any) => EDGE_COLOR[ele.data('kind') as EdgeKind] ?? '#555',
              'target-arrow-color': (ele: any) => EDGE_COLOR[ele.data('kind') as EdgeKind] ?? '#555',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'opacity': 0.55,
              'arrow-scale': 0.8,
            },
          },
          {
            selector: 'edge:selected',
            style: { 'opacity': 1, 'width': 2.5 },
          },
        ],
      });
      cyInstance.current.on('tap', 'node', (evt) => {
        const id = evt.target.id() as string;
        const entity = entities.find((e) => e.urn === id);
        const touching = findings.filter((f) =>
          (entity?.file && f.file === entity.file) ||
          f.summary.includes(id) ||
          f.summary.includes(id.replace(/^[^:]+:/, '')),
        );
        setSelected({ id, entity, touching });
      });
      cyInstance.current.on('tap', (evt) => {
        if (evt.target === cyInstance.current) setSelected(null);
      });
    }
    const cy = cyInstance.current;
    cy.elements().remove();
    cy.add(elements);
    cy.layout({
      name: 'fcose',
      animate: false,
      randomize: true,
      nodeRepulsion: 4500,
      idealEdgeLength: 80,
      gravity: 0.3,
      numIter: 2500,
    } as any).run();
    cy.fit(undefined, 30);
  }, [elements, entities, findings]);

  // Keep the cytoscape instance through unmount.
  useEffect(() => () => { cyInstance.current?.destroy(); cyInstance.current = null; }, []);

  const counts = useMemo(() => {
    const c: Partial<Record<NodeType, number>> = {};
    if (graph) for (const n of graph.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [graph]);

  const statusCounts = useMemo(() => {
    let ok = 0, warn = 0, err = 0, unk = 0;
    for (const s of statusByUrn.values()) {
      if (s === 'ok') ok++;
      else if (s === 'warn') warn++;
      else if (s === 'error') err++;
      else unk++;
    }
    return { ok, warn, err, unk };
  }, [statusByUrn]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>GRAPH PLAYGROUND</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : (error ? 'error' : 'loading…')}
          </div>
        </div>
        <input
          placeholder="filter nodes by label / urn…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mono"
          style={{ minWidth: 220, padding: '4px 8px', fontSize: 12 }}
        />
        <div className="mono" style={{ display: 'flex', gap: 8, fontSize: 10 }}>
          {(Object.keys(NODE_COLOR) as NodeType[]).map((t) => {
            const on = selectedTypes.has(t);
            return (
              <button
                key={t}
                onClick={() => {
                  const next = new Set(selectedTypes);
                  on ? next.delete(t) : next.add(t);
                  setSelectedTypes(next);
                }}
                style={{
                  padding: '2px 8px', fontSize: 10,
                  background: on ? NODE_COLOR[t] + '33' : 'transparent',
                  borderColor: on ? NODE_COLOR[t] : 'var(--hairline)',
                  color: on ? NODE_COLOR[t] : 'var(--fg-3)',
                }}
              >● {t} {counts[t] !== undefined ? counts[t] : ''}</button>
            );
          })}
        </div>
        <div className="mono" style={{ marginLeft: 'auto', fontSize: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: STATUS_COLOR.ok }}>● ok {statusCounts.ok}</span>
          <span style={{ color: STATUS_COLOR.warn }}>● warn {statusCounts.warn}</span>
          <span style={{ color: STATUS_COLOR.error }}>● err {statusCounts.err}</span>
          <span style={{ color: STATUS_COLOR.unknown }}>● unknown {statusCounts.unk}</span>
          <button onClick={onClose} className="mono" style={{ padding: '4px 10px', fontSize: 12 }}>×</button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={cyRef} style={{ flex: 1, background: 'var(--bg)' }} />

        {/* Side panel: selected entity drill-down */}
        {selected && (
          <div style={{ width: 360, borderLeft: '1px solid var(--hairline)', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>{selected.entity?.kind ?? '—'}</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>{selected.id}</div>
            </div>
            {selected.entity?.file && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>{selected.entity.file}</div>
            )}
            {selected.entity?.segment && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>segment: <span style={{ color: 'var(--fg-2)' }}>{selected.entity.segment}</span></div>
            )}
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
              status: <span style={{ color: STATUS_COLOR[statusByUrn.get(selected.id) ?? 'unknown'] }}>{statusByUrn.get(selected.id) ?? 'unknown'}</span>
              {' · '}registered by <span style={{ color: 'var(--fg-2)' }}>{selected.entity?.agent ?? '—'}</span>
              {' · '}confidence <span style={{ color: 'var(--fg-2)' }}>{selected.entity?.confidence?.toFixed(2) ?? '—'}</span>
            </div>
            {selected.entity?.evidence && selected.entity.evidence.length > 0 && (
              <div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>EVIDENCE</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {selected.entity.evidence.map((e, i) => (
                    <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--fg-2)' }}>{e}</div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>
                FINDINGS · {selected.touching.length}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {selected.touching.length === 0 && (
                  <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>no findings touching this entity</div>
                )}
                {selected.touching.slice().reverse().slice(0, 30).map((f) => (
                  <div key={f.id} className="glass" style={{ padding: 8, borderLeft: `3px solid ${f.severity === 'error' ? STATUS_COLOR.error : f.severity === 'warn' ? STATUS_COLOR.warn : 'var(--info)'}` }}>
                    <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>{f.agent} · {f.kind}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg)', marginTop: 2 }}>{f.summary}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
