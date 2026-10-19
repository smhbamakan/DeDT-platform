"""Figures for the WP1 README.

Two data sources:
  * results/gas.json - gas measured on our L3 prototype (npm run benchmark)
  * values transcribed from Banaeian Far & Hosseini Bamakan (2025), Advanced Engineering
    Informatics 68, 103616: Table 7 (mechanism profile), Table 17 (complexity) and
    Table 23 (simulated latency/cost).

Each figure is written in a light and a dark variant (docs/figures/<name>-light.png / -dark.png)
so the README can follow GitHub's theme. Usage: python analysis/make_figures.py
"""
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "figures"
GAS = json.loads((ROOT / "results" / "gas.json").read_text())

# Validated reference palette (categorical slots 1-4, chrome and ink), light and dark steps.
THEMES = {
    "light": dict(
        surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9", axis="#c3c2b7",
        series=["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], other="#c3c2b7",
        ramp=["#86b6ef", "#5598e7", "#256abf", "#104281"],  # ordinal blue, steps 250-650
    ),
    "dark": dict(
        surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a", axis="#383835",
        series=["#3987e5", "#d95926", "#199e70", "#c98500"], other="#52514e",
        ramp=["#184f95", "#1c5cab", "#3987e5", "#86b6ef"],  # ordinal blue, anchored for the dark surface
    ),
}


def style(t):
    plt.rcParams.update({
        "figure.facecolor": t["surface"], "axes.facecolor": t["surface"], "savefig.facecolor": t["surface"],
        "axes.edgecolor": t["axis"], "axes.labelcolor": t["ink2"], "axes.titlecolor": t["ink"],
        "axes.titlesize": 12, "axes.titleweight": "bold", "axes.titlelocation": "left", "axes.titlepad": 12,
        "axes.labelsize": 10, "axes.grid": True, "grid.color": t["grid"], "grid.linewidth": 0.8,
        "axes.spines.top": False, "axes.spines.right": False, "axes.axisbelow": True,
        "xtick.color": t["muted"], "ytick.color": t["muted"], "xtick.labelcolor": t["ink2"], "ytick.labelcolor": t["ink2"],
        "font.family": "DejaVu Sans", "font.size": 10, "legend.frameon": False, "legend.labelcolor": t["ink2"],
    })


def save(fig, name, mode):
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f"{name}-{mode}.png", dpi=160, bbox_inches="tight", pad_inches=0.25)
    plt.close(fig)


def luminance(hex_color):
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def best_text(fill):
    """Dark or white text, whichever has the higher WCAG contrast on `fill`."""
    lf = luminance(fill)
    dark = (lf + 0.05) / (luminance("#0b0b0b") + 0.05)
    white = 1.05 / (lf + 0.05)
    return "#0b0b0b" if dark >= white else "#ffffff"


def kgas(x, _pos=None):
    return f"{x / 1000:.0f}k"


# --------------------------------------------------------------------------- 1. quorum cost
def fig_quorum(t, mode):
    rows = GAS["deliver"]
    q = np.array([r["threshold"] for r in rows])
    g = np.array([r["gas"] for r in rows])
    n = [r["validators"] for r in rows]
    slope, intercept = np.polyfit(q, g, 1)

    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    ax.plot(q, g, color=t["series"][0], lw=2, marker="o", ms=6, mec=t["surface"], mew=2, zorder=3)
    ax.yaxis.set_major_formatter(kgas)
    ax.set_ylim(0, max(g) * 1.18)
    ax.set_xticks(q, [f"{qi}\n({ni})" for qi, ni in zip(q, n)])
    ax.set_xlabel("signatures required  (validators in set)")
    ax.set_ylabel("gas per delivered message")
    ax.set_title("Delivery cost grows linearly with the quorum")
    ax.annotate(f"≈ {slope / 1000:.1f}k gas per signature\n+ {intercept / 1000:.0f}k fixed",
                xy=(q[-1], g[-1]), xytext=(-12, 14), textcoords="offset points", ha="right",
                color=t["ink2"], fontsize=9.5)
    for i in (0, len(q) - 1):
        ax.annotate(f"{g[i] / 1000:.0f}k", xy=(q[i], g[i]), xytext=(0, -16), textcoords="offset points",
                    ha="center", color=t["ink"], fontsize=9)
    save(fig, "gas-vs-quorum", mode)


# --------------------------------------------------------------------------- 2. workflow
def fig_workflow(t, mode):
    items = list(GAS["workflow"].items())[::-1]
    labels = [k for k, _ in items]
    vals = [v for _, v in items]
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    ax.barh(labels, vals, height=0.62, color=t["series"][0], edgecolor=t["surface"], linewidth=2)
    ax.xaxis.set_major_formatter(kgas)
    ax.grid(axis="y", visible=False)
    ax.set_xlim(0, max(vals) * 1.16)
    for y, v in enumerate(vals):
        ax.text(v + max(vals) * 0.012, y, f"{v / 1000:.0f}k", va="center", color=t["ink"], fontsize=9)
    ax.set_xlabel("gas")
    ax.set_title("Gas per step of the collaboration workflow (5 validators, quorum 3)")
    ax.tick_params(axis="y", length=0)
    save(fig, "workflow-gas", mode)


# --------------------------------------------------------------------------- 3. paper Table 23
TABLE23 = [  # mechanism, Tx time (ms), cost (USD)
    ("Cross-chain bridge", 650, 0.42),
    ("IBC protocol (L1–L1)", 780, 0.34),
    ("Relay chain (para-chain)", 300, 0.15),
    ("L3 (ZK rollup)", 120, 0.05),
]


def efficiency(ms, usd):
    """Efficiency = 1 / (T_tx · C_tx), T in seconds, as defined in §4.6 of the paper."""
    return 1 / ((ms / 1000) * usd)


def fig_table23(t, mode):
    names = [m[0] for m in TABLE23]
    metrics = [
        ("Transaction time (ms)", [m[1] for m in TABLE23], lambda v: f"{v:.0f}"),
        ("Cost per transaction (USD)", [m[2] for m in TABLE23], lambda v: f"{v:.2f}"),
        ("Efficiency 1/(T·C), log scale", [efficiency(m[1], m[2]) for m in TABLE23], lambda v: f"{v:.1f}"),
    ]
    colors = [t["other"]] * 3 + [t["series"][0]]  # emphasis: the L3 mechanism vs the rest
    fig, axes = plt.subplots(1, 3, figsize=(11, 3.6), sharey=True)
    y = np.arange(len(names))[::-1]
    for ax, (title, vals, fmt) in zip(axes, metrics):
        ax.barh(y, vals, height=0.6, color=colors, edgecolor=t["surface"], linewidth=2)
        if "log" in title:
            ax.set_xscale("log")
            ax.set_xlim(1, max(vals) * 6)
        else:
            ax.set_xlim(0, max(vals) * 1.3)
        for yi, v in zip(y, vals):
            ax.text(v * (1.08 if "log" in title else 1) + (0 if "log" in title else max(vals) * 0.03), yi, fmt(v),
                    va="center", color=t["ink"], fontsize=9)
        ax.set_title(title, fontsize=10.5)
        ax.grid(axis="y", visible=False)
        ax.tick_params(axis="y", length=0)
    axes[0].set_yticks(y, names)
    fig.suptitle("L3 rollups: lowest latency and cost (paper Table 23, simulated)", x=0.01, ha="left",
                 color=t["ink"], fontsize=12, fontweight="bold")
    fig.tight_layout()
    save(fig, "paper-table23", mode)


# --------------------------------------------------------------------------- 4. paper Table 17
def fig_complexity(t, mode):
    n = np.linspace(2, 64, 200)
    curves = [  # Table 17 order; color follows the mechanism in every figure
        ("Cross-chain  O(log n)", np.log2(n)),
        ("Para-chain  O(n)", n),
        ("Side-chain  O(n²)", n ** 2),
        ("Super-chain  O(n log n)", n * np.log2(n)),
    ]
    fig, ax = plt.subplots(figsize=(7.2, 4))
    for (label, ys), c in zip(curves, t["series"]):
        ax.plot(n, ys, color=c, lw=2, label=label)
        ax.annotate(label.split("  ")[0], xy=(n[-1], ys[-1]), xytext=(6, 0), textcoords="offset points",
                    va="center", color=t["ink2"], fontsize=9)
    ax.set_yscale("log")
    ax.set_xlim(2, 64 * 1.22)
    ax.set_xlabel("n  (relayers / validators / shards)")
    ax.set_ylabel("relative operations (log)")
    ax.set_title("Asymptotic overhead of L3 mechanisms (paper Table 17)")
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.2), ncol=2, fontsize=9)
    save(fig, "paper-complexity", mode)


# --------------------------------------------------------------------------- 5. paper Table 7
TABLE7 = {  # qualitative ratings transcribed from Table 7
    "Scalability": ["Moderate", "High", "Moderate", "Very high"],
    "Interoperability": ["High", "Moderate", "Low", "High"],
    "Customization": ["Low", "High", "Very high", "Moderate"],
    "Flexibility": ["High", "Moderate", "Moderate", "High"],
    "Latency (lower is better)": ["Moderate", "Low", "Moderate", "High"],
    "Complexity (lower is better)": ["Moderate", "Moderate", "Moderate", "High"],
}
LEVELS = ["Low", "Moderate", "High", "Very high"]
MECHS = ["Cross-chain", "Para-chain", "Side-chain", "Super-chain"]


def fig_profile(t, mode):
    rows = list(TABLE7)
    data = np.array([[LEVELS.index(v) for v in TABLE7[r]] for r in rows])
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    cmap = matplotlib.colors.ListedColormap(t["ramp"])
    ax.imshow(data, cmap=cmap, vmin=-0.5, vmax=3.5, aspect="auto")
    ax.set_xticks(range(4), MECHS)
    ax.set_yticks(range(len(rows)), rows)
    ax.xaxis.tick_top()
    ax.tick_params(length=0)
    ax.grid(False)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_xticks(np.arange(-0.5, 4), minor=True)
    ax.set_yticks(np.arange(-0.5, len(rows)), minor=True)
    ax.grid(which="minor", color=t["surface"], linewidth=3)
    for i, r in enumerate(rows):
        for j in range(4):
            level = data[i, j]
            ax.text(j, i, LEVELS[level], ha="center", va="center", fontsize=9, color=best_text(t["ramp"][level]))
    ax.set_title("Qualitative profile of the four L3 mechanisms (paper Table 7)", pad=28)
    save(fig, "paper-profile", mode)


def main():
    for mode, t in THEMES.items():
        style(t)
        fig_quorum(t, mode)
        fig_workflow(t, mode)
        fig_table23(t, mode)
        fig_complexity(t, mode)
        fig_profile(t, mode)

    print("Reproduction of paper Table 23 efficiency = 1 / (T[s] * C[USD]):")
    for name, ms, usd in TABLE23:
        print(f"  {name.replace(chr(8211), '-'):<26} {efficiency(ms, usd):8.2f}")
    q = [r["threshold"] for r in GAS["deliver"]]
    g = [r["gas"] for r in GAS["deliver"]]
    slope, intercept = np.polyfit(q, g, 1)
    print(f"Measured delivery gas ~ {intercept:,.0f} + {slope:,.0f} x signatures")
    print(f"Figures written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
