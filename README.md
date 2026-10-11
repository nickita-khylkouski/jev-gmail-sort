# Jev Sort: sort anything by a sentence

A Chrome extension that ranks whatever you're looking at by a sentence you type, using [Jev](https://typesafe.ai) pairwise judgments.

- **Any page (side panel).** Click the toolbar icon and type what matters, e.g. "how big the vulnerability was". Luna (OpenAI) reads the page and pulls out just the things worth ranking. Jev then ranks them live in Swiss rounds.
- **Gmail (in place).** A **Sort** button sits next to "Inbox" and ranks the 50 emails on screen, reading the full threads through the Gmail API. It reorders Gmail's own rows into sections and flags what's safe to trash.

## Demos

| Page | Sentence | What happens |
|---|---|---|
| [ycombinator.com/security](https://www.ycombinator.com/security) | how big the vulnerability was | 16 disclosed findings → 6 Swiss rounds, 48 Jev decisions, about 6s and $0.001 |
| Gmail inbox | what matters most to me | 50 emails, pre-sorted in the background, so the click is instant |
| A LinkedIn profile | most impressive achievement, on merit | About 18 achievements pulled from the profile, ranked in 7 rounds |

## How the ranking works

1. **Extract** (side panel only). The page's text goes to Luna with the sentence. Luna streams back one JSON line per item (title, the relevant facts, and an exact anchor quote) and skips navigation, ads and "people also viewed". Items appear in the panel as they stream in.
2. **Swiss rounds.** Every round pairs items with similar records (no rematches), and each pair is one Jev question: "which ranks higher by this sentence?". A whole round is one parallel wave of calls. There are ⌈log₂ n⌉ + 2 rounds. A and B are swapped at random so position bias averages out, and every answer is a probability (a soft win), not a coin flip.
3. **Bradley–Terry fit** over all the games gives the final order.

Gmail additionally runs a triage read of every email first to seed the rounds, plus a top-12 round robin at the end. It also asks a per-email "safe to trash?" question. The A/B scripts in `ab/` measure accuracy against all-pairs ranking: Swiss reaches Kendall τ ≈ 0.9 and NDCG ≈ 0.99.

Clicking a result in the panel scrolls the page to it.

## Setup

```bash
bun install
cp .env.example .env    # TYPESAFE_API_KEY, OPENAI_API_KEY, GOOGLE_TOKEN_FILE (Gmail only)
bun run scripts/secrets.ts   # writes extension/secrets.js (gitignored)
bun run build                # src/rank.ts → extension/engine.js
```

For the any-page panel, leave `GOOGLE_TOKEN_FILE` unset (remove its example value from `.env`); Google credentials are only needed for full-thread Gmail reads. Still run `scripts/secrets.ts` to create the module the extension imports, even if you will enter your Jev and OpenAI keys in settings.

Then go to `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `extension/`. Jev and OpenAI keys can also be entered in the extension's settings.

## Safety

- **Gmail access is read-only.** The token is downscoped to `gmail.readonly`, and any wider token is refused. Only GET requests are made.
- **Trash goes through Gmail itself.** "Move to Trash" ticks the suggested emails and presses Gmail's own Delete button, only after a second confirming click. Gmail keeps Trash for 30 days.
- **What leaves the browser.** The side panel sends the current page's text to OpenAI only when you press Sort. The Gmail sort ideas send senders, subjects and short previews.
- **Never committed:** `.env`, `extension/secrets.js`, `owner.json` and `data/`.

## Tests

```bash
bun run test/panel.ts [yc|linkedin|all] ["sentence"]   # side panel on the demo pages (real Luna + Jev)
PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 bun run test/e2e.ts   # Gmail: mock Gmail DOM, real API + Jev
```

Both run headless Chromium with the unpacked extension. The LinkedIn demo uses a saved profile's text in `data/linkedin.txt`, because LinkedIn needs a login.

## Also in here

- `server.ts`: a Gmail-look-alike web app on localhost:8383 that mirrors your recent inbox (read-only) and sorts it. This is where the engine started.
- `ab/`: speed and accuracy experiments (all pairs vs. Swiss vs. pivot, junk-pass timing, suggestion latency).
