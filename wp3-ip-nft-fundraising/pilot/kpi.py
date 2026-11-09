"""Technical pilot (D3.3), step 1: compute milestone KPIs of a digital twin from its own data.

Uses the WP2 data-flow module: a robot-arm twin is simulated, readings pass the edge pipeline
(windowing, anomaly detection) and are sealed into Merkle batches linked by a hash chain. Each
KPI is computed by a published function from these data, and the evidence hash commits to the
KPI identifier, its value (basis points) and the head of the batch hash chain. A watcher who
holds the same data can recompute every value. Writes evidence.json.
Usage: python kpi.py
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "wp2-big-data-flows"))
from dedt_flows.pipeline import run
from dedt_flows.simulator import SimulationConfig
from Crypto.Hash import keccak

def k256(b: bytes) -> bytes:
    h = keccak.new(digest_bits=256); h.update(b); return h.digest()

def kid(name: str) -> bytes:
    return k256(name.encode())

def evidence(kpi: str, value_bps: int, chain_head: bytes) -> str:
    return "0x" + k256(kid(kpi) + value_bps.to_bytes(32, "big", signed=True) + chain_head).hex()

def kpis(res):
    m = res.metrics()
    return {
        "completeness": round(10_000 * (1 - m["loss_ratio"])),
        "anomaly_f1": round(10_000 * m["anomaly_detection"]["f1"]),
        "reduction": round(m["reduction_factor"]),           # plain factor, target 100
    }, res.builder.batches[-1].chain

out = {"milestones": [
    {"kpi": "completeness", "target": 9900, "unit": "bps", "label": "M1 data pipeline: completeness >= 99%"},
    {"kpi": "anomaly_f1", "target": 8000, "unit": "bps", "label": "M2 analytics: anomaly-detection F1 >= 0.80"},
    {"kpi": "reduction", "target": 100, "unit": "x", "label": "M3 scale-up: data reduction >= 100x"},
]}
runs = {}
for name, det in (("published", None), ("misconfigured", {"k": 12})):
    res = run(SimulationConfig(duration_s=30, seed=21), detector=det)
    vals, head = kpis(res)
    runs[name] = {"values": vals, "chainHead": "0x" + head.hex(), "batches": len(res.builder.batches),
                  "readings": res.metrics()["readings_received"],
                  "evidence": {k: evidence(k, v, head) for k, v in vals.items()}}
out["runs"] = runs
out["kpiIds"] = {k["kpi"]: "0x" + kid(k["kpi"]).hex() for k in out["milestones"]}
Path(__file__).with_name("evidence.json").write_text(json.dumps(out, indent=2))
print(json.dumps({n: r["values"] for n, r in runs.items()}))
