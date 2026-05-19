# Blended CPA Cohort Dashboard

Long-term, multi-touch CPA analysis served as a single-page site on GitHub Pages.

> What's the **real** cost of a first click — once you count the leads
> and acquisitions that come back later through Email, Organic, No Media,
> Affiliates, and every other channel?

The dashboard ingests the output of your `ayelet_blended_cpa.sql` script,
queries it **in the browser** via DuckDB-WASM, and renders an interactive
cohort heatmap (rows = downstream Media, columns = months from the initial
lead) together with KPI cards, a cumulative-acquisition / CPA-decay chart,
and a top-cohorts table.

---

## 1 · File structure

```
.
├── index.html                    # Layout, KPI cards, filters, panels
├── app.js                        # DuckDB-WASM, queries, ECharts rendering
├── styles.css                    # Dark editorial theme (Inter + Instrument Serif)
├── data/
│   └── cohorts.parquet           # Compressed SQL output (≈0.7 MB for 212 k rows)
├── scripts/
│   └── convert.py                # xlsx / csv  →  data/cohorts.parquet
├── .github/workflows/pages.yml   # Auto-deploy on push to main
└── README.md
```

No bundler, no npm, no Node — everything is loaded from CDN
(DuckDB-WASM, ECharts, Google Fonts). You can edit any file straight in
the GitHub web UI and the next push redeploys.

---

## 2 · Refreshing the data

Each time you re-run the SQL:

1. Export the result of `SELECT * FROM #test2` from SSMS / Azure Data
   Studio as either **`.xlsx`** or, faster, **`.csv`** (UTF-8, comma
   delimited, **with NULLs kept as `NULL`** — the converter handles
   either spelling).
2. From a terminal at the repo root:

   ```bash
   python -m pip install pandas pyarrow openpyxl
   python scripts/convert.py /path/to/ayelet_blended_cpa.xlsx
   ```

3. Commit the regenerated `data/cohorts.parquet` and push.
   GitHub Pages will redeploy automatically.

You can also automate this — drop the SQL into a scheduled job that
exports the CSV, runs `convert.py`, and commits/pushes via GitHub Actions
or a Cloudflare Worker.

---

## 3 · Deploying to GitHub Pages

The first time:

1. Create a public (or private with Pages Pro) repository on GitHub.
2. Push this folder to `main`:

   ```bash
   git init
   git add .
   git commit -m "Initial dashboard"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

3. Go to **Settings → Pages → Build and deployment → Source =
   GitHub Actions**.
4. The included workflow (`.github/workflows/pages.yml`) builds and
   deploys automatically.  Your permanent URL is

   ```
   https://<you>.github.io/<repo>/
   ```

Every subsequent push to `main` redeploys.

> ⚠️ **CORS on the parquet file** — GitHub Pages serves static files with
> permissive CORS, so DuckDB-WASM can read `data/cohorts.parquet`
> directly with no proxy.

---

## 4 · Data model

The Parquet file mirrors `#test2` from your SQL, plus one
convenience column:

| Column                | Type    | Notes |
|---|---|---|
| `InitialMedia`        | string  | `Google` / `Facebook` — channel of first click. |
| `InitialCampaignID`   | int     | Campaign of first click. |
| `AggInitialLeadDate`  | date    | First day of the month of the first lead. **Cohort anchor**. |
| `Media`               | string  | Downstream channel that produced this lead/acq row (`Google`, `Facebook`, `Email_Marketing`, `Affiliates`, `No Media`, `Organic`, …). |
| `MonthBucket`         | string  | Distance from `AggInitialLeadDate`: `'<0'`, `'0'`, …, `'12'`, `'12+'`. |
| `Leads`               | int     | Leads in this Media × Bucket. |
| `Acquisitions`        | int     | Acquisitions in this Media × Bucket. |
| `Cost`                | number  | Cohort cost. **Only on the first row of each cohort**, NULL elsewhere — see below. |
| `CohortKey`           | string  | `InitialCampaignID + "|" + AggInitialLeadDate` — added by the converter; saves a concat every query. |

### Cohort definition

> A cohort = `(InitialCampaignID, AggInitialLeadDate)`, optionally faceted
> by `InitialMedia` for context.

A cohort therefore expands into many `(Media, MonthBucket)` rows.

### Cost — counted **once per cohort**

Your SQL already does the deduplication
(`CASE WHEN x.CostRow=1 THEN x.Cost ELSE NULL END`).  The dashboard
re-asserts it defensively with `MAX(Cost) PER CohortKey` so a future
edit to the SQL can't accidentally double-count.

---

## 5 · CPA logic

| Metric                      | Definition                                                                                       |
|---|---|
| **Blended CPA (headline)**  | `Σ cost (one per selected cohort) ÷ Σ acquisitions across every Media × MonthBucket in the selection`. |
| **Cell CPA (heatmap)**      | `Σ cost (one per selected cohort) ÷ acquisitions in that single Media × MonthBucket cell`.       |
| **Cumulative CPA (line)**   | At month M: `Σ cost ÷ Σ acquisitions from M0 through M`.                                         |

### Why "cell CPA" uses the full cost (option 1, not allocated)

The alternative — allocating cost across cells proportionally to their
share of acquisitions — produces a uniform CPA in every cell exactly
equal to the blended CPA. That hides timing information.

Using the full cost in the numerator answers the practical question
**"having spent $X on this cohort, what does a customer from channel Y in
month M actually cost me?"** A cell whose CPA is close to the blended
CPA is doing its share; a cell with much higher CPA is contributing few
acquisitions; a cell with lower CPA shows where the long-tail upside
lives.

> 💡 **Tip:** Cell CPA only carries clean business meaning when you've
> narrowed the filter to a single cohort or a small group of cohorts
> with related cost. Across all 22 k cohorts in the data set, cell CPA
> is dominated by total spend and is mostly noise — that's why the
> **Acquisitions** view is the default.

---

## 6 · Making the heatmap easy to read

A few choices baked into the dashboard:

* **Two-dimensional encoding.** Rows are sorted with preferred channels
  (Google → Facebook → other paid → Email → Organic → No Media) at the
  top so the eye reads sources of high downstream value first; columns
  step linearly from M0 to 12+.
* **P95 colour cap.** A single huge cell (typically `Google M0` in a
  large selection) would crush the scale and turn every other cell
  black. We cap the gradient at the 95th-percentile non-zero value so
  the long tail remains visible. Top cells still get the brightest hue
  via clipping.
* **Per-cell label colour.** Each cell stores a baked-in light/dark
  label colour based on its normalised value, so numbers stay legible on
  both dark and bright cells.
* **Compact numbers.** `1,200 → 1.2k`, `1,200,000 → $1.2M`.
* **Three metric toggles** (Acquisitions / Leads / CPA) plus a clear
  methodology accordion sit right next to the chart, so anyone in your
  team can read the legend without leaving the page.
* **Always-on tooltip** shows leads, acquisitions, and cell CPA for the
  hovered cell together — no need to switch tabs.

---

## 7 · Interactivity

* **Click any heatmap cell** → opens a drill-in modal listing the top 100 contributing cohorts for that Media × MonthBucket with leads, acquisitions, and per-cell CPA.
* **Click any row in the cohort table** → narrows every panel down to that single cohort (Initial Media + Campaign + Lead Month).
* **Sortable columns** — click any header in the cohort table to toggle asc / desc.
* **Active filters** appear as chips above the heatmap. Click × on a chip to remove it, or **Clear all** to reset.
* **Shareable URLs** — every filter and the current metric mode are encoded in the URL. Hit **Copy view link** in the header to copy the current view to your clipboard.
* **Fullscreen heatmap** — the maximize icon next to the metric toggle expands the heatmap to the full viewport. Press **Esc** or click it again to exit.
* **Keyboard shortcuts** — `/` focuses the campaign search, `Esc` closes the drill-in modal or exits fullscreen.

---

## 8 · Suggested SQL tweaks

These are optional but make the file cleaner for analytics tools:

1. **Replace `'NULL'` strings with real NULLs.** When you copy from SSMS
   the literal text `NULL` gets pasted. The converter handles it, but if
   you export to CSV directly use SQLCMD or
   `bcp` so empty cells stay empty.

2. **Add an `Organic` row** if your DB has it — the dashboard already
   has it in its preferred-order list.

3. **Optional: add a `<0` filter.**  The dashboard already keeps `<0`
   in the heatmap when present, but if `MonthBucket = '<0'` rows are
   not useful for blended-CPA analysis you can drop them at SQL time:

   ```sql
   AND MonthBucket <> '<0'
   ```

4. **Convenience column.** If you maintain the SQL directly, add the
   cohort key once at SQL time:

   ```sql
   CONCAT(x.InitialCampaignID, '|', x.AggInitialLeadDate) AS CohortKey
   ```

   then the converter can stop synthesising it.

5. **Pre-aggregate.**  212 k rows compress to 0.7 MB and load
   instantly. If the table grows past ~5 M rows, swap the
   `read_parquet` call in `app.js` for a remote DuckDB query against a
   `.parquet` hosted on Cloudflare R2 — DuckDB-WASM can stream
   Parquet row-groups via HTTP range requests.

---

## 9 · Local preview

```bash
# from the repo root
python -m http.server 8000
open http://localhost:8000
```

The dashboard works fully offline once loaded
(except for the CDN-hosted DuckDB-WASM bundle, which is cached after the
first visit).

---

## 10 · Tech stack

| Concern                 | Tool                                              |
|---|---|
| In-browser SQL          | [`@duckdb/duckdb-wasm`](https://duckdb.org/docs/api/wasm/overview.html) |
| Charts                  | [`ECharts 5`](https://echarts.apache.org/)        |
| Compression             | Apache Parquet + zstd                             |
| Hosting                 | GitHub Pages + GitHub Actions                     |
| Typography              | Inter, Instrument Serif, JetBrains Mono (Google)  |

---

## 11 · Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Loading cohort data…" never finishes | `data/cohorts.parquet` missing — re-run `convert.py`. |
| Filter looks ignored | Hard-refresh (`Cmd-Shift-R`) — the parquet file is cached. |
| Numbers don't match SQL | Re-run `convert.py` on the latest SQL export. The Cost in the dataset is per cohort, not per row; the dashboard sums `MAX(Cost) PER CohortKey`. |
| KPI = 0 / NaN | Selection contains no rows. Click **Reset** to clear filters. |
