import json, numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9}); NAVY = "#1F3864"
S = json.load(open("sim.json")); res = S["res"]; mechs = ["KIA", "AON", "DAICO", "DTVF"]
lab = {"KIA": "Keep-it-all\n(lump sum)", "AON": "All-or-nothing\n(lump sum)", "DAICO": "Vote-gated\ntranches", "DTVF": "DTVF\n(KPI-verified)"}
cols = ["#B9CDE8", "#7FA6D9", "#3F6CB0", "#1F3864"]
# fig: metrics bars
fig, axs = plt.subplots(1, 4, figsize=(7.4, 2.6))
for ax, (k, t) in zip(axs, [("loss", "Capital lost\n(share of invested)"), ("fraud", "Released on\nfalse claims"), ("wrongful", "Good projects\nwrongly stopped"), ("theta", "Break-even backer\nincome share θ*")]):
    v = [res[m][k][0] for m in mechs]; e = [res[m][k][1] for m in mechs]
    ax.bar(range(4), v, yerr=e, color=cols, capsize=2)
    ax.set_xticks(range(4), ["KIA", "AON", "Vote", "DTVF"], fontsize=7.5); ax.set_title(t, fontsize=8.5)
    ax.spines[["top", "right"]].set_visible(False)
    for i, x in enumerate(v): ax.text(i, x + max(v) * 0.03, f"{x:.2f}", ha="center", fontsize=7)
    ax.set_ylim(0, max(v) * 1.2 + 1e-3)
plt.tight_layout(); plt.savefig("fig_sim.png", dpi=220); plt.close()
# fig: heatmap
qs, ks, H = np.array(S["qs"]), np.array(S["ks"]), np.array(S["H"])
fig, ax = plt.subplots(figsize=(6.0, 3.2))
im = ax.imshow(H, origin="lower", aspect="auto", cmap="Blues", extent=[qs[0], qs[-1], ks[0], ks[-1]])
qq = np.linspace(0.5, 0.98, 200); ax.plot(qq, (1 - qq) / qq, color="#C9A227", lw=2, label="deterrence threshold κ* = (1−q)/q")
ax.set_ylim(ks[0], ks[-1]); ax.set_xlabel("Probability q that a false claim is detected"); ax.set_ylabel("Bond κ (share of tranche)")
cb = plt.colorbar(im); cb.set_label("Capital released on false claims"); ax.legend(loc="upper right", fontsize=7.5, frameon=False, labelcolor="#8C6D1F")
plt.tight_layout(); plt.savefig("fig_heat.png", dpi=220); plt.close()
# fig: dishonesty sweep + analytic staging
fig, axs = plt.subplots(1, 2, figsize=(7.4, 2.8))
ax = axs[0]
for m, c, ls in zip(mechs, cols, ["-", "--", "-.", "-"]):
    ax.plot(S["ds"], S["D"][m], ls, color=c if m != "KIA" else "#8EA2C4", lw=2 if m == "DTVF" else 1.4, label=lab[m].replace("\n", " "))
ax.set_xlabel("Share of dishonest teams δ"); ax.set_ylabel("Capital lost (share of invested)"); ax.legend(fontsize=7, frameon=False); ax.spines[["top", "right"]].set_visible(False)
ax = axs[1]; p = 0.8
Ms = np.arange(1, 9)
lump = [1 - p ** M for M in Ms]
def staged(M, p):
    tau = 1 / M; L = 0
    for m in range(1, M + 1): L += p ** (m - 1) * (1 - p) * m * tau
    return L
ax.plot(Ms, lump, "o--", color="#8EA2C4", label="Lump sum")
ax.plot(Ms, [staged(M, p) for M in Ms], "o-", color=NAVY, label="Staged (equal tranches)")
ax.set_xlabel("Number of stages M (p = 0.8 per stage)"); ax.set_ylabel("Expected capital at risk E[L]/B"); ax.legend(fontsize=7.5, frameon=False); ax.spines[["top", "right"]].set_visible(False)
plt.tight_layout(); plt.savefig("fig_stage.png", dpi=220); plt.close()
# fig: QF example
c0 = [100] * 4; c1 = [400]
r0 = (sum(np.sqrt(c0))) ** 2 - sum(c0); r1 = 0
print("qf", r0, r1)
