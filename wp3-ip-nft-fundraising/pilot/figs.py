import json, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from pathlib import Path
here = Path(__file__).parent; R = json.loads((here / "pilot-results.json").read_text())
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9}); NAVY = "#1F3864"
cols = ["#1F3864", "#C0392B", "#3F6CB0", "#C9A227"]
fig, axs = plt.subplots(1, 4, figsize=(7.4, 2.4), sharey=True)
for ax, sc, c in zip(axs, R["scenarios"], cols):
    xs = [0] + [t["day"] for t in sc["timeline"]]; ys = [0] + [t["released"] / 1000 for t in sc["timeline"]]
    ax.step(xs, ys, where="post", color=c, lw=1.8); ax.plot(xs[-1], ys[-1], "o", color=c, ms=5)
    ax.set_title(sc["name"].split(" ", 1)[0] + "\n" + sc["outcome"].replace("cancelled: ", "cancelled:\n"), fontsize=7.5)
    ax.set_xlabel("Day", fontsize=8); ax.set_ylim(0, 108); ax.set_xlim(0, 110); ax.grid(alpha=.25); ax.spines[["top", "right"]].set_visible(False)
axs[0].set_ylabel("Released to team\n(thousand mEUR)")
plt.tight_layout(); plt.savefig(here / "fig_timeline.png", dpi=220); plt.close()
roles = ["team", "backers", "anyone", "watcher", "griefer", "licensee"]
rc = {"team": "#1F3864", "backers": "#7FA6D9", "anyone": "#B9CDE8", "watcher": "#C9A227", "griefer": "#C0392B", "licensee": "#5E8C61"}
fig, ax = plt.subplots(figsize=(7.2, 2.6)); y = range(len(R["scenarios"]))
for i, s in enumerate(R["scenarios"]):
    left = 0
    for r in roles:
        v = s["gas"].get(r, 0) / 1e6
        if v: ax.barh(i, v, left=left, color=rc[r], label=r if i == 0 or r not in [h.get_label() for h in ax.patches] else None); left += v
ax.set_yticks(list(y), [s["name"].split(" ", 1)[0] for s in R["scenarios"]]); ax.invert_yaxis(); ax.set_xlabel("Gas used, million (all transactions of the project)")
h, l = ax.get_legend_handles_labels(); seen = {}
for a, b in zip(h, l):
    if b and b not in seen: seen[b] = a
ax.legend(seen.values(), seen.keys(), fontsize=7, frameon=False, ncol=6, loc="upper center", bbox_to_anchor=(0.5, 1.2))
ax.spines[["top", "right"]].set_visible(False); plt.tight_layout(); plt.savefig(here / "fig_gas.png", dpi=220); plt.close()
