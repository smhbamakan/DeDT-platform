"""Monte Carlo agent-based comparison of funding mechanisms for collaborative digital twins (DeDT D3.2).
All parameters are modelling assumptions (Table in the report); results are simulated, not observed."""
import numpy as np, json
P = dict(N=20000, seeds=20, M=4, pi_good=0.6, p_good=0.88, p_bad=0.55, delta=0.2,
         f_mu=-0.05, f_sigma=0.35, gamma=0.5, V=3.0,
         q_vote=0.35, eps_vote=0.10, q_kpi=0.90, eps_kpi=0.03, kappa=0.15)

def run(mech, rng, P, q=None, kappa=None, delta=None):
    N, M = P["N"], P["M"]
    q_kpi = P["q_kpi"] if q is None else q
    kap = P["kappa"] if kappa is None else kappa
    dl = P["delta"] if delta is None else delta
    good = rng.random(N) < P["pi_good"]
    dishonest = rng.random(N) < dl
    p = np.where(good, P["p_good"], P["p_bad"])
    f = np.exp(rng.normal(P["f_mu"], P["f_sigma"], N))          # funding ratio raised/goal
    if mech == "KIA":
        started = np.ones(N, bool); scale = np.minimum(f, 1.0)
        p_eff = p * scale ** P["gamma"]                          # underfunded projects are less likely to succeed
        invested = np.minimum(f, 1.0)
    else:
        started = f >= 1.0; p_eff = p; invested = started.astype(float)
    tau = 1.0 / M
    out = dict(started=0, completed=0, invested=0.0, lost=0.0, fraud=0.0, wrongful=0, good_started=0, refunded=0.0)
    U = rng.random((N, M)); W = rng.random((N, M))
    for i in np.flatnonzero(started):
        inv = invested[i]; out["started"] += 1; out["invested"] += inv
        out["good_started"] += good[i]
        if mech in ("KIA", "AON"):                               # everything released up front
            ok = np.all(U[i] < p_eff[i])
            if ok: out["completed"] += 1
            else: out["lost"] += inv
            continue
        q_det, eps = (P["q_vote"], P["eps_vote"]) if mech == "DAICO" else (q_kpi, P["eps_kpi"])
        bond = 0.0 if mech == "DAICO" else kap
        released = tau; truly_ok = True; status = None; fraud_released = 0.0
        for m in range(M):
            stage_ok = U[i, m] < p_eff[i]
            truly_ok = truly_ok and stage_ok
            nxt = tau if m < M - 1 else 0.0
            if stage_ok:
                if W[i, m] < eps:                                # true claim wrongly rejected
                    status = "cancel"; out["wrongful"] += truly_ok and good[i]; break
                released += nxt; continue
            # stage failed: honest teams report failure; dishonest teams claim falsely if it pays
            gain = (1 - q_det) * max(nxt, tau) - q_det * bond * tau
            if dishonest[i] and gain > 0:
                if W[i, m] < q_det: status = "cancel"; break     # false claim caught
                released += nxt; fraud_released += nxt; continue  # false claim passes
            status = "cancel"; break
        if status is None and truly_ok:
            out["completed"] += 1
        else:
            out["lost"] += released; out["fraud"] += fraud_released; out["refunded"] += 1.0 - released
    return out

def metrics(o, N):
    inv = o["invested"]
    return dict(funded=o["started"] / N, completion=o["completed"] / max(o["started"], 1),
                loss=o["lost"] / inv, fraud=o["fraud"] / inv, wrongful=o["wrongful"] / max(o["good_started"], 1),
                theta=(inv - o["refunded"]) / max(o["completed"] * P["V"], 1e-9))

mechs = ["KIA", "AON", "DAICO", "DTVF"]
res = {}
for mname in mechs:
    rows = [metrics(run(mname, np.random.default_rng(s), P), P["N"]) for s in range(P["seeds"])]
    res[mname] = {k: (float(np.mean([r[k] for r in rows])), float(1.96 * np.std([r[k] for r in rows], ddof=1) / np.sqrt(len(rows)))) for k in rows[0]}
# sensitivity: DTVF fraud loss over detection q and bond kappa
qs = np.round(np.linspace(0.5, 0.98, 13), 3); ks = np.round(np.linspace(0, 0.5, 11), 3)
H = np.zeros((len(ks), len(qs)))
for a, k in enumerate(ks):
    for b, q in enumerate(qs):
        P2 = dict(P, N=6000)
        rows = [metrics(run("DTVF", np.random.default_rng(100 + s), P2, q=q, kappa=k), P2["N"]) for s in range(4)]
        H[a, b] = np.mean([r["fraud"] for r in rows])
# dishonesty sweep
ds = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]
D = {m: [float(np.mean([metrics(run(m, np.random.default_rng(200 + s), dict(P, N=8000), delta=d), 8000)["loss"] for s in range(5)])) for d in ds] for m in mechs}
json.dump(dict(P=P, res=res, qs=qs.tolist(), ks=ks.tolist(), H=H.tolist(), ds=ds, D=D), open("sim.json", "w"), indent=1)
for m in mechs: print(m, {k: round(v[0], 3) for k, v in res[m].items()})
