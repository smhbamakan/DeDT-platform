import json, numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from pathlib import Path
h = Path(__file__).parent; plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9})
NAVY, GOLD, BLUE = "#1F3864", "#C9A227", "#7FA6D9"
kv = json.loads((h / "kpi_variability.json").read_text()); ins = json.loads((h / "insilico_results.json").read_text()); cal = json.loads((h / "calibration.json").read_text())
fig, axs = plt.subplots(1, 3, figsize=(7.4, 2.4))
for ax, (k, lab, scale) in zip(axs, [("completeness", "Completeness (%)", 100), ("anomaly_f1", "Anomaly-detection F1", 1), ("reduction", "Data reduction (×)", 1)]):
    v = np.array(kv[k]["values"]) * scale; t = kv[k]["target"] * scale
    ax.hist(v, bins=(np.linspace(95, 165, 36) if k == "reduction" else 12), color=BLUE, edgecolor="white"); ax.axvline(t, color=GOLD, lw=2, label="target")
    ax.set_title(f"{lab}\nmeets target in {100*kv[k]['pMeet']:.1f}% of runs", fontsize=8); ax.spines[["top", "right"]].set_visible(False); ax.set_yticks([])
axs[0].legend(fontsize=7, frameon=False)
plt.tight_layout(); plt.savefig(h / "fig_kpi_var.png", dpi=220); plt.close()
R = ins["replications"]
fig, ax = plt.subplots(figsize=(6.6, 2.7)); xs = np.arange(3); w = 0.36
for j, (c, col, lab) in enumerate([("vote", BLUE, "Narrative reports + votes"), ("dtvf", NAVY, "KPI evidence (DTVF)")]):
    m = [R[f"{c}_{k}"][1] for k in ("q", "eps", "nu")]; lo = [R[f"{c}_{k}"][0] for k in ("q", "eps", "nu")]; hi = [R[f"{c}_{k}"][2] for k in ("q", "eps", "nu")]
    ax.bar(xs + (j - .5) * w, m, w, color=col, label=lab, yerr=[np.array(m) - lo, np.array(hi) - m], capsize=3)
    for x, y, u in zip(xs + (j - .5) * w, m, hi): ax.text(x, u + 0.03, f"{y:.2f}", ha="center", fontsize=7.5)
ax.set_xticks(xs, ["False claims rejected (q)", "True claims rejected (ε)", "Participants who check (ν)"]); ax.set_ylim(0, 1.25)
ax.legend(frameon=False, fontsize=7.5, loc="upper center", ncol=2); ax.spines[["top", "right"]].set_visible(False)
plt.tight_layout(); plt.savefig(h / "fig_experiment.png", dpi=220); plt.close()
S = cal["sensitivity"]
fig, axs = plt.subplots(1, 2, figsize=(7.2, 2.6))
c = np.array(S["dtvf_cost"]); axs[0].plot(c[:, 0], c[:, 1], "o-", color=NAVY); axs[0].axhline(R["vote_q"][1], ls="--", color=BLUE, label="vote condition (12 min)")
axs[0].set_xlabel("Median minutes to check a KPI claim (DTVF)"); axs[0].set_ylabel("False claims rejected (q)"); axs[0].legend(fontsize=7, frameon=False); axs[0].set_ylim(0, 1.05)
t = np.array(S["trust"]); axs[1].plot(t[:, 0], t[:, 2], "o-", color=NAVY, label="KPI evidence (DTVF)"); axs[1].plot(t[:, 0], t[:, 1], "o--", color=BLUE, label="Reports + votes")
axs[1].set_xlabel("P(approve) when voting without checking"); axs[1].legend(fontsize=7, frameon=False); axs[1].set_ylim(0, 1.05)
for a in axs: a.spines[["top", "right"]].set_visible(False); a.grid(alpha=.25)
plt.tight_layout(); plt.savefig(h / "fig_sensitivity.png", dpi=220); plt.close()
