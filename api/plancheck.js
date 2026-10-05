// PlanCheck Lite: Vercel Node serverless function.
// All secrets come from process.env inside this file only. Nothing secret is logged or returned.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const TRACKS = ['Consulting', 'PE/VC', 'Product', 'Finance', 'Public Policy', 'GCC Leadership'];
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TOTAL_POINTS = 4500;
const MIN_BID = 100;
const TOTAL_ELECTIVES = 18;
const DAILY_CAP = 3;
const CAP_MSG = "You've used your 3 free checks for today. Please come back tomorrow.";
const AI_FALLBACK = 'AI explanation unavailable right now; rule checks are shown below.';
const GENERIC_ERR = 'Something went wrong on our side. Please try again in a minute.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z0-9]{1,12}$/;

// Data files (bundled via vercel.json "includeFiles")
const COURSES_RAW = readFileSync(path.join(process.cwd(), 'term5.json'), 'utf8');
const COURSES = JSON.parse(COURSES_RAW);
const BY_CODE = new Map(COURSES.map((c) => [c.code, c]));
const ALL_CODES_RE = new RegExp(`\\b(${COURSES.map((c) => c.code).join('|')})\\b`, 'g');
const SYSTEM_PROMPT = readFileSync(path.join(process.cwd(), 'plancheck_system_prompt.txt'), 'utf8');
const SYSTEM_INSTRUCTION = SYSTEM_PROMPT + '\nTERM5_COURSES:\n' + COURSES_RAW;

const fmt = (n) => n.toLocaleString('en-US');

// ---------- Supabase (server only) ----------
let _sb = null;
function db() {
  if (!_sb) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('supabase_not_configured');
    _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _sb;
}

// ---------- Validation ----------
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}

// Strip things that look like emails or phone numbers before the goal is sent or stored.
function redact(s) {
  return s
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[removed]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[removed]');
}

function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Request body must be a JSON object.' };

  const visitor_id = typeof b.visitor_id === 'string' ? b.visitor_id.trim() : '';
  if (!UUID_RE.test(visitor_id)) return { error: 'Missing or invalid visitor_id.' };

  if (!TRACKS.includes(b.track)) return { error: `Track must be one of: ${TRACKS.join(', ')}.` };

  if (b.goal != null && typeof b.goal !== 'string') return { error: 'Goal must be text.' };
  const goalRaw = (b.goal || '').trim();
  if (goalRaw.length > 120) return { error: 'Goal must be 120 characters or fewer.' };
  const goal = redact(goalRaw);

  const points_spent = toInt(b.points_spent);
  if (!(points_spent >= 0 && points_spent <= TOTAL_POINTS)) {
    return { error: 'Points spent must be a whole number from 0 to 4,500.' };
  }
  const electives_completed = toInt(b.electives_completed);
  if (!(electives_completed >= 0 && electives_completed <= TOTAL_ELECTIVES)) {
    return { error: 'Electives completed must be a whole number from 0 to 18.' };
  }

  if (!Array.isArray(b.planned) || b.planned.length < 1 || b.planned.length > 5) {
    return { error: 'Plan between 1 and 5 courses.' };
  }
  const planned = [];
  const seen = new Set();
  for (let i = 0; i < b.planned.length; i++) {
    const p = b.planned[i];
    if (!p || typeof p !== 'object') return { error: `Course ${i + 1} is missing.` };
    const code = typeof p.code === 'string' ? p.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) return { error: `Course ${i + 1} needs a course code (letters and numbers only).` };
    const bid = toInt(p.bid);
    if (!(bid >= 0 && bid <= TOTAL_POINTS)) return { error: `Bid for ${code} must be a whole number from 0 to 4,500.` };
    if (seen.has(code)) return { error: `${code} appears more than once.` };
    seen.add(code);
    planned.push({ code, bid });
  }

  return { value: { visitor_id, track: b.track, goal, points_spent, electives_completed, planned } };
}

// ---------- Deterministic rules (code, never the model) ----------
function runRules({ points_spent, electives_completed, planned }) {
  const rules = [];
  const invalid = planned.filter((p) => !BY_CODE.has(p.code)).map((p) => p.code);
  const valid = planned.filter((p) => BY_CODE.has(p.code));
  const n = valid.length;

  // a) Course codes valid
  rules.push(invalid.length
    ? { rule: 'Course codes valid', status: 'FAIL', detail: `Not Term 5 courses, ignored: ${invalid.join(', ')}.` }
    : { rule: 'Course codes valid', status: 'OK', detail: `All ${n} codes are Term 5 courses.` });

  // b) 3–5 electives this term
  rules.push({
    rule: '3–5 electives this term',
    status: n >= 3 && n <= 5 ? 'OK' : 'FAIL',
    detail: `${n} valid course${n === 1 ? '' : 's'} planned; Term 5 needs 3 to 5.`,
  });

  // c) At least 100 points per course
  const low = valid.filter((p) => p.bid < MIN_BID);
  rules.push({
    rule: 'At least 100 points per course',
    status: low.length ? 'FAIL' : 'OK',
    detail: low.length
      ? `Below 100: ${low.map((p) => `${p.code} (${fmt(p.bid)})`).join(', ')}.`
      : n ? 'Every bid is 100 or more.' : 'No valid courses to check.',
  });

  // d) Total within 4,500 (bids of valid courses only; invalid codes are dropped)
  const bidSum = valid.reduce((s, p) => s + p.bid, 0);
  const total = points_spent + bidSum;
  rules.push({
    rule: 'Total within 4,500',
    status: total <= TOTAL_POINTS ? 'OK' : 'FAIL',
    detail: `${fmt(points_spent)} spent + ${fmt(bidSum)} bid = ${fmt(total)} of 4,500.`,
  });

  // e) Points left for remaining electives
  const remaining = TOTAL_POINTS - total;
  const needed = Math.max(0, TOTAL_ELECTIVES - electives_completed - n);
  const minNeeded = MIN_BID * needed;
  rules.push({
    rule: 'Points left for remaining electives',
    status: remaining >= minNeeded ? 'OK' : 'FAIL',
    detail: needed === 0
      ? `${fmt(remaining)} points left; no further electives needed after this plan.`
      : `${fmt(remaining)} points left for ${needed} more elective${needed === 1 ? '' : 's'}; at least ${fmt(minNeeded)} needed.`,
  });

  return { rules, valid };
}

function ruleSummary(rules) {
  const f = rules.find((r) => r.status === 'FAIL');
  return f ? `${f.rule}: ${f.detail}` : 'All rule checks passed.';
}

// ---------- Missed candidates (code) ----------
function missedCandidates(track, validCodes) {
  const planned = new Set(validCodes);
  const unplanned = COURSES.filter((c) => !planned.has(c.code));
  return [
    ...unplanned.filter((c) => c.track_fit[track] === 'core'),
    ...unplanned.filter((c) => c.track_fit[track] === 'useful'),
  ].map((c) => c.code);
}

// ---------- Gemini ----------
async function callGemini(student, rules, candidates) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('gemini_not_configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{
          role: 'user',
          parts: [{
            text: `STUDENT: ${JSON.stringify(student)}\nRULE_RESULTS: ${JSON.stringify(rules)}\nMISSED_CANDIDATES: ${JSON.stringify(candidates)}`,
          }],
        }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.2, responseMimeType: 'application/json' },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let reason = '';
      try { const j = await r.json(); reason = j?.error?.status || j?.error?.message || ''; } catch {}
      throw new Error(`gemini_http_${r.status} ${String(reason).slice(0, 200)}`);
    }
    const data = await r.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return { text, usage: data?.usageMetadata || {}, finish: data?.candidates?.[0]?.finishReason };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Server-side guardrail on model output ----------
function sanitize(text, validCodes, candidates, track) {
  let obj;
  try {
    obj = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const allowedAny = new Set([...validCodes, ...candidates]);
  const mentionsOther = (s) => (s.match(ALL_CODES_RE) || []).some((c) => !allowedAny.has(c));
  const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 600) : '');

  const pick = (arr, allowed, max) => {
    const out = [];
    const seen = new Set();
    for (const it of Array.isArray(arr) ? arr : []) {
      const code = typeof it?.code === 'string' ? it.code.trim().toUpperCase() : '';
      const note = str(it?.note);
      if (!allowed.has(code) || seen.has(code) || !note || mentionsOther(note)) continue;
      seen.add(code);
      const c = BY_CODE.get(code);
      out.push({ code, name: c.name, track_fit: c.track_fit[track], note });
      if (out.length >= max) break;
    }
    return out;
  };

  const summary = str(obj.summary);
  const coverage = str(obj.coverage_note);
  return {
    summary: mentionsOther(summary) ? '' : summary,
    fit: pick(obj.fit, new Set(validCodes), 5),
    missed_options: pick(obj.missed_options, new Set(candidates), 2),
    coverage_note: mentionsOther(coverage) ? '' : coverage,
  };
}

// ---------- Stats ----------
async function getStats() {
  const sb = db();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [total, week] = await Promise.all([
    sb.from('plan_checks').select('id', { count: 'exact', head: true }),
    sb.from('plan_checks').select('track').gte('created_at', since7d),
  ]);
  if (total.error || week.error) {
    const e = total.error || week.error;
    console.error('plancheck: supabase stats error:', e.code || '', e.message || '', e.hint || '');
    throw new Error('stats_failed');
  }
  const tally = {};
  for (const row of week.data || []) if (row.track) tally[row.track] = (tally[row.track] || 0) + 1;
  let top = null;
  let best = 0;
  for (const t of TRACKS) if ((tally[t] || 0) > best) { best = tally[t]; top = t; }
  return { plans_checked: total.count ?? 0, top_track_week: top };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ stats: await getStats() });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    const v = validate(body);
    if (v.error) return res.status(400).json({ error: v.error });
    const input = v.value;
    const sb = db();

    // Daily cap: checked before any Gemini call. Fails closed if the count can't be read.
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: capError } = await sb
      .from('plan_checks')
      .select('id', { count: 'exact', head: true })
      .eq('visitor_id', input.visitor_id)
      .gte('created_at', since24h);
    if (capError) {
      console.error('plancheck: supabase cap error:', capError.code || '', capError.message || '', capError.hint || '');
      throw new Error('cap_check_failed');
    }
    if ((count ?? 0) >= DAILY_CAP) return res.status(429).json({ error: CAP_MSG });

    const { rules, valid } = runRules(input);
    const validCodes = valid.map((p) => p.code);
    const candidates = missedCandidates(input.track, validCodes);

    let ai = null;
    let usage = {};
    let modelUsed = null;
    if (validCodes.length > 0) {
      modelUsed = MODEL;
      try {
        const g = await callGemini({ track: input.track, goal: input.goal, planned: validCodes }, rules, candidates);
        usage = g.usage;
        ai = sanitize(g.text, validCodes, candidates, input.track);
        if (!ai) console.error('plancheck: model returned invalid JSON, finishReason:', g.finish || '', 'chars:', (g.text || '').length);
      } catch (err) {
        console.error('plancheck: gemini call failed:', err?.name === 'AbortError' ? 'timeout' : err?.message);
      }
    }

    const summary = ai
      ? (ai.summary || ruleSummary(rules))
      : (validCodes.length ? AI_FALLBACK : ruleSummary(rules));

    const output = {
      summary,
      rules,
      fit: ai?.fit ?? [],
      missed_options: ai?.missed_options ?? [],
      coverage_note: ai?.coverage_note ?? '',
    };

    const { error: insertError } = await sb.from('plan_checks').insert({
      visitor_id: input.visitor_id,
      track: input.track,
      courses: validCodes,
      input: {
        track: input.track,
        goal: input.goal,
        points_spent: input.points_spent,
        electives_completed: input.electives_completed,
        planned: input.planned,
      },
      rule_flags: rules,
      output,
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null,
      model: modelUsed,
    });
    if (insertError) console.error('plancheck: log insert failed:', insertError.code || '', insertError.message || '');

    let stats = null;
    try { stats = await getStats(); } catch { /* stats are optional on POST */ }

    return res.status(200).json({ ...output, stats });
  } catch (err) {
    console.error('plancheck: request failed:', err?.message);
    return res.status(500).json({ error: GENERIC_ERR });
  }
}
