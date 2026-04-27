import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';

/* BRAIN — 3D animated live memory.
 *
 * Renders the register entities + facts as a force-directed brain.
 * Subscribes to the daemon WebSocket so any new finding pulses the
 * affected node briefly (the brain "lights up" as agents work).
 * Click any node → camera flies to it + side drawer with details.
 *
 * Continuously updating: every 20s the graph reloads to pick up
 * newly-added nodes/edges. Live pulses come from WS in real time.
 */

type NodeKind =
  | 'screen' | 'op' | 'cmd' | 'endpoint' | 'llm_provider'
  | 'mcp_server' | 'mcp_tool' | 'table' | 'component'
  | 'module' | 'function' | 'class' | 'package'
  | 'concern' | 'resolution' | 'commit' | 'file-activity'
  | 'note' | 'self' | 'test-suite' | 'agent';

type EdgeKind = string;

type RawNode = { id: string; type: NodeKind; label: string; file?: string };
type RawEdge = { from: string; to: string; kind: EdgeKind };
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

const EDGE_COLOR: Record<string, string> = {
  imports:        'rgba(98, 181, 255, 0.4)',
  imports_dynamic:'rgba(98, 181, 255, 0.25)',
  depends_on:     'rgba(255, 184, 107, 0.4)',
  exported_by:    'rgba(126, 182, 163, 0.5)',
  reads:          'rgba(98, 181, 255, 0.4)',
  writes:         'rgba(255, 184, 107, 0.4)',
  dispatches:     'rgba(195, 137, 255, 0.4)',
  navigates_to:   'rgba(95, 212, 154, 0.5)',
  calls:          'rgba(195, 137, 255, 0.4)',
  invokes_llm:    'rgba(255, 155, 210, 0.5)',
  tool_of:        'rgba(255, 224, 102, 0.5)',
  persists_to:    'rgba(95, 212, 154, 0.4)',
  renders:        'rgba(164, 196, 255, 0.4)',
  emits_kind:     'rgba(255, 209, 102, 0.4)',
  has_screenshot: 'rgba(98, 181, 255, 0.3)',
  raised_in:      'rgba(255, 107, 107, 0.5)',
  targets:        'rgba(255, 107, 107, 0.5)',
  resolves:       'rgba(95, 212, 154, 0.6)',
  modified:       'rgba(255, 209, 102, 0.4)',
  authored_by:    'rgba(164, 196, 255, 0.3)',
  has_agent:      'rgba(195, 137, 255, 0.3)',
  default:        'rgba(120, 120, 140, 0.25)',
};

// Blend a hex colour toward the dark canvas background so resolved
// nodes recede visually without disappearing entirely. factor=1 means
// untouched colour; factor=0 means full background dark.
function mixWithBg(hex: string, factor: number): string {
  const m = hex.replace('#', '').match(/^(..)(..)(..)$/);
  if (!m) return hex;
  const [r, g, b] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const bg = 14;       // matches #0a0a0e
  const blend = (c: number) => Math.round(bg + (c - bg) * factor);
  const hex2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex2(blend(r))}${hex2(blend(g))}${hex2(blend(b))}`;
}

type Pulse = { nodeId: string; until: number; intensity: number };

type GraphNode = {
  id: string;
  label: string;
  type: NodeKind;
  file?: string;
  // Internal state for rendering
  baseColor: string;
  size: number;
};

type GraphLink = { source: string; target: string; kind: EdgeKind; color: string };

export function BrainView({ onClose }: { onClose: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [filter, setFilter] = useState('');
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  // Concern status (open / claimed-resolved / resolved / regressed) →
  // dim resolved concerns so the live brain emphasizes what's
  // CURRENTLY a problem, not historical noise.
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
        const r = await fetch('/api/graph');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = (await r.json()) as unknown;
        const g: Graph = typeof raw === 'string' ? JSON.parse(raw) : (raw as Graph);
        if (!cancelled) setGraph(g);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

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
          // Find the node this finding pertains to: file match first,
          // then summary substring against any node label/id.
          const f = msg.finding;
          const matchingIds: string[] = [];
          for (const n of graph.nodes) {
            if (f.file && n.file === f.file) matchingIds.push(n.id);
            else if (f.summary && (f.summary.includes(n.label) || f.summary.includes(n.id))) matchingIds.push(n.id);
          }
          if (matchingIds.length === 0) return;
          const intensity = f.severity === 'error' ? 1.0 : f.severity === 'warn' ? 0.7 : 0.4;
          const until = Date.now() + 2_500;       // 2.5s pulse
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

  // Garbage-collect expired pulses every 500ms so dead entries don't
  // pile up. Cheap.
  useEffect(() => {
    const id = setInterval(() => {
      setPulses((prev) => {
        const now = Date.now();
        return prev.filter((p) => p.until > now);
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Build the data shape react-force-graph-3d wants. Filter by hidden
  // kinds + search query. Edges only kept when both endpoints visible.
  const data = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const q = filter.trim().toLowerCase();
    const visible = (n: RawNode) =>
      !hiddenKinds.has(n.type) &&
      (!q || n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    const visibleIds = new Set(graph.nodes.filter(visible).map((n) => n.id));

    // Per-node degree for size scaling.
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
        // Dim resolved concerns so the live brain emphasizes
        // what's CURRENTLY a problem, not historical noise.
        // claimed-resolved (no curator audit yet) stays half-bright.
        // regressed stays at full brightness (it's actively wrong).
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
      .map((e) => ({
        source: e.from,
        target: e.to,
        kind: e.kind,
        color: EDGE_COLOR[e.kind] ?? EDGE_COLOR.default!,
      }));

    return { nodes, links };
  }, [graph, filter, hiddenKinds, concernStatus]);

  // Per-kind counts for the legend / filter.
  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!graph) return m;
    for (const n of graph.nodes) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [graph]);

  // Click → fly camera to node + open drawer.
  const onNodeClick = (node: GraphNode) => {
    setSelected(node);
    if (!fgRef.current) return;
    const distance = 80;
    const n: any = node;
    if (typeof n.x !== 'number') return;
    const distRatio = 1 + distance / Math.hypot(n.x, n.y, n.z);
    fgRef.current.cameraPosition(
      { x: n.x * distRatio, y: n.y * distRatio, z: n.z * distRatio },
      { x: n.x, y: n.y, z: n.z },
      1500,
    );
  };

  // Three.js node rendering — sphere with optional pulse halo.
  const nodeThreeObject = (node: any) => {
    const n = node as GraphNode;
    const pulse = pulses.find((p) => p.nodeId === n.id);
    const group = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(n.size, 16, 12),
      new THREE.MeshLambertMaterial({
        color: n.baseColor,
        emissive: pulse ? new THREE.Color(n.baseColor).multiplyScalar(pulse.intensity) : new THREE.Color(0x000000),
        emissiveIntensity: pulse ? 1.0 : 0,
      }),
    );
    group.add(sphere);
    if (pulse) {
      // Halo ring during pulse — quick fade.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(n.size * 1.8, 16, 12),
        new THREE.MeshBasicMaterial({ color: n.baseColor, transparent: true, opacity: 0.25 * pulse.intensity, depthWrite: false }),
      );
      group.add(halo);
    }
    return group;
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>BRAIN · LIVE 3D MEMORY</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {graph ? `${data.nodes.length} nodes · ${data.links.length} edges${liveCount > 0 ? ` · ${liveCount} pulse${liveCount === 1 ? '' : 's'}` : ''}` : (error ? `error: ${error}` : 'loading…')}
          </div>
        </div>
        <input
          placeholder="filter by label / urn…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mono"
          style={{ minWidth: 220, padding: '4px 8px', fontSize: 12 }}
        />
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
        <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 300 }}>
          {graph && (
            <ForceGraph3D
              ref={fgRef as any}
              width={containerSize.w}
              height={containerSize.h}
              graphData={data}
              nodeLabel={(n: any) => `${n.type}: ${n.label}`}
              nodeThreeObject={nodeThreeObject}
              linkColor={(l: any) => l.color}
              linkOpacity={0.4}
              linkWidth={0.4}
              linkDirectionalParticles={(l: any) => {
                // Highlight pulsed edges with travelling particles for 2.5s.
                const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
                const targetId = typeof l.target === 'object' ? l.target.id : l.target;
                return pulses.some((p) => p.nodeId === sourceId || p.nodeId === targetId) ? 2 : 0;
              }}
              linkDirectionalParticleSpeed={0.01}
              backgroundColor="#0a0a0e"
              onNodeClick={onNodeClick as any}
              onBackgroundClick={() => setSelected(null)}
              cooldownTicks={120}
              warmupTicks={20}
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

/* Per-node deep-detail loaded lazily from /api/memory/feed (filtered to
 * the node) + /api/code-intents (when the node is a module). Keeps the
 * brain's main render path lean. */
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
        // Findings touching this node — substring search against id + label-derived path.
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
