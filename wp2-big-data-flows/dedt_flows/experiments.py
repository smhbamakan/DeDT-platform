"""Experiments for WP2 (D2.2, D2.3): figures and numbers for the README.

    python -m dedt_flows.experiments          # after `cd chain && npm run anchor`

E1  Volume and velocity of a twin's data flow (T2.1)
E2  Data reduction at the edge vs window length (T2.3, T2.4)
E3  On-chain cost per reading and proof size vs batch size (T2.2), from measured anchor gas
E4  Anomaly detection: precision / recall / F1 vs threshold, held-out seed (T2.4)
E5  Throughput vs number of sensors (velocity scalability)
E6  Tamper detection: modification, deletion, insertion, reordering, timestamp change (T2.2)

Figures are written in a light and a dark variant to docs/figures, numbers to results/experiments.json.
"""
from __future__ import annotations

import dataclasses
import json
import math
import random
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from .edge import SUMMARY_BYTES, detection_scores  # noqa: E402
from .integrity import audit  # noqa: E402
from .pipeline import run  # noqa: E402
from .simulator import ROBOT_ARM, SensorSpec, SimulationConfig  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIG = ROOT / "docs" / "figures"
RES = ROOT / "results"

THEMES = {
    "light": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9", axis="#c3c2b7", series=["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]),
    "dark": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a", axis="#383835", series=["#3987e5", "#d95926", "#199e70", "#c98500"]),
}


def style(t):
    plt.rcParams.update({
        "figure.facecolor": t["surface"], "axes.facecolor": t["surface"], "savefig.facecolor": t["surface"],
        "axes.edgecolor": t["axis"], "axes.labelcolor": t["ink2"], "axes.titlecolor": t["ink"], "axes.titlesize": 11.5,
        "axes.titleweight": "bold", "axes.titlelocation": "left", "axes.grid": True, "grid.color": t["grid"],
        "grid.linewidth": 0.8, "axes.spines.top": False, "axes.spines.right": False, "axes.axisbelow": True,
        "xtick.color": t["muted"], "ytick.color": t["muted"], "xtick.labelcolor": t["ink2"], "ytick.labelcolor": t["ink2"],
        "font.family": "DejaVu Sans", "font.size": 9.5, "legend.frameon": False, "legend.labelcolor": t["ink2"],
    })


def save(fig, name, mode):
    FIG.mkdir(parents=True, exist_ok=True)
    fig.savefig(FIG / f"{name}-{mode}.png", dpi=160, bbox_inches="tight", pad_inches=0.2)
    plt.close(fig)


# ------------------------------------------------------------------ experiments (data)
def e1_volume():
    rows = []
    for s in ROBOT_ARM:
        per_day = s.rate_hz * 86400
        rows.append({"sensor": s.name, "unit": s.unit, "rate_hz": s.rate_hz, "readings_per_day": per_day, "mb_per_day": per_day * 160 / 1e6})
    return rows


def e2_reduction():
    out = []
    for w in [100, 250, 500, 1000, 2000, 5000, 10000]:
        res = run(SimulationConfig(duration_s=60, seed=7), window_ms=w)
        m = res.metrics()
        out.append({"window_ms": w, "reduction": m["reduction_factor"], "windows": m["windows"]})
    return out


def e3_cost(anchor):
    g = anchor["gasPerAnchor"]
    rows = []
    for n in [16, 64, 256, 1024, 4096, 16384, 65536]:
        depth = math.ceil(math.log2(n))
        rows.append({"batch": n, "gas_per_reading": g / n, "proof_bytes": 32 * depth})
    return rows


def e4_detection():
    out = {}
    for order in (1, 2):
        out[order] = []
        for k in [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0]:
            res = run(SimulationConfig(duration_s=60, seed=7), detector={"k": k, "order": order})
            d = detection_scores(res.edge.stats.flagged)
            out[order].append({"k": k, **{x: d[x] for x in ("precision", "recall", "f1")}})
    return out


def e5_throughput():
    out = []
    for copies in [1, 2, 4, 8]:
        sensors = tuple(SensorSpec(**{**dataclasses.asdict(s), "name": f"{s.name}#{c}"}) for c in range(copies) for s in ROBOT_ARM)
        res = run(SimulationConfig(duration_s=20, seed=3, sensors=sensors))
        m = res.metrics()
        out.append({"sensors": len(sensors), "throughput": m["throughput_readings_per_s"], "input_rate": m["readings_received"] / 20})
    return out


def e6_tamper(trials=50):
    res = run(SimulationConfig(duration_s=30, seed=9), batch_readings=512, batch_interval_ms=1000)
    anchors = [b.to_anchor(res.cfg.twin) for b in res.builder.batches]
    log = [list(b.readings) for b in res.builder.batches]
    rng = random.Random(1)
    kinds = {}

    def check(name, mutate, expect_batch=True):
        detected = located = 0
        for _ in range(trials):
            k = rng.randrange(len(log))
            tampered, anc, target = mutate([list(b) for b in log], list(anchors), k)
            a = audit(tampered, anc)
            detected += not a.ok
            located += (a.bad_batches == [target]) if expect_batch else (not a.chain_ok)
        kinds[name] = {"trials": trials, "detected": detected / trials, "localised": located / trials}

    def modify(lg, an, k):
        i = rng.randrange(len(lg[k]))
        lg[k][i] = dataclasses.replace(lg[k][i], value=lg[k][i].value + 1e-6)
        return lg, an, k

    def delete(lg, an, k):
        del lg[k][rng.randrange(len(lg[k]))]
        return lg, an, k

    def insert(lg, an, k):
        r = lg[k][rng.randrange(len(lg[k]))]
        lg[k].append(dataclasses.replace(r, seq=r.seq + 10**6))
        return lg, an, k

    def timestamp(lg, an, k):
        i = rng.randrange(len(lg[k]))
        lg[k][i] = dataclasses.replace(lg[k][i], t_event_ms=lg[k][i].t_event_ms + 1)
        return lg, an, k

    def reorder(lg, an, k):
        k = min(k, len(lg) - 2)
        lg[k], lg[k + 1] = lg[k + 1], lg[k]
        an[k], an[k + 1] = an[k + 1], an[k]  # an attacker reorders log and records consistently
        return lg, an, k

    check("Modify a value by 10⁻⁶", modify)
    check("Delete a reading", delete)
    check("Insert a forged reading", insert)
    check("Shift a timestamp by 1 ms", timestamp)
    check("Swap two batches", reorder, expect_batch=False)
    return kinds


# ------------------------------------------------------------------ figures
def figures(data):
    for mode, t in THEMES.items():
        style(t)
        c = t["series"]

        rows = data["volume"]
        fig, ax = plt.subplots(figsize=(7.2, 3.2))
        names = [r["sensor"] for r in rows][::-1]
        vals = [r["mb_per_day"] for r in rows][::-1]
        ax.barh(names, vals, height=0.6, color=c[0], edgecolor=t["surface"], linewidth=2)
        for y, v in enumerate(vals):
            ax.text(v + max(vals) * 0.015, y, f"{v:,.0f} MB", va="center", color=t["ink"], fontsize=9)
        ax.set_xlim(0, max(vals) * 1.18)
        ax.grid(axis="y", visible=False)
        ax.tick_params(axis="y", length=0)
        ax.set_xlabel("raw data per day (MB, 160-byte records)")
        ax.set_title(f"One robot-arm twin produces {sum(vals) / 1000:.1f} GB of raw readings a day")
        save(fig, "wp2-volume", mode)

        red = data["reduction"]
        fig, ax = plt.subplots(figsize=(7.2, 3.2))
        x = [r["window_ms"] / 1000 for r in red]
        y = [r["reduction"] for r in red]
        ax.plot(x, y, color=c[0], lw=2, marker="o", ms=6, mec=t["surface"], mew=2)
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xticks(x, [f"{v:g}" for v in x])
        for xi, yi in [(x[0], y[0]), (x[3], y[3]), (x[-1], y[-1])]:
            ax.annotate(f"×{yi:,.0f}", xy=(xi, yi), xytext=(0, 9), textcoords="offset points", ha="center", color=t["ink"], fontsize=9)
        ax.set_xlabel("edge window length (s)")
        ax.set_ylabel("raw bytes / summary bytes")
        ax.set_title("Edge aggregation reduces the upstream data volume")
        save(fig, "wp2-reduction", mode)

        cost = data["cost"]
        fig, axes = plt.subplots(1, 2, figsize=(9.5, 3.2))
        n = [r["batch"] for r in cost]
        axes[0].plot(n, [r["gas_per_reading"] for r in cost], color=c[0], lw=2, marker="o", ms=6, mec=t["surface"], mew=2)
        axes[0].set_xscale("log", base=2)
        axes[0].set_yscale("log")
        axes[0].set_title("On-chain gas per reading", fontsize=10.5)
        axes[0].set_xlabel("readings per batch")
        axes[1].plot(n, [r["proof_bytes"] for r in cost], color=c[0], lw=2, marker="o", ms=6, mec=t["surface"], mew=2)
        axes[1].set_xscale("log", base=2)
        axes[1].set_title("Proof size for one reading (bytes)", fontsize=10.5)
        axes[1].set_xlabel("readings per batch")
        fig.suptitle(f"Batching: anchoring cost is constant ({data['anchor']['gasPerAnchor']:,} gas per batch), proofs grow with log₂ n",
                     x=0.01, ha="left", color=t["ink"], fontsize=11.5, fontweight="bold")
        fig.tight_layout()
        save(fig, "wp2-batching", mode)

        det = data["detection"]
        fig, axes = plt.subplots(1, 2, figsize=(9.5, 3.4), sharey=True)
        for ax, order, title in zip(axes, (1, 2), ("First difference (default)", "Second difference")):
            ks = [r["k"] for r in det[order]]
            for key, col, lab in (("precision", c[0], "precision"), ("recall", c[1], "recall"), ("f1", c[2], "F1")):
                ax.plot(ks, [r[key] for r in det[order]], color=col, lw=2, label=lab)
            ax.axvline(4.5, color=t["muted"], lw=1)
            ax.set_title(title, fontsize=10.5)
            ax.set_xlabel("threshold k (standard deviations)")
            ax.set_ylim(0, 1.05)
        axes[0].legend(loc="lower right", fontsize=9)
        fig.suptitle("Anomaly detection on a held-out run (seed 7); vertical line = default k", x=0.01, ha="left", color=t["ink"], fontsize=11.5, fontweight="bold")
        fig.tight_layout()
        save(fig, "wp2-detection", mode)

        thr = data["throughput"]
        fig, ax = plt.subplots(figsize=(7.2, 3.2))
        s = [r["sensors"] for r in thr]
        ax.plot(s, [r["throughput"] for r in thr], color=c[0], lw=2, marker="o", ms=6, mec=t["surface"], mew=2, label="processing capacity")
        ax.plot(s, [r["input_rate"] for r in thr], color=c[1], lw=2, marker="o", ms=6, mec=t["surface"], mew=2, label="input rate of the twin")
        ax.set_xlabel("sensors")
        ax.set_ylabel("readings per second")
        ax.set_ylim(0, max(r["throughput"] for r in thr) * 1.2)
        head = min(r["throughput"] / r["input_rate"] for r in thr)
        ax.set_title(f"One Python edge process: at least {head:.1f}× headroom up to {max(s)} sensors")
        ax.legend(loc="upper left", fontsize=9)
        save(fig, "wp2-throughput", mode)


def main():
    anchor = json.loads((RES / "anchor-gas.json").read_text())
    data = {
        "volume": e1_volume(),
        "reduction": e2_reduction(),
        "anchor": anchor,
        "cost": e3_cost(anchor),
        "detection": e4_detection(),
        "throughput": e5_throughput(),
        "tamper": e6_tamper(),
    }
    figures(data)
    RES.mkdir(exist_ok=True)
    (RES / "experiments.json").write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(json.dumps({k: data[k] for k in ("reduction", "throughput", "tamper")}, indent=1, ensure_ascii=False))
    best = max(data["detection"][1], key=lambda r: r["f1"])
    print("best F1 (order 1):", best)


if __name__ == "__main__":
    main()
