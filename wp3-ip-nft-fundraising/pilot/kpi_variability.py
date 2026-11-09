"""D3.3 viability study (H1): how variable are milestone KPIs computed from twin data?
Runs the WP2 robot-arm twin with 40 independent seeds and reports the distribution of each KPI,
the probability of meeting the D3.3 targets, and a target that the twin meets with 90% probability.
Writes kpi_variability.json.  Usage: python pilot/kpi_variability.py"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "wp2-big-data-flows"))
from dedt_flows.pipeline import run
from dedt_flows.simulator import SimulationConfig
targets = {"completeness": 0.99, "anomaly_f1": 0.80, "reduction": 100}
vals = {k: [] for k in targets}
for seed in range(100, 140):
    m = run(SimulationConfig(duration_s=30, seed=seed)).metrics()
    vals["completeness"].append(1 - m["loss_ratio"]); vals["anomaly_f1"].append(m["anomaly_detection"]["f1"]); vals["reduction"].append(m["reduction_factor"])
out = {}
for k, v in vals.items():
    a = np.array(v)
    out[k] = {"mean": float(a.mean()), "sd": float(a.std(ddof=1)), "min": float(a.min()), "p10": float(np.percentile(a, 10)), "max": float(a.max()),
              "pMeet": float((a >= targets[k]).mean()), "target": targets[k], "values": [float(x) for x in a]}
Path(__file__).with_name("kpi_variability.json").write_text(json.dumps(out, indent=1))
for k, o in out.items(): print(k, {x: round(o[x], 4) for x in ("mean", "sd", "min", "p10", "max", "pMeet")})
