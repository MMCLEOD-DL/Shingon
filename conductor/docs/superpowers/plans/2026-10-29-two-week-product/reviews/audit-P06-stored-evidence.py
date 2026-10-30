"""Read-only audit of committed P06 evidence; no database or models.

Exit 1 means latency totals or their prose breakdown disagree with stored evidence/source.
This checks stored observations, not their underlying retrieval execution.
"""
import ast
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
maximum = re.search(r"maximum ([\d.]+) ms", prose)
maximum_matches = maximum is not None and float(maximum[1]) == latency["max"]
print(f"Maximum prose matches saved summary: {maximum_matches}")

# Counting only the aggregate hides 2*25*6 versus the actual 3*25*4 sweeps.
# Inspect Python syntax without importing the evaluator or contacting PostgreSQL.
tree = ast.parse((base / "evaluate.py").read_text(encoding="utf-8"))
creds = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "creds")
credential_dict = next(node.value for node in creds.body if isinstance(node, ast.Return))
assert isinstance(credential_dict, ast.Dict), "credential construction changed: inspect manually"
credential_count = len(credential_dict.keys)
sweep_calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
               and isinstance(node.func, ast.Name) and node.func.id == "sweep"]
sweep_checks = [check for check in data["checks"] if check["check"].startswith("no unauthorised result (")]
assert len(sweep_calls) == len(sweep_checks) == 3
question_count = len(json.loads((base / "questions.json").read_text(encoding="utf-8"))["questions"])
assert all(check["detail"] == f"0 unauthorised results in {question_count * credential_count} searches"
           for check in sweep_checks)
actual_breakdown = (len(sweep_calls), question_count, credential_count)
breakdown = re.search(r"plus (\d+) permission sweeps × (\d+) questions × (\d+) credentials", prose)
assert breakdown, "latency breakdown missing or changed: inspect manually"
reported_breakdown = tuple(int(value) for value in breakdown.groups())
assert question_count * len(data["questions"]) + len(sweep_calls) * question_count * credential_count == latency["searches"]
print(f"Permission sweep breakdown prose={reported_breakdown}; source/stored checks={actual_breakdown}")
raise SystemExit(0 if reported == saved and maximum_matches and reported_breakdown == actual_breakdown else 1)
