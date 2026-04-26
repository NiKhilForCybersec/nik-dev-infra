import { useEffect, useState } from 'react';

type Cfg = {
  target: { path: string; label: string };
  screenshotsDir: string;
  concernsFile: string;
  resolutionsFile: string;
  claudeMdFile: string;
  writeback: { enabled: boolean; insertClaudeMdGate: boolean };
  riskGate: { allowWritePrompt: boolean; allowWriteUserRepo: boolean };
  hasUserConfig: boolean;
  configFilePath: string;
};

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d: Cfg) => {
        setCfg(d);
        setPathInput(d.target.path);
        setLabelInput(d.target.label);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const save = async () => {
    setError(null);
    if (!pathInput.trim() || !labelInput.trim()) {
      setError('both fields required');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetPath: pathInput.trim(), targetLabel: labelInput.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSavedAt(Date.now());
      // Refresh cfg
      const r2 = await fetch('/api/config');
      setCfg(await r2.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass" style={{
        background: 'var(--bg)', width: 'min(620px, 95vw)', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>SETUP</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>Watch a different repo</div>
          </div>
          <button onClick={onClose} className="mono" style={{ padding: '4px 10px', fontSize: 12 }}>×</button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div className="glass" style={{ padding: 10, color: 'var(--err)', borderColor: 'var(--err)' }}>{error}</div>}

          <div>
            <label className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>TARGET PATH</label>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Absolute path to the repo you want this dev-infra to watch. Use <code>~/</code> for home.</div>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="~/NIK"
              className="mono"
              style={{ width: '100%', padding: '8px 10px', fontSize: 12 }}
            />
          </div>

          <div>
            <label className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5 }}>TARGET LABEL</label>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Short name shown in the dashboard header.</div>
            <input
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              placeholder="Nik"
              className="mono"
              style={{ width: '100%', padding: '8px 10px', fontSize: 12 }}
            />
          </div>

          {cfg && (
            <div className="glass" style={{ padding: 10 }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: 1.5, marginBottom: 4 }}>CURRENT</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                {cfg.target.label} · {cfg.target.path}
              </div>
              <div className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 4 }}>
                {cfg.hasUserConfig ? `config file: ${cfg.configFilePath}` : 'using built-in defaults — no dev-infra.config.json yet'}
              </div>
            </div>
          )}

          {savedAt && (
            <div className="glass" style={{ padding: 10, borderColor: 'var(--ok)' }}>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ok)' }}>
                ✓ saved · restart the daemon for changes to take effect
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
                <code>cmd-c</code> in the daemon terminal, then <code>npm start</code>
              </div>
            </div>
          )}

          <button
            onClick={save}
            disabled={saving || !pathInput.trim() || !labelInput.trim()}
            className="mono"
            style={{
              padding: '8px 14px', fontSize: 12, alignSelf: 'flex-start',
              background: saving ? 'transparent' : 'var(--accent-soft)',
              borderColor: 'var(--accent)',
              color: 'var(--accent)',
              cursor: saving ? 'wait' : 'pointer',
            }}
          >{saving ? 'saving…' : 'save'}</button>
        </div>
      </div>
    </div>
  );
}
