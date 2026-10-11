# Shortlist: sort anything by a sentence

A Chrome extension that ranks whatever you're looking at by a sentence you type, using pairwise judgments from the [Typesafe](https://typesafe.ai) API.

- **Any page (side panel).** Click the toolbar icon and type what matters, e.g. "how big the vulnerability was". A fast OpenAI model reads the page and pulls out just the things worth ranking, and they're ranked live as they arrive.
- **Gmail (in place).** A **Sort** button sits next to "Inbox" and ranks the 50 emails on screen, reading the full threads through the Gmail API. It reorders Gmail's own rows into sections and flags what's safe to trash.

## Demos

| Page | Sentence | What happens |
|---|---|---|
| [ycombinator.com/security](https://www.ycombinator.com/security) | how big the vulnerability was | 16 disclosed findings, about 55 comparisons: 0.9s after Sort, $0.001 |
| A Hacker News thread | most useful | 116 comments, about 570 comparisons: 3.9s after Sort, $0.014 |
| Gmail inbox | what matters most to me | 50 emails, pre-sorted in the background, so the click is instant |
| A LinkedIn profile | most impressive achievement, on merit | About 20 achievements pulled from the profile: 0.9s after Sort |

Times are with the page already read ahead for that sentence (the panel was open before you picked it). Starting cold adds the page read, about 3s for a short page and 6–8s for a long thread, because ranking runs during it.

## How the ranking works

1. **Read ahead** (side panel only). When the panel shows a page, its text is split into numbered lines and long pages into parts. The model reads the parts in parallel and streams back one JSON line per item, pointing at the item's lines instead of copying them, so the text shown is the page's own. It skips navigation, ads and "people also viewed". The sentence decides what the items are ("most useful" on a profile ranks accomplishments, "most useful person" ranks people), so every Sort reads the page fresh. The read-ahead covers the page's first starter sentence.
2. **Rank while items arrive.** Ranking starts with the second item; there are no rounds. Whenever an item is free, it plays the opponent the current Bradley–Terry fit is least sure about, maximizing p(1−p)·(1/gₐ + 1/g_b). A new item starts mid-scale, so its first games place it the way a binary search would. Each game is one question: "which ranks higher by this sentence?". A and B are swapped at random so position bias averages out, and every answer is a probability (a soft win). Each item plays about ⌈log₂ n⌉ + 2 games, at most two at a time. When the last item is in, the top 6 also play any neighbour they haven't met.
3. **Bradley–Terry fit** over all the games gives the order, re-fit every 250ms while it runs.

`ab/live.ts` compares this with Swiss rounds on the same number of calls: 116 items rank in 1.4–2.1s instead of 2.2–2.6s, with Kendall τ 0.87 instead of 0.65.

Gmail uses Swiss rounds seeded by a triage read of every email, plus a top-12 round robin at the end. It also asks a per-email "safe to trash?" question. The other A/B scripts in `ab/` measure that against all-pairs ranking: τ ≈ 0.9 and NDCG ≈ 0.99.

Clicking a result in the panel scrolls the page to it.

## Setup

```bash
bun install
cp .env.example .env    # TYPESAFE_API_KEY, OPENAI_API_KEY, GOOGLE_TOKEN_FILE (Gmail only)
bun run scripts/secrets.ts   # writes extension/secrets.js (gitignored)
bun run build                # src/rank.ts → extension/engine.js
```

Then go to `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `extension/`. Keys can also be entered in the extension's settings instead of `secrets.js`.

## Safety

- **Gmail access is read-only.** The token is downscoped to `gmail.readonly`, and any wider token is refused. Only GET requests are made.
- **Trash goes through Gmail itself.** "Move to Trash" ticks the suggested emails and presses Gmail's own Delete button, only after a second confirming click. Gmail keeps Trash for 30 days.
- **What leaves the browser.** While the side panel is open, it sends the text of the page it shows to OpenAI, to read it ahead. It never does this on Gmail, and never with the panel closed. Items are sent to the ranking API only when you press Sort. The Gmail sort ideas send senders, subjects and short previews.
- **Never committed:** `.env`, `extension/secrets.js`, `owner.json` and `data/`.

## Tests

```bash
bun run test/panel.ts [yc|linkedin|hn|all] ["sentence"] [--ahead]   # side panel on the demo pages (real APIs)
PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 bun run test/e2e.ts   # Gmail: mock Gmail DOM, real APIs
```

Both run headless Chromium with the unpacked extension. The LinkedIn demo uses a saved profile's text in `data/linkedin.txt`, because LinkedIn needs a login.

## Also in here

- `server.ts`: a Gmail-look-alike web app on localhost:8383 that mirrors your recent inbox (read-only) and sorts it. This is where the engine started.
- `ab/`: speed and accuracy experiments (live vs. Swiss, all pairs vs. Swiss vs. pivot, junk-pass timing, suggestion latency).
