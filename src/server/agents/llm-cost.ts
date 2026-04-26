/* LLM-cost agent — deterministic.
 *
 * Tails an `llm_calls` table in the Nik Supabase project via REST,
 * flags expensive calls, and emits a daily roll-up. The Nik side is
 * responsible for INSERT-ing one row per Anthropic / OpenAI request
 * (this is the small Nik-side change called out in Phase 3.5 — to
 * be coordinated in the ~/NIK/ Claude Code session). Until that
 * lands, this agent stays quiet (one info finding) instead of
 * crashing.
 *
 * Expected Nik-side schema:
 *   create table llm_calls (
 *     id uuid primary key default gen_random_uuid(),
 *     created_at timestamptz not null default now(),
 *     agent text,         -- which Nik feature made the call
 *     model text,         -- claude-opus-4-7 / gpt-4 / etc.
 *     input_tokens int,
 *     output_tokens int,
 *     cost_cents int      -- precomputed at insert time
 *   );
 */

import { newId } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
const TABLE = process.env.LLM_CALLS_TABLE ?? 'llm_calls';

const FETCH_TIMEOUT_MS = 8_000;
/** Single-call cost cents threshold — anything above this gets flagged. */
const EXPENSIVE_CENTS = Number(process.env.LLM_EXPENSIVE_CENTS ?? 50);    // 50¢
/** Daily aggregate cents threshold — surfaces summary as warn above this. */
const DAILY_BUDGET_CENTS = Number(process.env.LLM_DAILY_BUDGET_CENTS ?? 2000);   // $20
const SUMMARY_EVERY_MS = 60 * 60 * 1000;

type Row = {
  id: string;
  created_at: string;
  agent?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_cents?: number | null;
};

let lastSeenAt = '1970-01-01T00:00:00Z';
let lastSummaryAt = 0;
let configHintEmitted = false;

async function fetchNewRows(): Promise<Row[] | { error: string; status?: number }> {
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(TABLE)}`
    + `?select=id,created_at,agent,model,input_tokens,output_tokens,cost_cents`
    + `&created_at=gt.${encodeURIComponent(lastSeenAt)}`
    + `&order=created_at.asc&limit=200`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { error: body.slice(0, 200) || `HTTP ${r.status}`, status: r.status };
    }
    return (await r.json()) as Row[];
  } catch (e) {
    return { error: (e as Error).message || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const dailyTotals = new Map<string, { cents: number; calls: number }>();

export const llmCostAgent: Agent = {
  name: 'llm-cost',
  description: 'Tails the llm_calls table; flags expensive calls and surfaces daily spend rollups.',
  routedFiles: [],
  intervalMs: 60_000,
  run: async () => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      if (configHintEmitted) return [];
      configHintEmitted = true;
      return [{
        id: newId(),
        agent: 'llm-cost',
        kind: 'llm:not-configured',
        at: Date.now(),
        severity: 'info',
        summary: 'set SUPABASE_URL + SUPABASE_ANON_KEY to enable LLM cost tracking',
      }];
    }

    const result = await fetchNewRows();
    if ('error' in result) {
      // Table not yet created on the Nik side, or auth misconfigured.
      // Surface once, then stay quiet until the env or schema changes.
      if (configHintEmitted) return [];
      configHintEmitted = true;
      return [{
        id: newId(),
        agent: 'llm-cost',
        kind: 'llm:not-configured',
        at: Date.now(),
        severity: 'info',
        summary: `llm_calls table unreachable (${result.status ?? 'err'}) — coordinate the Nik-side INSERT and ${TABLE} table`,
        payload: { error: result.error, status: result.status },
      }];
    }

    configHintEmitted = false;       // got a successful read; reset hint state
    const findings: Finding[] = [];

    for (const row of result) {
      lastSeenAt = row.created_at;
      const cents = row.cost_cents ?? 0;
      const key = dayKey(new Date(row.created_at).getTime());
      const day = dailyTotals.get(key) ?? { cents: 0, calls: 0 };
      day.cents += cents;
      day.calls += 1;
      dailyTotals.set(key, day);

      if (cents >= EXPENSIVE_CENTS) {
        findings.push({
          id: newId(),
          agent: 'llm-cost',
          kind: 'llm:expensive-call',
          at: new Date(row.created_at).getTime(),
          severity: cents >= EXPENSIVE_CENTS * 4 ? 'error' : 'warn',
          summary: `expensive ${row.model ?? '?'} call from ${row.agent ?? '?'} — ${(cents / 100).toFixed(2)} USD`,
          payload: {
            row_id: row.id,
            cost_cents: cents,
            input_tokens: row.input_tokens ?? null,
            output_tokens: row.output_tokens ?? null,
            model: row.model ?? null,
            agent_origin: row.agent ?? null,
          },
        });
      }
    }

    const now = Date.now();
    if (now - lastSummaryAt >= SUMMARY_EVERY_MS) {
      lastSummaryAt = now;
      const today = dailyTotals.get(dayKey(now)) ?? { cents: 0, calls: 0 };
      const overBudget = today.cents > DAILY_BUDGET_CENTS;
      findings.push({
        id: newId(),
        agent: 'llm-cost',
        kind: 'llm:daily-summary',
        at: now,
        severity: overBudget ? 'warn' : 'info',
        summary: `today: ${(today.cents / 100).toFixed(2)} USD across ${today.calls} call${today.calls === 1 ? '' : 's'}${overBudget ? ` (over $${(DAILY_BUDGET_CENTS / 100).toFixed(0)} budget)` : ''}`,
        payload: { day: dayKey(now), cost_cents: today.cents, calls: today.calls, budget_cents: DAILY_BUDGET_CENTS, overBudget },
      });
    }

    return findings;
  },
};
