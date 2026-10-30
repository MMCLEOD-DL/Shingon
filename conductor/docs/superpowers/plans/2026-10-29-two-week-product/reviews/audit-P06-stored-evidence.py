"""Read-only audit of committed P06 evidence; no database or models.

Exit 1 means the evaluation latency prose differs from the saved result summary.
This checks stored observations, not their underlying retrieval execution.
"""
import json
import re
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[6]
base = root / "conductor/spikes/knowledge-base-evaluation"
data = json.loads((base / "results/results.json").read_text(encoding="utf-8"))
for name, rows in data["questions"].items():
    saved = data["summary"]["variants"][name]
    categories = Counter(row["category"] for row in rows)
    correct_categories = Counter(row["category"] for row in rows if row["correct"])
    assert saved["questions"] == len(rows) == 25
    assert saved["allCorrect"] == sum(row["correct"] for row in rows)
    assert saved["byCategory"] == {
        key: f"{correct_categories[key]}/{count}" for key, count in categories.items()
    }
    print(f"PASS {name}: {saved['allCorrect']}/{len(rows)}; all category counts agree")
assert len(data["checks"]) == data["summary"]["checks"] == 21
assert sum(check["ok"] for check in data["checks"]) == data["summary"]["checksPassed"] == 21
print("PASS 21/21 stored checks; not a new execution of those checks")
prose = (root / "conductor/docs/knowledge-base/evaluation.md").read_text(encoding="utf-8")
match = re.search(r"Latency over (\d+) searches: p50 ([\d.]+) ms, p95 ([\d.]+) ms", prose)
assert match, "latency sentence missing or changed: inspect manually"
reported = tuple(float(value) for value in match.groups())
latency = data["summary"]["latencyMs"]
saved = (latency["searches"], latency["p50"], latency["p95"])
print(f"Latency prose={reported}; saved summary={saved}")
print("Quantiles not independently recomputed: all 350 timing samples are not stored")
raise SystemExit(0 if reported == saved else 1)
