"""Figures for the WP4 README from results/bench.json (Python) and results/gas.json (Hardhat).
Usage: python analysis/make_figures.py  → docs/figures/wp4-*-{light,dark}.png
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIG = ROOT / "docs" / "figures"
BENCH = json.loads((ROOT / "results" / "bench.json").read_text())
GAS = json.loads((ROOT / "results" / "gas.json").read_text())

THEMES = {
    "light": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9", axis="#c3c2b7", series=["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]),
    "dark": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a", axis="#383835", series=["#3987e5", "#d95926", "#199e70", "#c98500"]),
}
kgas = FuncFormatter(lambda v, _: f"{v / 1000:.0f}k")


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


def batch_gas(t, mode):
    rows = GAS["dataAuthenticator"]["submitBatch"]
    k = [r["signers"] for r in rows]
    g = [r["gas"] for r in rows]
    fig, ax = plt.subplots(figsize=(7.2, 3.4))
    ax.plot(k, g, color=t["series"][0], lw=2, marker="o", ms=7, mec=t["surface"], mew=2, zorder=3)
    for x, y in zip(k, g):
        ax.annotate(f"{y / 1000:.0f}k", (x, y), textcoords="offset points", xytext=(0, 9), ha="center", fontsize=8.5, color=t["ink"])
    slope = (g[-1] - g[2]) / (k[-1] - k[2])
    ax.text(0.02, 0.06, f"≈ {g[0] - slope:,.0f} gas fixed (pairing check, hash to curve)\n+ ≈ {slope:,.0f} gas per co-signer (G1 addition)",
            transform=ax.transAxes, fontsize=8.5, color=t["ink2"])
    ax.set_xscale("log", base=2)
    ax.set_xticks(k, [str(x) for x in k])
    ax.set_ylim(0, max(g) * 1.18)
    ax.yaxis.set_major_formatter(kgas)
    ax.set_xlabel("co-signers of the batch (threshold = all)")
    ax.set_ylabel("gas per submitted batch")
    ax.set_title("One aggregated signature per batch: a fixed pairing cost plus ≈ 5k gas per co-signer")
    save(fig, "wp4-batch-gas", mode)


def ibe_vs_ecies(t, mode):
    e = BENCH["encryption_ms"]
    labels = ["Encrypt", "Decrypt"]
    ibe = [e["IBE encrypt"], e["IBE decrypt"]]
    ec = [e["ECIES encrypt"], e["ECIES decrypt"]]
    fig, axes = plt.subplots(1, 2, figsize=(9.6, 3.0), gridspec_kw={"width_ratios": [1.6, 1]})
    ax = axes[0]
    y = [1, 0]
    h = 0.36
    ax.barh([v + h / 2 for v in y], ibe, h, color=t["series"][0], label="IBE (Boneh–Franklin, BN254, pure Python)", edgecolor=t["surface"], lw=2)
    ax.barh([v - h / 2 for v in y], ec, h, color=t["series"][1], label="ECIES (secp256k1, native library)", edgecolor=t["surface"], lw=2)
    for v, a, b in zip(y, ibe, ec):
        ax.text(a * 1.15, v + h / 2, f"{a:,.0f} ms", va="center", fontsize=8.5, color=t["ink"])
        ax.text(b * 1.15, v - h / 2, f"{b:.2f} ms", va="center", fontsize=8.5, color=t["ink"])
    ax.set_xscale("log")
    ax.set_xlim(min(ec) / 3, max(ibe) * 12)
    ax.set_yticks(y, labels)
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", length=0)
    ax.set_xlabel("time per 1 KB message (median, log scale)")
    ax.legend(loc="lower right", fontsize=8)
    ax.set_title("Time")
    ax = axes[1]
    ov = BENCH["overhead_bytes"]
    ax.bar(["IBE", "ECIES"], [ov["IBE"], ov["ECIES"]], color=[t["series"][0], t["series"][1]], width=0.55, edgecolor=t["surface"], lw=2)
    for i, v in enumerate([ov["IBE"], ov["ECIES"]]):
        ax.text(i, v + 4, f"{v} B", ha="center", fontsize=9, color=t["ink"])
    ax.set_ylim(0, ov["IBE"] * 1.25)
    ax.set_ylabel("bytes added per message")
    ax.grid(axis="x", visible=False)
    ax.set_title("Ciphertext overhead")
    fig.suptitle("IBE needs no recipient key lookup, at the cost of a pairing and 127 extra bytes",
                 x=0.01, ha="left", color=t["ink"], fontsize=11.5, fontweight="bold")
    fig.tight_layout()
    save(fig, "wp4-ibe-vs-ecies", mode)


def zkp_gas(t, mode):
    rows = GAS["birthCertificate"]["prove"]
    bc = GAS["birthCertificate"]
    fig, ax = plt.subplots(figsize=(7.2, 3.2))
    xs = [r["disclosed"] for r in rows]
    ys = [r["gas"] for r in rows]
    ax.bar(xs, ys, color=t["series"][2], width=0.6, edgecolor=t["surface"], lw=2)
    for x, y in zip(xs, ys):
        ax.text(x, y + 2500, f"{y / 1000:.1f}k", ha="center", fontsize=8.5, color=t["ink"])
    ax.axhline(bc["rotate"], color=t["series"][3], lw=1.5, ls="--", label=f"rotate commitment after a sale ({bc['rotate'] / 1000:.0f}k)")
    ax.legend(loc="upper left", fontsize=8.5)
    ax.set_ylim(0, max(ys) * 1.32)
    ax.yaxis.set_major_formatter(kgas)
    ax.set_xticks(xs)
    ax.set_xlabel("attributes disclosed (of 6); the others stay hidden")
    ax.set_ylabel("gas per proof")
    ax.grid(axis="x", visible=False)
    ax.set_title("Zero-knowledge birth-certificate proofs cost ≈ 135k gas, no trusted setup")
    save(fig, "wp4-zkp-gas", mode)


def dkg_time(t, mode):
    d = BENCH["dkg_ms"]
    n = [int(k) for k in d]
    ms = [d[k]["ms"] / 1000 for k in d]
    fig, ax = plt.subplots(figsize=(6.4, 3.0))
    ax.plot(n, ms, color=t["series"][0], lw=2, marker="o", ms=7, mec=t["surface"], mew=2)
    for x, y, k in zip(n, ms, d):
        ax.annotate(f"t={d[k]['t']}: {y:.1f} s", (x, y), textcoords="offset points", xytext=(9, -4), ha="left", fontsize=8.5, color=t["ink"])
    ax.set_xticks(n)
    ax.set_xlim(2.5, 10.2)
    ax.set_ylim(0, max(ms) * 1.25)
    ax.set_xlabel("key servers n  (threshold t = ⌊2n/3⌋ + 1)")
    ax.set_ylabel("seconds (whole network, simulated)")
    ax.set_title("Distributed key generation runs once per key-server set")
    save(fig, "wp4-dkg-time", mode)


if __name__ == "__main__":
    for mode, t in THEMES.items():
        style(t)
        batch_gas(t, mode)
        ibe_vs_ecies(t, mode)
        zkp_gas(t, mode)
        dkg_time(t, mode)
    print("figures written to", FIG)
