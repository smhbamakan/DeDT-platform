"""End-to-end data flow: simulate → edge (reorder, detect, aggregate) → integrity batches.

    python -m dedt_flows.pipeline --duration 60 --out out

writes
    out/anchors.json        batch records to anchor on-chain (chain/scripts/anchor.js)
    out/summary.json        flow metrics
    chain/test/fixtures/batch.json   one batch with readings and Merkle proofs (Solidity tests)
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

from .edge import SUMMARY_BYTES, EdgeAggregator, detection_scores
from .encoding import name_id, to_micro
from .integrity import BatchBuilder
from .simulator import SimulationConfig, simulate

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class FlowResult:
    cfg: SimulationConfig
    edge: EdgeAggregator
    builder: BatchBuilder
    summaries: list
    seconds: float

    def metrics(self) -> dict:
        s = self.edge.stats
        raw_bytes = s.received * 160
        summary_bytes = len(self.summaries) * SUMMARY_BYTES
        expected = sum(int(self.cfg.duration_s * x.rate_hz) for x in self.cfg.sensors)
        return {
            "sensors": len(self.cfg.sensors),
            "duration_s": self.cfg.duration_s,
            "readings_generated": expected,
            "readings_received": s.received,
            "loss_ratio": 1 - s.received / expected,
            "late_ratio": s.late / s.received,
            "out_of_order_ratio": out_of_order_ratio(self),
            "windows": len(self.summaries),
            "raw_bytes": raw_bytes,
            "summary_bytes": summary_bytes,
            "reduction_factor": raw_bytes / summary_bytes if summary_bytes else 0,
            "batches": len(self.builder.batches),
            "throughput_readings_per_s": s.received / self.seconds if self.seconds else 0,
            "anomaly_detection": detection_scores(s.flagged),
        }


def out_of_order_ratio(res: FlowResult) -> float:
    last: dict[str, int] = {}
    swapped = total = 0
    for b in res.builder.batches:
        for r in b.readings:
            total += 1
            if r.t_event_ms < last.get(r.sensor, -1):
                swapped += 1
            last[r.sensor] = max(last.get(r.sensor, -1), r.t_event_ms)
    return swapped / total if total else 0.0


def run(cfg: SimulationConfig, window_ms: int = 1000, lateness_ms: int = 200, batch_readings: int = 1024, batch_interval_ms: int = 1000, detector: dict | None = None) -> FlowResult:
    edge = EdgeAggregator(window_ms, lateness_ms, detector)
    builder = BatchBuilder(batch_readings, batch_interval_ms)
    summaries: list = []
    t0 = time.perf_counter()
    for r in simulate(cfg):
        closed = edge.process(r)
        summaries.extend(closed)
        builder.add(r, closed)
    closed = edge.flush()
    summaries.extend(closed)
    builder.flush(closed)
    return FlowResult(cfg, edge, builder, summaries, time.perf_counter() - t0)


def write_fixture(res: FlowResult, path: Path, n: int = 8) -> None:
    """One batch with a few readings and their proofs, to check Solidity ↔ Python compatibility."""
    b = res.builder.batches[0]
    items = []
    for i in range(min(n, b.count)):
        r = b.readings[i]
        items.append({
            "sensor": r.sensor,
            "sensorId": "0x" + name_id(r.sensor).hex(),
            "seq": r.seq,
            "tEventMs": r.t_event_ms,
            "valueMicro": str(to_micro(r.value)),
            "proof": ["0x" + p.hex() for p in b.proof(i)],
        })
    fixture = {"twin": res.cfg.twin, "batch": b.to_anchor(res.cfg.twin), "readings": items, "next": res.builder.batches[1].to_anchor(res.cfg.twin)}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, indent=2))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--duration", type=float, default=60.0)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--window-ms", type=int, default=1000)
    ap.add_argument("--batch-readings", type=int, default=1024)
    ap.add_argument("--batch-interval-ms", type=int, default=1000)
    ap.add_argument("--out", type=Path, default=ROOT / "out")
    args = ap.parse_args(argv)

    cfg = SimulationConfig(duration_s=args.duration, seed=args.seed)
    res = run(cfg, window_ms=args.window_ms, batch_readings=args.batch_readings, batch_interval_ms=args.batch_interval_ms)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "anchors.json").write_text(json.dumps([b.to_anchor(cfg.twin) for b in res.builder.batches], indent=2))
    m = res.metrics()
    (args.out / "summary.json").write_text(json.dumps(m, indent=2))
    write_fixture(res, ROOT / "chain" / "test" / "fixtures" / "batch.json")

    print(f"twin {cfg.twin}: {m['sensors']} sensors, {m['duration_s']:.0f} s")
    print(f"  received {m['readings_received']:,} readings (loss {m['loss_ratio']:.2%}, out of order {m['out_of_order_ratio']:.1%}, late {m['late_ratio']:.2%})")
    print(f"  edge: {m['windows']:,} window summaries, data reduction x{m['reduction_factor']:.0f}")
    d = m["anomaly_detection"]
    print(f"  anomalies: precision {d['precision']:.2f}, recall {d['recall']:.2f}, F1 {d['f1']:.2f}")
    print(f"  integrity: {m['batches']} batches anchored by Merkle root + hash chain")
    print(f"  throughput {m['throughput_readings_per_s']:,.0f} readings/s (single Python process)")
    print(f"wrote {args.out / 'anchors.json'}")


if __name__ == "__main__":
    main()
