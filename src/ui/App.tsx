import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentMetrics } from './AgentMetrics';
import { BootstrapProgress } from './BootstrapProgress';
import { EntitiesPanel } from './EntitiesPanel';
import { GraphPanel } from './GraphPanel';
import { GraphPlayground } from './GraphPlayground';

type Severity = 'info' | 'warn' | 'error';

type Finding = {
  id: string;
  agent: string;
  kind: string;
  at: number;
  severity: Severity;
  summary: string;
  file?: string;
  line?: number;
  suggestion?: string;
  payload?: Record<string, unknown>;
};

type AgentRun = {
  agent: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  findingCount: number;
  error?: string;
};

type AgentInfo = { name: string; description: string };
type Target = { path: string; label: string };
type SystemPhase = 'bootstrapping' | 'live';
type Completeness = {
  overall_pct: number;
  screens: { total: number; withEdges: number };
  entities: { total: number; withEvidence: number };
  segments: { total: number; withWiki: number };
  at: number;
} | null;

type ServerEvent =
  | { type: 'finding'; finding: Finding }
  | { type: 'run'; run: AgentRun }
  | { type: 'snapshot'; findings: Finding[]; runs: AgentRun[]; agents: AgentInfo[]; target: Target; phase: SystemPhase; completeness: Completeness };

const SEV_COLOR: Record<Severity, string> = {
  info:  'var(--info)',
  warn:  'var(--warn)',
  error: 'var(--err)',
};

export function App() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [phase, setPhase] = useState<SystemPhase>('bootstrapping');
  const [completeness, setCompleteness] = useState<Completeness>(null);
  const [connected, setConnected] = useState(false);
  const [filterAgent, setFilterAgent] = useState<string>('all');
  const [filterSev, setFilterSev] = useState<'all' | Severity>('all');
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  const [liveCount, setLiveCount] = useState(0);
  const [graphOpen, setGraphOpen] = useState(false);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { if (alive) setConnected(true); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerEvent;
          if (msg.type === 'snapshot') {
            setFindings(msg.findings);
            setRuns(msg.runs);
            setAgents(msg.agents);
            setTarget(msg.target);
            setPhase(msg.phase);
            setCompleteness(msg.completeness);
          } else if (msg.type === 'finding') {
            // Live-update completeness from incoming memory:completeness
            // findings so the progress card reflects current % without
            // waiting for the next snapshot reconnect. Also flip phase
            // immediately when memory-keeper announces live-ready.
            if (msg.finding.agent === 'memory-keeper') {
              if (msg.finding.kind === 'memory:completeness' && msg.finding.payload) {
                const p = msg.finding.payload as { overall_pct?: number; screens?: { total: number; withEdges: number }; entities?: { total: number; withEvidence: number }; segments?: { total: number; withWiki: number } };
                if (typeof p.overall_pct === 'number' && p.screens && p.entities && p.segments) {
                  setCompleteness({ overall_pct: p.overall_pct, screens: p.screens, entities: p.entities, segments: p.segments, at: msg.finding.at });
                }
              } else if (msg.finding.kind === 'phase:live-ready') {
                setPhase('live');
              }
            }
            setFindings((prev) => [...prev, msg.finding].slice(-1000));
            setLastLiveAt(Date.now());
            setLiveCount((n) => n + 1);
          } else if (msg.type === 'run') {
            setRuns((prev) => [...prev, msg.run].slice(-200));
            setLastLiveAt(Date.now());
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { alive = false; wsRef.current?.close(); };
  }, []);

  const filtered = useMemo(() => {
    return findings
      .filter((f) => filterAgent === 'all' || f.agent === filterAgent)
      .filter((f) => filterSev === 'all' || f.severity === filterSev)
      .slice()
      .reverse();
  }, [findings, filterAgent, filterSev]);

  const counts = useMemo(() => {
    const out: Record<string, { info: number; warn: number; error: number; total: number }> = {};
    for (const f of findings) {
      const e = out[f.agent] ??= { info: 0, warn: 0, error: 0, total: 0 };
      e[f.severity]++;
      e.total++;
    }
    return out;
  }, [findings]);

  // Per-agent last-run + last-status, derived from the runs ring.
  const lastRunByAgent = useMemo(() => {
    const m = new Map<string, AgentRun>();
    for (const r of runs) {
      const cur = m.get(r.agent);
      if (!cur || r.startedAt > cur.startedAt) m.set(r.agent, r);
    }
    return m;
  }, [runs]);

  const recentRuns = useMemo(() => runs.slice().reverse().slice(0, 8), [runs]);

  const livePulse = lastLiveAt !== null && Date.now() - lastLiveAt < 1500;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ borderBottom: '1px solid var(--hairline)', padding: '14px 22px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>NIK-DEV-INFRA · ALWAYS-ON · CLAUDE MAX</span>
            <span style={{
              padding: '1px 8px', borderRadius: 4, fontSize: 9,
              color: phase === 'live' ? 'var(--ok)' : 'var(--warn)',
              border: `1px solid ${phase === 'live' ? 'var(--ok)' : 'var(--warn)'}`,
              background: phase === 'live' ? 'rgba(95,212,154,0.08)' : 'rgba(255,209,102,0.08)',
            }}>
              {phase === 'live' ? 'LIVE' : 'BOOTSTRAPPING'}
            </span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>
            Live agent findings
            {target && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', marginLeft: 12, fontWeight: 400 }}>
                watching: <span style={{ color: 'var(--fg-2)' }}>{target.label}</span>
                <span style={{ color: 'var(--fg-3)', marginLeft: 6 }}>({target.path})</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={() => setPlaygroundOpen(true)}
            className="mono"
            style={{ padding: '4px 10px', fontSize: 10, letterSpacing: 1, color: 'var(--accent)', borderColor: 'var(--accent)' }}
          >PLAYGROUND</button>
          <button
            onClick={() => setEntitiesOpen(true)}
            className="mono"
            style={{ padding: '4px 10px', fontSize: 10, letterSpacing: 1, color: 'var(--accent)', borderColor: 'var(--accent)' }}
          >ENTITIES</button>
          <button
            onClick={() => setGraphOpen(true)}
            className="mono"
            style={{ padding: '4px 10px', fontSize: 10, letterSpacing: 1, color: 'var(--fg-2)' }}
          >GRAPH (LIST)</button>
          <div className="mono" style={{ fontSize: 11, color: connected ? 'var(--ok)' : 'var(--err)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className={livePulse ? 'live-pulse' : ''}
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: connected ? 'var(--ok)' : 'var(--err)',
                boxShadow: connected ? '0 0 6px var(--ok)' : 'none',
              }}
            />
            {connected ? 'CONNECTED · WS' : 'RECONNECTING…'}
            {connected && lastLiveAt !== null && (
              <span style={{ color: 'var(--fg-3)', marginLeft: 4 }}>
                · {liveCount} live event{liveCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </div>

      {phase === 'bootstrapping' && (
        <div style={{ padding: '0 22px', marginTop: 12 }}>
          <BootstrapProgress data={completeness} />
        </div>
      )}

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: filterAgent === 'all' ? '280px 1fr' : '280px 1fr 340px', gap: 0, minHeight: 0 }}>
        {/* Left: agent rail + recent runs */}
        <div style={{ borderRight: '1px solid var(--hairline)', padding: 14, overflowY: 'auto' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 8 }}>AGENTS · {agents.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
            <AgentChip name="all" total={findings.length} active={filterAgent === 'all'} onClick={() => setFilterAgent('all')} />
            {agents.map((a) => {
              const lr = lastRunByAgent.get(a.name);
              return (
                <AgentChip
                  key={a.name}
                  name={a.name}
                  description={a.description}
                  total={counts[a.name]?.total ?? 0}
                  err={counts[a.name]?.error ?? 0}
                  warn={counts[a.name]?.warn ?? 0}
                  active={filterAgent === a.name}
                  onClick={() => setFilterAgent(a.name)}
                  lastRunAt={lr?.startedAt}
                  lastRunOk={lr?.ok}
                  onRunNow={() => {
                    void fetch(`/api/agents/${a.name}/run`, { method: 'POST' });
                  }}
                />
              );
            })}
          </div>

          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 8 }}>RECENT RUNS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentRuns.map((r, i) => (
              <div key={i} className="glass mono" style={{ padding: 6, fontSize: 10, color: 'var(--fg-2)' }}>
                <span style={{ color: r.ok ? 'var(--ok)' : 'var(--err)' }}>{r.ok ? '✓' : '✗'}</span>
                {' '}<b style={{ color: 'var(--fg)' }}>{r.agent}</b> · {r.findingCount} · {r.durationMs}ms
                {r.error && <div style={{ color: 'var(--err)', marginTop: 2 }}>{r.error}</div>}
              </div>
            ))}
            {recentRuns.length === 0 && (
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>no runs yet</div>
            )}
          </div>
        </div>

        {/* Right: findings stream */}
        <div style={{ padding: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>SEVERITY</span>
            {(['all', 'error', 'warn', 'info'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterSev(s)}
                className="mono"
                style={{
                  padding: '3px 8px', fontSize: 10, letterSpacing: 0.5,
                  background: filterSev === s ? 'var(--accent-soft)' : 'transparent',
                  borderColor: filterSev === s ? 'var(--accent)' : 'var(--hairline)',
                  color: filterSev === s ? 'var(--accent)' : 'var(--fg-2)',
                }}
              >{s.toUpperCase()}</button>
            ))}
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-3)' }}>
              {filtered.length} / {findings.length} findings
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((f) => <FindingRow key={f.id} f={f} />)}
            {filtered.length === 0 && (
              <div className="glass" style={{ padding: 24, textAlign: 'center' }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: 1 }}>NO FINDINGS</div>
                <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 8 }}>
                  Edit a file under <code className="mono">~/NIK/web/src/</code> and watch the agents fire.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: per-agent metrics panel (visible when an agent is selected) */}
        {filterAgent !== 'all' && (() => {
          const agentInfo = agents.find((a) => a.name === filterAgent)
            ?? { name: filterAgent, description: '' };
          return (
            <AgentMetrics
              agent={agentInfo}
              runs={runs}
              findings={findings}
              onClose={() => setFilterAgent('all')}
            />
          );
        })()}
      </div>

      {graphOpen && <GraphPanel onClose={() => setGraphOpen(false)} />}
      {playgroundOpen && <GraphPlayground onClose={() => setPlaygroundOpen(false)} />}
      {entitiesOpen && <EntitiesPanel onClose={() => setEntitiesOpen(false)} />}
    </div>
  );
}

function AgentChip(props: {
  name: string; description?: string; total: number; err?: number; warn?: number;
  active: boolean; onClick: () => void;
  lastRunAt?: number;
  lastRunOk?: boolean;
  onRunNow?: () => void;
}) {
  const lastRunStr = props.lastRunAt ? ago(props.lastRunAt) : null;
  // 24h cap for "stale". Beyond that, tint orange.
  const isStale = props.lastRunAt !== undefined && Date.now() - props.lastRunAt > 24 * 60 * 60 * 1000;
  const neverRan = props.lastRunAt === undefined && props.name !== 'all';

  return (
    <div
      onClick={props.onClick}
      className="glass"
      style={{
        padding: 8, cursor: 'pointer',
        borderColor: props.active ? 'var(--accent)'
          : props.lastRunOk === false ? 'var(--err)'
          : neverRan ? 'var(--hairline)'
          : isStale ? 'var(--warn)'
          : 'var(--hairline)',
        background: props.active ? 'var(--accent-soft)' : 'var(--surface)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>{props.name}</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
          {(props.err ?? 0) > 0 && <span style={{ color: 'var(--err)' }}>{props.err}e </span>}
          {(props.warn ?? 0) > 0 && <span style={{ color: 'var(--warn)' }}>{props.warn}w </span>}
          {props.total}
        </div>
      </div>
      {props.description && (
        <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 3, lineHeight: 1.4 }}>
          {props.description}
        </div>
      )}
      {props.name !== 'all' && (
        <div className="mono" style={{ fontSize: 9, marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
          <span style={{
            color: props.lastRunOk === false ? 'var(--err)'
              : neverRan ? 'var(--fg-3)'
              : isStale ? 'var(--warn)'
              : 'var(--fg-3)',
          }}>
            {neverRan ? 'never ran'
              : props.lastRunOk === false ? `failed · ${lastRunStr}`
              : `ran ${lastRunStr}`}
          </span>
          {props.onRunNow && (
            <button
              onClick={(e) => { e.stopPropagation(); props.onRunNow!(); }}
              className="mono"
              style={{ padding: '1px 6px', fontSize: 9, color: 'var(--accent)', borderColor: 'var(--accent-soft)' }}
            >run</button>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div className="glass" style={{
      padding: 10,
      borderLeft: `3px solid ${SEV_COLOR[f.severity]}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 9, color: SEV_COLOR[f.severity], letterSpacing: 1 }}>
          {f.severity.toUpperCase()}
        </span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 0.5 }}>
          {f.agent} · {f.kind}
        </span>
        {f.file && (
          <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
            {f.file}{f.line ? `:${f.line}` : ''}
          </span>
        )}
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginLeft: 'auto' }}>
          {ago(f.at)}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg)', marginTop: 5 }}>{f.summary}</div>
      {f.suggestion && (
        <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4, fontStyle: 'italic' }}>
          → {f.suggestion}
        </div>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
