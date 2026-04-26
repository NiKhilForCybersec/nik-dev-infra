import { useMemo } from 'react';

type Severity = 'info' | 'warn' | 'error';

type Finding = {
  id: string;
  agent: string;
  kind: string;
  at: number;
  severity: Severity;
  summary: string;
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

type Props = {
  agent: AgentInfo;
  runs: AgentRun[];
  findings: Finding[];
  onClose: () => void;
};

const DAY_MS = 86_400_000;

export function AgentMetrics({ agent, runs, findings, onClose }: Props) {
  const stats = useMemo(() => {
    const r = runs.filter((x) => x.agent === agent.name);
    const total = r.length;
    const ok = r.filter((x) => x.ok).length;
    const successRate = total ? (ok / total) * 100 : 0;
    const avgDuration = total ? Math.round(r.reduce((a, x) => a + x.durationMs, 0) / total) : 0;
    const lastErrorRun = [...r].reverse().find((x) => !x.ok);

    // Last 7 calendar days, oldest → newest
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const buckets: { dayStart: number; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const start = todayStart.getTime() - i * DAY_MS;
      const end = start + DAY_MS;
      const count = r.filter((x) => x.startedAt >= start && x.startedAt < end).length;
      buckets.push({ dayStart: start, count });
    }

    const af = findings.filter((f) => f.agent === agent.name);
    const errors = af.filter((f) => f.severity === 'error').length;
    const warns = af.filter((f) => f.severity === 'warn').length;
    const infos = af.filter((f) => f.severity === 'info').length;

    return { total, ok, successRate, avgDuration, lastErrorRun, buckets, errors, warns, infos, findingTotal: af.length };
  }, [agent.name, runs, findings]);

  return (
    <div style={{ borderLeft: '1px solid var(--hairline)', padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>METRICS</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>{agent.name}</div>
        </div>
        <button
          onClick={onClose}
          className="mono"
          aria-label="close metrics"
          style={{ padding: '2px 8px', fontSize: 11, color: 'var(--fg-3)' }}
        >×</button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5 }}>{agent.description}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat label="TOTAL RUNS" value={String(stats.total)} />
        <Stat label="SUCCESS RATE" value={stats.total ? `${stats.successRate.toFixed(0)}%` : '—'} tone={stats.total === 0 ? 'muted' : stats.successRate >= 95 ? 'ok' : stats.successRate >= 70 ? 'warn' : 'err'} />
        <Stat label="AVG DURATION" value={stats.total ? `${stats.avgDuration}ms` : '—'} />
        <Stat label="FINDINGS" value={String(stats.findingTotal)} sub={`${stats.errors}e · ${stats.warns}w · ${stats.infos}i`} />
      </div>

      <div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 6 }}>
          LAST 7 DAYS
        </div>
        <Sparkline buckets={stats.buckets} />
      </div>

      <div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 6 }}>
          LAST ERROR
        </div>
        {stats.lastErrorRun ? (
          <div className="glass" style={{ padding: 10, borderLeft: '3px solid var(--err)' }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              {new Date(stats.lastErrorRun.startedAt).toLocaleString()} · {stats.lastErrorRun.durationMs}ms
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap' }}>
              {stats.lastErrorRun.error || '(no error message)'}
            </div>
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            {stats.total === 0 ? 'no runs yet' : 'no errors in window'}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone = 'fg' }: { label: string; value: string; sub?: string; tone?: 'fg' | 'ok' | 'warn' | 'err' | 'muted' }) {
  const color = tone === 'ok' ? 'var(--ok)'
    : tone === 'warn' ? 'var(--warn)'
    : tone === 'err' ? 'var(--err)'
    : tone === 'muted' ? 'var(--fg-3)'
    : 'var(--fg)';
  return (
    <div className="glass" style={{ padding: 10 }}>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color, marginTop: 2 }}>{value}</div>
      {sub && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function Sparkline({ buckets }: { buckets: { dayStart: number; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const W = 240, H = 44, gap = 4;
  const barW = (W - gap * (buckets.length - 1)) / buckets.length;
  return (
    <div className="glass" style={{ padding: 10 }}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {buckets.map((b, i) => {
          const h = (b.count / max) * (H - 14);
          const x = i * (barW + gap);
          const y = H - 12 - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)}
                    fill={b.count > 0 ? 'var(--accent)' : 'var(--hairline)'}
                    rx={2} />
              <text x={x + barW / 2} y={H - 1} fontSize={8} fill="var(--fg-3)" textAnchor="middle" fontFamily="JetBrains Mono, monospace">
                {b.count}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>{new Date(buckets[0]?.dayStart ?? Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <span>today</span>
      </div>
    </div>
  );
}
