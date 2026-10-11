// Jev Sort for Gmail. Adds a Sort split-button to Gmail's toolbar, ranks the last 24 hours of mail
// by a sentence, and reorders Gmail's own rows in place. Read-only: we only move DOM nodes on this
// page; nothing is sent to or changed in the Gmail account.
(() => {
  const HOURS = 24;
  const DEFAULT_Q = "what matters most to me and should be read first";
  const PRESETS = [
    ["⚡", DEFAULT_Q],
    ["💸", "which require investor attention"],
    ["⏰", "has a deadline coming up soonest"],
    ["🙋", "a real person is waiting on my reply"],
    ["🛡️", "security, hacking or account access"],
    ["⚖️", "what gets me in trouble if I ignore it"],
    ["🎓", "actually matters for my college applications"],
  ];
  const TIER_LABEL = { top: "top", strong: "strong", some: "partial", weak: "weak", none: "" };

  const st = { meta: null, byId: new Map(), order: null, tiers: {}, rank: {}, running: false, q: "", algo: "auto", port: null, mutating: false };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // ---------- Gmail DOM ----------
  const visible = (el) => !!el && el.offsetParent !== null;
  const toolbar = () => [...document.querySelectorAll('div[gh="mtb"]')].find(visible);
  const rows = () => [...document.querySelectorAll('div[role="main"] tr.zA')].filter(visible);
  const rowId = (tr) => tr.querySelector("[data-legacy-thread-id]")?.getAttribute("data-legacy-thread-id") || null;
  const isList = () => /^#(inbox|category\/|$)/.test(location.hash || "#inbox") && !/^#inbox\/./.test(location.hash);

  // ---------- toolbar button + dropdown ----------
  function ensureButton() {
    const tb = toolbar();
    if (!tb || !isList() || tb.querySelector(".jevx-split")) return;
    const split = h(`<div class="jevx-split" role="group">
      <button class="jevx-sort" title="Sort the last ${HOURS} hours with Jev"><span class="jevx-bolt">⚡</span><span class="jevx-lbl">Sort</span></button>
      <button class="jevx-caret" title="Sort by a sentence">▾</button>
    </div>`);
    split.querySelector(".jevx-sort").addEventListener("click", (e) => (e.stopPropagation(), run(st.q)));
    split.querySelector(".jevx-caret").addEventListener("click", (e) => (e.stopPropagation(), toggleMenu(split)));
    tb.appendChild(split);
    paintButton();
  }

  function paintButton() {
    for (const b of document.querySelectorAll(".jevx-split")) {
      b.classList.toggle("running", st.running);
      b.classList.toggle("sorted", !!st.order && !st.running);
      b.querySelector(".jevx-lbl").textContent = st.running ? "Sorting…" : st.order ? "Sorted" : "Sort";
    }
  }

  let menu = null;
  function toggleMenu(anchor) {
    if (menu) return closeMenu();
    const r = anchor.getBoundingClientRect();
    menu = h(`<div class="jevx-menu">
      <form class="jevx-in"><span>✦</span><input placeholder="Sort by… e.g. which require investor attention" value="${esc(st.q === DEFAULT_Q ? "" : st.q)}"></form>
      <div class="jevx-scope">Last ${HOURS} hours · <b>${st.meta ? st.meta.threads.length : "…"}</b> emails</div>
      <div class="jevx-presets">${PRESETS.map(([ic, q]) => `<div class="jevx-p" data-q="${esc(q)}"><span>${ic}</span>${esc(q)}</div>`).join("")}</div>
      <div class="jevx-foot"><span>Algorithm</span><span class="jevx-seg">${["auto", "pivot", "swiss"].map((a) => `<button type="button" data-a="${a}" class="${st.algo === a ? "on" : ""}">${a[0].toUpperCase() + a.slice(1)}</button>`).join("")}</span>
        ${st.order ? `<button type="button" class="jevx-reset">Reset order</button>` : ""}</div>
    </div>`);
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, r.left) + "px";
    document.body.appendChild(menu);
    const input = menu.querySelector("input");
    input.focus();
    input.addEventListener("keydown", (e) => e.stopPropagation()); // keep Gmail's shortcuts out of the box
    menu.querySelector("form").addEventListener("submit", (e) => (e.preventDefault(), run(input.value)));
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      const p = e.target.closest(".jevx-p");
      if (p) return run(p.dataset.q);
      const a = e.target.closest(".jevx-seg button");
      if (a) {
        st.algo = a.dataset.a;
        menu.querySelectorAll(".jevx-seg button").forEach((b) => b.classList.toggle("on", b === a));
      }
      if (e.target.closest(".jevx-reset")) (reset(), closeMenu());
    });
    loadMeta().then(() => menu && (menu.querySelector(".jevx-scope b").textContent = st.meta?.threads?.length ?? "?"));
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  document.addEventListener("click", (e) => menu && !e.target.closest(".jevx-menu") && closeMenu());

  async function loadMeta() {
    if (st.meta && !st.meta.error) return st.meta;
    st.meta = await chrome.runtime.sendMessage({ type: "recent", hours: HOURS });
    st.byId = new Map((st.meta.threads || []).map((t) => [t.id, t]));
    return st.meta;
  }

  // ---------- panel ----------
  let panel = null;
  function openPanel(q) {
    panel?.remove();
    panel = h(`<div class="jevx-panel">
      <div class="jevx-ph"><div class="jevx-logo">⚡</div><div class="jevx-t"><b>${esc(q === DEFAULT_Q ? "Importance" : `“${q}”`)}</b><small>Jev · last ${HOURS}h · <span class="jevx-algo">…</span></small></div>
        <button class="jevx-min" title="Minimize">–</button><button class="jevx-x" title="Close">×</button></div>
      <div class="jevx-stats"><div><b class="s-el">0.0s</b><small>elapsed</small></div><div><b class="s-dec">0</b><small>decisions</small></div><div><b class="s-p50">–</b><small>p50</small></div><div><b class="s-n">–</b><small>emails</small></div></div>
      <ol class="jevx-phases"></ol>
      <div class="jevx-body"><div class="jevx-feed"></div></div>
    </div>`);
    panel.querySelector(".jevx-x").onclick = () => (panel.remove(), (panel = null));
    panel.querySelector(".jevx-min").onclick = () => panel.classList.toggle("min");
    document.body.appendChild(panel);
  }
  const P = (s) => panel?.querySelector(s);

  const ph = { done: {}, total: {}, t: {} };
  function buildPhases(phases) {
    Object.assign(ph, { done: {}, total: Object.fromEntries(phases.map((p) => [p.key, p.total || 0])), t: {} });
    if (P(".jevx-phases")) P(".jevx-phases").innerHTML = phases.map((p) => `<li data-k="${p.key}"><i></i><span>${esc(p.label)}</span><em></em><u><s></s></u></li>`).join("");
  }
  function phaseStart(k, total) {
    ph.total[k] = total ?? ph.total[k];
    ph.done[k] = 0;
    ph.t[k] = performance.now();
    const el = P(`[data-k="${k}"]`);
    el?.classList.add("on");
    if (el) el.querySelector("em").textContent = `0/${ph.total[k]}`;
  }
  function phaseTick(k) {
    const el = P(`[data-k="${k}"]`);
    if (!el) return;
    ph.done[k] = (ph.done[k] || 0) + 1;
    const tot = ph.total[k] || 1;
    el.querySelector("s").style.width = `${Math.min(100, (100 * ph.done[k]) / tot)}%`;
    el.querySelector("em").textContent = `${ph.done[k]}/${tot}`;
    if (ph.done[k] >= tot) phaseDone(k);
  }
  function phaseDone(k, text) {
    const el = P(`[data-k="${k}"]`);
    if (!el || el.classList.contains("done")) return;
    el.classList.remove("on");
    el.classList.add("done");
    el.querySelector("s").style.width = "100%";
    el.querySelector("em").textContent = text || `${ph.done[k] || 0} in ${Math.round(performance.now() - (ph.t[k] || performance.now()))}ms`;
  }

  let feedN = 0;
  const label = (id) => {
    const t = st.byId.get(id);
    if (!t) return { who: "…", what: "" };
    const me = st.meta.email.toLowerCase();
    const who = t.from.email === me ? t.senders.find((s) => s !== "me") || "me" : t.from.name;
    return { who: esc(who), what: esc(t.subject) };
  };
  function feed(html) {
    const f = P(".jevx-feed");
    if (!f) return;
    f.insertAdjacentHTML("afterbegin", html);
    while (f.childElementCount > 24) f.lastElementChild.remove();
  }

  // ---------- reorder Gmail's rows (FLIP) ----------
  function applyOrder(animate = true) {
    if (!st.order || !isList()) return;
    const rs = rows();
    if (!rs.length) return;
    const tbody = rs[0].parentElement;
    const pos = new Map(st.order.map((id, i) => [id, i]));
    const before = new Map(animate ? rs.map((r) => [r, r.getBoundingClientRect().top]) : []);
    const ranked = rs.filter((r) => pos.has(rowId(r))).sort((a, b) => pos.get(rowId(a)) - pos.get(rowId(b)));
    const rest = rs.filter((r) => !pos.has(rowId(r)));
    st.mutating = true;
    for (const r of [...ranked, ...rest]) tbody.appendChild(r);
    queueMicrotask(() => (st.mutating = false));
    for (const r of rs) decorate(r, pos);
    if (!animate) return;
    const moved = [];
    for (const r of rs) {
      const dy = before.get(r) - r.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      r.style.transition = "none";
      r.style.transform = `translateY(${dy}px)`;
      moved.push(r);
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const r of moved) {
          r.style.transition = "transform 420ms cubic-bezier(.2,.8,.2,1)";
          r.style.transform = "";
        }
      }),
    );
  }

  function decorate(tr, pos) {
    const id = rowId(tr);
    const i = pos.get(id);
    tr.classList.toggle("jevx-out", i == null);
    let chip = tr.querySelector(".jevx-chip");
    const host = tr.querySelector(".xT") || tr.querySelector(".y6")?.parentElement;
    if (!host) return;
    if (!chip) {
      chip = h(`<span class="jevx-chip"><b></b><span></span></span>`);
      host.prepend(chip);
    }
    const tier = st.tiers[id];
    chip.className = `jevx-chip ${tier ? "t-" + tier : ""} ${i == null ? "hide" : ""}`;
    chip.querySelector("b").textContent = i == null ? "" : `#${i + 1}`;
    chip.querySelector("span").textContent = tier ? TIER_LABEL[tier] : "";
    const imp = st.rank[id];
    tr.style.setProperty("--jevx-imp", imp == null ? 0 : imp);
    tr.classList.toggle("jevx-hot", imp != null && imp >= 0.75);
  }

  function flash(id, cls) {
    const tr = rows().find((r) => rowId(r) === id);
    if (!tr) return;
    tr.classList.remove("jevx-won", "jevx-lost");
    void tr.offsetWidth;
    tr.classList.add(cls);
    setTimeout(() => tr.classList.remove(cls), 600);
  }

  function reset() {
    st.order = null;
    st.tiers = {};
    st.rank = {};
    for (const r of rows()) {
      r.querySelector(".jevx-chip")?.remove();
      r.classList.remove("jevx-out", "jevx-hot");
    }
    // Put Gmail's rows back in the order Gmail had them before the first sort.
    const rs = rows();
    if (rs.length && st.original) {
      const pos = new Map(st.original.map((r, i) => [r, i]));
      st.mutating = true;
      for (const r of [...rs].sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9))) rs[0].parentElement.appendChild(r);
      queueMicrotask(() => (st.mutating = false));
    }
    st.original = null;
    paintButton();
  }

  // Gmail re-renders the list on new mail / tab switches; put our order back.
  let pending = 0;
  new MutationObserver(() => {
    if (st.mutating || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      ensureButton();
      if (st.order && !st.running) {
        const rs = rows();
        const pos = new Map(st.order.map((id, i) => [id, i]));
        const ids = rs.map(rowId).filter((id) => pos.has(id));
        const sorted = ids.every((id, k) => k === 0 || pos.get(ids[k - 1]) < pos.get(id));
        if (!sorted || rs.some((r) => !r.querySelector(".jevx-chip"))) applyOrder(false);
      }
    });
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- run ----------
  let generation = 0;
  async function run(q, complete = null) {
    if (st.running) return;
    const runID = ++generation;
    st.complete = complete;
    q = (q || "").trim() || DEFAULT_Q;
    closeMenu();
    if (!isList()) location.hash = "#inbox";
    st.q = q;
    if (!st.original) st.original = rows();
    st.running = true;
    st.tiers = {};
    st.rank = {};
    paintButton();
    openPanel(q);
    const meta = await loadMeta();
    if (runID !== generation) return;
    if (meta.error) return fail(meta.error);
    if (P(".s-n")) P(".s-n").textContent = meta.threads.length;
    const t0 = performance.now();
    let decisions = 0;
    const lat = [];
    let raf = 0;
    const tick = () => {
      if (runID !== generation) return;
      P(".s-el") && (P(".s-el").textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s");
      P(".s-dec") && (P(".s-dec").textContent = decisions.toLocaleString());
      if (lat.length && P(".s-p50")) P(".s-p50").textContent = [...lat].sort((a, b) => a - b)[lat.length >> 1] + "ms";
      if (st.running) raf = requestAnimationFrame(tick);
    };
    tick();

    st.port?.disconnect();
    const port = (st.port = chrome.runtime.connect({ name: "jev" }));
    let pivots = new Set();
    port.onMessage.addListener((ev) => {
      if (runID !== generation) return;
      switch (ev.type) {
        case "plan":
          buildPhases(ev.phases);
          if (P(".jevx-algo")) P(".jevx-algo").textContent = { full: "every pair at once", pivot: "pivot sort", swiss: "Swiss tournament" }[ev.algo] || ev.algo;
          break;
        case "pivots":
          pivots = new Set(ev.ids);
          break;
        case "phase": {
          const total = ev.key === "pivot" ? (ev.pairs?.length || 0) + (meta.threads.length - pivots.size) * pivots.size : ev.total;
          // Phases run back to back except triage, which can overlap the full round robin.
          for (const el of panel?.querySelectorAll(".jevx-phases li.on") || []) if (el.dataset.k !== "triage") phaseDone(el.dataset.k);
          phaseStart(ev.key, total);
          break;
        }
        case "triage":
          decisions++;
          lat.push(ev.ms);
          st.tiers[ev.id] = ev.tier;
          phaseTick("triage");
          if (!st.order) st.order = [...meta.threads.map((t) => t.id)];
          applyOrder(false);
          {
            const s = label(ev.id);
            feed(`<div class="jevx-tri"><span class="jevx-tag t-${ev.tier}">${TIER_LABEL[ev.tier] || "no match"}</span><b>${s.who}</b><span>${s.what}</span><em>${ev.ms}ms</em></div>`);
          }
          break;
        case "match": {
          decisions++;
          lat.push(ev.ms);
          phaseTick(ev.phase);
          const aw = ev.pA >= 0.5;
          flash(ev.a, aw ? "jevx-won" : "jevx-lost");
          flash(ev.b, aw ? "jevx-lost" : "jevx-won");
          const A = label(ev.a), B = label(ev.b);
          const p = Math.round(Math.max(ev.pA, 1 - ev.pA) * 100);
          feed(`<div class="jevx-duel"><b class="${aw ? "w" : "l"}">${A.who}</b><i>vs</i><b class="${aw ? "l" : "w"}">${pivots.has(ev.b) ? "◆ " : ""}${B.who}</b><em>${p}% · ${ev.ms}ms</em></div>`);
          break;
        }
        case "standings":
          st.order = ev.order;
          applyOrder(true);
          break;
        case "done": {
          phaseDone("bt", `${ev.matches.toLocaleString()} games`);
          for (const el of panel?.querySelectorAll(".jevx-phases li.on") || []) phaseDone(el.dataset.k);
          st.order = ev.order;
          st.rank = ev.importance;
          st.running = false;
          cancelAnimationFrame(raf);
          if (P(".s-el")) P(".s-el").textContent = (ev.ms / 1000).toFixed(1) + "s";
          if (P(".s-dec")) P(".s-dec").textContent = ev.jev.decisions.toLocaleString();
          if (P(".s-p50")) P(".s-p50").textContent = ev.jev.p50 + "ms";
          applyOrder(true);
          paintButton();
          showTop();
          const complete = st.complete; st.complete = null;
          complete?.(ev.jev.errors ? { error: "Some Jev decisions failed; retry the sort before choosing the top email." } : {
            threadID: ev.order[0], source: `${location.origin}${location.pathname}#inbox/${ev.order[0]}`
          });
          port.disconnect();
          break;
        }
        case "fatal":
          fail(ev.message);
          break;
      }
    });
    port.postMessage({ type: "analyze", q: q === DEFAULT_Q ? "" : q, algo: st.algo, hours: HOURS });
  }

  // Final ranked list in the panel: covers threads Gmail isn't showing (other tabs, next page).
  function showTop() {
    const body = P(".jevx-body");
    if (!body) return;
    body.innerHTML = `<div class="jevx-top">${st.order
      .slice(0, 12)
      .map((id, i) => {
        const s = label(id);
        const t = st.tiers[id];
        return `<a href="#inbox/${id}" class="jevx-row"><span class="n">${i + 1}</span>${TIER_LABEL[t] ? `<span class="jevx-tag t-${t}">${TIER_LABEL[t]}</span>` : ""}<b>${s.who}</b><span>${s.what}</span><u style="width:${Math.round((st.rank[id] || 0) * 100)}%"></u></a>`;
      })
      .join("")}</div>`;
  }

  function fail(msg) {
    st.command = null;
    const complete = st.complete; st.complete = null; complete?.({ error: msg });
    st.running = false;
    paintButton();
    const body = P(".jevx-body");
    if (body) body.innerHTML = `<div class="jevx-err">${esc(msg)}</div>`;
  }

  // Glance's global K/L reuse this extension and the existing server-side Gmail mirror.
  let hover = null;
  document.addEventListener("mousemove", (event) => { hover = { x: event.clientX, y: event.clientY }; }, { passive: true });
  document.addEventListener("mouseleave", () => { hover = null; });
  function cancelShortcut(id) {
    if (!st.complete || (id && st.command !== id)) return;
    generation++; st.port?.disconnect(); st.port = null;
    fail("Gmail shortcut cancelled.");
  }
  document.addEventListener("keydown", (event) => { if (event.code === "Escape") cancelShortcut(); }, true);
  chrome.runtime.onMessage?.addListener((msg, _sender, reply) => {
    if (msg.type === "glanceCancel") { cancelShortcut(msg.id); reply({ ok: true }); return; }
    if (msg.type === "glancePresence") { reply({ gmail: document.hasFocus() }); return; }
    if (msg.type !== "glanceLookup") return;
    if (!document.hasFocus()) { reply({ error: "Focus this Gmail tab first." }); return; }
    if (msg.mode === "screen") {
      if (st.running) { reply({ error: "Gmail Sort is already running." }); return; }
      st.command = msg.id;
      void run(msg.criterion || st.q, reply).catch(() => {
        if (st.complete === reply) fail("Gmail Sort could not complete. Check the local server.");
      });
      return true;
    }
    // Prefer the actual hovered row; an open message uses its stable Gmail API thread id.
    const tr = hover && document.elementFromPoint(hover.x, hover.y)?.closest("tr.zA");
    let id = tr && visible(tr) && rowId(tr);
    if (!id) {
      const message = [...document.querySelectorAll('[role="main"] [data-legacy-thread-id]')]
        .find((el) => visible(el) && !el.closest("tr.zA"));
      id = message?.getAttribute("data-legacy-thread-id");
      if (!id && !isList()) id = location.hash.match(/\/([a-f0-9]{6,32})$/i)?.[1];
    }
    if (!id || !/^[a-f0-9]{6,32}$/i.test(id)) { reply({ error: "Point at an email row or open its conversation first." }); return; }
    reply({ threadID: id, source: `${location.origin}${location.pathname}#inbox/${id}` });
  });

  ensureButton();
  window.addEventListener("hashchange", () => setTimeout(() => (ensureButton(), applyOrder(false)), 50));
})();
