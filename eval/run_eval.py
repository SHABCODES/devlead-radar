#!/usr/bin/env python3
"""Send leads to the Lead Radar webhook and compare its scores with your own labels.

Usage:
  python3 eval/run_eval.py --url http://localhost:5678/webhook/lead-intake
  python3 eval/run_eval.py --report-only eval/results.csv

Fill the human_score column (1-5) in data/leads.csv BEFORE trusting any number here.
Stdlib only. Free GitHub API access allows 60 requests/hour, so add a GitHub token
credential to the n8n workflow before running more than ~50 leads.
"""
import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ["company", "domain", "human_score", "http", "status", "final_score", "llm_score",
          "rule_tier", "score_source", "llm_status", "llm_error", "needs_review", "opener_dropped", "reason", "errors"]


def post(url, payload, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except Exception as e:  # network trouble: record it, keep going
        return 0, {"status": "client_error", "errors": [str(e)]}


def run(url, leads_path, out_path, delay):
    rows = list(csv.DictReader(open(leads_path, newline="")))
    out = []
    for i, row in enumerate(rows, 1):
        payload = {k: row[k] for k in ("company", "domain", "github_org", "contact_name", "contact_email", "source")}
        http, res = post(url, payload)
        out.append({
            "company": row["company"], "domain": row["domain"], "human_score": row["human_score"],
            "http": http, "status": res.get("status", ""), "final_score": res.get("final_score", ""),
            "llm_score": res.get("llm_score", ""), "rule_tier": res.get("rule_tier", ""),
            "score_source": res.get("score_source", ""), "llm_status": res.get("llm_status", ""), "llm_error": res.get("llm_error", "") or "",
            "needs_review": res.get("needs_review", ""), "opener_dropped": res.get("opener_dropped", ""),
            "reason": res.get("reason", "") or "", "errors": "; ".join(res.get("errors", []) or []),
        })
        print(f"[{i}/{len(rows)}] {row['company'][:28]:<28} http={http} status={out[-1]['status']} score={out[-1]['final_score']}")
        time.sleep(delay)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(out)
    print("saved", out_path)
    return out


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(a, b):
    if len(a) < 3:
        return None
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = (sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb)) ** 0.5
    return num / den if den else None


def metrics(human, pred):
    n = len(human)
    if n == 0:
        return None
    exact = sum(h == p for h, p in zip(human, pred)) / n
    within1 = sum(abs(h - p) <= 1 for h, p in zip(human, pred)) / n
    mae = sum(abs(h - p) for h, p in zip(human, pred)) / n
    tp = sum(h >= 4 and p >= 4 for h, p in zip(human, pred))
    fp = sum(h < 4 and p >= 4 for h, p in zip(human, pred))
    fn = sum(h >= 4 and p < 4 for h, p in zip(human, pred))
    return {"n": n, "exact": exact, "within1": within1, "mae": mae,
            "hot_precision": tp / (tp + fp) if tp + fp else None,
            "hot_recall": tp / (tp + fn) if tp + fn else None,
            "spearman": spearman(human, pred)}


def fmt(v):
    return "n/a" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))


def report(rows):
    total = len(rows)
    statuses = Counter(r["status"] or "no_response" for r in rows)
    print(f"\nLeads sent: {total}")
    print("Outcomes:", dict(statuses))
    fallback = sum(r["score_source"] == "rules_fallback" for r in rows)
    print(f"LLM fallbacks to rules: {fallback}")

    labeled = [r for r in rows if str(r["human_score"]).strip() and r["status"] == "scored"]
    unlabeled = sum(1 for r in rows if r["status"] == "scored" and not str(r["human_score"]).strip())
    if unlabeled:
        print(f"Scored but not labeled by you (excluded): {unlabeled}")
    if not labeled:
        print("\nNo labeled + scored rows yet. Fill human_score (1-5) in data/leads.csv and re-run.")
        return
    human = [int(r["human_score"]) for r in labeled]
    print(f"\nCompared against your labels (n={len(labeled)}):")
    print(f"{'scorer':<14}{'exact':>7}{'within1':>9}{'MAE':>7}{'hotP':>7}{'hotR':>7}{'spearman':>10}")
    for name, key in (("final", "final_score"), ("llm only", "llm_score"), ("rules only", "rule_tier")):
        pairs = [(h, int(r[key])) for h, r in zip(human, labeled) if str(r[key]).strip() not in ("", "None")]
        m = metrics([p[0] for p in pairs], [p[1] for p in pairs])
        if m:
            print(f"{name:<14}{fmt(m['exact']):>7}{fmt(m['within1']):>9}{fmt(m['mae']):>7}"
                  f"{fmt(m['hot_precision']):>7}{fmt(m['hot_recall']):>7}{fmt(m['spearman']):>10}   (n={m['n']})")
    print("\nConfusion matrix, final score (rows = your label, cols = pipeline):")
    print("      " + " ".join(f"{c:>3}" for c in range(1, 6)))
    for h in range(1, 6):
        cells = [sum(1 for hh, r in zip(human, labeled) if hh == h and str(r["final_score"]) == str(c)) for c in range(1, 6)]
        print(f"  {h}:  " + " ".join(f"{c:>3}" for c in cells))
    print("\nReminder: small n means wide error bars. Report n next to every number.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5678/webhook/lead-intake")
    ap.add_argument("--leads", default=str(ROOT / "data" / "leads.csv"))
    ap.add_argument("--out", default=str(ROOT / "eval" / "results.csv"))
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    ap.add_argument("--report-only", metavar="RESULTS_CSV")
    a = ap.parse_args()
    if a.report_only:
        rows = list(csv.DictReader(open(a.report_only, newline="")))
    else:
        rows = run(a.url, a.leads, a.out, a.delay)
    report(rows)
