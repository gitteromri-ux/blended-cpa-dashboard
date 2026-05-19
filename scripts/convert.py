#!/usr/bin/env python3
"""
Convert SQL output (Excel or CSV) into a compact Parquet file the
dashboard loads via DuckDB-WASM in the browser.

Usage
-----
    python scripts/convert.py path/to/ayelet_blended_cpa.xlsx
    python scripts/convert.py path/to/ayelet_blended_cpa.csv

Output:  data/cohorts.parquet
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

EXPECTED_COLS = [
    "InitialMedia",
    "InitialCampaignID",
    "AggInitialLeadDate",
    "Media",
    "MonthBucket",
    "Leads",
    "Acquisitions",
    "Cost",
]


def load(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in (".xlsx", ".xls"):
        df = pd.read_excel(path)
    elif path.suffix.lower() == ".csv":
        # The "NULL" tokens that SQL Server prints become real NaN with na_values
        df = pd.read_csv(path, na_values=["NULL", "null", ""])
    else:
        raise SystemExit(f"Unsupported extension: {path.suffix}")
    return df


def clean(df: pd.DataFrame) -> pd.DataFrame:
    missing = [c for c in EXPECTED_COLS if c not in df.columns]
    if missing:
        raise SystemExit(f"Missing required columns: {missing}")

    df = df[EXPECTED_COLS].copy()

    # Cost: the SQL deduplicates cost to one row per cohort and writes 'NULL' elsewhere.
    df["Cost"] = pd.to_numeric(df["Cost"], errors="coerce")

    # Counts to numeric
    df["Leads"] = pd.to_numeric(df["Leads"], errors="coerce").fillna(0).astype("int32")
    df["Acquisitions"] = (
        pd.to_numeric(df["Acquisitions"], errors="coerce").fillna(0).astype("int32")
    )

    # Date -> ISO string (DuckDB-WASM parses cleanly, ECharts/JS read it directly)
    df["AggInitialLeadDate"] = pd.to_datetime(df["AggInitialLeadDate"]).dt.strftime(
        "%Y-%m-%d"
    )

    # MonthBucket arrives mixed (ints and "12+"/"<0").  Store as string for stable
    # categorical handling; the dashboard maps to a numeric sort key.
    df["MonthBucket"] = df["MonthBucket"].astype(str).str.strip()

    # Convenience: a single cohort key. Saves a concat in SQL/JS later.
    df["CohortKey"] = (
        df["InitialCampaignID"].astype(str) + "|" + df["AggInitialLeadDate"]
    )

    # Tighten dtypes for parquet size
    df["InitialMedia"] = df["InitialMedia"].astype("category")
    df["Media"] = df["Media"].astype("category")
    df["MonthBucket"] = df["MonthBucket"].astype("category")
    df["InitialCampaignID"] = pd.to_numeric(
        df["InitialCampaignID"], errors="coerce"
    ).astype("Int64")

    return df


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python scripts/convert.py <input.xlsx|csv>")
    src = Path(sys.argv[1]).expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"Not found: {src}")

    out_dir = Path(__file__).resolve().parent.parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "cohorts.parquet"

    df = clean(load(src))
    df.to_parquet(out, compression="zstd", index=False)

    size_mb = out.stat().st_size / 1_048_576
    print(f"Wrote {out}  ({len(df):,} rows, {size_mb:.2f} MB)")
    print("Distinct InitialMedia :", sorted(df["InitialMedia"].dropna().unique()))
    print("Distinct Media        :", sorted(df["Media"].dropna().unique()))
    print(
        "Date range            :",
        df["AggInitialLeadDate"].min(),
        "→",
        df["AggInitialLeadDate"].max(),
    )
    print("Cohorts               :", df["CohortKey"].nunique())


if __name__ == "__main__":
    main()
