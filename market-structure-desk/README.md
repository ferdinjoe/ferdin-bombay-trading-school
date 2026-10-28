# Structure Desk

A zero-build web app for reading market structure the way it is taught: swing structure (higher
highs / higher lows versus lower highs / lower lows), close-weighted pivots, and volume confirmation
as a gate rather than a decoration. One page, three markets (India, United States, Singapore), plus
the major world indices, driven by live quotes.

It is used as a live class demo, so it is designed to be started by double-clicking a file, to open as
an ordinary browser tab, and to say plainly when a number is not available instead of inventing one.

---

## What it does

### Desk tab — one instrument at a time
- Canvas chart: candles, hollow candles, OHLC bars, Heikin Ashi, area, line, candles + line.
- Swing labelling on the tape: filled triangle = close-backed swing (this is what drives the trend
  label), hollow marker = wick-only probe (a level, never a trend leg), filled arrow =
  volume-confirmed acceptance, outline + `?` = unconfirmed break.
- Toggle overlays: volume, structure labels, swing levels, trendlines, Fib retracement, log scale,
  close-weighted pivots.
- Studies (`js/indicators.js`): SMA 20/50, EMA 9/200, Bollinger, ATR band as overlays; RSI 14,
  MACD 12/26/9, Stochastics as panes. Two panes is the cap on this canvas. Studies are descriptive —
  an oscillator never overrides the structure gate, and warm-up bars stay blank rather than faked.
- Verdict card: one-line read, a score out of 100, and Buy / Hold / Sell with the weighted evidence
  behind it. Signals list, event log, "unconfirmed / not tradeable" list, structure ladder, levels and
  readouts, and a data-quality panel that says which relay answered and how fresh the tape is.
- Bar replay: step backwards and forwards through history, re-running the whole engine on the truncated
  tape, so a signal can be shown exactly as it looked when it printed.
- Alerts: price above/below, or structure breakout/breakdown. Up to 20 armed at once, in-app toasts
  plus optional desktop notifications.
- Snapshot PNG, event-log CSV.
- Manual override: paste `date,open,high,low,close,volume` lines or load a CSV file, or press
  **Demo series** for a deterministic synthetic tape.

### Watchlist tab — many instruments at once
Three seeded lists — United States (8 names), India (7), Singapore (6) — each row a mini chart plus
price, change, RVOL, verdict pill, score and signals. Type tickers (comma or space separated) to add
rows, reorder or delete them, reload a single row or the whole list, and turn auto-refresh off while
talking. Rows are read by the same engine as the Desk.

### Scan tab — the same engine across every list
Ranks every name on all three watchlists by a weighted score out of ten: structure 3, trendline 2.5,
volume-confirmed break 2, reward-risk 1.5, flow 1. RSI and MACD are context and filters, never part of
the score. Filters by list, by action and by technical condition; a starred Hold means the evidence is
missing, not that the tape is neutral. Click any row for the full evidence ledger and the projection
over the next N bars.

### Books tab — fundamentals
Load statements for a whole watch list (one request per company, cached for a week), read sales and
profit, quarterly sales, ratios, and the peers on your own basket. A screener takes plain-language
queries such as `roe > 15 and debt to equity < 1 and avg roce 5years > 12`, can explain itself, save
presets, and export CSV. Private analysis notes and manual entries live on this machine.

### Ticker input — how a name becomes a chart
- Suggestions drop down as you type, from the vendored NSE listing file, everything this machine has
  already quoted, and the major indices.
- Exchange words work: `NSE:RELIANCE`, `BSE:CROPSTER`, `reliance.nse`, `^NSEI`, `500325`.
- A bare name is tried across NSE, BSE and the plain symbol, and the match that answered is remembered,
  so the second load costs one request.
- Indices answer to the names used out loud — `NIFTY`, `SENSEX`, `BANKNIFTY`, `NIFTY IT`, `SPX`,
  `NASDAQ`, `DOW JONES`, `NIKKEI`, `HANG SENG`, `STI` — and reach their own series before any scrip
  guess is tried. Names that a listed company actually owns (`DOW`, `AUTO`, `CNX`) are deliberately not
  treated as indices.
- The Market row under the toolbar loads an index tape in one click; the lit chip tracks the tape on
  screen, not the text in the box.

---

## Setup

Nothing to install, no build step, no package.json, no API key.

**Requirement:** any modern browser. Node.js is optional (only for the bundled static server and the
helper scripts).

### Option 1 — double-click the launcher (Windows)
```
market-structure-desk\Start Structure Desk.bat
```
It starts `tools/serve.js` on port 8931 and opens `http://127.0.0.1:8931/`. Leave the minimized
"Structure Desk server" window open while you use the desk; closing it stops the feed. A second
double-click is harmless — the server exits quietly if the port is taken and the browser just opens the
instance that is running. If Node is not on `PATH` the launcher falls back to opening `index.html` from
disk.

To use a different port:
```
set SD_PORT=8941
Start Structure Desk.bat
```

### Option 2 — run the server by hand
```
cd market-structure-desk
node tools/serve.js 8931
```
Open `http://127.0.0.1:8931/`. `node tools/serve.js [port] [rootDir]` — passing the repository root as
`rootDir` serves the lecture decks too.

### Option 3 — open the file directly
Double-click `index.html`. The chart tools, the offline listing file and pasted OHLCV all work; live
quotes depend on the public CORS relays, which behave better from an `http://` origin than from
`file://`.

### Optional — refresh the Indian listing universe
The suggestion dropdown is seeded from `data/nse-listed.csv`, which ships inside the app:
```
node tools/refresh-tickers.js
```
It pulls NSE's own equity file and validates it before replacing the copy on disk. US and Singapore
universes are learned from the search endpoint at run time instead; there is no bulk file for them
without a crumb.

---

## How to use it

1. Start the desk, then pick an instrument in the ticker box. `AAPL`, `RELIANCE`, `NIFTY`, `TATACHEM`,
   `D05.SI` all work; the dropdown fills in the exchange suffix so you do not have to know it.
2. Pick a window from the timeline bar — **Intraday** (1m to 90m), **Swing** (1h · 3M up to 1D · 6M),
   **Position** (1Y, 5W, 10M, Max) — or set a **Custom window** with two dates and an interval. **Back
   to live** returns to the auto-refreshing tape.
3. Read the right-hand rail: the verdict and its score, the confirmed signals, the event log, and the
   unconfirmed list. Hover the chart for a crosshair and bar readout; click a bar to focus it.
4. For a class point, press **Replay** and step bar by bar, or use the Market chips to put NIFTY beside
   the scrip being discussed.
5. Add the names you follow on the Watchlist tab, then press **Scan every list** on the Scan tab when
   you want them ranked. Use **Refresh all** on the Watchlist to refill the tape first.
6. On the Books tab choose a scope and press **Load books**. Load a list once and read it all day —
   each company is one request, cached for a week.
7. **Settings** (top right) exposes the engine dials: pivot width, close weight, swing lookback, ATR
   period, RVOL threshold, sustained bars, minimum break margin as a multiple of ATR, and the switch
   that refuses to emit a signal without volume confirmation. Feed settings cover poll and tick
   intervals, the quote base URL, the CORS proxy template and the failover chain, and there are buttons
   to forget remembered ticker matches and to reset defaults.

Every setting, list, note and alert is saved in this browser's `localStorage` under the `sd:` prefix and
stays on the machine. Nothing is uploaded.

---

## Layout

```
index.html                     the whole page
css/app.css                    one stylesheet
js/util.js                     storage, formatting, DOM helpers, toasts
js/data.js                     symbols, venues, index aliases, relay chain, chart parsing
js/tickers.js                  ticker directory, suggestion ranking, dropdown
js/analysis.js                 swing detection, structure labels, signals, scoring
js/indicators.js               SMA / EMA / RSI / MACD / Bollinger / Stoch / ATR / Fibonacci
js/chart.js                    canvas renderer, panes, replay drawing
js/watchlist.js                multi-name lists and mini charts
js/scanner.js                  cross-list ranking and evidence ledger
js/fundamentals.js             statements, ratios, screener query engine, exports
js/books.js                    Books view
js/ui.js                       wiring, timeline, live polling, alerts, settings
data/nse-listed.csv            2,618 NSE listings, vendored (offline universe for suggestions)
tools/serve.js                 optional local static server
tools/refresh-tickers.js       re-download the NSE listing file
test/                          headless harnesses, see below
```

Globals are hung off `window.SD` — `SD.U`, `SD.Data`, `SD.Tickers`, `SD.Analysis`, `SD.Ind`,
`SD.Chart`, `SD.Watch`, `SD.Scan`, `SD.Fund`, `SD.Books` — loaded as plain scripts, in that order.

---

## Data, and what is deliberately not claimed

- Quotes come from Yahoo's public chart and search endpoints. A browser cannot call them directly (no
  `Access-Control-Allow-Origin`), so requests go through free public relays with automatic failover;
  the base URL and proxy template are editable in Settings.
- The relay is rate limited. Keep the price tick at 5 seconds, avoid scanning while a tick is due, and
  expect the app to back off when a relay returns `429`. The status line and the data-quality card say
  which path answered and how old the tape is.
- If every relay fails, the Desk falls back to a synthetic tape and says so — the label reads **Demo
  tape**, and the status bar and toast both announce it. A demo tape is never presented as a quote.
- Statement lines the free feed does not carry — promoter holding, pledges, face value where missing —
  ship **empty**, with "hide empty rows" on by default. Cross-currency P/E, P/BV, EV and dividend yield
  are withheld rather than computed from mixed-currency inputs.
- A company name is only printed where this machine has actually seen one. An empty label is honest; an
  invented one ends up in a lecture.

---

## Tests

Headless, no dependencies, no network:

```
node test/ticker-harness.js        # directory, suggestion ranking, aliases, hygiene   (86)
node test/symbol-harness.js        # symbol shapes, candidate chain, venue labelling    (73)
node test/engine-harness.js        # swing detection, signals, scoring                  (91)
node test/fund-harness.js          # statements, ratios, screener parser                (109)
node test/indicator-harness.js     # indicator maths against hand-computed values       (41)
```

400 assertions, all expected to pass. `node test/feed-smoke.js [SYMBOL...]` is the optional network
smoke test — it reaches the live feed, so run it only when you want to prove routing.

For layout work the app is rendered inside a 390 px iframe and the DOM is measured, because the phone
checks cannot be made by resizing the browser window.

---

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `429` in the console, tape goes stale | The free relay is rate limiting. Stop auto-refresh, wait a minute, or set your own proxy in Settings. |
| Status reads `Demo tape` | No relay answered. Structure tools still work; the prices are synthetic. |
| A ticker will not load | Try it with its venue: `CROPSTER.BO`, `RELIANCE.NS`, `^NSEI`. Settings → *Forget remembered ticker matches* clears a wrong match the desk cached. |
| Port 8931 already in use | Another copy is running — open `http://127.0.0.1:8931/`, or `set SD_PORT=8941` and relaunch. |
| Lists, notes or settings need clearing | Delete the `sd:*` keys in the browser's `localStorage` for this origin. `file://` and `http://127.0.0.1:8931` are different origins and keep separate copies. |
| Live quotes fail from `file://` | Use the launcher or `node tools/serve.js` so the page runs on an `http://` origin. |
