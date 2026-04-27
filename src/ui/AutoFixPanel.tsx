import { useEffect, useState } from 'react';

type Severity = 'info' | 'warn' | 'error';

type AutoFixConfig = {
  enabled: boolean;
  dryRun: boolean;
  maxCyclesPerDay: number;
  maxConsecutiveFailures: number;
  killSwitchFile: string;
  scopes: string[];
  approvalMode: 'auto' | 'manual';
};

type Approval = {
  id: string;
  agent: string;
  kind: string;
  created_at: number;
  decided_at: number | null;
  status: 'pending' | 'approved' | 'rejected';
  payload: {
    // auto-fix:cycle-complete payload
    fingerprint?: string;
    concernText?: string;
    severity?: string;
    fileRef?: string | null;
    headBefore?: string;
    scopes?: string[];
    durationMs?: number;
    claudeOutputTail?: string;
    diff?: { filesChanged: string[]; outOfScopeFiles: string[]; statTail: string };
    // self:prompt-diff-proposal payload
    targetAgent?: string;
    promptPathRel?: string;
    find?: string;
    replace?: string;
    rationale?: string | null;
    monitorFinding?: string | null;
    proposalSummary?: string;
  } | null;
};

type Finding = {
  id: string;
  agent: string;
  kind: string;
  at: number;
  severity: Severity;
  summary: string;
  payload?: Record<string, unknown>;
};

type DiffPayload = {
  filesChanged?: string[];
  outOfScopeFiles?: string[];
  statTail?: string;
};

const KIND_LABEL: Record<string, string> = {
  'auto-fix:loop-disabled':        'disabled',
  'auto-fix:dry-run-plan':         'dry-run plan',
  'auto-fix:dispatched':           'dispatched',
  'auto-fix:cycle-complete':       'complete',
  'auto-fix:cycle-failed':         'failed',
  'auto-fix:diff-recorded':        'diff',
  'auto-fix:awaiting-approval':    'awaiting approval',
  'auto-fix:approved':             'approved',
  'auto-fix:rejected':             'rejected',
  'auto-fix:revert-failed':        'revert failed',
  'auto-fix:no-targets':           'no targets',
  'auto-fix:needs-clarification':  'needs clarification',
  'auto-fix:out-of-scope':         'out of scope',
  'auto-fix:kill-switched':        'kill-switched',
  'auto-fix:budget-exceeded':      'budget exceeded',
  'auto-fix:halted-failures':      'halted',
  'auto-fix:dirty-tree':           'dirty tree',
  'auto-fix:no-concerns-file':     'no concerns file',
  'auto-fix:summary':              'summary',
};

const KIND_COLOR: Record<string, string> = {
  'auto-fix:loop-disabled':        'var(--fg-3)',
  'auto-fix:dry-run-plan':         'var(--accent)',
  'auto-fix:dispatched':           'var(--accent)',
  'auto-fix:cycle-complete':       'var(--ok, #5fd49a)',
  'auto-fix:cycle-failed':         'var(--err)',
  'auto-fix:diff-recorded':        'var(--info)',
  'auto-fix:awaiting-approval':    'var(--warn)',
  'auto-fix:approved':             'var(--ok, #5fd49a)',
  'auto-fix:rejected':             'var(--err)',
  'auto-fix:revert-failed':        'var(--err)',
  'auto-fix:no-targets':           'var(--fg-3)',
  'auto-fix:needs-clarification':  'var(--warn)',
  'auto-fix:out-of-scope':         'var(--warn)',
  'auto-fix:kill-switched':        'var(--warn)',
  'auto-fix:budget-exceeded':      'var(--warn)',
  'auto-fix:halted-failures':      'var(--err)',
  'auto-fix:dirty-tree':           'var(--warn)',
  'auto-fix:no-concerns-file':     'var(--fg-3)',
  'auto-fix:summary':              'var(--fg-3)',
};

function ago(ts: number): string {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86_400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86_400)}d ago`;
}

export function AutoFixPanel({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<AutoFixConfig | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [triggering, setTriggering] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [c, s, a] = await Promise.all([
        fetch('/api/config').then((r) => r.json()) as Promise<{ autoFixLoop?: AutoFixConfig }>,
        fetch('/api/snapshot').then((r) => r.json()) as Promise<{ findings: Finding[] }>,
        fetch('/api/approvals?filter=pending').then((r) => r.json()) as Promise<{ approvals: Approval[] }>,
      ]);
      setCfg(c.autoFixLoop ?? null);
      const ours = s.findings.filter((f) => f.agent === 'auto-fix-driver').slice(-60).reverse();
      setFindings(ours);
      setApprovals(a.approvals);
    } catch (e) { setError((e as Error).message); }
  };

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setDecidingId(id);
    try {
      const r = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setDecidingId(null); }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5_000);
    return () => clearInterval(id);
  }, []);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const trigger = async () => {
    setTriggering(true);
    try {
      await fetch('/api/agents/auto-fix-driver/run', { method: 'POST' });
      setTimeout(() => { void load(); setTriggering(false); }, 2_500);
    } catch { setTriggering(false); }
  };

  // Status banner colour based on the most authoritative recent kind.
  const statusKind = !cfg?.enabled ? 'auto-fix:loop-disabled'
    : findings[0]?.kind ?? 'auto-fix:loop-disabled';

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>AUTO-FIX · CONTINUOUS DEV LOOP</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {cfg?.enabled ? (cfg.dryRun ? 'enabled · dry-run' : 'enabled · LIVE') : 'disabled'}
          </div>
        </div>
        <button
          onClick={() => void trigger()}
          disabled={triggering || !cfg?.enabled}
          className="mono"
          style={{
            padding: '4px 12px', fontSize: 11, letterSpacing: 1,
            color: cfg?.enabled ? 'var(--accent)' : 'var(--fg-3)',
            borderColor: cfg?.enabled ? 'var(--accent)' : 'var(--hairline)',
            cursor: triggering || !cfg?.enabled ? 'wait' : 'pointer',
          }}
        >{triggering ? 'TRIGGERING…' : 'RUN CYCLE NOW'}</button>
        <button onClick={onClose} className="mono" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}>×</button>
      </div>

      {error && <div style={{ padding: 18, color: 'var(--err)' }}>{error}</div>}

      {/* Config + status grid */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 11 }}>
        <ConfigCell label="DRY-RUN" value={cfg?.dryRun ? 'YES (planned only)' : 'NO (live edits)'} colour={cfg?.dryRun ? 'var(--accent)' : 'var(--err)'} />
        <ConfigCell label="APPROVAL" value={cfg?.approvalMode === 'manual' ? 'MANUAL (human gate)' : 'AUTO (no gate)'} colour={cfg?.approvalMode === 'manual' ? 'var(--accent)' : 'var(--warn)'} />
        <ConfigCell label="DAILY CAP" value={cfg ? `${cfg.maxCyclesPerDay} cycle${cfg.maxCyclesPerDay === 1 ? '' : 's'}/24h` : '—'} />
        <ConfigCell label="HALT AFTER" value={cfg ? `${cfg.maxConsecutiveFailures} consec. failures` : '—'} />
        <ConfigCell label="KILL SWITCH" value={cfg?.killSwitchFile ?? '—'} colour="var(--fg-3)" />
        <ConfigCell label="SCOPES" value={cfg?.scopes.length ? cfg.scopes.join(' · ') : '(open / no filter)'} colour={cfg?.scopes.length ? 'var(--accent)' : 'var(--warn)'} />
        <ConfigCell label="STATUS KIND" value={KIND_LABEL[statusKind] ?? statusKind} colour={KIND_COLOR[statusKind] ?? 'var(--fg-2)'} />
      </div>

      {/* Pending approvals — only render when there are any */}
      {approvals.length > 0 && (
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--warn)', letterSpacing: 1.5, marginBottom: 8 }}>
            PENDING APPROVAL · {approvals.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {approvals.map((a) => {
              const isPromptDiff = a.kind === 'self:prompt-diff-proposal';
              const rejectLabel = isPromptDiff ? 'REJECT' : 'REJECT (revert files)';
              const tag = isPromptDiff ? 'PROMPT DIFF' : 'AUTO-FIX CYCLE';
              return (
                <div key={a.id} className="glass" style={{ padding: 12, borderLeft: '3px solid var(--warn)' }}>
                  <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
                    <span style={{ color: 'var(--accent)' }}>{tag}</span> · {ago(a.created_at)} · {a.id.slice(0, 8)}
                    {a.payload?.severity && <> · <span style={{ color: a.payload.severity === 'error' ? 'var(--err)' : a.payload.severity === 'warn' ? 'var(--warn)' : 'var(--fg-2)' }}>{a.payload.severity}</span></>}
                  </div>

                  {/* Concern body for auto-fix cycles */}
                  {!isPromptDiff && a.payload?.concernText && (
                    <div style={{ fontSize: 12, color: 'var(--fg)', margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                      {a.payload.concernText.slice(0, 240)}{a.payload.concernText.length > 240 ? '…' : ''}
                    </div>
                  )}

                  {/* File diff for auto-fix cycles */}
                  {!isPromptDiff && a.payload?.diff && a.payload.diff.filesChanged.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1, marginBottom: 3 }}>
                        FILES CHANGED · {a.payload.diff.filesChanged.length}
                        {a.payload.diff.outOfScopeFiles.length > 0 && (
                          <span style={{ color: 'var(--err)' }}> · {a.payload.diff.outOfScopeFiles.length} OUT-OF-SCOPE</span>
                        )}
                      </div>
                      {a.payload.diff.filesChanged.slice(0, 8).map((file, i) => {
                        const oos = a.payload!.diff!.outOfScopeFiles.includes(file);
                        return (
                          <div key={i} className="mono" style={{ fontSize: 10, color: oos ? 'var(--err)' : 'var(--fg-2)' }}>
                            {oos ? '⚠ ' : '· '}{file}
                          </div>
                        );
                      })}
                      {a.payload.diff.statTail && (
                        <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 120, overflowY: 'auto' }}>{a.payload.diff.statTail}</pre>
                      )}
                    </div>
                  )}

                  {/* Prompt-diff body */}
                  {isPromptDiff && (
                    <div style={{ marginTop: 6 }}>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--fg)' }}>
                        target agent: <b>{a.payload?.targetAgent ?? '?'}</b>
                      </div>
                      {a.payload?.promptPathRel && (
                        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>{a.payload.promptPathRel}</div>
                      )}
                      {a.payload?.proposalSummary && (
                        <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>{a.payload.proposalSummary}</div>
                      )}
                      {a.payload?.rationale && (
                        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4, fontStyle: 'italic' }}>
                          → {a.payload.rationale}
                        </div>
                      )}
                      {a.payload?.find && a.payload?.replace && (
                        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <div>
                            <div className="mono" style={{ fontSize: 9, color: 'var(--err)', letterSpacing: 1, marginBottom: 3 }}>FIND (current)</div>
                            <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', background: 'rgba(255,107,107,0.08)', padding: 6, borderRadius: 4 }}>{a.payload.find}</pre>
                          </div>
                          <div>
                            <div className="mono" style={{ fontSize: 9, color: 'var(--ok, #5fd49a)', letterSpacing: 1, marginBottom: 3 }}>REPLACE (proposed)</div>
                            <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', background: 'rgba(95,212,154,0.08)', padding: 6, borderRadius: 4 }}>{a.payload.replace}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Claude output (auto-fix only) */}
                  {!isPromptDiff && a.payload?.claudeOutputTail && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1, cursor: 'pointer' }}>CLAUDE OUTPUT (tail)</summary>
                      <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>{a.payload.claudeOutputTail}</pre>
                    </details>
                  )}

                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => void decide(a.id, 'approved')}
                      disabled={decidingId !== null}
                      className="mono"
                      style={{
                        padding: '6px 14px', fontSize: 11, letterSpacing: 1,
                        color: 'var(--ok, #5fd49a)', borderColor: 'var(--ok, #5fd49a)',
                        cursor: decidingId !== null ? 'wait' : 'pointer',
                      }}
                    >{decidingId === a.id ? 'DECIDING…' : (isPromptDiff ? 'APPROVE (apply diff)' : 'APPROVE')}</button>
                    <button
                      onClick={() => void decide(a.id, 'rejected')}
                      disabled={decidingId !== null}
                      className="mono"
                      style={{
                        padding: '6px 14px', fontSize: 11, letterSpacing: 1,
                        color: 'var(--err)', borderColor: 'var(--err)',
                        cursor: decidingId !== null ? 'wait' : 'pointer',
                      }}
                    >{decidingId === a.id ? 'DECIDING…' : rejectLabel}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cycle history */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        {findings.length === 0 ? (
          <div className="mono" style={{ fontSize: 12, color: 'var(--fg-3)', textAlign: 'center', padding: 40 }}>
            no auto-fix events yet · trigger a cycle or wait for the 30-min interval
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {findings.map((f) => {
              const colour = KIND_COLOR[f.kind] ?? 'var(--hairline)';
              const isExpanded = expanded.has(f.id);
              const p = (f.payload ?? {}) as {
                concernText?: string;
                fingerprint?: string;
                fileRef?: string | null;
                priorVerdict?: string | null;
                priorAttempts?: number;
                scopes?: string[];
                prompt?: string;
                claudeOutputTail?: string;
                durationMs?: number;
                diff?: DiffPayload;
                outOfScopeFiles?: string[];
                statTail?: string;
                filesChanged?: string[];
              };
              return (
                <div
                  key={f.id}
                  className="glass"
                  onClick={() => toggle(f.id)}
                  style={{
                    padding: 10, cursor: 'pointer',
                    borderLeft: `3px solid ${colour}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 9, color: colour, letterSpacing: 1 }}>
                      {(KIND_LABEL[f.kind] ?? f.kind).toUpperCase()}
                    </span>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>{ago(f.at)}</span>
                    {p.fingerprint && (
                      <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>· {p.fingerprint.slice(0, 8)}</span>
                    )}
                    {typeof p.priorAttempts === 'number' && p.priorAttempts > 0 && (
                      <span className="mono" style={{ fontSize: 9, color: 'var(--warn)' }}>· attempt {p.priorAttempts + 1}</span>
                    )}
                    {p.priorVerdict && (
                      <span className="mono" style={{ fontSize: 9, color: 'var(--warn)' }}>· prior: {p.priorVerdict}</span>
                    )}
                    {typeof p.durationMs === 'number' && (
                      <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>· {Math.round(p.durationMs / 1000)}s</span>
                    )}
                    {p.outOfScopeFiles && p.outOfScopeFiles.length > 0 && (
                      <span className="mono" style={{ fontSize: 9, color: 'var(--err)' }}>· {p.outOfScopeFiles.length} OUT-OF-SCOPE FILES</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg)', marginTop: 4 }}>{f.summary}</div>
                  {isExpanded && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {p.concernText && (
                        <Detail label="CONCERN">
                          <div style={{ fontSize: 11, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{p.concernText}</div>
                        </Detail>
                      )}
                      {p.fileRef && (
                        <Detail label="FILE REF"><code className="mono" style={{ fontSize: 10 }}>{p.fileRef}</code></Detail>
                      )}
                      {p.scopes && (
                        <Detail label="SCOPES IN EFFECT"><code className="mono" style={{ fontSize: 10 }}>{p.scopes.join(' · ')}</code></Detail>
                      )}
                      {p.filesChanged && p.filesChanged.length > 0 && (
                        <Detail label={`FILES CHANGED · ${p.filesChanged.length}`}>
                          {p.filesChanged.map((file, i) => {
                            const oos = p.outOfScopeFiles?.includes(file);
                            return (
                              <div key={i} className="mono" style={{ fontSize: 10, color: oos ? 'var(--err)' : 'var(--fg-2)' }}>
                                {oos ? '⚠ ' : '· '}{file}
                              </div>
                            );
                          })}
                        </Detail>
                      )}
                      {p.diff && p.diff.filesChanged && p.diff.filesChanged.length > 0 && (
                        <Detail label={`DIFF · ${p.diff.filesChanged.length} files`}>
                          {p.diff.filesChanged.map((file, i) => {
                            const oos = p.diff?.outOfScopeFiles?.includes(file);
                            return (
                              <div key={i} className="mono" style={{ fontSize: 10, color: oos ? 'var(--err)' : 'var(--fg-2)' }}>
                                {oos ? '⚠ ' : '· '}{file}
                              </div>
                            );
                          })}
                          {p.diff.statTail && (
                            <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', marginTop: 6 }}>{p.diff.statTail}</pre>
                          )}
                        </Detail>
                      )}
                      {p.statTail && (
                        <Detail label="GIT DIFF --STAT">
                          <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap' }}>{p.statTail}</pre>
                        </Detail>
                      )}
                      {p.claudeOutputTail && (
                        <Detail label="CLAUDE OUTPUT (tail)">
                          <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>{p.claudeOutputTail}</pre>
                        </Detail>
                      )}
                      {p.prompt && (
                        <Detail label="PROMPT (planned)">
                          <pre className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto', background: 'var(--surface)', padding: 8, borderRadius: 4 }}>{p.prompt}</pre>
                        </Detail>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigCell({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div className="glass" style={{ padding: 10 }}>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 11, color: colour ?? 'var(--fg)' }}>{value}</div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
