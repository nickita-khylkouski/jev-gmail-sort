// An addition to the existing Gmail extension. No continuous draft capture; only the button/hotkey.
(() => {
  const EDITOR = '.Am[contenteditable="true"], [g_editable="true"][role="textbox"][contenteditable="true"]';
  const states = new WeakMap();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el, max) => (el?.innerText || el?.textContent || '').trim().slice(0, max);
  function project(editor) {
    const nodes = []; let draft = '';
    const boundary = () => { if (draft && !draft.endsWith('\n')) draft += '\n'; };
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const start = draft.length; draft += node.data;
        nodes.push({ node, start, end: draft.length }); return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      // Inline formatting must not split a word. Real blocks, line breaks and protected regions do.
      if (!visible(node)) return;
      if (node.matches('blockquote, .gmail_quote, .gmail_signature, a, code, pre, [contenteditable="false"], script, style')) {
        // A digit-bearing marker protects partial words adjoining excluded inline content too.
        if (['inline', 'inline-block', 'contents'].includes(getComputedStyle(node).display)) draft += '__protected0__';
        else boundary();
        return;
      }
      if (node.tagName === 'BR') { boundary(); return; }
      const block = node !== editor && !['inline', 'inline-block', 'contents'].includes(getComputedStyle(node).display);
      if (block) boundary();
      for (const child of node.childNodes) visit(child);
      if (block) boundary();
    }
    visit(editor);
    return { draft, nodes };
  }
  function context(editor, purpose) {
    const compose = editor.closest('[role="dialog"], .M9, .ip') || editor.parentElement;
    const subject = compose.querySelector('input[name="subjectbox"]')?.value ?? text(document.querySelector('h2.hP'), 300);
    const recipients = [...compose.querySelectorAll('input[name="to"], [email][data-name], [email][data-hovercard-id]')]
      .slice(0, 12).map((el) => [el.getAttribute('data-name') || text(el, 120), el.getAttribute('email') || el.value || ''].filter(Boolean).join(' ')).join(', ').slice(0, 500);
    const threadRoot = editor.closest('.ip')?.closest('[role="main"]') || compose;
    const thread = editor.querySelector('.gmail_quote, blockquote') || [...threadRoot.querySelectorAll('.a3s')].filter((el) => visible(el) && !editor.contains(el) && !el.contains(editor)).at(-1);
    return { subject, recipients, purpose, thread: text(thread, 2000) };
  }
  function planChanges(snapshot, changes) {
    if (!Array.isArray(changes) || changes.length > 24) throw new Error('Invalid correction response; your draft is unchanged.');
    let end = -1;
    return [...changes].sort((a, b) => a.start - b.start).map((change) => {
      const { start, end: finish, original, replacement } = change;
      if (!Number.isInteger(start) || !Number.isInteger(finish) || start < 0 || start < end || finish <= start ||
          snapshot.draft.slice(start, finish) !== original || typeof replacement !== 'string' || !/^[A-Za-z][A-Za-z '’-]{0,47}$/.test(replacement)) {
        throw new Error('Invalid correction response; your draft is unchanged.');
      }
      const entry = snapshot.nodes.find((entry) => entry.start <= start && entry.end >= finish);
      end = finish;
      // Keep words with internal formatting intact rather than flattening their markup.
      if (!entry) return null;
      const range = document.createRange();
      range.setStart(entry.node, start - entry.start); range.setEnd(entry.node, finish - entry.start);
      return { range, original, replacement };
    }).filter(Boolean);
  }
  async function run(editor) {
    const state = states.get(editor);
    if (!state || state.running) return;
    const snapshot = project(editor), beforeHTML = editor.innerHTML;
    if (!snapshot.draft.trim() || snapshot.draft.length > 12_000) { state.note.textContent = 'Use an English draft of 1–12,000 characters.'; return; }
    const writingContext = context(editor, state.purpose.value.slice(0, 300));
    const selection = window.getSelection();
    const saved = selection.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    state.running = true; state.button.disabled = true; state.note.textContent = 'Checking with Jev…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'spellcheck', draft: snapshot.draft, context: writingContext });
      if (result?.error) throw new Error(result.error);
      // Never replace a newer draft, another compose window, or a changed conversation.
      if (!editor.isConnected || !state.tools.isConnected || editor.innerHTML !== beforeHTML ||
          JSON.stringify(context(editor, state.purpose.value.slice(0, 300))) !== JSON.stringify(writingContext)) {
        state.note.textContent = 'Draft or context changed. Press the shortcut again.'; return;
      }
      const focused = document.activeElement;
      if (focused !== editor && !editor.contains(focused) && !state.tools.contains(focused)) {
        state.note.textContent = 'Focus returned elsewhere. Press the shortcut again in this draft.'; return;
      }
      if (saved && (selection.rangeCount !== 1 || selection.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, saved) || selection.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END, saved))) {
        state.note.textContent = 'Selection changed. Press the shortcut again in this draft.'; return;
      }
      const plan = planChanges(snapshot, result?.changes);
      if (!plan.length) { state.note.textContent = 'No safely applicable spelling fixes found.'; return; }
      editor.focus();
      let applied = 0;
      // Live Ranges track text edits. Work backwards to preserve positions, formatting, and links.
      for (const { range, original, replacement } of plan.reverse()) {
        if (!editor.contains(range.startContainer) || range.toString() !== original) break;
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, replacement)) break;
        applied++;
      }
      if (saved && editor.contains(saved.startContainer)) { selection.removeAllRanges(); selection.addRange(saved); }
      state.note.textContent = applied
        ? `Fixed ${applied} word${applied === 1 ? '' : 's'} · ${(result.ms / 1000).toFixed(1)}s · Undo in Gmail as usual`
        : 'This editor could not apply the fixes. Your draft is unchanged.';
    } catch (error) { state.note.textContent = error.message || 'Spell check failed. Your draft is unchanged.'; }
    finally { state.running = false; state.button.disabled = false; }
  }
  function ensure() {
    for (const editor of document.querySelectorAll(EDITOR)) {
      if (!visible(editor) || states.get(editor)?.tools.isConnected) continue;
      const tools = document.createElement('div'); tools.className = 'jevx-spell-tools'; tools.contentEditable = 'false';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '✦ Spell check'; button.title = 'Check this draft with Jev · F8 (or Option-Shift-S / Alt-Shift-S)';
      const purpose = document.createElement('input'); purpose.type = 'text'; purpose.placeholder = 'Writing purpose (optional)'; purpose.maxLength = 300; purpose.setAttribute('aria-label', 'Jev spell check writing purpose');
      const note = document.createElement('span'); note.className = 'jevx-spell-note'; note.setAttribute('role', 'status'); note.textContent = 'F8 · checks only when asked';
      tools.append(button, purpose, note); editor.before(tools);
      states.set(editor, { tools, button, purpose, note, running: false });
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => { editor.focus(); void run(editor); });
      purpose.addEventListener('keydown', (event) => event.stopPropagation());
    }
  }
  document.addEventListener('keydown', (event) => {
    const shortcut = (event.code === 'F8' && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) || (event.code === 'KeyS' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey);
    if (event.isComposing || event.repeat || !shortcut) return;
    const editor = event.target.closest?.(EDITOR);
    if (!editor) return;
    event.preventDefault(); event.stopImmediatePropagation(); ensure(); void run(editor);
  }, true);
  let scheduled = false;
  new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; ensure(); }); } })
    .observe(document.body, { childList: true, subtree: true });
  ensure();
})();
