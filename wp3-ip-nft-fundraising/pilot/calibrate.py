"""D3.3 Part C, step 2: (a) sensitivity of the in-silico experiment to checking cost and default trust;
(b) re-run the D3.2 mechanism simulation with parameters estimated in Part C instead of assumed ones.
Writes calibration.json.  Usage: python pilot/calibrate.py (after insilico_experiment.py, kpi_variability.py)"""
import json, importlib.util, sys
from pathlib import Path
import numpy as np
here = Path(__file__).parent
spec = importlib.util.spec_from_file_location("exp", here / "insilico_experiment.py")
src = (here / "insilico_experiment.py").read_text().split("rng = np.random.default_rng(20261109)")[0]
ns = {}; exec(src, ns)
P = ns["P"]; study, summarise = ns["study"], ns["summarise"]
# (a) sensitivity
sens = {"dtvf_cost": [], "trust": []}
for c in [1, 3, 6, 9, 12]:
    P["cost_min"]["dtvf"] = float(c)
    qs = [summarise(*study(np.random.default_rng(500 + r)))["dtvf"]["q"] for r in range(200)]
    sens["dtvf_cost"].append([c, float(np.mean(qs))])
P["cost_min"]["dtvf"] = 3.0
for t in [0.5, 0.65, 0.85, 0.95]:
    P["approve_if_unchecked"] = t
    s = [summarise(*study(np.random.default_rng(900 + r))) for r in range(200)]
    sens["trust"].append([t, float(np.mean([x["vote"]["q"] for x in s])), float(np.mean([x["dtvf"]["q"] for x in s]))])
P["approve_if_unchecked"] = 0.85
# (b) recalibrate D3.2
ins = json.loads((here / "insilico_results.json").read_text())["replications"]
kv = json.loads((here / "kpi_variability.json").read_text())
sim_src = (here.parent / "simulation" / "sim.py").read_text().split("mechs = [")[0]
sn = {}; exec(sim_src, sn)
base = dict(sn["P"]); cal = dict(base)
cal.update(q_vote=ins["vote_q"][1], eps_vote=ins["vote_eps"][1], q_kpi=ins["dtvf_q"][1], eps_kpi=1 - kv["anomaly_f1"]["pMeet"])
out = {}
tol = dict(cal); tol["eps_kpi"] = 0.0
for name, par in (("assumed", base), ("calibrated", cal), ("calibrated_tolerant_targets", tol)):
    out[name] = {"params": {k: par[k] for k in ("q_vote", "eps_vote", "q_kpi", "eps_kpi")}}
    for m in ("AON", "DAICO", "DTVF"):
        rows = [sn["metrics"](sn["run"](m, np.random.default_rng(s), par), par["N"]) for s in range(10)]
        out[name][m] = {k: float(np.mean([r[k] for r in rows])) for k in rows[0]}
res = {"sensitivity": sens, "recalibration": out}
(here / "calibration.json").write_text(json.dumps(res, indent=1))
print(json.dumps(sens)); 
for n in out: print(n, out[n]["params"], {m: {k: round(v, 3) for k, v in out[n][m].items() if k in ("loss", "fraud", "wrongful", "theta")} for m in ("AON", "DAICO", "DTVF")})
