# Gmail × Jev: importance sort

A pixel-faithful Gmail clone that mirrors your 100 most recent Inbox threads (read-only). **Analyze** sorts them by importance with Jev.

How the sort works:
1. **Triage.** Every email gets a tier from Jev (critical/high/medium/low/noise). All 100 calls run in parallel, about 0.5s total. This seeds the next step.
2. **Swiss tournament.** About 9 rounds. Each round pairs neighbours in the current standings with no rematches, and all 50 pairwise Jev decisions run at once. Each result is soft: Jev returns P(A matters more). A/B order is randomized so position bias averages out.
3. **Top-12 round robin.** Nails down the head of the list.
4. **Bradley–Terry fit.** Runs over every game and gives the final order.

A full run is about 600 Jev decisions in about 3–4s, costing about $0.03.

**Safety:** the refresh token is downscoped to `gmail.readonly` at refresh time, and the server refuses any other scope. Only GET requests are made. Clicking archive, star, etc. in the UI does nothing.

```bash
bun install
bun run server.ts   # http://localhost:8383
```
`.env`: `TYPESAFE_API_KEY`, `GOOGLE_TOKEN_FILE` (an authorized-user JSON for the account). `data/inbox.json` caches the fetch. The refresh button refetches live.

## Chrome extension (extension/)

Sort your real Gmail (last 24 hours) in place. A **⚡ Sort ▾** split button is injected into Gmail's toolbar.
The ▾ opens "Sort by…": type any sentence ("which require investor attention") or pick a preset, plus Auto/Pivot/Swiss.
Gmail's own rows are reordered (FLIP animation) with rank + tier chips, and a live Jev panel shows the tournament.

No Google sign-in in the extension: its service worker talks to this server on localhost:8383, which holds the
read-only (gmail.readonly) token and the Jev key. Row ids match because Gmail renders `data-legacy-thread-id` = API thread id.

1. `bun run server.ts`
2. chrome://extensions → Developer mode → Load unpacked → pick `extension/`
3. Open Gmail inbox → ⚡ Sort

Logic test without Gmail: http://localhost:8383/ext-test.html (Gmail-DOM mock + chrome.runtime shim).

## Glance: screen, cursor and editor shortcuts

The optional macOS companion in `native/Glance/` adds screen reading and native popups to this same app. It uses **this Bun server, this Chrome extension, and this repository's Jev client**. The existing Gmail mirror, Sort panel, full/pivot/Swiss tournaments and Bradley–Terry fit remain the basis of Gmail ranking. There is no second Node bridge or separate Gmail extension.

- **K**, outside editable fields: in focused Chrome Gmail, runs the existing last-24-hour Sort flow using its current criterion and algorithm, then shows the top subject in a native card. Elsewhere it reads the display with local OCR, lets Jev choose a useful public topic, and asks Exa Instant for a cited explanation.
- **L**, outside editable fields: in Gmail, checks the hovered row or open conversation through the same read-only Google client and asks Jev for a conservative next-step category. Elsewhere it captures a 640×360-point region around the pointer, reads it locally, and displays an Exa explanation above the pointer.
- **F8**: checks the focused draft. Gmail uses the extension's rich-text path; other Mac editors use Accessibility replacement when the editor explicitly supports selected-text and selection-range writes. Unsupported editors show a message rather than using clipboard paste or replacing the whole document. The window title, app name, and optional **Writing purpose** in Glance Settings guide native corrections. Native Undo support depends on the editor; Gmail Undo is exercised by the browser fixture.
- **Option-K / Option-L** work while editing. Escape cancels a lookup and dismisses its card. Pause stops native shortcuts. F8 in Gmail remains an independent extension shortcut.

Gmail commands are pinned to the focused tab. Cancelling a shortcut disconnects its Sort stream and cancels pending Jev work; late results cannot finish a newer command. Native capture rechecks the focused app/window after asynchronous connection and capture work.

Screen/cursor explanations default to complete **10–15-word sentences**, supported by a citation. Excerpts are available as an explicit fastest setting; failed explanations never silently become excerpts. Freshness defaults to 90 days, with 30 days, one year or any time available. Synthesis adds latency: a complete lookup is not guaranteed to take 200 ms. [Exa Search API](https://exa.ai/docs/reference/search).

### Build and connect on macOS

Requires Apple Silicon, macOS 14+, Apple's Command Line Tools, and Bun. The Gmail extension alone remains usable on other platforms.

1. Keep the existing `TYPESAFE_API_KEY` and `GOOGLE_TOKEN_FILE` setup. Add `EXA_API_KEY` to the server's `.env` for screen/cursor web lookups. Exa is optional for Gmail sorting, email inspection and spelling.
2. Run `bun install`, then `bun run companion:build` from the repo root. This builds `native/build/Glance.app` and pairs it with this server. Run `bun run companion:pair` again if the checkout moves or the server port changes.
3. Start `bun run server.ts`. Load/reload **this repo's `extension/`** at `chrome://extensions` and refresh Gmail. Remove/disable the earlier standalone Glance Gmail extension if it was loaded, to avoid duplicate toolbars. The extension currently uses the existing default port 8383.
4. Open `native/build/Glance.app`. Enable its Screen Recording and Accessibility permissions in macOS Settings, and reopen if macOS asks. Use **Test connection** and **Check Gmail connection** in Glance Settings.

Pairing creates a random native authentication token in ignored `data/companion-token` and a mode-0600 connection file at `~/Library/Application Support/JevGlance/connection.json`. No provider keys are copied into the helper, browser extension, or repository source. The app is locally ad-hoc signed, not notarized; rebuilding may require regranting macOS permissions. Build output is ignored by Git.

Screenshots remain in memory for local OCR and never leave the Mac. Redacted text goes to the existing server only after a shortcut: selected web topics go to Exa, screen topic selection and spelling go to Jev, and structured Gmail checks go only to Jev. Redaction detects common credential patterns, not every kind of private content. Password fields block native capture. The companion routes use bounded JSON, a native bearer token, origin/host checks and cancellation; the server binds to loopback. Presence heartbeats contain only focus state, with no email/draft text. The original Gmail mirror's existing cache behavior is retained.

Verification commands:

```bash
bun test
native/build/Glance.app/Contents/MacOS/Glance --self-test
native/build/Glance.app/Contents/MacOS/Glance --check-server
# Optional live public-provider checks; no screen or Gmail capture:
native/build/Glance.app/Contents/MacOS/Glance --check-lookups
# Invented data / mocked provider browser fixtures:
# http://localhost:8383/companion-test.html
# http://localhost:8383/spellcheck-test.html
```

## On-demand spelling in Gmail drafts

This is an addition to the same extension and localhost server. The sorting UI, ranking engine and read-only Gmail API flow are retained. Run `bun install` after updating, restart the server, reload the extension at `chrome://extensions`, and refresh Gmail. Spelling needs no new extension permissions, API provider, or API key.

Focus a Gmail compose or reply body and press **F8**, or click **✦ Spell check** above that draft. On keyboards where F8 controls media, use **Fn-F8**. The earlier Option-Shift-S / Alt-Shift-S shortcut remains available. The tool checks only when asked. An optional **Writing purpose** field can specify context such as “email to my professor”; the current subject, recipient names, and that draft's quoted conversation also guide decisions. Unrelated open conversations are excluded.

Local Hunspell candidates (`nspell` + `dictionary-en`) propose spellings. One batch through the shared Jev client asks it to keep or correct each candidate in context. This covers English spelling, capitalization, common contractions and word confusions such as your/you're. **Jev selects supplied options; it does not generate unrestricted rewrites or perform a general grammar rewrite.** There is no separate LLM or Exa call. At most 24 suspect spans are assessed per shortcut in drafts up to 12,000 characters; run again if further mistakes remain. Latency depends on local candidate generation and the Jev round trip, and is not guaranteed to be instantaneous.

Only confident choices (confidence ≥0.8 and selected probability ≥0.9) apply. Names, slang and uncertain words can stay unchanged. Corrections replace individual words using the browser's native editing command, preserving surrounding formatting. Inline formatting does not split words; a correction spanning multiple text nodes is skipped to preserve its markup. Links, code, noneditable chips, signatures and quoted replies are not edited. If the draft, writing context, focused editor or selection changes while checking, the response does not overwrite the newer text. Gmail's normal Undo works for applied corrections; it may take more than one undo step for several words.

**Draft edits are real edits:** Gmail may autosave them. Spell check never clicks Send or uses a Gmail write API. The original `gmail.readonly` token remains unchanged. Draft text and bounded context go to Jev only after the explicit button or shortcut; credential patterns, email addresses, URLs and inline code are masked before the provider request. Drafts and provider response bodies are not logged or cached. The new route is JSON-only and rejects unrelated web origins; the local server binds to loopback.

Validation:

```bash
bun test
# Browser regression fixture, with invented drafts and mocked Jev decisions:
# http://localhost:8383/spellcheck-test.html
```

Tests cover candidate quality, context and UTF-16 offsets, confidence gates, bearer redaction, hostile origins/hosts, malformed responses, and request limits. They also exercise OAuth/backoff/queued cancellation, healthy slow tournaments, stale worker heartbeats, and actual HTTP stream disconnection with mocked providers. The browser fixtures exercise rich-text edits and Undo, both shortcut and button entry points, focus/context/selection changes, formatting inside words, and Sort cancellation including late events. They do not claim live model accuracy or production Gmail DOM coverage. Official API shape: [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice).

Algorithms: `auto` = every pair at once when n(n-1)/2 ≤ 250 (one wave, complete information), else pivot sort.
Jev is throughput-bound: ≤256 in flight → p50 ~200ms; 1200 in flight → p50 11s. Slow calls are hedged after 3×p50.
