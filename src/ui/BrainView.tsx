import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

/* BRAIN — 2D Canvas live memory.
 *
 * Switched from react-force-graph-3d to 2D after the 3D version felt
 * unsteerable (jittery mouse wheel, camera occlusion, depth confusion).
 * Obsidian's graph is 2D for the same reasons. This version uses
 * Canvas/WebGL via react-force-graph-2d:
 *   - Mouse wheel zooms smoothly (no axis confusion)
 *   - Drag pans the canvas, drag-on-node moves the node
 *   - Hover a node → connected subgraph stays bright, rest dims
 *     (Obsidian-style focus mode)
 *   - Click a node → side drawer with intent + related memory
 *
 * Live: WebSocket pulse on every finding that names a node (file or
 * label match). 20s background refresh of /api/memory/graph.
 *
 * Scopes:
 *   MEMORY  (default) — concerns / notes / commits / wiki / activity /
 *           agents / mcp tools / their virtual file:/scope:/section:/
 *           author:/tag:/table: endpoints. 96-ish nodes on a populated
 *           dev-infra; reads as a coherent brain.
 *   ALL    — overlay project topology (modules / functions / screens /
 *           ops / etc.) — same data PLAYGROUND shows in 2D Cytoscape.
 *
 * Confidence floor: a `100%` toggle drops anything below 1.0 (heuristic
 * resolution↔concern links + per-severity weighted concern entities).
 */

type RawNode = { id: string; type: string; label: string; file?: string };
type RawEdge = { from: string; to: string; kind: string };
type Graph = { nodes: RawNode[]; edges: RawEdge[]; builtAt: number };

type Severity = 'info' | 'warn' | 'error';
type Finding = {
  id: string; agent: string; kind: string; at: number; severity: Severity;
  summary: string; file?: string;
};

type ServerEvent =
  | { type: 'finding'; finding: Finding }
  | { type: 'run'; run: { agent: string; ok: boolean } }
  | { type: 'snapshot'; findings: Finding[] };

const NODE_COLOR: Record<string, string> = {
  // Pseudo-kinds (virtual endpoints)
  file:          '#7a7a8c',
  scope:         '#a4c4ff',
  section:       '#ffd166',
  author:        '#5fd49a',
  tag:           '#c389ff',
  // Real kinds
  screen:        '#62b5ff',
  op:            '#7eb6a3',
  cmd:           '#c389ff',
  endpoint:      '#ffb86b',
  llm_provider:  '#ff9bd2',
  mcp_server:    '#ffe066',
  mcp_tool:      '#ffe066',
  table:         '#5fd49a',
  component:     '#a4c4ff',
  module:        '#62b5ff',
  function:      '#7eb6a3',
  class:         '#c389ff',
  package:       '#ffb86b',
  concern:       '#ff6b6b',
  resolution:    '#5fd49a',
  commit:        '#a4c4ff',
  'file-activity': '#ffd166',
  note:          '#ffe066',
  self:          '#ff9bd2',
  'test-suite':  '#7eb6a3',
  agent:         '#c389ff',
};

const MEMORY_KINDS = new Set([
  'concern', 'resolution', 'note', 'commit', 'file-activity',
  'self', 'agent', 'mcp_server', 'mcp_tool',
  'file', 'scope', 'section', 'author', 'tag', 'table',
]);

type Pulse = { nodeId: string; until: number; intensity: number };

type GraphNode = {
  id: string;
  label: string;
  type: string;
  file?: string;
  baseColor: string;
  size: number;
  x?: number;
  y?: number;
};

type GraphLink = { source: string; target: string; kind: string };

function ago(ts: number): string {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86_400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86_400)}d ago`;
}

export function BrainView({ onClose }: { onClose: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'memory' | 'all'>('memory');
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [showLabels, setShowLabels] = useState(false);
  const [confidentOnly, setConfidentOnly] = useState(false);
  const [concernStatus, setConcernStatus] = useState<Record<string, { status: string }>>({});
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });

  // Initial graph load + 20s refresh.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const url = confidentOnly ? '/api/memory/graph?minConfidence=1.0' : '/api/memory/graph';
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const g = (await r.json()) as Graph;
        if (!cancelled) setGraph(g);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [confidentOnly]);

  // Concern status — refreshed alongside the graph reload.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/memory/concern-status');
        if (!r.ok) return;
        const d = (await r.json()) as { statuses: Record<string, { status: string }> };
        if (!cancelled) setConcernStatus(d.statuses);
      } catch { /* */ }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Track container size for the canvas dimensions.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      setContainerSize({ w: Math.max(300, e.contentRect.width), h: Math.max(300, e.contentRect.height) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // WebSocket — pulse nodes when their file (or label) is mentioned in
  // a fresh finding. Keeps the brain "lit up" as agents work.
  useEffect(() => {
    let alive = true;
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerEvent;
          if (msg.type !== 'finding' || !graph) return;
          const f = msg.finding;
          const matchingIds: string[] = [];
          for (const n of graph.nodes) {
            if (f.file && n.file === f.file) matchingIds.push(n.id);
            else if (f.summary && (f.summary.includes(n.label) || f.summary.includes(n.id))) matchingIds.push(n.id);
          }
          if (matchingIds.length === 0) return;
          const intensity = f.severity === 'error' ? 1.0 : f.severity === 'warn' ? 0.7 : 0.4;
          const until = Date.now() + 2_500;
          setPulses((prev) => [
            ...prev.filter((p) => p.until > Date.now()),
            ...matchingIds.slice(0, 5).map((id) => ({ nodeId: id, until, intensity })),
          ]);
          setLiveCount((n) => n + 1);
        } catch { /* */ }
      };
      ws.onclose = () => { if (alive) setTimeout(connect, 2_000); };
    };
    connect();
    return () => { alive = false; wsRef.current?.close(); };
  }, [graph]);

  // Pulse GC every 250ms so dead entries don't pile up + frame stays smooth.
  useEffect(() => {
    const id = setInterval(() => {
      setPulses((prev) => prev.filter((p) => p.until > Date.now()));
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Ambient pulse — every ~4s, pick a random visible node and pulse it
  // briefly. Makes the brain feel ALIVE even when no real findings are
  // arriving. Subtle (intensity 0.3) so it reads as background activity,
  // not noise.
  useEffect(() => {
    const id = setInterval(() => {
      if (data.nodes.length === 0) return;
      const node = data.nodes[Math.floor(Math.random() * data.nodes.length)]!;
      setPulses((prev) => [...prev, { nodeId: node.id, until: Date.now() + 1500, intensity: 0.3 }]);
    }, 4_000);
    return () => clearInterval(id);
  }, [data.nodes.length]);

  // Reheat the simulation periodically so it never fully settles —
  // gives the layout a gentle continuous drift like Obsidian. Without
  // this it crystallizes after the cooldown and feels static.
  useEffect(() => {
    const id = setInterval(() => {
      if (fgRef.current && (fgRef.current as any).d3ReheatSimulation) {
        (fgRef.current as any).d3ReheatSimulation(0.05);
      }
    }, 8_000);
    return () => clearInterval(id);
  }, []);

  // Build the graph data. Filter by scope + search + hidden kinds.
  const data = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const q = filter.trim().toLowerCase();
    const inScope = (n: RawNode) => scope === 'all' || MEMORY_KINDS.has(n.type);
    const visible = (n: RawNode) =>
      inScope(n) &&
      !hiddenKinds.has(n.type) &&
      (!q || n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    const visibleIds = new Set(graph.nodes.filter(visible).map((n) => n.id));

    const deg = new Map<string, number>();
    for (const e of graph.edges) {
      if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) continue;
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }

    const nodes: GraphNode[] = graph.nodes
      .filter(visible)
      .map((n) => {
        const status = concernStatus[n.id]?.status;
        const dimFactor =
          status === 'resolved' ? 0.25
          : status === 'claimed-resolved' ? 0.55
          : 1.0;
        const baseColor = dimFactor < 1
          ? mixWithBg(NODE_COLOR[n.type] ?? '#888', dimFactor)
          : (NODE_COLOR[n.type] ?? '#888');
        const sizeMult = status === 'resolved' ? 0.6 : 1.0;
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          ...(n.file ? { file: n.file } : {}),
          baseColor,
          size: (3 + Math.min(8, Math.sqrt(deg.get(n.id) ?? 0) * 1.4)) * sizeMult,
        };
      });

    const links: GraphLink[] = graph.edges
      .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
      .map((e) => ({ source: e.from, target: e.to, kind: e.kind }));

    return { nodes, links };
  }, [graph, filter, hiddenKinds, concernStatus, scope]);

  // Adjacency map for hover-highlight (Obsidian style: focus the
  // hovered node + its 1-hop neighbourhood, dim everything else).
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    }
    return m;
  }, [data.links]);

  const isFocused = (nodeId: string) =>
    !hoveredId || hoveredId === nodeId || (adjacency.get(hoveredId)?.has(nodeId) ?? false);

  // Per-kind counts for the legend (filtered by scope so MEMORY mode
  // only shows memory kind chips).
  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!graph) return m;
    for (const n of graph.nodes) {
      if (scope === 'memory' && !MEMORY_KINDS.has(n.type)) continue;
      m.set(n.type, (m.get(n.type) ?? 0) + 1);
    }
    return m;
  }, [graph, scope]);

  const onNodeClick = (node: GraphNode) => {
    setSelected(node);
    if (!fgRef.current || node.x == null || node.y == null) return;
    fgRef.current.centerAt(node.x, node.y, 800);
    fgRef.current.zoom(2.5, 800);
  };

  // Custom canvas node renderer — runs AFTER the library's default
  // circle (nodeCanvasObjectMode=after below) so the brain always
  // renders SOMETHING even if our custom layer breaks. We add: hover
  // halo, selection ring, optional always-on label.
  const drawNode = (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
    const focused = isFocused(node.id);
    const pulse = pulses.find((p) => p.nodeId === node.id);

    // Pulse halo (behind the default circle visually since we're "after").
    if (pulse) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size * 2.2, 0, 2 * Math.PI);
      ctx.fillStyle = node.baseColor;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 0.18 * pulse.intensity;
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    }

    // Selection ring on top of the default circle.
    if (selected?.id === node.id) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Hover dim: paint a dark veil over non-focused nodes (since the
    // default circle already drew, we tint over it instead of skipping).
    if (!focused) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size + 0.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#0a0a0e';
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    }

    // Label: always-on when toggle + zoomed in, hovered, OR selected.
    const showThisLabel = (showLabels && globalScale > 0.6) || hoveredId === node.id || selected?.id === node.id;
    if (showThisLabel && focused) {
      const fontSize = Math.max(8, 12 / globalScale);
      ctx.font = `${fontSize}px JetBrains Mono, monospace`;
      const text = node.label.slice(0, 28);
      const w = ctx.measureText(text).width;
      const padding = 3 / globalScale;
      ctx.fillStyle = 'rgba(10, 10, 14, 0.85)';
      ctx.fillRect(node.x - w / 2 - padding, node.y + node.size + 2, w + padding * 2, fontSize + padding * 2);
      ctx.fillStyle = '#e8e8ec';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(text, node.x, node.y + node.size + 2 + padding);
    }
  };

  const linkColor = (link: GraphLink) => {
    const sId = typeof link.source === 'object' ? (link.source as any).id : link.source;
    const tId = typeof link.target === 'object' ? (link.target as any).id : link.target;
    const focused = isFocused(sId) && isFocused(tId);
    return focused ? 'rgba(180, 180, 200, 0.45)' : 'rgba(120, 120, 140, 0.08)';
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>BRAIN · LIVE 2D MEMORY</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {graph ? `${data.nodes.length} nodes · ${data.links.length} edges${liveCount > 0 ? ` · ${liveCount} pulse${liveCount === 1 ? '' : 's'}` : ''}` : (error ? `error: ${error}` : 'loading…')}
          </div>
        </div>
        <input
          placeholder="filter by label / urn…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mono"
          style={{ minWidth: 200, padding: '4px 8px', fontSize: 12 }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {(['memory', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className="mono"
              title={s === 'memory' ? 'concerns / resolutions / notes / commits / activity / agents — what dev-infra REMEMBERS' : 'overlay the project topology too — same data PLAYGROUND shows'}
              style={{
                padding: '3px 8px', fontSize: 10,
                background: scope === s ? 'var(--accent-soft)' : 'transparent',
                borderColor: scope === s ? 'var(--accent)' : 'var(--hairline)',
                color: scope === s ? 'var(--accent)' : 'var(--fg-2)',
              }}
            >{s === 'memory' ? 'MEMORY' : 'ALL'}</button>
          ))}
        </div>
        <button
          onClick={() => setShowLabels((v) => !v)}
          className="mono"
          title="always-on labels (vs hover only)"
          style={{
            padding: '3px 8px', fontSize: 10,
            background: showLabels ? 'var(--accent-soft)' : 'transparent',
            borderColor: showLabels ? 'var(--accent)' : 'var(--hairline)',
            color: showLabels ? 'var(--accent)' : 'var(--fg-2)',
          }}
        >LABELS</button>
        <button
          onClick={() => setConfidentOnly((v) => !v)}
          className="mono"
          title={confidentOnly ? 'show all (heuristic links + medium-confidence entries included)' : 'show only memory at 100% confidence'}
          style={{
            padding: '3px 8px', fontSize: 10,
            background: confidentOnly ? 'var(--accent-soft)' : 'transparent',
            borderColor: confidentOnly ? 'var(--accent)' : 'var(--hairline)',
            color: confidentOnly ? 'var(--accent)' : 'var(--fg-2)',
          }}
        >100%</button>
        <button
          onClick={() => fgRef.current?.zoomToFit(600, 60)}
          className="mono"
          title="fit all visible nodes in view"
          style={{ padding: '3px 8px', fontSize: 10, color: 'var(--fg-2)' }}
        >RECENTER</button>
        <button onClick={onClose} className="mono" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>×</button>
      </div>

      {/* Kind legend / filter */}
      <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[...kindCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([kind, n]) => {
            const on = !hiddenKinds.has(kind);
            const colour = NODE_COLOR[kind] ?? '#888';
            return (
              <button
                key={kind}
                onClick={() => {
                  const next = new Set(hiddenKinds);
                  on ? next.add(kind) : next.delete(kind);
                  setHiddenKinds(next);
                }}
                className="mono"
                style={{
                  padding: '2px 8px', fontSize: 10, cursor: 'pointer',
                  background: on ? colour + '22' : 'transparent',
                  borderColor: on ? colour : 'var(--hairline)',
                  color: on ? colour : 'var(--fg-3)',
                  opacity: on ? 1 : 0.5,
                }}
              >● {kind} {n}</button>
            );
          })}
      </div>

      {/* Canvas + drawer */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 300, background: '#0a0a0e' }}>
          {graph && data.nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 1 }}>
              <div className="glass" style={{ padding: 24, maxWidth: 480, textAlign: 'center', pointerEvents: 'auto' }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 8 }}>EMPTY BRAIN</div>
                <div style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.5 }}>
                  {scope === 'memory'
                    ? <>No memory entities match the current filters. Try clicking <b>ALL</b> above to overlay project topology.</>
                    : <>No nodes match the current filters. Clear the search or re-enable kind chips.</>}
                </div>
              </div>
            </div>
          )}
          {graph && (
            <ForceGraph2D
              ref={fgRef as any}
              width={containerSize.w}
              height={containerSize.h}
              graphData={data}
              backgroundColor="#0a0a0e"
              // Tell react-force-graph to use sane defaults for size +
              // colour, then layer my custom drawer ON TOP — so even if
              // my code throws, the lib still draws the basic circles.
              nodeRelSize={4}
              nodeVal={(n: any) => (n as GraphNode).size ?? 4}
              nodeColor={(n: any) => (n as GraphNode).baseColor ?? '#888'}
              nodeCanvasObject={(n: any, ctx: any, scale: any) => drawNode(n as GraphNode, ctx, scale)}
              nodeCanvasObjectMode={() => 'after'}
              linkColor={linkColor as any}
              linkWidth={(l: any) => {
                const sId = typeof l.source === 'object' ? l.source.id : l.source;
                const tId = typeof l.target === 'object' ? l.target.id : l.target;
                return isFocused(sId) && isFocused(tId) ? 1.0 : 0.3;
              }}
              linkDirectionalParticles={(l: any) => {
                // Always-on subtle particles on the busy edges so the
                // brain reads as data-in-motion, not a static lattice.
                // Plus the pulse particles on event-affected edges.
                const sId = typeof l.source === 'object' ? l.source.id : l.source;
                const tId = typeof l.target === 'object' ? l.target.id : l.target;
                const pulsing = pulses.some((p) => p.nodeId === sId || p.nodeId === tId);
                if (pulsing) return 3;
                // Hash the source-id to deterministically pick ~10% of
                // links to carry an ambient particle. Stable so the same
                // edges always glow (pattern, not chaos).
                const hash = (sId + tId).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
                return Math.abs(hash) % 10 === 0 ? 1 : 0;
              }}
              linkDirectionalParticleSpeed={(l: any) => {
                const sId = typeof l.source === 'object' ? l.source.id : l.source;
                const tId = typeof l.target === 'object' ? l.target.id : l.target;
                return pulses.some((p) => p.nodeId === sId || p.nodeId === tId) ? 0.012 : 0.003;
              }}
              linkDirectionalParticleColor={() => 'rgba(232, 232, 236, 0.7)'}
              linkDirectionalParticleWidth={1.5}
              onNodeHover={(n: any) => setHoveredId(n ? (n as GraphNode).id : null)}
              onNodeClick={onNodeClick as any}
              onBackgroundClick={() => { setSelected(null); setHoveredId(null); }}
              // Never fully settle — Obsidian-style ambient drift. The
              // ambient-pulse + 8s reheat effects keep the simulation
              // alive at low alpha so nodes breathe gently.
              cooldownTicks={Infinity}
              cooldownTime={Infinity}
              warmupTicks={80}
              d3AlphaDecay={0.008}
              d3VelocityDecay={0.4}
              minZoom={0.15}
              maxZoom={8}
              enableZoomInteraction={true}
              enablePanInteraction={true}
            />
          )}
        </div>

        {/* Side drawer */}
        {selected && (
          <div style={{ width: 360, borderLeft: '1px solid var(--hairline)', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: NODE_COLOR[selected.type] ?? 'var(--fg-3)', letterSpacing: 1.5 }}>{selected.type.toUpperCase()}</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2, fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all' }}>{selected.label}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2, wordBreak: 'break-all' }}>{selected.id}</div>
            </div>
            {selected.file && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>{selected.file}</div>
            )}
            <NodeDetail urn={selected.id} />
          </div>
        )}
      </div>
    </div>
  );
}

function mixWithBg(hex: string, factor: number): string {
  const m = hex.replace('#', '').match(/^(..)(..)(..)$/);
  if (!m) return hex;
  const [r, g, b] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const bg = 14;
  const blend = (c: number) => Math.round(bg + (c - bg) * factor);
  const hex2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex2(blend(r))}${hex2(blend(g))}${hex2(blend(b))}`;
}

function NodeDetail({ urn }: { urn: string }) {
  const [intent, setIntent] = useState<string | null>(null);
  const [findings, setFindings] = useState<Array<{ kind: string; severity: string; summary: string; at_iso: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (urn.startsWith('module:')) {
          const path = urn.slice('module:'.length);
          const r = await fetch('/api/code-intents');
          if (r.ok) {
            const d = (await r.json()) as { intents: { path: string; summary: string }[] };
            if (!cancelled) setIntent(d.intents.find((i) => i.path === path)?.summary ?? null);
          }
        }
        const labelGuess = urn.includes(':') ? urn.slice(urn.indexOf(':') + 1) : urn;
        const fr = await fetch(`/api/memory/feed?layer=all&query=${encodeURIComponent(labelGuess)}&limit=10`);
        if (fr.ok) {
          const j = (await fr.json()) as { rows: { layer: string; primary: string; secondary: string; raw: any; at_iso: string }[] };
          if (!cancelled) {
            setFindings(j.rows
              .filter((r) => r.layer === 'register' || r.layer === 'facts' || r.layer === 'wiki')
              .slice(0, 6)
              .map((r) => ({
                kind: r.layer + ': ' + (r.raw.kind ?? r.raw.predicate ?? ''),
                severity: 'info',
                summary: r.primary,
                at_iso: r.at_iso,
              })));
          }
        }
      } catch { /* */ }
    };
    void load();
    return () => { cancelled = true; };
  }, [urn]);

  return (
    <>
      {intent && (
        <div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--accent)', letterSpacing: 1, marginBottom: 4 }}>INTENT</div>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.5 }}>{intent}</div>
        </div>
      )}
      {findings.length > 0 && (
        <div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1, marginBottom: 4 }}>RELATED MEMORY · {findings.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {findings.map((f, i) => (
              <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', borderLeft: '2px solid var(--hairline)', paddingLeft: 6 }}>
                <div style={{ color: 'var(--fg-3)' }}>{f.kind}</div>
                <div style={{ color: 'var(--fg)', marginTop: 2 }}>{f.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
