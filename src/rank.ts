// Generic "sort by judgment" engine on top of Jev. Items are opaque cards; the criterion is a sentence.

// ---------- Jev client ----------
const JEV = "https://api.typesafe.ai/v1/systemone";
// Runtime-agnostic: the same file runs in Bun (server) and in the extension's service worker.
let CONCURRENCY = 256;
let API_KEY = "";
export function configure(o: { key?: string; concurrency?: number }) {
  if (o.key != null) API_KEY = o.key;
  if (o.concurrency) CONCURRENCY = o.concurrency;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await f();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

interface Answer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

const stats = { calls: 0, decisions: 0, errors: 0, hedges: 0, inputTokens: 0, lat: [] as number[] };

// Every wave waits for its slowest call, so wall time is a sum of per-wave maxima. A single
// multi-second straggler used to triple the total. Hedge: if a call is still out after ~3x the
// running p50, fire a duplicate and keep whichever answers first (Dean & Barroso, "The Tail at Scale").
let p50 = 200;
const hedgeAfter = () => Math.min(900, Math.max(300, 3 * p50));

async function once(body: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(JEV, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body,
      signal,
    });
    if (res.ok) return res.json() as Promise<any>;
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(150 * 2 ** attempt);
      continue;
    }
    throw new Error(`jev ${res.status}: ${text.slice(0, 200)}`);
  }
}

export function jev(state: unknown, questions: Record<string, unknown>): Promise<{ answers: Record<string, Answer>; ms: number }> {
  return slot(async () => {
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    const t0 = performance.now();
    const ctl = [new AbortController()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r: any = await new Promise((resolve, reject) => {
        let failed = 0;
        const launch = (c: AbortController) =>
          once(body, c.signal).then(resolve, (e) => {
            if (++failed === ctl.length && (ctl.length > 1 || !timer)) reject(e);
          });
        launch(ctl[0]);
        timer = setTimeout(() => {
          timer = undefined;
          if (stats.hedges > 8 + stats.calls * 0.15) return; // during a backend-wide slowdown, hedging only adds load
          stats.hedges++;
          const c = new AbortController();
          ctl.push(c);
          launch(c);
        }, hedgeAfter());
      });
      const ms = performance.now() - t0;
      stats.calls++;
      stats.decisions += Object.keys(questions).length;
      stats.inputTokens += r.usage?.input_tokens || 0;
      stats.lat.push(ms);
      p50 = p50 * 0.95 + Math.min(ms, 2000) * 0.05;
      return { answers: r.answers, ms };
    } catch (e) {
      stats.errors++;
      throw e;
    } finally {
      clearTimeout(timer);
      for (const c of ctl) c.abort();
    }
  });
}

export function summary() {
  const l = [...stats.lat].sort((a, b) => a - b);
  const q = (p: number) => (l.length ? Math.round(l[Math.min(l.length - 1, Math.floor(p * l.length))]) : 0);
  return { calls: stats.calls, decisions: stats.decisions, errors: stats.errors, hedges: stats.hedges, p50: q(0.5), p90: q(0.9), costUsd: (stats.inputTokens / 1e6) * 0.042 };
}

// ---------- task description ----------
export interface RankItem {
  id: string;
  card: Record<string, unknown>;
}

export interface RankTask {
  noun: string; // "email", "company"
  context: Record<string, unknown>; // who is asking and why
  criterion: string; // the sentence we sort by
  guide?: string[]; // extra guidance (used for the default criterion)
  algo?: "auto" | "full" | "pivot" | "swiss";
  plain?: boolean; // Swiss rounds only: no triage read first and no top round robin after
}

const TIERS: Record<string, string> = {
  top: "One of the very best matches for the criterion",
  strong: "Clearly matches the criterion well",
  some: "Partly matches the criterion",
  weak: "Barely matches the criterion",
  none: "Does not match the criterion at all",
};
const TIER_VALUE: Record<string, number> = { top: 4, strong: 3, some: 2, weak: 1, none: 0 };

// ---------- tournament ----------
export interface Match {
  a: string;
  b: string;
  pA: number; // P(a ranks above b)
  ms: number;
  phase: string;
}
export type Emit = (ev: Record<string, unknown>) => void;

// Pivot calls carry P+1 cards; trimming long text on the pivot side keeps those calls as fast as a pair.
const lite = (c: Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(c || {}).map(([k, v]) => [k, typeof v === "string" && v.length > 280 ? v.slice(0, 280) + "…" : v]));

const shuffle = <T>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

export async function rank(items: RankItem[], task: RankTask, emit: Emit) {
  const t0 = performance.now();
  Object.assign(stats, { calls: 0, decisions: 0, errors: 0, hedges: 0, inputTokens: 0, lat: [] });
  const ids = items.map((t) => t.id);
  const n = ids.length;
  // A/B (ab/pack.ts): one pair per call is the most accurate shape; packing many questions into a
  // call is cheaper but drifts (k=8 blocks: tau 0.57 vs 0.97). So: every pair at once while that
  // fits Jev's ~256-in-flight sweet spot, otherwise a Swiss tournament of single pairs.
  const algo = !task.algo || task.algo === "auto" ? ((n * (n - 1)) / 2 <= 300 ? "full" : "swiss") : task.algo;
  const cards = new Map(items.map((t) => [t.id, t.card]));
  const seed = new Map<string, number>();
  const played = new Map(ids.map((id) => [id, new Set<string>()]));
  const record = new Map(ids.map((id) => [id, { w: 0, l: 0 }]));
  const score = new Map(ids.map((id) => [id, 0]));
  const matches: Match[] = [];
  const rule = `Rank each ${task.noun} by this criterion: "${task.criterion}".`;
  const base = { context: task.context, criterion: task.criterion };

  const swissRounds = Math.ceil(Math.log2(n)) + 2;
  const K = Math.min(12, n);
  const P = Math.min(8, Math.max(2, Math.floor(n / 12)));
  const REFINE = 3;
  const plain = !!task.plain && algo === "swiss";
  const phases = plain
    ? [...Array.from({ length: swissRounds }, (_, i) => ({ key: `s${i + 1}`, label: `Swiss round ${i + 1} of ${swissRounds}`, total: Math.floor(n / 2) })), { key: "bt", label: "Bradley–Terry fit" }]
    : algo === "full"
      ? [
          { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
          { key: "full", label: `All ${(n * (n - 1)) / 2} pairs at once`, total: (n * (n - 1)) / 2 },
          { key: "bt", label: "Bradley–Terry fit" },
        ]
      : algo === "swiss"
      ? [
          { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
          ...Array.from({ length: swissRounds }, (_, i) => ({ key: `s${i + 1}`, label: `Swiss round ${i + 1}` })),
          { key: "rr", label: `Top-${K} round robin` },
          { key: "bt", label: "Bradley–Terry fit" },
        ]
      : [
          { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
          { key: "pivot", label: `Place against ${P} pivots` },
          ...Array.from({ length: REFINE }, (_, i) => ({ key: `n${i + 1}`, label: `Neighbour pass ${i + 1}` })),
          { key: "rr", label: `Top-${K} round robin` },
          { key: "bt", label: "Bradley–Terry fit" },
        ];
  emit({ type: "plan", algo, n, phases, criterion: task.criterion });

  const record1 = (a: string, b: string, pA: number, ms: number, phase: string) => {
    const m: Match = { a, b, pA, ms: Math.round(ms), phase };
    matches.push(m);
    score.set(a, score.get(a)! + pA);
    score.set(b, score.get(b)! + 1 - pA);
    played.get(a)!.add(b);
    played.get(b)!.add(a);
    record.get(pA >= 0.5 ? a : b)!.w++;
    record.get(pA >= 0.5 ? b : a)!.l++;
    emit({ type: "match", ...m });
  };

  // One pairwise question per call. A/B sides are randomized so position bias averages out.
  const play = async (a: string, b: string, phase: string) => {
    const swap = Math.random() < 0.5;
    const [x, y] = swap ? [b, a] : [a, b];
    try {
      const r = await jev(
        { ...base, A: cards.get(x), B: cards.get(y) },
        {
          higher: {
            type: "choice",
            instructions: [rule, `Which ${task.noun}, \`A\` or \`B\`, ranks higher?`, ...(task.guide || [])],
            criteria: { A: `${task.noun} A ranks higher`, B: `${task.noun} B ranks higher` },
          },
        },
      );
      const pX = r.answers.higher.probabilities.A ?? (r.answers.higher.choice === "A" ? 1 : 0);
      record1(a, b, swap ? 1 - pX : pX, r.ms, phase);
    } catch (e) {
      emit({ type: "error", id: a, message: String(e).slice(0, 160) });
    }
  };

  const wave = async (key: string, pairs: [string, string][], extra: Promise<unknown>[] = []) => {
    emit({ type: "phase", key, total: pairs.length + extra.length, pairs });
    await Promise.all([...pairs.map(([a, b]) => play(a, b, key)), ...extra]);
  };

  const fit = () => bradleyTerry(ids, matches, seed);
  const orderBy = (s: Map<string, number>) => [...ids].sort((x, y) => s.get(y)! - s.get(x)!);
  const standings = (order: string[]) => emit({ type: "standings", order, record: Object.fromEntries(record) });

  // Triage: one independent read of every item, all in one parallel wave. Seeds everything after it.
  const triage = () =>
    Promise.all(
      ids.map(async (id) => {
        try {
          const r = await jev(
            { ...base, item: cards.get(id) },
            { tier: { type: "choice", instructions: [rule, `How well does \`item\` match the criterion?`, ...(task.guide || [])], criteria: TIERS } },
          );
          const a = r.answers.tier;
          seed.set(id, Object.entries(a.probabilities).reduce((s, [k, p]) => s + (TIER_VALUE[k] ?? 0) * p, 0));
          emit({ type: "triage", id, tier: a.choice, value: seed.get(id), conf: a.confidence, ms: Math.round(r.ms) });
        } catch (e) {
          seed.set(id, 2);
          emit({ type: "error", id, message: String(e).slice(0, 160) });
        }
      }),
    );

  if (algo === "full") {
    // Triage and the complete round robin share one wave: wall time is ~one Jev round-trip.
    const all: [string, string][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([ids[i], ids[j]]);
    shuffle(all);
    emit({ type: "phase", key: "triage", total: n });
    const live = setInterval(() => standings(orderBy(fit())), 250);
    await Promise.all([triage(), wave("full", all)]);
    clearInterval(live);
    const strength = fit();
    return finish(strength);
  }

  if (plain) for (const id of ids) seed.set(id, 2); // everyone starts level
  else {
    emit({ type: "phase", key: "triage", total: n });
    await triage();
  }
  const seeded = plain ? shuffle([...ids]) : [...ids].sort((x, y) => seed.get(y)! - seed.get(x)!);
  standings(seeded);

  if (algo === "swiss") {
    // Swiss: pair neighbours in the standings (no rematches); a round costs one Jev round-trip.
    for (let round = 1; round <= swissRounds; round++) {
      const order = round === 1 ? seeded : [...ids].sort((x, y) => score.get(y)! - score.get(x)! || seed.get(y)! - seed.get(x)!);
      const pairs: [string, string][] = [];
      const used = new Set<string>();
      for (let i = 0; i < order.length; i++) {
        const a = order[i];
        if (used.has(a)) continue;
        let j = i + 1;
        while (j < order.length && (used.has(order[j]) || played.get(a)!.has(order[j]))) j++;
        if (j >= order.length) j = order.findIndex((b, k) => k > i && !used.has(b));
        if (j < 0 || j >= order.length) continue;
        used.add(a).add(order[j]);
        pairs.push([a, order[j]]);
      }
      await wave(`s${round}`, pairs);
      standings([...ids].sort((x, y) => score.get(y)! - score.get(x)! || seed.get(y)! - seed.get(x)!));
    }
  } else {
    // Pivot (sample) sort: pick P pivots spread over the seeded order, denser near the top where
    // precision matters. Every other item meets all pivots in ONE Jev call (P questions over shared
    // state), and the pivots play each other, all in a single wave. That places every item in ~0.4s.
    const qs = [0.02, 0.06, 0.12, 0.2, 0.32, 0.48, 0.66, 0.85].slice(0, P);
    const pivots = [...new Set(qs.map((q) => seeded[Math.min(n - 1, Math.floor(q * n))]))];
    const pivotSet = new Set(pivots);
    const pivotPairs: [string, string][] = [];
    for (let i = 0; i < pivots.length; i++) for (let j = i + 1; j < pivots.length; j++) pivotPairs.push([pivots[i], pivots[j]]);
    const placements = ids
      .filter((id) => !pivotSet.has(id))
      .map(async (id) => {
        const names = pivots.map((_, k) => `P${k + 1}`);
        const questions = Object.fromEntries(
          names.map((p) => {
            const sides = shuffle([
              ["item", `\`item\` ranks higher`],
              [p, `\`pivots.${p}\` ranks higher`],
            ]);
            return [`vs_${p}`, { type: "choice", instructions: [rule, `Does \`item\` rank above \`pivots.${p}\`?`, ...(task.guide || [])], criteria: Object.fromEntries(sides) }];
          }),
        );
        try {
          const r = await jev({ ...base, pivots: Object.fromEntries(names.map((p, k) => [p, lite(cards.get(pivots[k]))])), item: cards.get(id) }, questions);
          names.forEach((p, k) => {
            const a = r.answers[`vs_${p}`];
            if (a) record1(id, pivots[k], a.probabilities.item ?? (a.choice === "item" ? 1 : 0), r.ms, "pivot");
          });
        } catch (e) {
          emit({ type: "error", id, message: String(e).slice(0, 160) });
        }
      });
    emit({ type: "pivots", ids: pivots });
    await wave("pivot", pivotPairs, placements);
    let order = orderBy(fit());
    standings(order);

    // Neighbour passes (odd-even transposition style): compare each item with the one right below
    // it, then the other parity, then two apart. Re-fit after each so effort follows the uncertainty.
    for (let w = 0; w < REFINE; w++) {
      const step = w < 2 ? 1 : 2;
      const pairs: [string, string][] = [];
      const used = new Set<string>();
      for (let i = w % 2; i + step < order.length; i += step === 1 ? 2 : 1) {
        const a = order[i], b = order[i + step];
        if (used.has(a) || used.has(b) || played.get(a)!.has(b)) continue;
        used.add(a).add(b);
        pairs.push([a, b]);
      }
      await wave(`n${w + 1}`, pairs);
      order = orderBy(fit());
      standings(order);
    }
  }

  if (plain) return finish(fit());
  // The head of the list is what people read: the top K play a full round robin.
  const top = orderBy(fit()).slice(0, K);
  const rr: [string, string][] = [];
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) if (!played.get(top[i])!.has(top[j])) rr.push([top[i], top[j]]);
  await wave("rr", rr);
  return finish(fit());

  function finish(strength: Map<string, number>) {
    emit({ type: "phase", key: "bt", total: 1 });
    const final = orderBy(strength);
    const vals = [...strength.values()];
    const max = Math.max(...vals), min = Math.min(...vals);
    const result = {
      type: "done",
      algo,
      order: final,
      importance: Object.fromEntries(final.map((id) => [id, (strength.get(id)! - min) / (max - min || 1)])),
      tiers: Object.fromEntries(ids.map((id) => [id, seed.get(id)])),
      record: Object.fromEntries(record),
      matches: matches.length,
      waves: phases.length - 1,
      ms: Math.round(performance.now() - t0),
      jev: summary(),
    };
    emit(result);
    return result;
  }
}

export function bradleyTerry(ids: string[], matches: Match[], seed: Map<string, number>) {
  // MM updates with soft wins. A weak prior game against a virtual player at the triage seed keeps
  // items with few games from drifting to the extremes.
  const s = new Map(ids.map((id) => [id, 1]));
  const prior = new Map(ids.map((id) => [id, Math.exp((seed.get(id) ?? 2) - 2)]));
  const by = new Map(ids.map((id) => [id, [] as { o: string; w: number }[]]));
  for (const m of matches) {
    by.get(m.a)!.push({ o: m.b, w: m.pA });
    by.get(m.b)!.push({ o: m.a, w: 1 - m.pA });
  }
  for (let it = 0; it < 200; it++) {
    for (const id of ids) {
      const si = s.get(id)!;
      let wins = 0.5, denom = 1 / (si + prior.get(id)!);
      for (const { o, w } of by.get(id)!) {
        wins += w;
        denom += 1 / (si + s.get(o)!);
      }
      s.set(id, wins / denom);
    }
    const g = Math.exp(ids.reduce((a, id) => a + Math.log(s.get(id)!), 0) / ids.length);
    for (const id of ids) s.set(id, s.get(id)! / g);
  }
  return new Map(ids.map((id) => [id, Math.log(s.get(id)!)]));
}

// ---------- live ranking: rank while items are still arriving ----------
// No rounds. Whenever an item is free, it plays the opponent the current fit is least sure about:
// maximize p(1-p) * (1/games_a + 1/games_b), p = P(a beats b) under Bradley–Terry. A new item starts
// at the middle of the scale, so its first games are against the middle of the field (a binary
// search in effect). Each item has at most two games out at a time and plays about log2(n) + 2,
// the same budget as Swiss, but nothing waits for the slowest call of a round. After the last item
// arrives, the top 6 also play any neighbour they haven't met. ab/live.ts, 116 items: 1.4-2.1s and
// Kendall tau 0.87, vs 2.2-2.6s and tau 0.65 for Swiss rounds, for ~15% more calls.
export function rankLive(task: RankTask, emit: Emit) {
  const AT_ONCE = 2; // games one item can have out at a time
  const t0 = performance.now();
  Object.assign(stats, { calls: 0, decisions: 0, errors: 0, hedges: 0, inputTokens: 0, lat: [] });
  const ids: string[] = [];
  const cards = new Map<string, Record<string, unknown>>();
  const played = new Map<string, Set<string>>();
  const record = new Map<string, { w: number; l: number }>();
  const games = new Map<string, number>();
  const busy = new Map<string, number>(); // games out right now, per item
  const isBusy = (id: string) => (busy.get(id) || 0) >= AT_ONCE;
  const matches: Match[] = [];
  const noSeed = new Map<string, number>();
  const rule = `Rank each ${task.noun} by this criterion: "${task.criterion}".`;
  const base = { context: task.context, criterion: task.criterion };
  let strength = new Map<string, number>();
  let out = 0, fitAt = 0, dirty = false, ended = false, stopped = false, finished = false, settled = false;
  let resolveDone: (r: any) => void = () => {};
  const done = new Promise<any>((r) => (resolveDone = r));

  const target = () => Math.ceil(Math.log2(Math.max(2, ids.length))) + 2;
  const budget = () => Math.ceil((ids.length * target()) / 2) + 5;
  const refit = (force = false) => {
    if (!dirty && !force) return;
    if (!force && performance.now() - fitAt < 60) return;
    strength = bradleyTerry(ids, matches, noSeed);
    fitAt = performance.now();
    dirty = false;
  };
  const order = () => [...ids].sort((x, y) => (strength.get(y) ?? 0) - (strength.get(x) ?? 0));
  const standings = () => emit({ type: "standings", order: order(), record: Object.fromEntries(record), budget: budget() });

  const play = async (a: string, b: string, phase: string) => {
    out++;
    for (const x of [a, b]) busy.set(x, (busy.get(x) || 0) + 1);
    played.get(a)!.add(b);
    played.get(b)!.add(a);
    const swap = Math.random() < 0.5;
    const [x, y] = swap ? [b, a] : [a, b];
    try {
      const r = await jev(
        { ...base, A: cards.get(x), B: cards.get(y) },
        {
          higher: {
            type: "choice",
            instructions: [rule, `Which ${task.noun}, \`A\` or \`B\`, ranks higher?`, ...(task.guide || [])],
            criteria: { A: `${task.noun} A ranks higher`, B: `${task.noun} B ranks higher` },
          },
        },
      );
      const pX = r.answers.higher.probabilities.A ?? (r.answers.higher.choice === "A" ? 1 : 0);
      const m: Match = { a, b, pA: swap ? 1 - pX : pX, ms: Math.round(r.ms), phase };
      matches.push(m);
      games.set(a, games.get(a)! + 1);
      games.set(b, games.get(b)! + 1);
      record.get(m.pA >= 0.5 ? a : b)!.w++;
      record.get(m.pA >= 0.5 ? b : a)!.l++;
      dirty = true;
      emit({ type: "match", ...m });
    } catch (e) {
      emit({ type: "error", id: a, message: String(e).slice(0, 160) });
    } finally {
      for (const x of [a, b]) busy.set(x, busy.get(x)! - 1);
      out--;
      pump();
    }
  };

  function pump() {
    if (stopped || finished) return;
    refit();
    const T = target();
    const free = ids.filter((id) => !isBusy(id));
    const load = (id: string) => games.get(id)! + (busy.get(id) || 0); // games played or out
    const need = shuffle(free.filter((id) => load(id) < T)).sort((x, y) => load(x) - load(y));
    for (const a of need) {
      while (!isBusy(a) && load(a) < T) {
        const sa = strength.get(a) ?? 0, ga = load(a);
        let best = "", bestV = -1;
        for (const b of free) {
          if (b === a || isBusy(b) || played.get(a)!.has(b)) continue;
          const p = 1 / (1 + Math.exp((strength.get(b) ?? 0) - sa));
          const v = p * (1 - p) * (1 / (ga + 1) + 1 / (load(b) + 1));
          if (v > bestV) (bestV = v), (best = b);
        }
        if (!best) break;
        play(a, best, "live");
      }
    }
    if (!ended) return;
    if (!settled && ids.every((id) => games.get(id)! >= T || ids.every((b) => b === id || played.get(id)!.has(b)))) {
      // Budget spent: the head of the list is what people read, so its neighbours that haven't met
      // play once, all at the same time (repeating this until stable doubled the wall time).
      settled = true;
      refit(true);
      const top = order().slice(0, 6);
      for (let i = 0; i + 1 < top.length; i++) {
        const [a, b] = [top[i], top[i + 1]];
        if (!isBusy(a) && !isBusy(b) && !played.get(a)!.has(b)) play(a, b, "top");
      }
    }
    if (out === 0) finish();
  }

  const live = setInterval(() => {
    if (!dirty) return;
    refit(true);
    standings();
  }, 250);

  function finish() {
    finished = true;
    clearInterval(live);
    refit(true);
    const final = order();
    const vals = [...strength.values()];
    const max = Math.max(...vals), min = Math.min(...vals);
    const result = {
      type: "done",
      algo: "live",
      order: final,
      importance: Object.fromEntries(final.map((id) => [id, ((strength.get(id) ?? 0) - min) / (max - min || 1)])),
      record: Object.fromEntries(record),
      matches: matches.length,
      ms: Math.round(performance.now() - t0),
      jev: summary(),
    };
    emit(result);
    resolveDone(result);
  }

  return {
    add(item: RankItem) {
      if (cards.has(item.id) || ended) return;
      ids.push(item.id);
      cards.set(item.id, item.card);
      played.set(item.id, new Set());
      record.set(item.id, { w: 0, l: 0 });
      games.set(item.id, 0);
      dirty = true;
      pump();
    },
    // No more items are coming. Resolves with the "done" event once the last games are in.
    end() {
      ended = true;
      if (ids.length < 2) finish();
      else pump();
      return done;
    },
    // Abandon: start no new games (calls already out still land, unreported).
    stop() {
      stopped = true;
      clearInterval(live);
    },
  };
}
