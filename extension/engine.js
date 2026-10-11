// src/rank.ts
var JEV = "https://api.typesafe.ai/v1/systemone";
var CONCURRENCY = 256;
var API_KEY = "";
function configure(o) {
  if (o.key != null)
    API_KEY = o.key;
  if (o.concurrency)
    CONCURRENCY = o.concurrency;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var active = 0;
var waiting = [];
async function slot(f) {
  if (active >= CONCURRENCY)
    await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await f();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
var stats = { calls: 0, decisions: 0, errors: 0, hedges: 0, inputTokens: 0, lat: [] };
var p50 = 200;
var hedgeAfter = () => Math.min(900, Math.max(300, 3 * p50));
async function once(body, signal) {
  for (let attempt = 0;; attempt++) {
    const res = await fetch(JEV, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body,
      signal
    });
    if (res.ok)
      return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(150 * 2 ** attempt);
      continue;
    }
    throw new Error(`jev ${res.status}: ${text.slice(0, 200)}`);
  }
}
function jev(state, questions) {
  return slot(async () => {
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    const t0 = performance.now();
    const ctl = [new AbortController];
    let timer;
    try {
      const r = await new Promise((resolve, reject) => {
        let failed = 0;
        let lastError;
        const launch = (c) => once(body, c.signal).then(resolve, (e) => {
          lastError = e;
          if (++failed === ctl.length && (ctl.length > 1 || !timer))
            reject(e);
        });
        launch(ctl[0]);
        timer = setTimeout(() => {
          timer = undefined;
          if (stats.hedges > 8 + stats.calls * 0.15) {
            if (failed === ctl.length)
              reject(lastError);
            return;
          }
          stats.hedges++;
          const c = new AbortController;
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
      for (const c of ctl)
        c.abort();
    }
  });
}
function summary() {
  const l = [...stats.lat].sort((a, b) => a - b);
  const q = (p) => l.length ? Math.round(l[Math.min(l.length - 1, Math.floor(p * l.length))]) : 0;
  return { calls: stats.calls, decisions: stats.decisions, errors: stats.errors, hedges: stats.hedges, p50: q(0.5), p90: q(0.9), costUsd: stats.inputTokens / 1e6 * 0.042 };
}
var TIERS = {
  top: "One of the very best matches for the criterion",
  strong: "Clearly matches the criterion well",
  some: "Partly matches the criterion",
  weak: "Barely matches the criterion",
  none: "Does not match the criterion at all"
};
var TIER_VALUE = { top: 4, strong: 3, some: 2, weak: 1, none: 0 };
var lite = (c) => Object.fromEntries(Object.entries(c || {}).map(([k, v]) => [k, typeof v === "string" && v.length > 280 ? v.slice(0, 280) + "…" : v]));
var shuffle = (xs) => {
  for (let i = xs.length - 1;i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};
async function rank(items, task, emit) {
  const t0 = performance.now();
  Object.assign(stats, { calls: 0, decisions: 0, errors: 0, hedges: 0, inputTokens: 0, lat: [] });
  const ids = items.map((t) => t.id);
  const n = ids.length;
  const algo = !task.algo || task.algo === "auto" ? n * (n - 1) / 2 <= 300 ? "full" : "swiss" : task.algo;
  const cards = new Map(items.map((t) => [t.id, t.card]));
  const seed = new Map;
  const played = new Map(ids.map((id) => [id, new Set]));
  const record = new Map(ids.map((id) => [id, { w: 0, l: 0 }]));
  const score = new Map(ids.map((id) => [id, 0]));
  const matches = [];
  const rule = `Rank each ${task.noun} by this criterion: "${task.criterion}".`;
  const base = { context: task.context, criterion: task.criterion };
  const swissRounds = Math.ceil(Math.log2(n)) + 2;
  const K = Math.min(12, n);
  const P = Math.min(8, Math.max(2, Math.floor(n / 12)));
  const REFINE = 3;
  const plain = !!task.plain && algo === "swiss";
  const phases = plain ? [...Array.from({ length: swissRounds }, (_, i) => ({ key: `s${i + 1}`, label: `Swiss round ${i + 1} of ${swissRounds}`, total: Math.floor(n / 2) })), { key: "bt", label: "Bradley–Terry fit" }] : algo === "full" ? [
    { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
    { key: "full", label: `All ${n * (n - 1) / 2} pairs at once`, total: n * (n - 1) / 2 },
    { key: "bt", label: "Bradley–Terry fit" }
  ] : algo === "swiss" ? [
    { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
    ...Array.from({ length: swissRounds }, (_, i) => ({ key: `s${i + 1}`, label: `Swiss round ${i + 1}` })),
    { key: "rr", label: `Top-${K} round robin` },
    { key: "bt", label: "Bradley–Terry fit" }
  ] : [
    { key: "triage", label: `Triage ${n} ${task.noun}s`, total: n },
    { key: "pivot", label: `Place against ${P} pivots` },
    ...Array.from({ length: REFINE }, (_, i) => ({ key: `n${i + 1}`, label: `Neighbour pass ${i + 1}` })),
    { key: "rr", label: `Top-${K} round robin` },
    { key: "bt", label: "Bradley–Terry fit" }
  ];
  emit({ type: "plan", algo, n, phases, criterion: task.criterion });
  const record1 = (a, b, pA, ms, phase) => {
    const m = { a, b, pA, ms: Math.round(ms), phase };
    matches.push(m);
    score.set(a, score.get(a) + pA);
    score.set(b, score.get(b) + 1 - pA);
    played.get(a).add(b);
    played.get(b).add(a);
    record.get(pA >= 0.5 ? a : b).w++;
    record.get(pA >= 0.5 ? b : a).l++;
    emit({ type: "match", ...m });
  };
  const play = async (a, b, phase) => {
    const swap = Math.random() < 0.5;
    const [x, y] = swap ? [b, a] : [a, b];
    try {
      const r = await jev({ ...base, A: cards.get(x), B: cards.get(y) }, {
        higher: {
          type: "choice",
          instructions: [rule, `Which ${task.noun}, \`A\` or \`B\`, ranks higher?`, ...task.guide || []],
          criteria: { A: `${task.noun} A ranks higher`, B: `${task.noun} B ranks higher` }
        }
      });
      const pX = r.answers.higher.probabilities.A ?? (r.answers.higher.choice === "A" ? 1 : 0);
      record1(a, b, swap ? 1 - pX : pX, r.ms, phase);
    } catch (e) {
      emit({ type: "error", id: a, message: String(e).slice(0, 160) });
    }
  };
  const wave = async (key, pairs, extra = []) => {
    emit({ type: "phase", key, total: pairs.length + extra.length, pairs });
    await Promise.all([...pairs.map(([a, b]) => play(a, b, key)), ...extra]);
  };
  const fit = () => bradleyTerry(ids, matches, seed);
  const orderBy = (s) => [...ids].sort((x, y) => s.get(y) - s.get(x));
  const standings = (order) => emit({ type: "standings", order, record: Object.fromEntries(record) });
  const triage = () => Promise.all(ids.map(async (id) => {
    try {
      const r = await jev({ ...base, item: cards.get(id) }, { tier: { type: "choice", instructions: [rule, `How well does \`item\` match the criterion?`, ...task.guide || []], criteria: TIERS } });
      const a = r.answers.tier;
      seed.set(id, Object.entries(a.probabilities).reduce((s, [k, p]) => s + (TIER_VALUE[k] ?? 0) * p, 0));
      emit({ type: "triage", id, tier: a.choice, value: seed.get(id), conf: a.confidence, ms: Math.round(r.ms) });
    } catch (e) {
      seed.set(id, 2);
      emit({ type: "error", id, message: String(e).slice(0, 160) });
    }
  }));
  if (algo === "full") {
    const all = [];
    for (let i = 0;i < n; i++)
      for (let j = i + 1;j < n; j++)
        all.push([ids[i], ids[j]]);
    shuffle(all);
    emit({ type: "phase", key: "triage", total: n });
    const live = setInterval(() => standings(orderBy(fit())), 250);
    await Promise.all([triage(), wave("full", all)]);
    clearInterval(live);
    const strength = fit();
    return finish(strength);
  }
  if (plain)
    for (const id of ids)
      seed.set(id, 2);
  else {
    emit({ type: "phase", key: "triage", total: n });
    await triage();
  }
  const seeded = plain ? shuffle([...ids]) : [...ids].sort((x, y) => seed.get(y) - seed.get(x));
  standings(seeded);
  if (algo === "swiss") {
    for (let round = 1;round <= swissRounds; round++) {
      const order = round === 1 ? seeded : [...ids].sort((x, y) => score.get(y) - score.get(x) || seed.get(y) - seed.get(x));
      const pairs = [];
      const used = new Set;
      for (let i = 0;i < order.length; i++) {
        const a = order[i];
        if (used.has(a))
          continue;
        let j = i + 1;
        while (j < order.length && (used.has(order[j]) || played.get(a).has(order[j])))
          j++;
        if (j >= order.length)
          j = order.findIndex((b, k) => k > i && !used.has(b));
        if (j < 0 || j >= order.length)
          continue;
        used.add(a).add(order[j]);
        pairs.push([a, order[j]]);
      }
      await wave(`s${round}`, pairs);
      standings([...ids].sort((x, y) => score.get(y) - score.get(x) || seed.get(y) - seed.get(x)));
    }
  } else {
    const qs = [0.02, 0.06, 0.12, 0.2, 0.32, 0.48, 0.66, 0.85].slice(0, P);
    const pivots = [...new Set(qs.map((q) => seeded[Math.min(n - 1, Math.floor(q * n))]))];
    const pivotSet = new Set(pivots);
    const pivotPairs = [];
    for (let i = 0;i < pivots.length; i++)
      for (let j = i + 1;j < pivots.length; j++)
        pivotPairs.push([pivots[i], pivots[j]]);
    const placements = ids.filter((id) => !pivotSet.has(id)).map(async (id) => {
      const names = pivots.map((_, k) => `P${k + 1}`);
      const questions = Object.fromEntries(names.map((p) => {
        const sides = shuffle([
          ["item", `\`item\` ranks higher`],
          [p, `\`pivots.${p}\` ranks higher`]
        ]);
        return [`vs_${p}`, { type: "choice", instructions: [rule, `Does \`item\` rank above \`pivots.${p}\`?`, ...task.guide || []], criteria: Object.fromEntries(sides) }];
      }));
      try {
        const r = await jev({ ...base, pivots: Object.fromEntries(names.map((p, k) => [p, lite(cards.get(pivots[k]))])), item: cards.get(id) }, questions);
        names.forEach((p, k) => {
          const a = r.answers[`vs_${p}`];
          if (a)
            record1(id, pivots[k], a.probabilities.item ?? (a.choice === "item" ? 1 : 0), r.ms, "pivot");
        });
      } catch (e) {
        emit({ type: "error", id, message: String(e).slice(0, 160) });
      }
    });
    emit({ type: "pivots", ids: pivots });
    await wave("pivot", pivotPairs, placements);
    let order = orderBy(fit());
    standings(order);
    for (let w = 0;w < REFINE; w++) {
      const step = w < 2 ? 1 : 2;
      const pairs = [];
      const used = new Set;
      for (let i = w % 2;i + step < order.length; i += step === 1 ? 2 : 1) {
        const a = order[i], b = order[i + step];
        if (used.has(a) || used.has(b) || played.get(a).has(b))
          continue;
        used.add(a).add(b);
        pairs.push([a, b]);
      }
      await wave(`n${w + 1}`, pairs);
      order = orderBy(fit());
      standings(order);
    }
  }
  if (plain)
    return finish(fit());
  const top = orderBy(fit()).slice(0, K);
  const rr = [];
  for (let i = 0;i < K; i++)
    for (let j = i + 1;j < K; j++)
      if (!played.get(top[i]).has(top[j]))
        rr.push([top[i], top[j]]);
  await wave("rr", rr);
  return finish(fit());
  function finish(strength) {
    emit({ type: "phase", key: "bt", total: 1 });
    const final = orderBy(strength);
    const vals = [...strength.values()];
    const max = Math.max(...vals), min = Math.min(...vals);
    const result = {
      type: "done",
      algo,
      order: final,
      importance: Object.fromEntries(final.map((id) => [id, (strength.get(id) - min) / (max - min || 1)])),
      tiers: Object.fromEntries(ids.map((id) => [id, seed.get(id)])),
      record: Object.fromEntries(record),
      matches: matches.length,
      waves: phases.length - 1,
      ms: Math.round(performance.now() - t0),
      jev: summary()
    };
    emit(result);
    return result;
  }
}
function bradleyTerry(ids, matches, seed) {
  const s = new Map(ids.map((id) => [id, 1]));
  const prior = new Map(ids.map((id) => [id, Math.exp((seed.get(id) ?? 2) - 2)]));
  const by = new Map(ids.map((id) => [id, []]));
  for (const m of matches) {
    by.get(m.a).push({ o: m.b, w: m.pA });
    by.get(m.b).push({ o: m.a, w: 1 - m.pA });
  }
  for (let it = 0;it < 200; it++) {
    for (const id of ids) {
      const si = s.get(id);
      let wins = 0.5, denom = 1 / (si + prior.get(id));
      for (const { o, w } of by.get(id)) {
        wins += w;
        denom += 1 / (si + s.get(o));
      }
      s.set(id, wins / denom);
    }
    const g = Math.exp(ids.reduce((a, id) => a + Math.log(s.get(id)), 0) / ids.length);
    for (const id of ids)
      s.set(id, s.get(id) / g);
  }
  return new Map(ids.map((id) => [id, Math.log(s.get(id))]));
}
export {
  bradleyTerry,
  configure,
  jev,
  rank,
  summary
};
