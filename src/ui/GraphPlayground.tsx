import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
// @ts-expect-error — fcose has no bundled types
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

type NodeType = 'screen' | 'op' | 'cmd' | 'endpoint' | 'llm_provider' | 'mcp_server' | 'mcp_tool' | 'table' | 'component';
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to' | 'calls' | 'invokes_llm' | 'tool_of' | 'persists_to' | 'renders';

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
  table:        '#5fd49a',
  component:    '#a4c4ff',
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

type Status = 'ok' | 'warn' | 'error' | 'orphan' | 'silent' | 'unknown';
const STATUS_COLOR: Record<Status, string> = {
  ok:      '#5fd49a',
  warn:    '#ffd166',
  error:   '#ff6b6b',
  orphan:  '#c389ff',
  silent:  '#7a7a8c',
  unknown: '#555568',
};
const SILENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;     // 24h with no activity = silent

export function GraphPlayground({ onClose }: { onClose: () => void }) {
  const cyRef = useRef<HTMLDivElement | null>(null);
  const cyInstance = useRef<Core | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<Set<NodeType>>(new Set(Object.keys(NODE_COLOR) as NodeType[]));
  const [selectedStatuses, setSelectedStatuses] = useState<Set<Status>>(new Set(Object.keys(STATUS_COLOR) as Status[]));
  const [selected, setSelected] = useState<{ id: string; entity?: Entity; touching: Finding[] } | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

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

  // Per-URN status — hard-path priority order:
  //   error  : any error finding hits the URN's file
  //   warn   : any warn finding hits the URN's file
  //   orphan : 0 in-edges AND 0 out-edges (the registry knows about it but
  //            nothing wires to/from it — that's a real concern)
  //   silent : has edges but no entity activity in the last 24h (the system
  //            forgot about it; could be stale code or missing instrumentation)
  //   ok     : has edges + recent activity + no findings (positive evidence)
  //   unknown: missing the data needed to judge — never paint green by default
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
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const e of graph.edges) {
      outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
    const now = Date.now();
    for (const n of graph.nodes) {
      const ent = entities.find((x) => x.urn === n.id);
      const file = n.file ?? ent?.file ?? null;
      const c = file ? byFile.get(file) : undefined;
      if (c?.e) { m.set(n.id, 'error'); continue; }
      if (c?.w) { m.set(n.id, 'warn'); continue; }
      const inD = inDeg.get(n.id) ?? 0;
      const outD = outDeg.get(n.id) ?? 0;
      if (inD === 0 && outD === 0) { m.set(n.id, 'orphan'); continue; }
      if (!ent) { m.set(n.id, 'unknown'); continue; }
      if (now - ent.at > SILENT_THRESHOLD_MS) { m.set(n.id, 'silent'); continue; }
      if (file && c) { m.set(n.id, 'ok'); continue; }
      m.set(n.id, 'unknown');
    }
    return m;
  }, [graph, findings, entities]);

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!graph) return [];
    const f = filter.trim().toLowerCase();
    // Type filter HIDES nodes; status filter DIMS them (so the user can
    // still see structural context when isolating a status — e.g. "show
    // only orphans + their neighbours" reads better than "hide everything
    // that isn't orphan").
    const visible = (n: Node) =>
      selectedTypes.has(n.type) &&
      (!f || n.label.toLowerCase().includes(f) || n.id.toLowerCase().includes(f));
    const visibleNodeIds = new Set(graph.nodes.filter(visible).map((n) => n.id));
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
          dimmed: !selectedStatuses.has(status),
        },
      });
    }
    for (const e of graph.edges) {
      if (!visibleNodeIds.has(e.from) || !visibleNodeIds.has(e.to)) continue;
      const fromStatus = statusByUrn.get(e.from) ?? 'unknown';
      const toStatus = statusByUrn.get(e.to) ?? 'unknown';
      // An edge dims if EITHER endpoint dims — keeps focused subgraph crisp.
      els.push({
        data: {
          id: `${e.from}->${e.to}->${e.kind}`,
          source: e.from, target: e.to, kind: e.kind,
          dimmed: !selectedStatuses.has(fromStatus) || !selectedStatuses.has(toStatus),
        },
      });
    }
    return els;
  }, [graph, filter, selectedTypes, selectedStatuses, statusByUrn]);

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
            selector: 'node[?dimmed]',
            style: { 'opacity': 0.12 },
          },
          {
            selector: 'edge[?dimmed]',
            style: { 'opacity': 0.06 },
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
      // Hover tooltip — track the rendered (canvas) position so the
      // overlay div can be positioned over the cytoscape container.
      cyInstance.current.on('mouseover', 'node', (evt) => {
        const id = evt.target.id() as string;
        const pos = evt.target.renderedPosition();
        setHover({ id, x: pos.x, y: pos.y });
      });
      cyInstance.current.on('mouseout', 'node', () => setHover(null));
      // Persist drag — when the user moves a node, save the new position
      // so it sticks across reloads. Debounced via dragfree (fires once
      // when the mouse releases, not for every pixel of drag).
      cyInstance.current.on('dragfree', 'node', () => {
        if (!cyInstance.current) return;
        try {
          const snapshot: Record<string, { x: number; y: number }> = {};
          cyInstance.current.nodes().forEach((n) => {
            const p = n.position();
            snapshot[n.id() as string] = { x: p.x, y: p.y };
          });
          localStorage.setItem('dev-infra:graph-positions', JSON.stringify(snapshot));
        } catch { /* */ }
      });
      // Keep the tooltip glued to the node when the user pans / zooms.
      cyInstance.current.on('pan zoom', () => {
        setHover((prev) => {
          if (!prev || !cyInstance.current) return prev;
          const node = cyInstance.current.getElementById(prev.id);
          if (!node || node.empty()) return null;
          const pos = node.renderedPosition();
          return { id: prev.id, x: pos.x, y: pos.y };
        });
      });
    }
    const cy = cyInstance.current;
    cy.elements().remove();
    cy.add(elements);

    // Sticky positions across reloads — load saved positions per node id;
    // if ≥80% of currently-visible nodes have a saved position, use the
    // 'preset' layout (instant, preserves the user's mental map). Otherwise
    // fall back to fcose so newly-added nodes get sensible coordinates.
    let usedPreset = false;
    try {
      const raw = localStorage.getItem('dev-infra:graph-positions');
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, { x: number; y: number }>;
        let withPos = 0;
        cy.nodes().forEach((n) => {
          const p = saved[n.id() as string];
          if (p) { n.position(p); withPos++; }
        });
        if (cy.nodes().length > 0 && withPos / cy.nodes().length >= 0.8) {
          cy.layout({ name: 'preset', animate: false } as any).run();
          cy.fit(undefined, 40);
          usedPreset = true;
        }
      }
    } catch { /* */ }

    if (!usedPreset) cy.layout({
      name: 'fcose',
      animate: false,
      randomize: true,
      // Tuned for Nik's ~160-node graph: more repulsion + longer edges so
      // dense hubs (items.* fans, ui.* command cluster) breathe instead
      // of pancake-stacking. componentSpacing pushes disconnected
      // sub-graphs (FamilyOps / Cycle / Chat) apart.
      nodeRepulsion: 12000,
      idealEdgeLength: 130,
      edgeElasticity: 0.45,
      nodeSeparation: 90,
      gravity: 0.18,
      gravityRangeCompound: 1.5,
      componentSpacing: 120,
      tile: true,
      tilingPaddingVertical: 20,
      tilingPaddingHorizontal: 20,
      numIter: 3500,
    } as any).run();
    if (!usedPreset) cy.fit(undefined, 40);

    // Persist positions after either layout settles. Fcose with
    // animate:false is synchronous, preset is too — positions are final
    // immediately. Snapshot every visible node so future reloads land on
    // the same map.
    try {
      const snapshot: Record<string, { x: number; y: number }> = {};
      cy.nodes().forEach((n) => {
        const p = n.position();
        snapshot[n.id() as string] = { x: p.x, y: p.y };
      });
      localStorage.setItem('dev-infra:graph-positions', JSON.stringify(snapshot));
    } catch { /* localStorage may be full or disabled */ }
  }, [elements, entities, findings]);

  // Keep the cytoscape instance through unmount.
  useEffect(() => () => { cyInstance.current?.destroy(); cyInstance.current = null; }, []);

  const counts = useMemo(() => {
    const c: Partial<Record<NodeType, number>> = {};
    if (graph) for (const n of graph.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [graph]);

  const statusCounts = useMemo(() => {
    let ok = 0, warn = 0, err = 0, orphan = 0, silent = 0, unk = 0;
    for (const s of statusByUrn.values()) {
      if (s === 'ok') ok++;
      else if (s === 'warn') warn++;
      else if (s === 'error') err++;
      else if (s === 'orphan') orphan++;
      else if (s === 'silent') silent++;
      else unk++;
    }
    return { ok, warn, err, orphan, silent, unk };
  }, [statusByUrn]);

  // Rich detail for the hover tooltip — derived once per (hovered id) change.
  const hoverDetail = useMemo(() => {
    if (!hover || !graph) return null;
    const node = graph.nodes.find((n) => n.id === hover.id);
    if (!node) return null;
    const ent = entities.find((e) => e.urn === hover.id);
    const file = node.file ?? ent?.file ?? null;
    const inEdges = graph.edges.filter((e) => e.to === hover.id);
    const outEdges = graph.edges.filter((e) => e.from === hover.id);
    const touching = file ? findings.filter((f) => f.file === file) : [];
    const errCount = touching.filter((f) => f.severity === 'error').length;
    const warnCount = touching.filter((f) => f.severity === 'warn').length;
    return {
      node,
      ent,
      status: statusByUrn.get(hover.id) ?? 'unknown',
      file,
      inDeg: inEdges.length,
      outDeg: outEdges.length,
      errCount,
      warnCount,
      lastTouchAgo: ent ? Math.round((Date.now() - ent.at) / 1000) : null,
    };
  }, [hover, graph, entities, findings, statusByUrn]);

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
          {(['ok', 'warn', 'error', 'orphan', 'silent', 'unknown'] as Status[]).map((s) => {
            const on = selectedStatuses.has(s);
            const n = s === 'ok' ? statusCounts.ok
              : s === 'warn' ? statusCounts.warn
              : s === 'error' ? statusCounts.err
              : s === 'orphan' ? statusCounts.orphan
              : s === 'silent' ? statusCounts.silent
              : statusCounts.unk;
            return (
              <button
                key={s}
                onClick={() => {
                  const next = new Set(selectedStatuses);
                  on ? next.delete(s) : next.add(s);
                  setSelectedStatuses(next);
                }}
                title={on ? `hide ${s}` : `show ${s}`}
                style={{
                  padding: '2px 6px', fontSize: 10, cursor: 'pointer',
                  background: on ? STATUS_COLOR[s] + '22' : 'transparent',
                  borderColor: on ? STATUS_COLOR[s] : 'var(--hairline)',
                  color: on ? STATUS_COLOR[s] : 'var(--fg-3)',
                  opacity: on ? 1 : 0.55,
                }}
              >● {s === 'error' ? 'err' : s === 'unknown' ? 'unknown' : s} {n}</button>
            );
          })}
          <button
            onClick={() => {
              try { localStorage.removeItem('dev-infra:graph-positions'); } catch { /* */ }
              if (cyInstance.current) {
                cyInstance.current.layout({
                  name: 'fcose', animate: false, randomize: true,
                  nodeRepulsion: 12000, idealEdgeLength: 130, edgeElasticity: 0.45,
                  nodeSeparation: 90, gravity: 0.18, gravityRangeCompound: 1.5,
                  componentSpacing: 120, tile: true,
                  tilingPaddingVertical: 20, tilingPaddingHorizontal: 20, numIter: 3500,
                } as any).run();
                cyInstance.current.fit(undefined, 40);
              }
            }}
            title="discard saved positions and re-layout from scratch"
            className="mono"
            style={{ padding: '4px 8px', fontSize: 10, color: 'var(--fg-3)' }}
          >RESET LAYOUT</button>
          <button onClick={onClose} className="mono" style={{ padding: '4px 10px', fontSize: 12 }}>×</button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <div ref={cyRef} style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }} />
          {hover && hoverDetail && (
            <div
              className="glass"
              style={{
                position: 'absolute',
                left: Math.min(hover.x + 16, (cyRef.current?.clientWidth ?? 800) - 280),
                top: Math.max(hover.y - 8, 8),
                width: 260,
                padding: 10,
                pointerEvents: 'none',
                zIndex: 5,
                fontSize: 11,
                background: 'rgba(10, 10, 14, 0.92)',
                borderColor: STATUS_COLOR[hoverDetail.status],
              }}
            >
              <div className="mono" style={{ fontSize: 9, color: STATUS_COLOR[hoverDetail.status], letterSpacing: 1.5, marginBottom: 4 }}>
                {hoverDetail.node.type.toUpperCase()} · {hoverDetail.status.toUpperCase()}
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--fg)', wordBreak: 'break-all', marginBottom: 6 }}>
                {hoverDetail.node.label}
              </div>
              {hoverDetail.file && (
                <div className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', marginBottom: 4, wordBreak: 'break-all' }}>
                  {hoverDetail.file}
                </div>
              )}
              {hoverDetail.ent?.segment && (
                <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginBottom: 4 }}>
                  segment: <span style={{ color: 'var(--fg-2)' }}>{hoverDetail.ent.segment}</span>
                </div>
              )}
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', display: 'flex', gap: 10, marginTop: 6 }}>
                <span>in:{hoverDetail.inDeg}</span>
                <span>out:{hoverDetail.outDeg}</span>
                {hoverDetail.errCount > 0 && <span style={{ color: 'var(--err)' }}>{hoverDetail.errCount}e</span>}
                {hoverDetail.warnCount > 0 && <span style={{ color: 'var(--warn)' }}>{hoverDetail.warnCount}w</span>}
                {hoverDetail.ent && (
                  <span>conf:{Math.round(hoverDetail.ent.confidence * 100)}%</span>
                )}
              </div>
              {hoverDetail.lastTouchAgo !== null && (
                <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 4 }}>
                  touched {hoverDetail.lastTouchAgo < 60 ? `${hoverDetail.lastTouchAgo}s` : hoverDetail.lastTouchAgo < 3600 ? `${Math.round(hoverDetail.lastTouchAgo / 60)}m` : hoverDetail.lastTouchAgo < 86400 ? `${Math.round(hoverDetail.lastTouchAgo / 3600)}h` : `${Math.round(hoverDetail.lastTouchAgo / 86400)}d`} ago
                </div>
              )}
            </div>
          )}
        </div>

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

            {/* Screen preview — pulls the latest *.png from the watched
                repo's screenshots folder. 404 means the user's Claude
                session hasn't dropped one yet. */}
            {selected.entity?.kind === 'screen' && (
              <ScreenPreview urn={selected.id} />
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

function ScreenPreview({ urn }: { urn: string }) {
  // Cache-bust on URN change so a freshly dropped screenshot beats any
  // stale browser cache. The /api/screenshots/<urn> endpoint also sets
  // cache-control: no-cache for good measure.
  const [status, setStatus] = useState<'loading' | 'ok' | 'missing'>('loading');
  const src = `/api/screenshots/${encodeURIComponent(urn)}?t=${Date.now()}`;
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>SCREEN PREVIEW</div>
      {status === 'missing' ? (
        <div className="glass" style={{ padding: 10 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.5 }}>
            no screenshot dropped yet · ask your Claude session to save<br />
            <span style={{ color: 'var(--fg-2)' }}>docs/screenshots/{urn.replace('screen:', '')}.png</span>
          </div>
        </div>
      ) : (
        <img
          src={src}
          alt={`${urn} preview`}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('missing')}
          style={{
            maxWidth: '100%', borderRadius: 8,
            border: '1px solid var(--hairline)',
            display: status === 'ok' ? 'block' : 'none',
          }}
        />
      )}
      {status === 'loading' && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>loading…</div>
      )}
    </div>
  );
}
