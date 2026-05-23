/* =============================================================
   Blended CPA Cohort Dashboard
   - DuckDB-WASM for in-browser SQL over data/cohorts.parquet
   - ECharts for heatmap + cumulative chart
   ============================================================= */

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------
const MONTH_ORDER = [
  "<0",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "12+",
];

const MEDIA_PREFERRED_ORDER = [
  "Google",
  "Facebook",
  "PPC Other",
  "Affiliates",
  "Email_Marketing",
  "Web Campaign",
  "Business Coop",
  "Community",
  "Organic",
  "No Media",
];

const fmtInt = new Intl.NumberFormat("en-US");
const fmtMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const fmtMoney2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const state = {
  db: null,
  conn: null,
  ready: false,
  filters: {
    initialMedia: [],     // empty = all
    campaigns: [],        // empty = all
    dateFrom: null,
    dateTo: null,
  },
  metric: "acq",          // 'acq' | 'leads' | 'cpa'
  totals: null,
  campaignList: [],
  heatmap: null,
  cumchart: null,
  sort: { key: "acq", dir: "desc" },
  lastTableRows: [],
  vmetric: "cpa",            // vintage line: cpa | acq | leads | cost
  vsplit: "all",              // vintage line: all | media
  yhmetric: "cpa",            // vintage heatmap: cpa | acq | leads
  vintagechart: null,
  vintageheatmap: null,
  modalSpark: null,
  yearList: [],               // [{year, cohorts, leads, acq, cost, cpa}]
  selectedYear: null,         // currently filtered year (number) or null
  pinnedYears: [],            // for compare mode
  compareMode: false,
  density: "comfortable",
  theme: "dark",
  rowNormalize: false,
};

// ---------------------------------------------------------------
// DuckDB bootstrap
// ---------------------------------------------------------------
async function initDuckDB() {
  setStatus("Loading SQL engine");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: "text/javascript",
    })
  );
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);

  setStatus("Loading cohort data");
  const dataUrl = new URL("data/cohorts.parquet", window.location.href).href;
  // DuckDB-WASM can register an HTTP URL as a virtual file
  await db.registerFileURL(
    "cohorts.parquet",
    dataUrl,
    duckdb.DuckDBDataProtocol.HTTP,
    false
  );

  const conn = await db.connect();
  // Create a view so every other query stays terse
  await conn.query(`
    CREATE OR REPLACE VIEW cohorts AS
      SELECT
        InitialMedia,
        InitialCampaignID,
        CAST(AggInitialLeadDate AS DATE) AS AggInitialLeadDate,
        Media,
        MonthBucket,
        Leads,
        Acquisitions,
        Cost,
        CohortKey
      FROM read_parquet('cohorts.parquet')
  `);

  state.db = db;
  state.conn = conn;
  state.ready = true;
}

// Run a query, return Array<Object>
async function q(sql, params = []) {
  const stmt = await state.conn.prepare(sql);
  try {
    const result = await stmt.query(...params);
    return result.toArray().map((r) => {
      const o = r.toJSON();
      // Convert any BigInt to Number for downstream chart libs
      for (const k of Object.keys(o)) {
        if (typeof o[k] === "bigint") o[k] = Number(o[k]);
      }
      return o;
    });
  } finally {
    await stmt.close();
  }
}

// ---------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------
function whereClause() {
  const parts = ["1=1"];
  const params = [];
  if (state.filters.initialMedia.length) {
    const ph = state.filters.initialMedia.map(() => "?").join(",");
    parts.push(`InitialMedia IN (${ph})`);
    params.push(...state.filters.initialMedia);
  }
  if (state.filters.campaigns.length) {
    const ph = state.filters.campaigns.map(() => "?").join(",");
    parts.push(`InitialCampaignID IN (${ph})`);
    params.push(...state.filters.campaigns.map((c) => Number(c)));
  }
  if (state.filters.dateFrom) {
    parts.push("AggInitialLeadDate >= CAST(? AS DATE)");
    params.push(state.filters.dateFrom);
  }
  if (state.filters.dateTo) {
    parts.push("AggInitialLeadDate <= CAST(? AS DATE)");
    params.push(state.filters.dateTo);
  }
  return { sql: parts.join(" AND "), params };
}

// ---------------------------------------------------------------
// Initial metadata for filters & header
// ---------------------------------------------------------------
async function loadMeta() {
  const [rows] = await q(`
    SELECT COUNT(*) AS rows,
           COUNT(DISTINCT CohortKey) AS cohorts,
           MIN(AggInitialLeadDate) AS dmin,
           MAX(AggInitialLeadDate) AS dmax
    FROM cohorts
  `);

  document.getElementById("meta-rows").textContent = fmtInt.format(rows.rows);
  document.getElementById("meta-cohorts").textContent = fmtInt.format(
    rows.cohorts
  );
  const dmin = formatYM(rows.dmin);
  const dmax = formatYM(rows.dmax);
  document.getElementById("meta-range").textContent = `${dmin} → ${dmax}`;

  // populate date inputs as YYYY-MM
  document.getElementById("f-date-from").min = dmin;
  document.getElementById("f-date-to").max = dmax;

  // initial-media options
  const ims = await q(
    "SELECT DISTINCT InitialMedia FROM cohorts ORDER BY 1"
  );
  const selIM = document.getElementById("f-initial-media");
  selIM.innerHTML = ims
    .map((r) => `<option value="${r.InitialMedia}">${r.InitialMedia}</option>`)
    .join("");

  // campaigns
  state.campaignList = (
    await q(
      `SELECT InitialCampaignID AS id, COUNT(*) AS n
         FROM cohorts
        GROUP BY 1
        ORDER BY n DESC`
    )
  ).map((r) => ({ id: r.id, n: r.n }));
  renderCampaignOptions("");
}

function renderCampaignOptions(query) {
  const sel = document.getElementById("f-campaign");
  const q = String(query || "").trim().toLowerCase();
  const filtered = q
    ? state.campaignList.filter((c) => String(c.id).includes(q))
    : state.campaignList;
  // Keep selected ones at the top so users don't lose track
  const selected = new Set(state.filters.campaigns.map(String));
  const head = filtered.filter((c) => selected.has(String(c.id)));
  const tail = filtered.filter((c) => !selected.has(String(c.id)));
  const display = [...head, ...tail].slice(0, 500);
  sel.innerHTML = display
    .map(
      (c) =>
        `<option value="${c.id}"${selected.has(String(c.id)) ? " selected" : ""
        }>#${c.id} · ${fmtInt.format(c.n)} rows</option>`
    )
    .join("");
}

// ---------------------------------------------------------------
// Theme-aware chart palette (reads live CSS variables)
// ---------------------------------------------------------------
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const isLight = document.documentElement.dataset.theme === "light";
  return {
    fg: v("--text", "#e8ece9"),
    muted: v("--text-muted", "#97a39b"),
    faint: v("--text-faint", "#5e6d65"),
    line: v("--surface-3", "#3a4842"),
    grid: v("--surface-2", "#1c241f"),
    surface: v("--surface", "#161c19"),
    tooltipBg: isLight ? "rgba(255,255,255,0.98)" : "rgba(22,28,25,0.96)",
    // On light bg use a soft dark border so heatmap cells are separated; on dark bg use the existing near-black
    cellBorder: isLight ? "rgba(26,31,28,0.18)" : "rgba(15,20,17,0.75)",
    // A darker low-end of the heatmap ramp for light mode so light cells aren't invisible
    heatmapRampSeq: isLight
      ? ["#e6e2d6", "#9fd0d7", "#4f98a3", "#20808d", "#1d595e", "#15403f"]
      : ["#1d2a26", "#1d595e", "#20808d", "#4f98a3", "#9fd0d7", "#e8f5f6"],
    heatmapRampCPA: isLight
      ? ["#15403f", "#20808d", "#4f98a3", "#e8af34", "#c46546"]
      : ["#20808d", "#4f98a3", "#bce2e7", "#e8af34", "#c46546"],
    isLight,
  };
}

// Returns a readable text color (black or white) for a given hex fill
function readableOn(hex) {
  if (!hex || typeof hex !== "string") return "#e8ece9";
  const m = hex.replace("#", "");
  if (m.length !== 6) return "#e8ece9";
  const r = parseInt(m.slice(0, 2), 16),
        g = parseInt(m.slice(2, 4), 16),
        b = parseInt(m.slice(4, 6), 16);
  // Relative luminance
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.6 ? "#1a1f1c" : "#f4f6f4";
}

// ---------------------------------------------------------------
// Main refresh — recompute KPIs + charts under current filters
// ---------------------------------------------------------------
async function refresh() {
  const { sql: where, params } = whereClause();

  // ── Totals: cost summed ONCE per cohort (max Cost per cohort because
  // SQL emitted cost on the first row of each cohort and NULL elsewhere)
  const [tot] = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts WHERE ${where}
    ),
    cost_per_cohort AS (
      SELECT CohortKey, MAX(Cost) AS cost
      FROM base
      GROUP BY CohortKey
    ),
    sums AS (
      SELECT
        SUM(Leads)        AS total_leads,
        SUM(Acquisitions) AS total_acq,
        SUM(CASE WHEN MonthBucket = '0'                       THEN Acquisitions END) AS acq0,
        SUM(CASE WHEN MonthBucket IN ('0','1','2','3')        THEN Acquisitions END) AS acq3,
        SUM(CASE WHEN MonthBucket IN ('0','1','2','3','4','5','6') THEN Acquisitions END) AS acq6,
        SUM(CASE WHEN MonthBucket IN ('0','1','2','3','4','5','6','7','8','9','10','11','12') THEN Acquisitions END) AS acq12
      FROM base
    )
    SELECT
      (SELECT SUM(cost) FROM cost_per_cohort) AS total_cost,
      sums.*
    FROM sums
    `,
    params
  );

  state.totals = tot;
  paintKPIs(tot);

  // ── Heatmap data: Media × MonthBucket
  const heat = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts WHERE ${where}
    ),
    cost_per_cohort AS (
      SELECT CohortKey, MAX(Cost) AS cost
      FROM base
      GROUP BY CohortKey
    ),
    total_cost AS ( SELECT COALESCE(SUM(cost),0) AS c FROM cost_per_cohort )
    SELECT
      Media,
      MonthBucket,
      SUM(Leads)        AS leads,
      SUM(Acquisitions) AS acq,
      (SELECT c FROM total_cost) AS total_cost
    FROM base
    GROUP BY Media, MonthBucket
    `,
    params
  );
  paintHeatmap(heat);

  // ── Cumulative acquisitions by integer month-bucket (drop '<0' and '12+'
  // for the line/area to keep the X axis linear)
  const cum = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts WHERE ${where}
        AND MonthBucket NOT IN ('<0','12+')
    ),
    cost_per_cohort AS (
      SELECT CohortKey, MAX(Cost) AS cost
      FROM base
      GROUP BY CohortKey
    )
    SELECT
      CAST(MonthBucket AS INTEGER) AS m,
      SUM(Acquisitions) AS acq,
      (SELECT COALESCE(SUM(cost),0) FROM cost_per_cohort) AS total_cost
    FROM base
    GROUP BY 1
    ORDER BY 1
    `,
    params
  );
  paintCumChart(cum);

  // ── Cohort table — top by acquisitions
  const cohorts = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts WHERE ${where}
    ),
    per_cohort AS (
      SELECT
        InitialMedia,
        InitialCampaignID,
        AggInitialLeadDate,
        SUM(Leads)        AS leads,
        SUM(Acquisitions) AS acq,
        MAX(Cost)         AS cost
      FROM base
      GROUP BY InitialMedia, InitialCampaignID, AggInitialLeadDate
    )
    SELECT * FROM per_cohort
    ORDER BY acq DESC NULLS LAST, cost DESC NULLS LAST
    LIMIT 200
    `,
    params
  );
  state.lastTableRows = cohorts;
  paintTable();
  renderChips();
  renderBreadcrumbs();
  writeUrlState();

  // ── v2: vintage analyses run in parallel ──
  await Promise.all([
    refreshVintageStrip(where, params),
    refreshVintageChart(where, params),
    refreshVintageHeatmap(where, params),
  ]);
}

// ---------------------------------------------------------------
// v2: Vintage year strip
// ---------------------------------------------------------------
async function refreshVintageStrip(where, params) {
  const rows = await q(
    `
    WITH base AS ( SELECT * FROM cohorts WHERE ${where} ),
    cost_per_cohort AS (
      SELECT CohortKey, EXTRACT(YEAR FROM AggInitialLeadDate) AS y, MAX(Cost) AS cost
      FROM base GROUP BY CohortKey, y
    ),
    base_y AS (
      SELECT EXTRACT(YEAR FROM AggInitialLeadDate) AS y,
             SUM(Leads) AS leads, SUM(Acquisitions) AS acq
      FROM base GROUP BY y
    ),
    cost_y AS (
      SELECT y, SUM(cost) AS cost, COUNT(*) AS cohorts FROM cost_per_cohort GROUP BY y
    )
    SELECT b.y AS year, b.leads, b.acq, c.cost, c.cohorts
    FROM base_y b LEFT JOIN cost_y c USING(y)
    ORDER BY b.y
    `,
    params
  );
  state.yearList = rows.map((r) => ({
    year: Number(r.year),
    leads: Number(r.leads || 0),
    acq: Number(r.acq || 0),
    cost: Number(r.cost || 0),
    cohorts: Number(r.cohorts || 0),
    cpa: Number(r.acq || 0) > 0 ? Number(r.cost || 0) / Number(r.acq) : null,
  }));
  paintYearStrip();
}

function paintYearStrip() {
  const wrap = document.getElementById("year-strip");
  if (!state.yearList.length) {
    wrap.innerHTML = `<div class="muted" style="color:var(--text-muted);font-size:12px">No cohorts in current filter</div>`;
    return;
  }
  const maxAcq = Math.max(...state.yearList.map((y) => y.acq || 0)) || 1;
  wrap.innerHTML = state.yearList
    .map((y) => {
      const isActive = state.selectedYear === y.year;
      const isPinned = state.pinnedYears.includes(y.year);
      const cls = ["year-chip"];
      if (isActive) cls.push("active");
      if (isPinned) cls.push("pinned");
      const widthPct = Math.max(4, Math.round((y.acq / maxAcq) * 100));
      const cpaTxt = y.cpa == null ? "—" : fmtMoney.format(Math.round(y.cpa));
      return `
        <button class="${cls.join(" ")}" data-year="${y.year}" title="${y.cohorts} cohorts · ${fmtInt.format(y.acq)} acq · CPA ${cpaTxt}">
          <span class="year-chip-year">${y.year}</span>
          <span class="year-chip-meta">${fmtInt.format(y.acq)} acq · ${cpaTxt}</span>
          <span class="year-chip-bar" style="width:${widthPct}%"></span>
        </button>
      `;
    })
    .join("");
  wrap.querySelectorAll(".year-chip").forEach((el) => {
    el.addEventListener("click", (e) => {
      const yr = Number(el.dataset.year);
      if (state.compareMode) {
        const idx = state.pinnedYears.indexOf(yr);
        if (idx >= 0) state.pinnedYears.splice(idx, 1);
        else {
          state.pinnedYears.push(yr);
          if (state.pinnedYears.length > 2) state.pinnedYears.shift();
        }
        paintYearStrip();
        refreshVintageChart(...whereTuple());
      } else {
        // toggle single-year filter
        if (state.selectedYear === yr) {
          state.selectedYear = null;
          state.filters.dateFrom = null;
          state.filters.dateTo = null;
          document.getElementById("f-date-from").value = "";
          document.getElementById("f-date-to").value = "";
        } else {
          state.selectedYear = yr;
          state.filters.dateFrom = `${yr}-01-01`;
          state.filters.dateTo = `${yr}-12-01`;
          document.getElementById("f-date-from").value = `${yr}-01`;
          document.getElementById("f-date-to").value = `${yr}-12`;
        }
        document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
        refresh();
      }
    });
  });
}

function whereTuple() {
  const w = whereClause();
  return [w.sql, w.params];
}

// ---------------------------------------------------------------
// v2: Vintage trend line chart
// ---------------------------------------------------------------
async function refreshVintageChart(where, params) {
  const wantsSplit = state.vsplit === "media";
  const groupCols = wantsSplit ? "AggInitialLeadDate, InitialMedia" : "AggInitialLeadDate";
  const selectCols = wantsSplit
    ? "AggInitialLeadDate AS d, InitialMedia AS series"
    : "AggInitialLeadDate AS d, 'All' AS series";
  // When compare mode + pinned years, ignore date filter, restrict to pinned years
  let extra = "";
  const extraParams = [];
  if (state.compareMode && state.pinnedYears.length) {
    extra = ` AND EXTRACT(YEAR FROM AggInitialLeadDate) IN (${state.pinnedYears.map(() => "?").join(",")}) `;
    extraParams.push(...state.pinnedYears);
  }
  const rows = await q(
    `
    WITH base AS ( SELECT * FROM cohorts WHERE ${where} ${extra} ),
    cost_per_cohort AS (
      SELECT CohortKey, AggInitialLeadDate, InitialMedia, MAX(Cost) AS cost
      FROM base GROUP BY CohortKey, AggInitialLeadDate, InitialMedia
    ),
    leads_acq AS (
      SELECT ${selectCols}, SUM(Leads) AS leads, SUM(Acquisitions) AS acq
      FROM base GROUP BY ${groupCols}
    ),
    costs AS (
      SELECT AggInitialLeadDate AS d, ${wantsSplit ? "InitialMedia AS series," : "'All' AS series,"}
             SUM(cost) AS cost
      FROM cost_per_cohort GROUP BY AggInitialLeadDate${wantsSplit ? ", InitialMedia" : ""}
    )
    SELECT la.d AS d, la.series AS series, la.leads, la.acq, COALESCE(c.cost, 0) AS cost
    FROM leads_acq la LEFT JOIN costs c ON la.d = c.d AND la.series = c.series
    ORDER BY la.d
    `,
    [...params, ...extraParams]
  );
  paintVintageChart(rows);
}

function paintVintageChart(rows) {
  const el = document.getElementById("vintagechart");
  if (!state.vintagechart) state.vintagechart = echarts.init(el, null, { renderer: "canvas" });

  // Group by series
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series)) bySeries.set(r.series, []);
    bySeries.get(r.series).push(r);
  }
  const series = [];
  const palette = ["#4f98a3", "#e8af34", "#c46546", "#9fd0d7", "#76a09a", "#d1a05c", "#8c6f5a", "#bce2e7", "#5e7d77", "#a07d52"];
  let i = 0;
  for (const [name, arr] of bySeries) {
    arr.sort((a, b) => new Date(a.d) - new Date(b.d));
    const data = arr.map((r) => {
      const d = (typeof r.d === "string" ? r.d : new Date(r.d).toISOString()).slice(0, 10);
      let v;
      const acq = Number(r.acq || 0);
      const leads = Number(r.leads || 0);
      const cost = Number(r.cost || 0);
      if (state.vmetric === "cpa") v = acq > 0 ? cost / acq : null;
      else if (state.vmetric === "acq") v = acq;
      else if (state.vmetric === "leads") v = leads;
      else v = cost;
      return [d, v];
    });
    series.push({
      name,
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      showSymbol: arr.length < 60,
      data,
      itemStyle: { color: palette[i % palette.length] },
      lineStyle: { width: 2 },
      areaStyle: bySeries.size === 1 ? { opacity: 0.12 } : undefined,
      connectNulls: false,
      emphasis: { focus: "series" },
    });
    i++;
  }

  const isCPA = state.vmetric === "cpa";
  const fmt = (v) => {
    if (v == null) return "—";
    if (isCPA || state.vmetric === "cost") return fmtMoney.format(Math.round(v));
    return fmtInt.format(Math.round(v));
  };

  state.vintagechart.setOption(
    {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: themeColors().tooltipBg,
        borderColor: "#3a4842",
        backgroundColor: themeColors().tooltipBg,
        borderColor: themeColors().line,
        textStyle: { color: themeColors().fg, fontFamily: "Inter" },
        formatter: (params) => {
          if (!params?.length) return "";
          const lines = params
            .filter((p) => p.value && p.value[1] != null)
            .sort((a, b) => (b.value[1] || 0) - (a.value[1] || 0))
            .map(
              (p) =>
                `<div style="display:flex;justify-content:space-between;gap:18px"><span>${p.marker} ${escapeHTML(p.seriesName)}</span><b>${fmt(p.value[1])}</b></div>`
            )
            .join("");
          return `<div style="font-size:12px"><div style="font-weight:600;margin-bottom:6px">${params[0].axisValueLabel}</div>${lines}</div>`;
        },
      },
      legend: bySeries.size > 1
        ? {
            top: 0,
            right: 0,
            textStyle: { color: themeColors().muted, fontFamily: "Inter", fontSize: 11 },
            icon: "roundRect",
          }
        : { show: false },
      grid: { left: 70, right: 24, top: 36, bottom: 60 },
      dataZoom: [
        { type: "inside", throttle: 50 },
        {
          type: "slider",
          height: 18,
          bottom: 16,
          backgroundColor: "#161c19",
          fillerColor: "rgba(79,152,163,0.18)",
          borderColor: "#2a342d",
          handleStyle: { color: "#4f98a3" },
          textStyle: { color: themeColors().muted, fontSize: 10 },
        },
      ],
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: themeColors().line } },
        axisLabel: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        axisLine: { lineStyle: { color: themeColors().line } },
        axisLabel: { color: themeColors().muted,
          fontFamily: "JetBrains Mono",
          fontSize: 11,
          formatter: (v) => {
            if (isCPA || state.vmetric === "cost") return `$${v >= 1000 ? Math.round(v / 100) / 10 + "k" : Math.round(v)}`;
            if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
            return v;
          },
        },
        splitLine: { lineStyle: { color: themeColors().grid } },
      },
      series,
    },
    true
  );
  if (!state._vcBound) {
    window.addEventListener("resize", () => state.vintagechart?.resize());
    state._vcBound = true;
  }
}

// ---------------------------------------------------------------
// v2: Vintage maturation heatmap (Year x MonthBucket)
// ---------------------------------------------------------------
async function refreshVintageHeatmap(where, params) {
  const rows = await q(
    `
    WITH base AS ( SELECT * FROM cohorts WHERE ${where} ),
    cost_per_cohort AS (
      SELECT CohortKey, EXTRACT(YEAR FROM AggInitialLeadDate) AS y, MAX(Cost) AS cost
      FROM base GROUP BY CohortKey, y
    ),
    cost_by_year AS (
      SELECT y, SUM(cost) AS cost FROM cost_per_cohort GROUP BY y
    ),
    cells AS (
      SELECT EXTRACT(YEAR FROM AggInitialLeadDate) AS y,
             MonthBucket AS b,
             SUM(Leads) AS leads, SUM(Acquisitions) AS acq
      FROM base GROUP BY y, MonthBucket
    )
    SELECT c.y AS year, c.b AS bucket, c.leads, c.acq, COALESCE(cy.cost, 0) AS year_cost
    FROM cells c LEFT JOIN cost_by_year cy ON c.y = cy.y
    `,
    params
  );
  paintVintageHeatmap(rows);
}

function paintVintageHeatmap(rows) {
  const el = document.getElementById("vintageheatmap");
  if (!state.vintageheatmap) state.vintageheatmap = echarts.init(el, null, { renderer: "canvas" });

  const yearsSet = new Set();
  const bucketsSet = new Set();
  for (const r of rows) {
    yearsSet.add(Number(r.year));
    bucketsSet.add(r.bucket);
  }
  const years = Array.from(yearsSet).sort((a, b) => a - b);
  const buckets = Array.from(bucketsSet).sort(
    (a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b)
  );

  const lookup = new Map();
  for (const r of rows) {
    lookup.set(`${Number(r.year)}|${r.bucket}`, {
      leads: Number(r.leads || 0),
      acq: Number(r.acq || 0),
      yearCost: Number(r.year_cost || 0),
    });
  }

  const positives = [];
  const cells = [];
  for (let y = 0; y < years.length; y++) {
    for (let x = 0; x < buckets.length; x++) {
      const c = lookup.get(`${years[y]}|${buckets[x]}`) || { leads: 0, acq: 0, yearCost: 0 };
      let v;
      if (state.yhmetric === "leads") v = c.leads;
      else if (state.yhmetric === "acq") v = c.acq;
      else v = c.acq > 0 ? c.yearCost / c.acq : null;
      cells.push({ x, y, v, c, year: years[y], bucket: buckets[x] });
      if (typeof v === "number" && isFinite(v) && v > 0) positives.push(v);
    }
  }
  const sorted = positives.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(0.95 * sorted.length)] : 1;
  const vmin = sorted.length ? sorted[0] : 0;

  const data = cells.map(({ x, y, v, c }) => {
    const t = v == null || !isFinite(v) ? 0 : Math.min(1, v / (p95 || 1));
    const labelColor = readableOn(c);
    return [x, y, v, c, labelColor];
  });

  const isCPA = state.yhmetric === "cpa";
  const visualMap = isCPA
    ? { min: vmin, max: p95, inRange: { color: themeColors().heatmapRampCPA } }
    : { min: 0, max: p95, inRange: { color: themeColors().heatmapRampSeq } };

  state.vintageheatmap.setOption(
    {
      backgroundColor: "transparent",
      tooltip: {
        backgroundColor: themeColors().tooltipBg,
        borderColor: "#3a4842",
        textStyle: { color: themeColors().fg, fontFamily: "Inter" },
        formatter: (p) => {
          const c = p.data[3];
          const year = years[p.value[1]];
          const bucket = buckets[p.value[0]];
          const cpa = c.acq > 0 ? c.yearCost / c.acq : null;
          return `
            <div style="font-size:12px;line-height:1.5">
              <div style="font-weight:600;margin-bottom:6px">Vintage ${year} · month ${escapeHTML(bucket)}</div>
              <div>Leads&nbsp;&nbsp;&nbsp;<b>${fmtInt.format(c.leads)}</b></div>
              <div>Acquisitions&nbsp;<b>${fmtInt.format(c.acq)}</b></div>
              <div>Cell CPA&nbsp;&nbsp;<b>${cpa == null ? "—" : fmtMoney.format(Math.round(cpa))}</b></div>
              <div style="margin-top:6px;color:#97a39b;font-size:11px">Year cost: ${fmtMoney.format(Math.round(c.yearCost))}</div>
            </div>`;
        },
      },
      grid: { left: 70, right: 30, top: 18, bottom: 60 },
      xAxis: {
        type: "category",
        data: buckets.map((b) => (b === "12+" ? "12+" : b === "<0" ? "<0" : `M${b}`)),
        axisLine: { lineStyle: { color: themeColors().line } },
        axisLabel: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
        name: "Months from initial lead",
        nameLocation: "middle",
        nameGap: 36,
        nameTextStyle: { color: themeColors().faint, fontSize: 11 },
      },
      yAxis: {
        type: "category",
        data: years,
        axisLine: { lineStyle: { color: themeColors().line } },
        axisLabel: { color: themeColors().fg, fontFamily: "JetBrains Mono", fontSize: 12 },
      },
      visualMap: {
        ...visualMap,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 4,
        itemWidth: 14,
        itemHeight: 220,
        text: [isCPA ? "higher CPA" : "more", isCPA ? "lower CPA" : "fewer"],
        textStyle: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
        formatter: (v) => (isCPA ? fmtMoney.format(Math.round(v || 0)) : fmtInt.format(Math.round(v || 0))),
      },
      series: [
        {
          type: "heatmap",
          data,
          label: {
            show: true,
            fontFamily: "JetBrains Mono",
            fontSize: 10,
            color: (p) => p.data?.[4] || themeColors().fg,
            formatter: (p) => {
              const v = p.data[2];
              if (v == null || v === 0) return "";
              if (isCPA) return v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${Math.round(v)}`;
              if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
              return String(v);
            },
          },
          itemStyle: { borderColor: themeColors().cellBorder, borderWidth: 1 },
          emphasis: {
            itemStyle: { shadowBlur: 12, shadowColor: "rgba(232,175,52,0.55)", borderColor: "#e8ece9", borderWidth: 1 },
          },
        },
      ],
    },
    true
  );

  if (!state._vhBound) {
    window.addEventListener("resize", () => state.vintageheatmap?.resize());
    state._vhBound = true;
  }

  // Click → drill into vintage × bucket
  if (!state._vhClickBound) {
    state.vintageheatmap.on("click", async (params) => {
      if (!params || !params.data) return;
      const [x, y] = params.value;
      const year = years[y];
      const bucket = buckets[x];
      await openVintageCellDrill(year, bucket);
    });
    state._vhClickBound = true;
  }
}

async function openVintageCellDrill(year, bucket) {
  const { sql: where, params } = whereClause();
  const rows = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts WHERE ${where}
      AND EXTRACT(YEAR FROM AggInitialLeadDate) = ?
      AND MonthBucket = ?
    ),
    per_cohort AS (
      SELECT InitialMedia, InitialCampaignID, AggInitialLeadDate,
             SUM(Leads) AS leads, SUM(Acquisitions) AS acq, MAX(Cost) AS cost
      FROM base GROUP BY 1,2,3
    )
    SELECT * FROM per_cohort
    ORDER BY acq DESC NULLS LAST, leads DESC NULLS LAST
    LIMIT 100
    `,
    [...params, year, bucket]
  );
  const totalLeads = rows.reduce((s, r) => s + Number(r.leads || 0), 0);
  const totalAcq = rows.reduce((s, r) => s + Number(r.acq || 0), 0);
  // Year cost from already-loaded yearList
  const yEntry = state.yearList.find((y) => y.year === Number(year));
  const yearCost = yEntry ? yEntry.cost : 0;
  const cellCPA = totalAcq > 0 ? yearCost / totalAcq : null;

  document.getElementById("modal-eyebrow").textContent = "Vintage drill-in";
  document.getElementById("modal-title").textContent = `Vintage ${year} · month ${bucket}`;
  document.getElementById("modal-stats").innerHTML = `
    <div class="modal-stat"><div class="modal-stat-label">Leads</div><div class="modal-stat-value">${fmtInt.format(totalLeads)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Acquisitions</div><div class="modal-stat-value">${fmtInt.format(totalAcq)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Contributing cohorts</div><div class="modal-stat-value">${fmtInt.format(rows.length)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Cell CPA</div><div class="modal-stat-value">${cellCPA == null ? "—" : fmtMoney.format(Math.round(cellCPA))}</div></div>
  `;
  document.getElementById("modal-sub").textContent = `Top cohorts in this vintage × bucket`;
  document.getElementById("modal-spark").hidden = true;
  document.getElementById("modal-ftr").hidden = false;

  const tbody = document.querySelector("#modal-table tbody");
  tbody.innerHTML = rows
    .map((r) => {
      const ym = formatYM(r.AggInitialLeadDate);
      return `<tr data-media="${escapeAttr(r.InitialMedia)}" data-campaign="${r.InitialCampaignID}" data-date="${ym}-01">
        <td>${escapeHTML(r.InitialMedia)}</td>
        <td>#${r.InitialCampaignID}</td>
        <td>${ym}</td>
        <td class="num">${fmtInt.format(r.leads || 0)}</td>
        <td class="num">${fmtInt.format(r.acq || 0)}</td>
        <td class="num">${r.cost == null ? "—" : fmtMoney.format(r.cost)}</td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      focusCohort(tr.dataset.media, tr.dataset.campaign, tr.dataset.date);
      closeModal();
    });
  });

  // Apply filter button
  const applyBtn = document.getElementById("modal-apply");
  applyBtn.onclick = () => {
    state.selectedYear = Number(year);
    state.filters.dateFrom = `${year}-01-01`;
    state.filters.dateTo = `${year}-12-01`;
    document.getElementById("f-date-from").value = `${year}-01`;
    document.getElementById("f-date-to").value = `${year}-12`;
    closeModal();
    refresh();
  };

  openModal();
}

// ---------------------------------------------------------------
// v2: Per-cohort detail drill (clicking a single row → open detail)
// ---------------------------------------------------------------
async function openCohortDrill(media, campaignId, dateISO) {
  const [r] = await q(
    `
    WITH base AS (
      SELECT * FROM cohorts
      WHERE InitialMedia = ? AND InitialCampaignID = ? AND AggInitialLeadDate = CAST(? AS DATE)
    ),
    per_cohort AS (
      SELECT MAX(Cost) AS cost, SUM(Leads) AS leads, SUM(Acquisitions) AS acq
      FROM base
    )
    SELECT * FROM per_cohort
    `,
    [media, campaignId, dateISO]
  );
  const series = await q(
    `
    SELECT MonthBucket AS b, SUM(Leads) AS leads, SUM(Acquisitions) AS acq
    FROM cohorts
    WHERE InitialMedia = ? AND InitialCampaignID = ? AND AggInitialLeadDate = CAST(? AS DATE)
      AND MonthBucket NOT IN ('<0')
    GROUP BY MonthBucket
    `,
    [media, campaignId, dateISO]
  );
  // Order buckets canonically and build cumulative
  series.sort((a, b) => MONTH_ORDER.indexOf(a.b) - MONTH_ORDER.indexOf(b.b));
  let cum = 0;
  let paybackBucket = null;
  const cost = Number(r?.cost || 0);
  const monthly = series.map((row) => {
    cum += Number(row.acq || 0);
    if (paybackBucket == null && cum > 0 && cost > 0 && cost / cum <= 500) paybackBucket = row.b; // heuristic
    return { b: row.b, leads: Number(row.leads || 0), acq: Number(row.acq || 0), cum };
  });

  const totalAcq = Number(r?.acq || 0);
  const totalLeads = Number(r?.leads || 0);
  const cpa = totalAcq > 0 ? cost / totalAcq : null;

  document.getElementById("modal-eyebrow").textContent = "Cohort detail";
  document.getElementById("modal-title").textContent =
    `${media} · #${campaignId} · ${dateISO.slice(0, 7)}`;
  document.getElementById("modal-stats").innerHTML = `
    <div class="modal-stat"><div class="modal-stat-label">Cost</div><div class="modal-stat-value">${cost ? fmtMoney.format(cost) : "—"}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Leads</div><div class="modal-stat-value">${fmtInt.format(totalLeads)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Acquisitions</div><div class="modal-stat-value">${fmtInt.format(totalAcq)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Cohort CPA</div><div class="modal-stat-value">${cpa == null ? "—" : fmtMoney.format(Math.round(cpa))}</div></div>
  `;

  // Sparkline
  const sparkEl = document.getElementById("modal-spark");
  sparkEl.hidden = false;
  if (!state.modalSpark) state.modalSpark = echarts.init(sparkEl, null, { renderer: "canvas" });
  const labels = monthly.map((m) => (m.b === "12+" ? "12+" : `M${m.b}`));
  state.modalSpark.setOption(
    {
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", backgroundColor: themeColors().tooltipBg, textStyle: { color: themeColors().fg } },
      grid: { left: 50, right: 18, top: 16, bottom: 30 },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: themeColors().line } },
        axisLabel: { color: themeColors().muted, fontSize: 10, fontFamily: "JetBrains Mono" },
      },
      yAxis: [
        {
          type: "value",
          axisLine: { lineStyle: { color: themeColors().line } },
          axisLabel: { color: themeColors().muted, fontSize: 10 },
          splitLine: { lineStyle: { color: themeColors().grid } },
        },
      ],
      series: [
        {
          name: "Acquisitions / month",
          type: "bar",
          data: monthly.map((m) => m.acq),
          itemStyle: { color: "#4f98a3", borderRadius: [3, 3, 0, 0] },
        },
        {
          name: "Cumulative",
          type: "line",
          smooth: true,
          data: monthly.map((m) => m.cum),
          itemStyle: { color: "#e8af34" },
          lineStyle: { width: 2 },
          symbol: "circle",
          symbolSize: 4,
        },
      ],
    },
    true
  );
  requestAnimationFrame(() => state.modalSpark?.resize());

  document.getElementById("modal-sub").textContent = "Monthly acquisitions vs cumulative";
  // Hide the table — for cohort detail we don't need cohort list
  document.querySelector("#modal-table").style.display = "none";
  document.getElementById("modal-ftr").hidden = false;
  const applyBtn = document.getElementById("modal-apply");
  applyBtn.textContent = "Filter dashboard to this cohort";
  applyBtn.onclick = () => {
    closeModal();
    focusCohort(media, campaignId, dateISO);
  };

  openModal();
}

// ---------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------
function renderBreadcrumbs() {
  const el = document.getElementById("breadcrumbs");
  const crumbs = [];
  crumbs.push({ label: "All cohorts", onClick: () => { document.getElementById("f-reset").click(); }, root: true });
  const f = state.filters;
  if (f.initialMedia.length === 1) {
    crumbs.push({ label: f.initialMedia[0], onClick: () => {} });
  } else if (f.initialMedia.length > 1) {
    crumbs.push({ label: `${f.initialMedia.length} media`, onClick: () => {} });
  }
  if (state.selectedYear || (f.dateFrom && f.dateTo && f.dateFrom.slice(0, 4) === f.dateTo.slice(0, 4))) {
    crumbs.push({ label: state.selectedYear || f.dateFrom.slice(0, 4), onClick: () => {} });
  } else if (f.dateFrom || f.dateTo) {
    crumbs.push({ label: `${f.dateFrom?.slice(0,7) || "…"} → ${f.dateTo?.slice(0,7) || "…"}`, onClick: () => {} });
  }
  if (f.campaigns.length === 1) {
    crumbs.push({ label: `Campaign #${f.campaigns[0]}`, onClick: () => {} });
  } else if (f.campaigns.length > 1) {
    crumbs.push({ label: `${f.campaigns.length} campaigns`, onClick: () => {} });
  }

  if (crumbs.length <= 1) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = crumbs
    .map((c, i) => {
      const cls = c.root ? "crumb crumb-root" : "crumb";
      const sep = i === 0 ? "" : `<span class="crumb-sep">›</span>`;
      return `${sep}<button class="${cls}" data-i="${i}">${escapeHTML(c.label)}</button>`;
    })
    .join("");
  el.querySelectorAll("[data-i]").forEach((b) => {
    b.addEventListener("click", () => crumbs[Number(b.dataset.i)].onClick());
  });
}

// ---------------------------------------------------------------
// KPI rendering
// ---------------------------------------------------------------
function paintKPIs(t) {
  const cost = Number(t.total_cost ?? 0);
  const leads = Number(t.total_leads ?? 0);
  const acq = Number(t.total_acq ?? 0);
  const cpa = acq > 0 ? cost / acq : null;

  document.getElementById("kpi-cost").textContent = fmtMoney.format(cost);
  document.getElementById("kpi-leads").textContent = fmtInt.format(leads);
  document.getElementById("kpi-acq").textContent = fmtInt.format(acq);
  document.getElementById("kpi-cpa").textContent =
    cpa == null ? "—" : fmtMoney2.format(cpa);

  document.getElementById("kpi-acq-0").textContent = fmtInt.format(t.acq0 || 0);
  document.getElementById("kpi-acq-3").textContent = fmtInt.format(t.acq3 || 0);
  document.getElementById("kpi-acq-6").textContent = fmtInt.format(t.acq6 || 0);
  document.getElementById("kpi-acq-12").textContent = fmtInt.format(
    t.acq12 || 0
  );
}

// ---------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------
function paintHeatmap(rows) {
  const el = document.getElementById("heatmap");
  if (!state.heatmap) state.heatmap = echarts.init(el, null, { renderer: "canvas" });

  // Y axis = media, sorted by total-acq desc among present media
  const totalsByMedia = new Map();
  for (const r of rows) {
    const m = r.Media;
    totalsByMedia.set(m, (totalsByMedia.get(m) || 0) + (Number(r.acq) || 0));
  }
  const mediasPresent = Array.from(totalsByMedia.keys());
  mediasPresent.sort((a, b) => {
    const pa = MEDIA_PREFERRED_ORDER.indexOf(a);
    const pb = MEDIA_PREFERRED_ORDER.indexOf(b);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return (totalsByMedia.get(b) || 0) - (totalsByMedia.get(a) || 0);
  });

  // X axis = month buckets actually present, in canonical order
  const bucketsPresent = Array.from(new Set(rows.map((r) => r.MonthBucket)));
  bucketsPresent.sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  // Lookup
  const totalCost = Number(rows[0]?.total_cost || 0);
  const lookup = new Map();
  for (const r of rows) {
    lookup.set(`${r.Media}|${r.MonthBucket}`, {
      leads: Number(r.leads) || 0,
      acq: Number(r.acq) || 0,
    });
  }

  // First pass: compute every cell value
  const cells = [];
  const positives = [];
  for (let y = 0; y < mediasPresent.length; y++) {
    for (let x = 0; x < bucketsPresent.length; x++) {
      const cell = lookup.get(`${mediasPresent[y]}|${bucketsPresent[x]}`) || {
        leads: 0,
        acq: 0,
      };
      let v;
      if (state.metric === "leads") v = cell.leads;
      else if (state.metric === "acq") v = cell.acq;
      else {
        v = cell.acq > 0 ? totalCost / cell.acq : null;
      }
      cells.push({ x, y, v, cell });
      if (typeof v === "number" && isFinite(v) && v > 0) positives.push(v);
    }
  }

  // Percentile cap so a single huge cell (e.g. Google M0) doesn’t flatten
  // the rest of the matrix to near-black. We cap at p95 of non-zero cells.
  const sorted = positives.slice().sort((a, b) => a - b);
  const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const valMin = positives.length ? sorted[0] : 0;
  const valP95 = p(0.95) || 1;

  // Second pass: bake per-cell label color (white on dark cells, dark on bright cells)
  const data = cells.map(({ x, y, v, cell }) => {
    const t = v == null || !isFinite(v) ? 0 : Math.min(1, v / (valP95 || 1));
    const labelColor = readableOn(cell);
    return [x, y, v, cell, labelColor];
  });

  // Visual map config
  const isCPA = state.metric === "cpa";
  const piecesOrRange = isCPA
    ? {
        // Lower CPA -> primary teal; higher -> warm terra
        min: valMin,
        max: valP95,
        inRange: { color: themeColors().heatmapRampCPA },
      }
    : {
        // Sequential teal ramp. Start a few shades brighter than the page bg
        // so even single-acquisition cells stay visible.
        min: 0,
        max: valP95,
        inRange: { color: themeColors().heatmapRampSeq },
      };

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      backgroundColor: themeColors().tooltipBg,
      borderColor: "#3a4842",
      borderWidth: 1,
      textStyle: { color: themeColors().fg, fontFamily: "Inter" },
      formatter: (p) => {
        const [, , v, cell] = p.data;
        const media = mediasPresent[p.value[1]];
        const bucket = bucketsPresent[p.value[0]];
        const cpa = cell.acq > 0 ? totalCost / cell.acq : null;
        return `
          <div style="font-size:12px;line-height:1.45">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px">
              ${escapeHTML(media)} · month ${escapeHTML(bucket)}
            </div>
            <div>Leads&nbsp;&nbsp;&nbsp;<b>${fmtInt.format(cell.leads)}</b></div>
            <div>Acquisitions&nbsp;<b>${fmtInt.format(cell.acq)}</b></div>
            <div>Cell CPA&nbsp;&nbsp;<b>${cpa == null ? "—" : fmtMoney2.format(cpa)}</b></div>
            <div style="margin-top:6px;color:#97a39b;font-size:11px">
              Cell CPA = total cohort cost ÷ this cell’s acquisitions
            </div>
          </div>`;
      },
    },
    grid: { left: 140, right: 40, top: 24, bottom: 60 },
    xAxis: {
      type: "category",
      data: bucketsPresent.map((b) => (b === "12+" ? "12+" : b === "<0" ? "<0" : `M${b}`)),
      splitArea: { show: false },
      axisLine: { lineStyle: { color: themeColors().line } },
      axisLabel: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
      name: "Months from initial lead",
      nameLocation: "middle",
      nameGap: 36,
      nameTextStyle: { color: themeColors().faint, fontSize: 11 },
    },
    yAxis: {
      type: "category",
      data: mediasPresent,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: themeColors().line } },
      axisLabel: { color: themeColors().fg, fontSize: 12 },
      inverse: false,
    },
    visualMap: {
      ...piecesOrRange,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemWidth: 14,
      itemHeight: 220,
      text: [
        state.metric === "cpa" ? "higher CPA" : "more",
        state.metric === "cpa" ? "lower CPA" : "fewer",
      ],
      textStyle: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
      formatter: (v) => {
        if (state.metric === "cpa") return fmtMoney.format(v || 0);
        return fmtInt.format(Math.round(v || 0));
      },
    },
    series: [
      {
        name: state.metric,
        type: "heatmap",
        data,
        label: {
          show: true,
          fontFamily: "JetBrains Mono",
          fontSize: 10,
          color: (p) => p.data?.[4] || themeColors().fg,
          formatter: (p) => {
            const v = p.data[2];
            if (v == null || v === 0) return "";
            if (state.metric === "cpa") {
              if (!isFinite(v)) return "";
              return v >= 1000
                ? `$${Math.round(v / 100) / 10}k`
                : `$${Math.round(v)}`;
            }
            if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
            return String(v);
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 12,
            shadowColor: "rgba(79,152,163,0.55)",
            borderColor: "#e8ece9",
            borderWidth: 1,
          },
        },
        itemStyle: {
          borderColor: themeColors().cellBorder,
          borderWidth: 1,
        },
        progressive: 0,
        animationDuration: 400,
      },
    ],
  };

  state.heatmap.setOption(option, true);
  // make sure resize works
  if (!state._heatBound) {
    window.addEventListener("resize", () => state.heatmap?.resize());
    state._heatBound = true;
  }
}

// ---------------------------------------------------------------
// Cumulative chart
// ---------------------------------------------------------------
function paintCumChart(rows) {
  const el = document.getElementById("cumchart");
  if (!state.cumchart) state.cumchart = echarts.init(el, null, { renderer: "canvas" });

  // Make sure every month 0..12 is represented
  const map = new Map(rows.map((r) => [Number(r.m), Number(r.acq) || 0]));
  const totalCost = Number(rows[0]?.total_cost || 0);

  const xs = [];
  const cumAcq = [];
  const cpa = [];
  let running = 0;
  for (let m = 0; m <= 12; m++) {
    xs.push(`M${m}`);
    running += map.get(m) || 0;
    cumAcq.push(running);
    cpa.push(running > 0 ? +(totalCost / running).toFixed(2) : null);
  }

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: themeColors().tooltipBg,
      borderColor: "#3a4842",
      borderWidth: 1,
      textStyle: { color: themeColors().fg, fontFamily: "Inter" },
      formatter: (params) => {
        const i = params[0].dataIndex;
        return `
          <div style="font-size:12px;line-height:1.45">
            <div style="font-weight:600;margin-bottom:6px">Month ${i} from initial lead</div>
            <div>Cumulative acquisitions&nbsp;<b>${fmtInt.format(cumAcq[i])}</b></div>
            <div>Cumulative CPA&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>${cpa[i] == null ? "—" : fmtMoney2.format(cpa[i])}</b></div>
          </div>`;
      },
    },
    grid: { left: 60, right: 60, top: 30, bottom: 40 },
    legend: {
      data: ["Cumulative acquisitions", "Cumulative CPA"],
      textStyle: { color: themeColors().muted },
      top: 0,
      right: 0,
    },
    xAxis: {
      type: "category",
      data: xs,
      axisLine: { lineStyle: { color: themeColors().line } },
      axisLabel: { color: themeColors().muted, fontFamily: "JetBrains Mono", fontSize: 11 },
    },
    yAxis: [
      {
        type: "value",
        name: "Acquisitions",
        nameTextStyle: { color: themeColors().faint },
        axisLine: { show: false, lineStyle: { color: "#3a4842" } },
        splitLine: { lineStyle: { color: themeColors().grid } },
        axisLabel: { color: themeColors().muted,
          fontFamily: "JetBrains Mono",
          fontSize: 11,
          formatter: (v) => (v >= 1000 ? `${v / 1000}k` : v),
        },
      },
      {
        type: "value",
        name: "CPA",
        nameTextStyle: { color: themeColors().faint },
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { color: themeColors().muted,
          fontFamily: "JetBrains Mono",
          fontSize: 11,
          formatter: (v) => (v >= 1000 ? `$${v / 1000}k` : `$${v}`),
        },
      },
    ],
    series: [
      {
        name: "Cumulative acquisitions",
        type: "line",
        data: cumAcq,
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { color: "#4f98a3", width: 2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(79,152,163,0.35)" },
              { offset: 1, color: "rgba(79,152,163,0)" },
            ],
          },
        },
      },
      {
        name: "Cumulative CPA",
        type: "line",
        yAxisIndex: 1,
        data: cpa,
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { color: "#e8af34", width: 2, type: "dashed" },
      },
    ],
  };
  state.cumchart.setOption(option, true);
  if (!state._cumBound) {
    window.addEventListener("resize", () => state.cumchart?.resize());
    state._cumBound = true;
  }
}

// ---------------------------------------------------------------
// Cohort table
// ---------------------------------------------------------------
function paintTable() {
  const rows = sortRows(state.lastTableRows.slice());
  const tbody = document.querySelector("#cohort-table tbody");
  tbody.innerHTML = rows
    .map((r) => {
      const cpa = r.acq > 0 && r.cost ? r.cost / r.acq : null;
      const cohortMonth = formatYM(r.AggInitialLeadDate);
      return `<tr data-media="${escapeAttr(r.InitialMedia)}" data-campaign="${r.InitialCampaignID}" data-date="${cohortMonth}-01">
        <td>${escapeHTML(r.InitialMedia)}</td>
        <td>#${r.InitialCampaignID}</td>
        <td>${cohortMonth}</td>
        <td class="num">${r.cost == null ? "—" : fmtMoney.format(r.cost)}</td>
        <td class="num">${fmtInt.format(r.leads)}</td>
        <td class="num">${fmtInt.format(r.acq)}</td>
        <td class="num">${cpa == null ? "—" : fmtMoney2.format(cpa)}</td>
      </tr>`;
    })
    .join("");

  // Sort indicators
  document.querySelectorAll("#cohort-table thead th").forEach((th) => {
    th.classList.remove("sort-active", "sort-desc", "sort-asc");
    if (th.dataset.sort === state.sort.key) {
      th.classList.add("sort-active", state.sort.dir === "desc" ? "sort-desc" : "sort-asc");
    }
  });
}

function sortRows(rows) {
  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    let va, vb;
    if (key === "cpa") {
      va = a.acq > 0 && a.cost ? a.cost / a.acq : null;
      vb = b.acq > 0 && b.cost ? b.cost / b.acq : null;
    } else {
      va = a[key];
      vb = b[key];
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  });
}

// ---------------------------------------------------------------
// Filter wiring
// ---------------------------------------------------------------
function bindUI() {
  // Initial-media multi-select
  document.getElementById("f-initial-media").addEventListener("change", (e) => {
    state.filters.initialMedia = Array.from(e.target.selectedOptions).map((o) => o.value);
  });

  // Campaign search
  const search = document.getElementById("f-campaign-search");
  let searchTimer;
  search.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderCampaignOptions(e.target.value), 80);
  });

  const camSel = document.getElementById("f-campaign");
  camSel.addEventListener("change", () => {
    state.filters.campaigns = Array.from(camSel.selectedOptions).map((o) => o.value);
    document.getElementById("f-campaign-count").textContent = state.filters.campaigns.length;
  });

  document.getElementById("f-campaign-clear").addEventListener("click", () => {
    state.filters.campaigns = [];
    document.getElementById("f-campaign-count").textContent = "0";
    renderCampaignOptions(search.value);
  });

  // Date range
  document.getElementById("f-date-from").addEventListener("change", (e) => {
    state.filters.dateFrom = e.target.value ? `${e.target.value}-01` : null;
  });
  document.getElementById("f-date-to").addEventListener("change", (e) => {
    state.filters.dateTo = e.target.value ? `${e.target.value}-01` : null;
  });

  // Presets
  document.querySelectorAll(".presets button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const today = new Date();
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let from = null;
      const to = fmt(today);
      if (b.dataset.preset === "ytd") from = `${today.getFullYear()}-01`;
      else if (b.dataset.preset === "12m") {
        const d = new Date(today);
        d.setMonth(d.getMonth() - 11);
        from = fmt(d);
      } else if (b.dataset.preset === "24m") {
        const d = new Date(today);
        d.setMonth(d.getMonth() - 23);
        from = fmt(d);
      }
      document.getElementById("f-date-from").value = from || "";
      document.getElementById("f-date-to").value = b.dataset.preset === "all" ? "" : to;
      state.filters.dateFrom = from ? `${from}-01` : null;
      state.filters.dateTo = b.dataset.preset === "all" ? null : `${to}-01`;
      refresh();
    });
  });

  document.getElementById("f-apply").addEventListener("click", () =>
    refresh().catch((e) => {
      console.error(e);
      alert("Query failed: " + (e?.message || e));
    })
  );
  document.getElementById("f-reset").addEventListener("click", () => {
    state.filters = { initialMedia: [], campaigns: [], dateFrom: null, dateTo: null };
    document.getElementById("f-initial-media").selectedIndex = -1;
    document.getElementById("f-campaign").selectedIndex = -1;
    document.getElementById("f-campaign-search").value = "";
    document.getElementById("f-campaign-count").textContent = "0";
    document.getElementById("f-date-from").value = "";
    document.getElementById("f-date-to").value = "";
    document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
    renderCampaignOptions("");
    refresh();
  });

  // Metric segmented control (heatmap metric only — scoped to data-metric)
  document.querySelectorAll(".seg-btn[data-metric]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-metric]").forEach((x) => {
        x.classList.remove("active");
        x.setAttribute("aria-selected", "false");
      });
      b.classList.add("active");
      b.setAttribute("aria-selected", "true");
      state.metric = b.dataset.metric;
      writeUrlState();
      refresh();
    });
  });

  // CSV export of current cohort table
  document.getElementById("export-csv").addEventListener("click", exportCSV);

  // ── Interactivity additions ──────────────────────────────────────
  bindHeatmapClick();
  bindTableClick();
  bindSortableHeaders();
  bindModal();
  bindShareLink();
  bindFullscreen();
  bindKeyboardShortcuts();
  bindV2Controls();
}

// ---------------------------------------------------------------
// V2 control wiring — vintage segs, density, theme, compare mode
// ---------------------------------------------------------------
function bindV2Controls() {
  // Generic helper: scoped segmented control that updates state[key]
  const wireSeg = (attr, stateKey, onChange) => {
    const buttons = document.querySelectorAll(`.seg-btn[data-${attr}]`);
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        buttons.forEach((x) => {
          x.classList.remove("active");
          x.setAttribute("aria-selected", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-selected", "true");
        state[stateKey] = b.dataset[attr];
        if (typeof onChange === "function") onChange(b.dataset[attr]);
      });
    });
  };

  // Vintage line: metric & split
  wireSeg("vmetric", "vmetric", () => {
    const [w, p] = whereTuple();
    refreshVintageChart(w, p);
  });
  wireSeg("vsplit", "vsplit", () => {
    const [w, p] = whereTuple();
    refreshVintageChart(w, p);
  });

  // Vintage heatmap metric
  wireSeg("yhmetric", "yhmetric", () => {
    const [w, p] = whereTuple();
    refreshVintageHeatmap(w, p);
  });

  // Cohort table density toggle
  wireSeg("density", "density", (val) => {
    const t = document.getElementById("cohort-table");
    if (t) t.classList.toggle("compact", val === "compact");
    try { localStorage.setItem("dash.density", val); } catch (_) {}
  });

  // Theme toggle (light <-> dark)
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const next = (document.documentElement.dataset.theme === "light") ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      state.theme = next;
      try { localStorage.setItem("dash.theme", next); } catch (_) {}
      // Re-paint charts so they pick up new bg/foreground colors
      const [w, p] = whereTuple();
      paintYearStrip();
      refresh().catch((e) => console.error(e));
    });
  }

  // Compare mode toggle (vintage strip)
  const cmpBtn = document.getElementById("vintage-compare-toggle");
  if (cmpBtn) {
    cmpBtn.addEventListener("click", () => {
      state.compareMode = !state.compareMode;
      cmpBtn.textContent = `Compare mode: ${state.compareMode ? "on" : "off"}`;
      cmpBtn.classList.toggle("active", state.compareMode);
      if (!state.compareMode) state.pinnedYears = [];
      paintYearStrip();
      const [w, p] = whereTuple();
      refreshVintageChart(w, p);
    });
  }

  // Modal apply (filter dashboard to cohorts shown in modal table)
  const modalApply = document.getElementById("modal-apply");
  if (modalApply && !modalApply._bound) {
    modalApply._bound = true;
    modalApply.addEventListener("click", () => {
      // Default behavior: just close — openCellDrill/openCohortDrill set onclick handlers per-context
      closeModal();
    });
  }
}

// ---------------------------------------------------------------
// Active filter chips
// ---------------------------------------------------------------
function renderChips() {
  const wrap = document.getElementById("chips");
  const chips = [];
  const f = state.filters;
  if (f.initialMedia.length) {
    chips.push({
      label: `Initial: ${f.initialMedia.join(", ")}`,
      clear: () => {
        state.filters.initialMedia = [];
        const sel = document.getElementById("f-initial-media");
        Array.from(sel.options).forEach((o) => (o.selected = false));
      },
    });
  }
  if (f.campaigns.length) {
    const head = f.campaigns.slice(0, 3).map((c) => `#${c}`).join(", ");
    const more = f.campaigns.length > 3 ? ` +${f.campaigns.length - 3}` : "";
    chips.push({
      label: `Campaign: ${head}${more}`,
      clear: () => {
        state.filters.campaigns = [];
        document.getElementById("f-campaign-count").textContent = "0";
        renderCampaignOptions(document.getElementById("f-campaign-search").value);
      },
    });
  }
  if (f.dateFrom || f.dateTo) {
    const from = f.dateFrom ? f.dateFrom.slice(0, 7) : "…";
    const to = f.dateTo ? f.dateTo.slice(0, 7) : "…";
    chips.push({
      label: `Lead month: ${from} → ${to}`,
      clear: () => {
        state.filters.dateFrom = null;
        state.filters.dateTo = null;
        document.getElementById("f-date-from").value = "";
        document.getElementById("f-date-to").value = "";
        document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
      },
    });
  }

  if (!chips.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = chips
    .map(
      (c, i) =>
        `<button class="chip" data-i="${i}" title="Remove filter">${escapeHTML(
          c.label
        )}<span class="chip-clear" aria-hidden="true">×</span></button>`
    )
    .join("") +
    `<button class="chip chip-reset" data-reset>Clear all</button>`;
  wrap.querySelectorAll("[data-i]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      chips[i].clear();
      refresh();
    });
  });
  wrap.querySelector("[data-reset]").addEventListener("click", () => {
    document.getElementById("f-reset").click();
  });
}

// ---------------------------------------------------------------
// URL state — read on load, write on every refresh
// ---------------------------------------------------------------
function readUrlState() {
  const p = new URLSearchParams(window.location.search);
  const im = p.get("im");
  const cmp = p.get("cmp");
  const from = p.get("from");
  const to = p.get("to");
  const m = p.get("m");
  if (im) state.filters.initialMedia = im.split(",").filter(Boolean);
  if (cmp) state.filters.campaigns = cmp.split(",").filter(Boolean);
  if (from) state.filters.dateFrom = `${from}-01`;
  if (to) state.filters.dateTo = `${to}-01`;
  if (m && ["acq", "leads", "cpa"].includes(m)) state.metric = m;
}

function applyUrlStateToInputs() {
  // Initial media
  const selIM = document.getElementById("f-initial-media");
  if (selIM && state.filters.initialMedia.length) {
    Array.from(selIM.options).forEach((o) => {
      o.selected = state.filters.initialMedia.includes(o.value);
    });
  }
  // Campaigns
  if (state.filters.campaigns.length) {
    document.getElementById("f-campaign-count").textContent =
      state.filters.campaigns.length;
    renderCampaignOptions("");
  }
  // Dates
  if (state.filters.dateFrom) {
    document.getElementById("f-date-from").value = state.filters.dateFrom.slice(0, 7);
  }
  if (state.filters.dateTo) {
    document.getElementById("f-date-to").value = state.filters.dateTo.slice(0, 7);
  }
  // Metric
  document.querySelectorAll(".seg-btn").forEach((b) => {
    const on = b.dataset.metric === state.metric;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
}

function writeUrlState() {
  const p = new URLSearchParams();
  if (state.filters.initialMedia.length) p.set("im", state.filters.initialMedia.join(","));
  if (state.filters.campaigns.length) p.set("cmp", state.filters.campaigns.join(","));
  if (state.filters.dateFrom) p.set("from", state.filters.dateFrom.slice(0, 7));
  if (state.filters.dateTo) p.set("to", state.filters.dateTo.slice(0, 7));
  if (state.metric !== "acq") p.set("m", state.metric);
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  history.replaceState(null, "", url);
}

// ---------------------------------------------------------------
// Heatmap click → drill-in modal
// ---------------------------------------------------------------
function bindHeatmapClick() {
  // ECharts handler is set inside paintHeatmap via state.heatmap; bind once here
  const tryBind = () => {
    if (!state.heatmap || state._heatClickBound) return;
    state.heatmap.on("click", async (params) => {
      if (!params || !params.data) return;
      const [x, y] = params.value;
      const media = state.heatmap.getOption().yAxis[0].data[y];
      const bucketLabel = state.heatmap.getOption().xAxis[0].data[x];
      // Convert label back: "M0" -> "0", "12+" -> "12+", "<0" -> "<0"
      const bucket = bucketLabel.startsWith("M") ? bucketLabel.slice(1) : bucketLabel;
      await openCellDrill(media, bucket);
    });
    state._heatClickBound = true;
  };
  const iv = setInterval(() => {
    if (state.heatmap) {
      tryBind();
      clearInterval(iv);
    }
  }, 100);
}

async function openCellDrill(media, bucket) {
  const { sql: where, params } = whereClause();
  const rows = await q(
    `
    WITH base AS ( SELECT * FROM cohorts WHERE ${where} AND Media = ? AND MonthBucket = ? ),
    per_cohort AS (
      SELECT InitialMedia, InitialCampaignID, AggInitialLeadDate,
             SUM(Leads) AS leads, SUM(Acquisitions) AS acq, MAX(Cost) AS cost
      FROM base
      GROUP BY 1,2,3
    )
    SELECT * FROM per_cohort
    ORDER BY acq DESC NULLS LAST, leads DESC NULLS LAST
    LIMIT 100
    `,
    [...params, media, bucket]
  );

  // Aggregate stats for the cell
  const totalLeads = rows.reduce((s, r) => s + Number(r.leads || 0), 0);
  const totalAcq = rows.reduce((s, r) => s + Number(r.acq || 0), 0);
  const cohortCount = rows.length;
  const fullCohortCost = Number(state.totals?.total_cost || 0);
  const cellCPA = totalAcq > 0 ? fullCohortCost / totalAcq : null;

  document.getElementById("modal-eyebrow").textContent = "Cell inspection";
  document.getElementById("modal-title").textContent = `${media} · month ${bucket}`;
  document.getElementById("modal-stats").innerHTML = `
    <div class="modal-stat"><div class="modal-stat-label">Leads</div><div class="modal-stat-value">${fmtInt.format(totalLeads)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Acquisitions</div><div class="modal-stat-value">${fmtInt.format(totalAcq)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Contributing cohorts</div><div class="modal-stat-value">${fmtInt.format(cohortCount)}</div></div>
    <div class="modal-stat"><div class="modal-stat-label">Cell CPA</div><div class="modal-stat-value">${cellCPA == null ? "—" : fmtMoney2.format(cellCPA)}</div></div>
  `;

  const tbody = document.querySelector("#modal-table tbody");
  tbody.innerHTML = rows
    .map((r) => {
      const ym = formatYM(r.AggInitialLeadDate);
      return `<tr data-media="${escapeAttr(r.InitialMedia)}" data-campaign="${r.InitialCampaignID}" data-date="${ym}-01">
        <td>${escapeHTML(r.InitialMedia)}</td>
        <td>#${r.InitialCampaignID}</td>
        <td>${ym}</td>
        <td class="num">${fmtInt.format(r.leads || 0)}</td>
        <td class="num">${fmtInt.format(r.acq || 0)}</td>
        <td class="num">${r.cost == null ? "—" : fmtMoney.format(r.cost)}</td>
      </tr>`;
    })
    .join("");

  // Wire row clicks inside the modal to focus that cohort
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      focusCohort(tr.dataset.media, tr.dataset.campaign, tr.dataset.date);
      closeModal();
    });
  });

  openModal();
}

function openModal() {
  document.getElementById("modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  document.getElementById("modal").hidden = true;
  document.body.style.overflow = "";
  // Reset modal pieces that openCohortDrill / openVintageCellDrill may have toggled
  const mt = document.getElementById("modal-table");
  if (mt) mt.style.display = "";
  const ms = document.getElementById("modal-spark");
  if (ms) ms.hidden = true;
  const mf = document.getElementById("modal-ftr");
  if (mf) mf.hidden = true;
  const ma = document.getElementById("modal-apply");
  if (ma) ma.textContent = "Filter dashboard to these cohorts";
  // Dispose any modal sparkline so the next open is clean
  if (state.modalSpark) {
    try { state.modalSpark.dispose(); } catch (_) {}
    state.modalSpark = null;
  }
}
function bindModal() {
  document.querySelectorAll("#modal [data-close]").forEach((el) => {
    el.addEventListener("click", closeModal);
  });
}

// ---------------------------------------------------------------
// Table interactivity
// ---------------------------------------------------------------
function bindTableClick() {
  const tbody = document.querySelector("#cohort-table tbody");
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    // If the user shift-clicks, fall back to the legacy "focus filter" behavior.
    // Plain click opens the per-cohort drill modal with sparkline.
    if (e.shiftKey) {
      focusCohort(tr.dataset.media, tr.dataset.campaign, tr.dataset.date);
    } else if (typeof openCohortDrill === "function") {
      openCohortDrill(tr.dataset.media, tr.dataset.campaign, tr.dataset.date);
    } else {
      focusCohort(tr.dataset.media, tr.dataset.campaign, tr.dataset.date);
    }
  });
}

function focusCohort(media, campaignId, dateISO) {
  state.filters.initialMedia = media ? [media] : [];
  state.filters.campaigns = campaignId ? [campaignId] : [];
  state.filters.dateFrom = dateISO || null;
  state.filters.dateTo = dateISO || null;
  // sync inputs
  const selIM = document.getElementById("f-initial-media");
  Array.from(selIM.options).forEach((o) => (o.selected = o.value === media));
  document.getElementById("f-campaign-count").textContent = campaignId ? "1" : "0";
  renderCampaignOptions("");
  if (dateISO) {
    const ym = dateISO.slice(0, 7);
    document.getElementById("f-date-from").value = ym;
    document.getElementById("f-date-to").value = ym;
  }
  document.querySelectorAll(".presets button").forEach((x) => x.classList.remove("active"));
  refresh();
  toast(`Focused on #${campaignId} · ${dateISO?.slice(0, 7) || ""}`);
}

function bindSortableHeaders() {
  document.querySelectorAll("#cohort-table thead th[data-sort]").forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "desc" ? "asc" : "desc";
      } else {
        state.sort.key = key;
        state.sort.dir = ["InitialMedia", "AggInitialLeadDate"].includes(key) ? "asc" : "desc";
      }
      paintTable();
    });
  });
}

// ---------------------------------------------------------------
// Share link
// ---------------------------------------------------------------
function bindShareLink() {
  document.getElementById("share-link").addEventListener("click", async () => {
    writeUrlState();
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("View link copied to clipboard");
    } catch {
      // Fallback: select-and-copy via temporary input
      const t = document.createElement("input");
      t.value = url;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand("copy"); toast("View link copied"); }
      catch { toast("Couldn’t copy — copy from the address bar"); }
      t.remove();
    }
  });
}

// ---------------------------------------------------------------
// Fullscreen heatmap
// ---------------------------------------------------------------
function bindFullscreen() {
  const btn = document.getElementById("fullscreen-heatmap");
  btn.addEventListener("click", () => {
    const panel = btn.closest(".panel");
    panel.classList.toggle("fullscreen");
    document.body.style.overflow = panel.classList.contains("fullscreen") ? "hidden" : "";
    requestAnimationFrame(() => state.heatmap?.resize());
  });
}

// ---------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Escape closes modal or exits fullscreen
    if (e.key === "Escape") {
      const modal = document.getElementById("modal");
      if (!modal.hidden) {
        closeModal();
        return;
      }
      const fs = document.querySelector(".panel.fullscreen");
      if (fs) {
        fs.classList.remove("fullscreen");
        document.body.style.overflow = "";
        requestAnimationFrame(() => state.heatmap?.resize());
      }
    }
    // / focuses campaign search
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      e.preventDefault();
      document.getElementById("f-campaign-search").focus();
    }
  });
}

// ---------------------------------------------------------------
// Toast
// ---------------------------------------------------------------
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.add("visible");
  clearTimeout(state._toastTimer);
  state._toastTimer = setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => (el.hidden = true), 300);
  }, 2200);
}

async function exportCSV() {
  const { sql: where, params } = whereClause();
  const rows = await q(
    `
    WITH base AS ( SELECT * FROM cohorts WHERE ${where} )
    SELECT InitialMedia, InitialCampaignID, AggInitialLeadDate,
           Media, MonthBucket,
           SUM(Leads) AS Leads,
           SUM(Acquisitions) AS Acquisitions,
           MAX(Cost) AS Cost
    FROM base
    GROUP BY 1,2,3,4,5
    ORDER BY 1,2,3,4,5
    `,
    params
  );
  const header = [
    "InitialMedia",
    "InitialCampaignID",
    "AggInitialLeadDate",
    "Media",
    "MonthBucket",
    "Leads",
    "Acquisitions",
    "Cost",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      header
        .map((h) => {
          let v = r[h];
          if (v == null) return "";
          if (h === "AggInitialLeadDate") v = formatYM(v) + "-01";
          if (typeof v === "string" && (v.includes(",") || v.includes('"')))
            return `"${v.replace(/"/g, '""')}"`;
          return v;
        })
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "blended_cpa_cohorts.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );
}

function escapeAttr(s) {
  return escapeHTML(s);
}

function formatYM(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 7);
  if (d instanceof Date)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // DuckDB returns date as a Date object via Arrow; fall through
  try {
    const dt = new Date(d);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
  } catch {
    return String(d);
  }
}

function setStatus(s) {
  const el = document.getElementById("loader-status");
  if (el) el.textContent = s;
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
(async () => {
  try {
    readUrlState();
    // Restore theme + density preferences early so first paint is correct
    try {
      const savedTheme = localStorage.getItem("dash.theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.dataset.theme = savedTheme;
        state.theme = savedTheme;
      }
      const savedDensity = localStorage.getItem("dash.density");
      if (savedDensity === "compact" || savedDensity === "comfortable") {
        state.density = savedDensity;
      }
    } catch (_) {}
    await initDuckDB();
    setStatus("Building filters");
    // Reveal app BEFORE rendering charts so ECharts can measure the canvas
    document.querySelector("main.app").hidden = false;
    document.getElementById("loader").style.display = "none";
    await loadMeta();
    applyUrlStateToInputs();
    // Apply restored density to table and reflect in seg buttons
    const cohortTbl = document.getElementById("cohort-table");
    if (cohortTbl) cohortTbl.classList.toggle("compact", state.density === "compact");
    document.querySelectorAll(".seg-btn[data-density]").forEach((b) => {
      const on = b.dataset.density === state.density;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    bindUI();
    setStatus("Rendering charts");
    await refresh();
    // Belt-and-braces resize after the first paint
    requestAnimationFrame(() => {
      state.heatmap?.resize();
      state.cumchart?.resize();
    });
  } catch (err) {
    console.error(err);
    setStatus("Error: " + (err?.message || err));
  }
})();
