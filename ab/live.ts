// Live ranking (items can arrive while it runs) vs plain Swiss rounds: wall time and Kendall tau
// against the true order. Items are numbers in words, ranked by "the largest number".
//   bun run ab/live.ts [n] [runs]
import { configure, rank, rankLive } from "../src/rank";
configure({ key: process.env.TYPESAFE_API_KEY, concurrency: 256 });

const n = Number(process.argv[2] || 60), runs = Number(process.argv[3] || 2);
const items = Array.from({ length: n }, (_, i) => ({ id: `x${i}`, card: { text: `${(i + 1) * 37} apples` } }));
const task = { noun: "pile of apples", context: {}, criterion: "the largest number of apples" };
const tau = (order: string[]) => {
  const pos = order.map((id) => Number(id.slice(1)));
  let c = 0, d = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) (pos[i] > pos[j] ? c++ : d++);
  return ((c - d) / (c + d)).toFixed(3);
};

for (let r = 0; r < runs; r++) {
  let t0 = performance.now();
  const s: any = await rank(items, { ...task, algo: "swiss", plain: true }, () => {});
  console.log(`swiss  ${((performance.now() - t0) / 1000).toFixed(1)}s  ${s.jev.decisions} calls  tau ${tau(s.order)}`);

  t0 = performance.now();
  let last = 0, top = 0;
  const L = rankLive(task, (ev) => {
    if (ev.type !== "match") return;
    if (ev.phase === "live") last = performance.now() - t0;
    else top++;
  });
  for (const it of [...items].sort(() => Math.random() - 0.5)) L.add(it);
  const l: any = await L.end();
  console.log(`live   ${((performance.now() - t0) / 1000).toFixed(1)}s  ${l.jev.decisions} calls  tau ${tau(l.order)}  (budget games done at ${(last / 1000).toFixed(1)}s, ${top} top games)`);
}
