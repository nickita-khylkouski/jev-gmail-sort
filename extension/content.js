// Shortlist for Gmail. Adds a "Sort ▾" button next to the list's heading (or in Gmail's toolbar). Takes the emails on screen (up to 50), has
// the background read them in full and rank them by any sentence, then rearranges Gmail's own
// rows in place, with sections and a "Suggested trash" group. Everything here is client-side; the only
// change to the account is when you press "Move to Trash", which uses Gmail's own Delete button.
(() => {
  // When the extension reloads, the old copy of this script keeps running with a dead connection to
  // it. That copy stands down (dead() below), and this one clears what it left on the page.
  let gone = false, observer = null;
  const dead = () => gone || ((gone = !chrome.runtime?.id) && (observer?.disconnect(), true));
  for (const el of document.querySelectorAll('[class*="jevx-"]')) {
    if (el.classList[0]?.startsWith("jevx-")) el.remove();
    else el.classList.remove(...[...el.classList].filter((c) => c.startsWith("jevx-")));
  }

  const MAX = 50;
  const DEFAULT_Q = "what matters most to me and should be read first";
  // Material Symbols (24px, Apache 2.0) so everything matches Gmail's own icons.
  const ICONS = {
    sort: "M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z",
    drop: "M7 10l5 5 5-5z",
    check: "M9 16.17L4.83 12l-1.42 1.42L9 19 21 7l-1.41-1.41z",
    sparkle: "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z",
    history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
    enter: "M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z",
    tune: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
    trash: "M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z",
    undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
    less: "M7.41 18.59L8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z",
    more: "M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z",
    trend: "M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z",
    reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
    clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z",
    shield: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z",
    receipt: "M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z",
    person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    money: "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
    work: "M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z",
    school: "M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z",
    travel: "M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z",
    code: "M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z",
    event: "M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z",
    chat: "M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z",
    star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  };
  const icon = (n, cls = "") => `<svg class="jevx-i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n] || ICONS.sparkle}"/></svg>`;
  const PRESETS = [
    ["sparkle", DEFAULT_Q],
    ["trend", "which require investor attention"],
    ["reply", "a real person is waiting on my reply"],
    ["clock", "has a deadline coming up soonest"],
    ["shield", "security, hacking or account access"],
    ["receipt", "money: invoices, receipts, payments"],
  ];
  const TIER_LABEL = { top: "Top", strong: "Strong", some: "Partial", weak: "Weak", none: "" };
  // Sections by Bradley–Terry importance (0..1, rescaled so the top email is 1).
  const BANDS = [
    [0.66, "Top"],
    [0.33, "Worth a look"],
    [-1, "Everything else"],
  ];
  const TRASH_P = 0.7; // Jev's probability that an email is safe to trash

  const st = { q: "", byId: new Map(), rowOf: new Map(), order: null, tiers: {}, imp: {}, junk: {}, flip: {}, running: false, done: false, port: null, mutating: false, original: null, seen: new Set(), listed: 0, hideLow: false, phase: "", t0: 0, decisions: 0, total: 0, stats: null };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const mutate = (f) => {
    st.mutating = true;
    try {
      f();
    } finally {
      setTimeout(() => (st.mutating = false), 0);
    }
  };
  const click = (el) => ["mousedown", "mouseup", "click"].forEach((type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));

  // ---------- reading Gmail's page ----------
  const visible = (el) => !!el && el.offsetParent !== null;
  const toolbar = () => [...document.querySelectorAll('div[gh="mtb"]')].find(visible);
  const rows = () => [...document.querySelectorAll('div[role="main"] tr.zA')].filter((r) => visible(r) || r.classList.contains("jevx-hidden"));
  const rowId = (tr) => tr.querySelector("[data-legacy-thread-id]")?.getAttribute("data-legacy-thread-id") || null;
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // Gmail puts the full timestamp in the date cell's title, e.g. "Sun, Oct 11, 2026, 9:34 AM".
  function parseDate(tr) {
    const t = tr.querySelector("td.xW [title]")?.getAttribute("title");
    if (!t) return null;
    const d = new Date(t.replace(/[\u202f\u00a0]/g, " ").replace(/^[A-Za-z]{3}, /, "").replace(/(\d{4}),/, "$1"));
    return isNaN(d) ? null : d.getTime();
  }

  function owner() {
    const acct = document.querySelector('a[aria-label^="Google Account"]')?.getAttribute("aria-label") || "";
    const email = (acct.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || document.title.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || "").toLowerCase();
    const name = acct.replace(/^Google Account:\s*/, "").split(/\n|\(/)[0].trim() || email.split("@")[0];
    return { name, email };
  }

  function scrape() {
    const me = owner();
    return rows()
      .map((tr) => {
        const id = rowId(tr);
        if (!id) return null;
        const people = [...tr.querySelectorAll(".yX [email], .yW [email]")].map((s) => ({ name: s.getAttribute("name") || txt(s), email: (s.getAttribute("email") || "").toLowerCase() }));
        const other = people.filter((p) => p.email !== me.email);
        return {
          id,
          tr,
          from: other.at(-1) || people.at(-1) || { name: txt(tr.querySelector(".yX")), email: "" },
          people: [...new Set(people.map((p) => (p.email === me.email ? "me" : p.name)))],
          subject: txt(tr.querySelector(".bog")) || txt(tr.querySelector(".y6")),
          snippet: txt(tr.querySelector(".y2")).replace(/^[-–]\s*/, ""),
          date: parseDate(tr),
          unread: tr.classList.contains("zE"),
          starred: !!tr.querySelector('[aria-label="Starred"]'),
          count: Number(txt(tr.querySelector(".bx0"))) || 1,
          attach: !!tr.querySelector(".brd, [aria-label*='ttachment']"),
        };
      })
      .filter(Boolean)
      .slice(0, MAX);
  }
  const ago = (ms) => {
    if (!ms) return "";
    const hr = (Date.now() - ms) / 36e5;
    return hr < 1 ? `${Math.max(1, Math.round(hr * 60))} minutes ago` : hr < 48 ? `${Math.round(hr)} hours ago` : `${Math.round(hr / 24)} days ago`;
  };
  // What the ranker sees if the background can't read the full email: exactly what the row shows.
  const card = (e) => ({
    from: e.from.email ? `${e.from.name} <${e.from.email}>` : e.from.name,
    subject: e.subject,
    received: ago(e.date),
    signals: [e.unread ? "unread" : "read", e.starred ? "starred" : "", e.count > 1 ? `thread of ${e.count} (${e.people.join(", ")})` : "", e.attach ? "has attachment" : ""].filter(Boolean).join(" · "),
    body: e.snippet.slice(0, 900),
  });

  // The element that scrolls the message list (Gmail scrolls an inner div, not the window).
  function scroller() {
    for (let el = st.rowOf.values().next().value?.parentElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }

  // ---------- the Sort button ----------
  // It sits next to the list's heading ("Inbox"), so it scrolls with the list instead of floating in
  // the sticky toolbar. No heading on this view: it goes inline in the toolbar, after Refresh / More.
  const viewName = () => document.title.split(" - ")[0].replace(/\s*\([\d,.]+\)\s*$/, "").trim().toLowerCase();
  function heading() {
    const name = viewName();
    const main = document.querySelector('div[role="main"]');
    if (!name || !main) return null;
    const first = rows()[0];
    const below = first ? first.getBoundingClientRect().top : Infinity;
    const w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim().toLowerCase() === name ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    for (let n; (n = w.nextNode()); ) {
      const el = n.parentElement;
      if (el.closest('tr, [gh="mtb"], button, a, [role="button"], [role="tab"], [role="link"], .jevx-split') || !visible(el)) continue;
      if (el.getBoundingClientRect().top <= below) return el;
    }
    return null;
  }
  let placedAt = 0;
  function ensureButton() {
    let split = document.querySelector(".jevx-split");
    const ok = split?.isConnected && visible(split);
    // In the heading: done. In the toolbar: look for a heading again at most every 2s.
    if (ok && (split.classList.contains("in-head") || performance.now() - placedAt < 2000)) return;
    placedAt = performance.now();
    const hd = heading();
    const tb = hd ? null : toolbar();
    if (!hd && !tb) return;
    if (ok && !hd && tb.contains(split)) return;
    if (!split) {
      split = h(`<div class="jevx-split" role="group">
        <button class="jevx-sort" data-tooltip="Sort these emails">${icon("sort", "s0")}${icon("check", "s1")}<span class="jevx-lbl">Sort</span><i class="jevx-bar"></i></button>
        <button class="jevx-caret" data-tooltip="Sort by a sentence" aria-label="Sort by a sentence">${icon("drop")}</button>
      </div>`);
      split.querySelector(".jevx-sort").addEventListener("click", (e) => (e.stopPropagation(), st.running ? null : run(st.q)));
      split.querySelector(".jevx-caret").addEventListener("click", (e) => (e.stopPropagation(), toggleMenu(split)));
    }
    mutate(() => {
      split.classList.toggle("in-head", !!hd);
      if (hd) {
        hd.classList.add("jevx-anchor");
        hd.append(split);
        return;
      }
      const after = tb.querySelector('[data-tooltip="More email options"], [aria-label="More email options"], [data-tooltip="Refresh"], [aria-label="Refresh"]');
      if (after) after.after(split);
      else (tb.firstElementChild || tb).append(split);
    });
    paintButton();
  }
  function paintButton() {
    for (const b of document.querySelectorAll(".jevx-split")) {
      b.classList.toggle("running", st.running);
      b.classList.toggle("sorted", st.done);
      b.querySelector(".jevx-lbl").textContent = st.running ? `Sorting ${((performance.now() - st.t0) / 1000).toFixed(1)}s` : st.done ? "Sorted" : "Sort";
      b.querySelector(".jevx-bar").style.width = st.running ? `${Math.round(100 * Math.min(1, st.decisions / Math.max(1, st.total)))}%` : "0";
    }
  }

  // ---------- prompt dropdown (looks like Gmail's search suggestions) ----------
  let menu = null, menuAnchor = null, opening = false;
  const item = (ic, q) => `<div class="jevx-p" data-q="${esc(q)}" role="option">${icon(ic, "ic")}<span class="q">${esc(q === DEFAULT_Q ? "What matters most to me" : q)}</span>${icon("enter", "go")}</div>`;
  // Sentences written for this inbox by the background (OpenAI), fetched when the list loads.
  function generated() {
    if (sugg.list === null) return `<div class="jevx-h">For this inbox</div><div class="jevx-skel"><i></i><i></i><i></i></div>`;
    if (!sugg.list.length) return "";
    return `<div class="jevx-h">For this inbox</div>${sugg.list.map((s) => item(s.icon, s.q)).join("")}`;
  }
  async function toggleMenu(anchor) {
    if (menu) return closeMenu();
    if (opening) return;
    opening = true;
    const { recent = [] } = await chrome.storage.local.get("recent").catch(() => ({}));
    opening = false;
    const n = Math.min(MAX, rows().length);
    const shown = new Set([...PRESETS.map(([, q]) => q), ...(sugg.list || []).map((s) => s.q)]);
    const recents = recent.filter((q) => !shown.has(q)).slice(0, 3);
    menu = h(`<div class="jevx-menu" role="listbox">
      <form class="jevx-in">${icon("sort", "ic")}<input placeholder="Sort ${n} emails by anything…" value="${esc(st.q === DEFAULT_Q ? "" : st.q)}" autocomplete="off" spellcheck="false"><kbd>Enter</kbd></form>
      <div class="jevx-gen">${generated()}</div>
      ${recents.length ? `<div class="jevx-h">Recent</div>${recents.map((q) => item("history", q)).join("")}` : ""}
      <div class="jevx-h">Suggestions</div>${PRESETS.map(([ic, q]) => item(ic, q)).join("")}
      <div class="jevx-foot"><span>Ranks the ${n} emails on screen and flags what's safe to trash</span><span class="jevx-sp"></span>
        ${st.order ? `<button type="button" class="jevx-link jevx-reset">${icon("undo")}Undo sort</button>` : ""}
        <button type="button" class="jevx-link jevx-opts" data-tooltip="Settings" aria-label="Settings">${icon("tune")}</button></div>
    </div>`);
    menuAnchor = anchor;
    document.body.appendChild(menu);
    placeMenu();
    const input = menu.querySelector("input");
    const opts = () => [...menu.querySelectorAll(".jevx-p")].filter((o) => !o.hidden);
    let sel = -1;
    const pick = (i) => {
      sel = i;
      opts().forEach((o, k) => o.classList.toggle("on", k === i));
      opts()[i]?.scrollIntoView({ block: "nearest" });
    };
    input.focus();
    // Keep Gmail's single-key shortcuts (e, #, r…) from firing while typing.
    for (const t of ["keydown", "keypress", "keyup"])
      input.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t !== "keydown") return;
        if (e.key === "Escape") closeMenu();
        if (e.key === "ArrowDown") (e.preventDefault(), pick(Math.min(opts().length - 1, sel + 1)));
        if (e.key === "ArrowUp") (e.preventDefault(), pick(Math.max(-1, sel - 1)));
      });
    input.addEventListener("input", () => {
      const v = input.value.toLowerCase();
      menu.querySelectorAll(".jevx-p").forEach((o) => (o.hidden = !!v && !o.dataset.q.toLowerCase().includes(v)));
      pick(-1);
    });
    menu.querySelector("form").addEventListener("submit", (e) => (e.preventDefault(), run(sel >= 0 ? opts()[sel].dataset.q : input.value)));
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      const p = e.target.closest(".jevx-p");
      if (p) return run(p.dataset.q);
      if (e.target.closest(".jevx-reset")) (reset(), closeMenu());
      if (e.target.closest(".jevx-opts")) chrome.runtime.sendMessage({ type: "options" });
    });
  }
  function placeMenu() {
    if (!menu) return;
    const r = menuAnchor.getBoundingClientRect();
    if (!menuAnchor.isConnected || r.bottom < 0 || r.top > innerHeight) return closeMenu();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  document.addEventListener("click", (e) => menu && !e.target.closest(".jevx-menu") && closeMenu());
  addEventListener("resize", closeMenu);
  addEventListener("scroll", () => menu && requestAnimationFrame(placeMenu), true); // the button scrolls with the list

  // ---------- the list: order, sections, chips ----------
  const pos = () => new Map((st.order || []).map((id, i) => [id, i]));
  const isJunk = (id) => (st.flip[id] ? !(st.junk[id] >= TRASH_P) : st.junk[id] >= TRASH_P);
  const band = (id) => (st.done && isJunk(id) ? BANDS.length : BANDS.findIndex(([t]) => (st.imp[id] ?? 0) >= t));

  // Layout reads are expensive on Gmail's huge page, so the whole list is laid out at most once per
  // frame no matter how many results arrive, and FLIP measures all rows in one read.
  let frame = 0, lastOrderAt = 0, wantAnimate = false;
  function schedule(animate = false) {
    wantAnimate ||= animate;
    if (frame) return;
    const wait = Math.max(0, 300 - (performance.now() - lastOrderAt));
    frame = setTimeout(() => requestAnimationFrame(() => {
      frame = 0;
      lastOrderAt = performance.now();
      const a = wantAnimate;
      wantAnimate = false;
      render(a);
    }), wait);
  }

  function render(animate) {
    if (!st.order) return;
    const p = pos();
    const rs = [...st.rowOf.values()].filter((r) => r.isConnected);
    if (!rs.length) return;
    const tbody = rs[0].parentElement;
    const sc = scroller();
    const top = sc?.scrollTop;
    const before = animate ? new Map(rs.map((r) => [r, r.getBoundingClientRect().top])) : null;
    const ranked = [...rs].sort((a, b) => band(rowId(a)) - band(rowId(b)) || p.get(rowId(a)) - p.get(rowId(b)));
    // Rows that aren't ranked: mail that arrived after sorting goes on top, the rest of the page below.
    const extra = [...tbody.children].filter((r) => r.matches("tr.zA") && !st.rowOf.has(rowId(r)));
    const fresh = extra.filter((r) => !st.seen.has(rowId(r)));
    const old = extra.filter((r) => st.seen.has(rowId(r)));
    mutate(() => {
      tbody.querySelectorAll(":scope > .jevx-sec").forEach((x) => x.remove());
      tbody.prepend(status());
      for (const r of [...fresh, ...ranked, ...old]) tbody.appendChild(r);
      for (const r of rs) decorate(r, p);
      if (st.done) sections(tbody, ranked, old, fresh);
    });
    st.listed = tbody.querySelectorAll(":scope > tr.zA").length;
    if (sc && top != null) sc.scrollTop = top; // moving rows must never move the page
    if (!before) return;
    for (const r of rs) {
      const dy = before.get(r) - r.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  const cols = () => st.rowOf.values().next().value?.cells.length || 6;
  const secRow = (cls, html) => h(`<table><tbody><tr class="jevx-sec ${cls}"><td colspan="${cols()}">${html}</td></tr></tbody></table>`).querySelector("tr");

  // A status line at the top of the list, styled like Gmail's own section headers.
  let statusEl = null;
  function status() {
    if (!statusEl) {
      statusEl = secRow("jevx-status", `<div class="jevx-st"><span class="jevx-spin"></span>${icon("check", "jevx-ok")}<b class="q"></b><span class="meta"></span><span class="jevx-sp"></span><span class="acts"></span></div><i class="jevx-prog"></i>`);
      statusEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = e.target.closest("[data-act]")?.dataset.act;
        if (a === "hide") toggleHide();
        if (a === "reset") reset();
        if (a === "trash") trash(e.target.closest("[data-act]"));
      });
    }
    paintStatus();
    return statusEl;
  }
  function paintStatus() {
    if (!statusEl?.querySelector(".q")) return; // cleared off the page by a newer copy of this script
    const q = st.q === DEFAULT_Q ? "What matters most" : `“${st.q}”`;
    const secs = ((performance.now() - st.t0) / 1000).toFixed(1);
    statusEl.classList.toggle("running", st.running);
    statusEl.querySelector(".q").textContent = st.running ? `Sorting by ${q}` : `Sorted by ${q}`;
    statusEl.querySelector(".meta").textContent = st.running
      ? `${st.phase || "reading emails"} · ${st.decisions} decisions · ${secs}s`
      : st.stats || "";
    statusEl.querySelector(".jevx-prog").style.width = st.running ? `${Math.round(100 * Math.min(1, st.decisions / Math.max(1, st.total)))}%` : "100%";
    const nJunk = st.done ? [...st.rowOf.keys()].filter(isJunk).length : 0;
    const acts = statusEl.querySelector(".acts");
    const html = st.done
      ? `${nJunk ? `<button data-act="trash" class="danger">${icon("trash")}<span>Move ${nJunk} to Trash</span></button>` : ""}<button data-act="hide">${st.hideLow ? icon("more") + "<span>Show everything</span>" : icon("less") + "<span>Hide the rest</span>"}</button><button data-act="reset">${icon("undo")}<span>Undo sort</span></button>`
      : "";
    if (acts.dataset.html !== html) (acts.innerHTML = html), (acts.dataset.html = html);
  }

  function sections(tbody, ranked, extra, fresh) {
    if (fresh.length) tbody.insertBefore(secRow("new", `<span class="name">New</span><em>${fresh.length}</em><span class="hint">arrived after sorting. Sort again to rank them</span>`), fresh[0]);
    let last = -1;
    for (const r of ranked) {
      const b = band(rowId(r));
      if (b === last) continue;
      last = b;
      const n = ranked.filter((x) => band(rowId(x)) === b).length;
      const name = b === BANDS.length ? "Suggested trash" : BANDS[b][1];
      const hint = b === BANDS.length ? `<span class="hint">Promotions and notices you likely won't miss. Use the trash icon on a row to keep it.</span>` : b === BANDS.length - 1 && st.hideLow ? `<span class="hint">hidden</span>` : "";
      tbody.insertBefore(secRow(`b${b}`, `<span class="name">${name}</span><em>${n}</em>${hint}`), r);
    }
    if (extra.length) tbody.insertBefore(secRow("out", `<span class="name">Not ranked</span><em>${extra.length}</em><span class="hint">past the first ${MAX}</span>`), extra[0]);
  }

  function decorate(tr, p) {
    const id = rowId(tr);
    const i = p.get(id);
    const b = band(id);
    tr.classList.toggle("jevx-hidden", st.hideLow && st.done && b >= BANDS.length - 1);
    tr.classList.toggle("jevx-hot", st.done && b === 0);
    tr.classList.toggle("jevx-junk", st.done && b === BANDS.length);
    const host = tr.querySelector(".xT") || tr.querySelector(".y6")?.parentElement;
    if (!host) return;
    let chip = host.querySelector(".jevx-chip");
    if (!chip) {
      chip = h(`<span class="jevx-chip"><b></b><span class="tier"></span><button class="tr" aria-label="Toggle suggested trash">${icon("trash")}</button></span>`);
      chip.querySelector(".tr").addEventListener("click", (e) => {
        e.stopPropagation(); // don't open the email
        e.preventDefault();
        st.flip[id] = !st.flip[id];
        schedule(true);
      });
      host.prepend(chip);
    }
    const tier = st.tiers[id];
    chip.querySelector(".tr").dataset.tooltip = st.done && isJunk(id) ? "Suggested trash. Click to keep" : "Suggest for trash";
    chip.className = `jevx-chip ${tier ? "t-" + tier : ""} ${st.done && isJunk(id) ? "junk" : ""} ${st.done && !isJunk(id) && st.junk[id] != null ? "keepable" : ""}`;
    chip.querySelector("b").textContent = i == null ? "" : `#${i + 1}`;
    chip.querySelector(".tier").textContent = (tier && TIER_LABEL[tier]) || "";
  }

  function flash(id, won) {
    st.rowOf.get(id)?.animate([{ backgroundColor: won ? "#e6f4ea" : "#fce8e6" }, { backgroundColor: "transparent" }], { duration: 500 });
  }

  function toggleHide() {
    st.hideLow = !st.hideLow;
    render(false);
  }

  // Trash uses Gmail itself: tick the suggested rows' checkboxes, then press Gmail's Delete button.
  // Two clicks so nothing is trashed by accident; Gmail keeps Trash for 30 days.
  let armed = 0;
  async function trash(btn) {
    const ids = [...st.rowOf.keys()].filter(isJunk);
    if (!ids.length) return;
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      btn.querySelector("span").textContent = `Click again to trash ${ids.length}`;
      btn.classList.add("armed");
      setTimeout(() => {
        if (armed && Date.now() - armed >= 4000) (statusEl.querySelector(".acts").dataset.html = ""), paintStatus();
      }, 4100);
      return;
    }
    armed = 0;
    // Gmail's selection and Delete follow its own list order, so put that order back while ticking.
    mutate(() => {
      document.querySelectorAll(".jevx-sec").forEach((x) => x.remove());
      gmailOrder();
    });
    for (const tr of st.rowOf.values()) {
      const cb = tr.querySelector('[role="checkbox"]');
      const want = ids.includes(rowId(tr));
      if (cb && (cb.getAttribute("aria-checked") === "true") !== want) click(cb);
    }
    await new Promise((r) => setTimeout(r, 250));
    const tb = toolbar();
    const del = tb && [...tb.querySelectorAll('[act="10"], [data-tooltip="Delete"], [aria-label="Delete"]')].find(visible);
    if (!del) return toast(`Selected ${ids.length}. Press Gmail's Delete button to trash them.`);
    click(del);
    for (const id of ids) st.rowOf.delete(id);
    toast(`Moved ${ids.length} to Trash. Gmail's “Undo” brings them back.`);
    schedule(false);
  }

  function reset() {
    st.port?.disconnect();
    clearTimeout(frame);
    frame = 0;
    const rs = [...st.rowOf.values()].filter((r) => r.isConnected);
    mutate(() => {
      document.querySelectorAll(".jevx-sec").forEach((x) => x.remove());
      if (rs.length) gmailOrder();
      for (const r of rs) {
        r.querySelector(".jevx-chip")?.remove();
        r.classList.remove("jevx-hot", "jevx-hidden", "jevx-junk");
      }
    });
    statusEl = null;
    setCursor(null);
    Object.assign(st, { order: null, original: null, tiers: {}, imp: {}, junk: {}, flip: {}, running: false, done: false, hideLow: false, port: null, rowOf: new Map() });
    paintButton();
  }

  // Every row back into the list (or section) it came from, in Gmail's order. Gmail may have swapped
  // in fresh elements for some rows since, so those are found by thread id.
  function gmailOrder() {
    if (!st.original) return;
    const sc = scroller();
    const top = sc?.scrollTop;
    for (const [r, parent] of st.original) {
      const el = r.isConnected ? r : st.rowOf.get(rowId(r));
      const into = parent.isConnected ? parent : el?.parentElement;
      if (el?.isConnected && into) into.appendChild(el);
    }
    if (sc && top != null) sc.scrollTop = top;
  }

  // ---------- clicks and keys on the sorted list ----------
  // Gmail keeps its own model of the list in its own order, so once rows are moved its click and
  // keyboard handling can open or act on the wrong email, or nothing. While sorted, opening an email,
  // j/k/o/x and shift-click ranges are handled here by the row's own thread id. Stars, checkboxes and
  // the hover buttons stay with Gmail.
  const CONTROLS = '[role="checkbox"], [role="button"], [role="link"], [role="option"], button, a[href], input, li, [data-tooltip], [aria-label], .apU, .brd, .jevx-chip';
  const sortedRow = (el) => {
    const tr = st.order && el?.closest?.("tr.zA");
    return tr && statusEl && tr.parentElement === statusEl.parentElement && rowId(tr) ? tr : null;
  };
  const listRows = () => {
    const tb = statusEl?.parentElement;
    return tb ? [...tb.querySelectorAll(":scope > tr.zA")].filter((r) => rowId(r) && !r.classList.contains("jevx-hidden")) : [];
  };
  // "#inbox", "#label/Work", "#search/foo", without a page ("/p2") or an open thread.
  const view = () => {
    const parts = (location.hash || "#inbox").split("/");
    return parts.slice(0, /^#(label|search|category|advanced-search|apps)$/.test(parts[0]) ? 2 : 1).join("/");
  };
  const threadUrl = (tr) => location.href.split("#")[0] + view() + "/" + rowId(tr);
  // Gmail only opens an email from its own list, in its own tables and order (with inbox sections, the
  // sort moves rows between tables). So for the click, every row goes back where Gmail put it and Gmail
  // opens the email itself; the sort comes back when the list shows again. If Gmail still doesn't open
  // it, load the email's URL.
  let holdUntil = 0, navs = 0;
  addEventListener("hashchange", () => navs++);
  function open(tr, native) {
    const before = navs;
    holdUntil = performance.now() + 1000;
    mutate(() => {
      document.querySelectorAll(".jevx-sec").forEach((x) => x.remove());
      gmailOrder();
    });
    if (!native) click(tr.querySelector(".bog") || tr.querySelector(".y6") || tr);
    setTimeout(() => {
      holdUntil = 0;
      if (navs !== before || location.href.includes(rowId(tr)) || !visible(tr)) return check(); // Gmail opened it; sort the list behind it again
      location.assign(threadUrl(tr));
      const at = navs;
      setTimeout(() => navs === at + 1 && visible(tr) && location.reload(), 1500); // a URL change alone didn't open it
    }, 600);
  }
  const swallow = (e) => (e.preventDefault(), e.stopImmediatePropagation());

  let lastBox = null;
  function selectRange(tr) {
    const list = listRows();
    const box = (r) => r.querySelector('[role="checkbox"]');
    const on = box(tr)?.getAttribute("aria-checked") !== "true";
    const a = list.indexOf(lastBox), b = list.indexOf(tr);
    const [i, j] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
    for (const r of list.slice(i, j + 1)) {
      const cb = box(r);
      if (cb && (cb.getAttribute("aria-checked") === "true") !== on) click(cb);
    }
    lastBox = tr;
  }
  for (const t of ["mousedown", "mouseup", "click", "dblclick"])
    addEventListener(t, (e) => {
      const tr = e.button === 0 && !dead() && sortedRow(e.target);
      if (!tr) return;
      if (e.target.closest('[role="checkbox"]')) {
        if (!e.shiftKey) return void (t === "click" && (lastBox = tr));
        swallow(e);
        if (t === "click") selectRange(tr);
        return;
      }
      if (e.target.closest(CONTROLS)) return;
      if (e.metaKey || e.ctrlKey) return void (swallow(e), t === "click" && window.open(threadUrl(tr), "_blank"));
      if (t === "click") (setCursor(tr), open(tr, true)); // the click goes on to Gmail
    }, true);
  addEventListener("auxclick", (e) => {
    const tr = e.button === 1 && !dead() && sortedRow(e.target);
    if (tr && !e.target.closest(CONTROLS)) (swallow(e), window.open(threadUrl(tr), "_blank"));
  }, true);

  // Our own row cursor, in the sorted order (Gmail's j/k would walk its own order).
  let cursor = null, handled = "";
  function setCursor(tr) {
    cursor?.classList.remove("jevx-cur");
    cursor = tr;
    tr?.classList.add("jevx-cur");
  }
  const ACTIONS = new Set(["e", "#", "!", "s", "I", "U", "l", "v", "b", "m"]); // archive, delete, spam, star, read, unread, label, move, snooze, mute
  addEventListener("keydown", (e) => {
    handled = "";
    const el = e.composedPath()[0];
    if (!st.order || menu || dead() || e.metaKey || e.ctrlKey || e.altKey || el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName)) return;
    const list = listRows();
    if (!list.length || !visible(list[0])) return; // an email is open, not the list
    if (cursor && !list.includes(cursor)) setCursor(null);
    const k = e.key;
    if (k === "j" || k === "k") {
      const i = list.indexOf(cursor);
      const next = list[cursor ? Math.max(0, Math.min(list.length - 1, i + (k === "j" ? 1 : -1))) : 0];
      setCursor(next);
      next.scrollIntoView({ block: "nearest" });
    } else if (cursor && (k === "o" || (k === "Enter" && !el?.closest?.('button, a, [role="button"]')))) open(cursor, false);
    else if (cursor && k === "x") {
      const cb = cursor.querySelector('[role="checkbox"]');
      if (cb) (click(cb), (lastBox = cursor));
    } else {
      // Gmail acts on the ticked rows first, so with nothing ticked, tick ours and let Gmail do the rest.
      if (cursor && ACTIONS.has(k) && !document.querySelector('div[role="main"] tr.zA [role="checkbox"][aria-checked="true"]')) {
        const cb = cursor.querySelector('[role="checkbox"]');
        if (cb) click(cb);
      }
      return;
    }
    handled = k;
    swallow(e);
  }, true);
  for (const t of ["keypress", "keyup"]) addEventListener(t, (e) => handled && e.key === handled && swallow(e), true);

  function toast(t) {
    document.querySelector(".jevx-toast")?.remove();
    const el = h(`<div class="jevx-toast">${esc(t)}</div>`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // Gmail re-renders the list on new mail, refreshes and tab switches. Checked at most twice a
  // second (Gmail mutates its DOM constantly) so this never competes with Gmail for the main thread.
  let checkAt = 0, checkTimer = 0;
  const check = () => {
    checkTimer = 0;
    if (dead()) return;
    checkAt = performance.now();
    ensureButton();
    warm();
    if (!st.order || performance.now() < holdUntil) return;
    // Gmail swapped in fresh row elements: re-map ids to the new rows, then redo our layout.
    if ([...st.rowOf.values()].some((r) => !r.isConnected)) {
      const now = rows();
      for (const r of now) {
        const id = rowId(r);
        if (st.rowOf.has(id)) st.rowOf.set(id, r);
      }
      // A different list is showing (another label or page): drop the sort instead of fighting Gmail.
      if (now.length && ![...st.rowOf.values()].some((r) => r.isConnected)) return reset();
      schedule(false);
    } else if (!statusEl?.isConnected || (st.done && !document.querySelector(".jevx-sec.b0, .jevx-sec.b1, .jevx-sec.b2, .jevx-sec.b3"))) schedule(false);
    // New mail (or Gmail removed rows): lay the list out again.
    else if (statusEl.parentElement.querySelectorAll(":scope > tr.zA").length !== st.listed) schedule(false);
  };
  addEventListener("hashchange", () => setTimeout(check, 300)); // back from an email: sort the list again
  observer = new MutationObserver(() => {
    if (st.mutating || checkTimer || dead()) return;
    checkTimer = setTimeout(check, Math.max(0, 500 - (performance.now() - checkAt)));
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Tell the background which threads are on screen so it reads them before Sort is pressed, and
  // ask for sort ideas written for this inbox so the menu has them ready when it opens.
  let warmed = "";
  const sugg = { key: "", list: null };
  function warm() {
    if (st.running) return;
    const ids = rows().map(rowId).filter(Boolean).slice(0, MAX);
    const key = ids.join();
    if (!ids.length || key === warmed) return;
    warmed = key;
    // The rows also let the background pre-sort this list by the sentence the Sort button would run.
    const list = scrape();
    chrome.runtime.sendMessage({ type: "prefetch", ids, rows: list.map((e) => ({ id: e.id, card: card(e) })), owner: owner(), q: st.q === DEFAULT_Q ? "" : st.q }).catch(() => {});
    // Same inbox with a few new emails on top: keep the ideas we have.
    if (sugg.list?.length && ids.filter((id) => sugg.key.includes(id)).length >= ids.length * 0.8) return;
    sugg.key = key;
    if (!sugg.list?.length) sugg.list = null;
    const items = list.map((e) => ({ from: e.from.name || e.from.email, subject: e.subject, snippet: e.snippet.slice(0, 90) }));
    chrome.runtime
      .sendMessage({ type: "suggest", items })
      .then((r) => r?.suggestions)
      .catch(() => null)
      .then((list) => {
        if (sugg.key !== key) return;
        sugg.list = list || sugg.list || [];
        const gen = menu?.querySelector(".jevx-gen");
        if (gen) gen.innerHTML = generated();
      });
  }

  // ---------- run ----------
  async function run(q) {
    if (st.running || dead()) return;
    q = (q || "").trim() || DEFAULT_Q;
    closeMenu();
    if (st.order) reset();
    const list = scrape();
    if (list.length < 2) return toast("Open your inbox (or any list of emails) first.");
    chrome.storage.local.get("recent").then(({ recent = [] }) => chrome.storage.local.set({ recent: [q, ...recent.filter((x) => x !== q)].slice(0, 8) })).catch(() => {});
    Object.assign(st, {
      q, running: true, done: false, t0: performance.now(), decisions: 0, total: list.length * 7, phase: "", stats: null,
      byId: new Map(list.map((e) => [e.id, e])), rowOf: new Map(list.map((e) => [e.id, e.tr])), original: rows().map((r) => [r, r.parentElement]), seen: new Set(rows().map(rowId)), tiers: {}, imp: {}, junk: {}, flip: {}, hideLow: false,
    });
    st.order = list.map((e) => e.id);
    // Start at the top of the list so the live ranking is in view.
    const sc = scroller();
    if (sc) sc.scrollTop = 0;
    render(false);
    paintButton();
    const tick = setInterval(() => (st.running && !dead() ? (paintButton(), paintStatus()) : clearInterval(tick)), 100);
    const lat = [];

    const port = (st.port = chrome.runtime.connect({ name: "jev" }));
    port.onDisconnect.addListener(() => st.port === port && st.running && fail("Lost the connection to the extension. Reload Gmail and try again."));
    port.onMessage.addListener((ev) => {
      if (st.port !== port) return;
      switch (ev.type) {
        case "read":
          st.phase = ev.ms != null ? `read ${ev.full} emails in ${ev.ms}ms` : `reading ${ev.done}/${ev.total}`;
          break;
        case "readfail":
          toast("Couldn't read the full emails (" + ev.message + "). Sorting by the previews instead.");
          break;
        case "nokey":
          fail("Add your ranking API key in the extension settings (the settings button in the Sort menu).");
          break;
        case "plan":
          st.total = ev.phases.reduce((s, p) => s + (p.total || (p.key === "bt" ? 0 : Math.ceil(ev.n / 2))), 0) + ev.n;
          st.plan = ev.phases;
          break;
        case "phase":
          st.phase = (st.plan || []).find((p) => p.key === ev.key)?.label || ev.key;
          break;
        case "junk":
          st.junk[ev.id] = ev.p;
          st.decisions++;
          if (st.done) schedule(false);
          break;
        case "triage":
          st.decisions++;
          lat.push(ev.ms);
          st.tiers[ev.id] = ev.tier;
          schedule(false);
          break;
        case "match":
          st.decisions++;
          lat.push(ev.ms);
          flash(ev.a, ev.pA >= 0.5);
          flash(ev.b, ev.pA < 0.5);
          break;
        case "standings":
          st.order = ev.order;
          schedule(true);
          break;
        case "done": {
          const secs = ((performance.now() - st.t0) / 1000).toFixed(1);
          Object.assign(st, { order: ev.order, imp: ev.importance, running: false, done: true, stats: ev.presorted ? `${list.length} emails · instant (sorted in the background in ${(ev.ms / 1000).toFixed(1)}s)` : `${list.length} emails · ${secs}s · ${ev.jev.decisions + Object.keys(st.junk).length} comparisons · $${ev.jev.costUsd.toFixed(3)}` });
          clearInterval(tick);
          paintButton();
          paintStatus();
          // Junk answers usually land first; if any are still out, the next "junk" event re-renders.
          schedule(true);
          break;
        }
        case "junkdone":
          if (st.done) schedule(false);
          break;
        case "error":
          break; // one failed call; the ranker retries or treats it as a coin flip
        case "fatal":
          fail(ev.message);
          break;
      }
    });
    port.postMessage({ type: "rank", rows: list.map((e) => ({ id: e.id, card: card(e) })), owner: owner(), q: q === DEFAULT_Q ? "" : q });
  }

  function fail(msg) {
    st.running = false;
    paintButton();
    toast(msg);
    reset();
  }

  ensureButton();
  warm();
})();
