/* Bootstrap progress card — visible only while phase === 'bootstrapping'.
 * Shows the three completeness dimensions the memory-keeper tracks
 * + an overall % with the gate threshold (95%) marked. */

type Completeness = {
  overall_pct: number;
  screens: { total: number; withEdges: number };
  entities: { total: number; withEvidence: number };
  segments: { total: number; withWiki: number };
  at: number;
};

export function BootstrapProgress({ data }: { data: Completeness | null }) {
  if (!data) {
    return (
      <div className="glass" style={{ padding: 12, marginBottom: 12 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--warn)', letterSpacing: 1 }}>BOOTSTRAPPING</div>
        <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>
          waiting for first <code className="mono">memory:completeness</code> finding from memory-keeper…
        </div>
      </div>
    );
  }

  const overall = data.overall_pct;
  const screensPct = data.screens.total > 0 ? Math.round((data.screens.withEdges / data.screens.total) * 100) : 0;
  const entitiesPct = data.entities.total > 0 ? Math.round((data.entities.withEvidence / data.entities.total) * 100) : 0;
  const segmentsPct = data.segments.total > 0 ? Math.round((data.segments.withWiki / data.segments.total) * 100) : 0;
  const screensReady = data.segments.total >= 5;
  const wikiReady = data.segments.total >= 5;

  return (
    <div className="glass" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <span className="mono" style={{ fontSize: 10, color: 'var(--warn)', letterSpacing: 1 }}>BOOTSTRAPPING · {overall}%</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginLeft: 8 }}>
            need ≥95% + ≥5 segments + ≥5 wiki pages to flip live
          </span>
        </div>
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
          updated {ago(data.at)}
        </span>
      </div>

      <Bar label="screens with edges" pct={screensPct} value={`${data.screens.withEdges}/${data.screens.total}`} />
      <Bar label="entities with evidence" pct={entitiesPct} value={`${data.entities.withEvidence}/${data.entities.total}`} />
      <Bar label="segments with wiki" pct={segmentsPct} value={`${data.segments.withWiki}/${data.segments.total}`} ready={wikiReady} />

      {/* Overall gate visualizer: 95% threshold tick. */}
      <div style={{ marginTop: 6, position: 'relative', height: 10, borderRadius: 6, background: 'var(--hairline)' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${overall}%`, background: overall >= 95 ? 'var(--ok)' : 'var(--warn)', borderRadius: 6 }} />
        <div style={{ position: 'absolute', top: -1, left: '95%', height: 12, width: 1, background: 'var(--fg-2)' }} title="95% gate" />
      </div>
    </div>
  );
}

function Bar({ label, pct, value, ready }: { label: string; pct: number; value: string; ready?: boolean }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--fg-2)' }}>{label}</span>
        <span className="mono" style={{ fontSize: 10, color: ready === false ? 'var(--warn)' : 'var(--fg-3)' }}>
          {value} · {pct}%
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--hairline)', position: 'relative', marginTop: 2 }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, height: '100%',
          width: `${Math.min(pct, 100)}%`,
          background: pct >= 95 ? 'var(--ok)' : pct >= 50 ? 'var(--warn)' : 'var(--info)',
          borderRadius: 2,
        }} />
      </div>
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
