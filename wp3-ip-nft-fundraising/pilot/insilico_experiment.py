"""D3.3 Part C: in-silico run of the field-pilot protocol (Part B) with simulated participants.

Design (as in the protocol): 128 participants randomly assigned to two conditions (64 each).
  vote  - participants review narrative progress reports; every milestone claim is put to a vote.
  dtvf  - participants see the KPI value and evidence and can recompute it with a tool; a claim is
          accepted after the challenge window unless someone challenges it, then it goes to a vote.
Participants form backer pools of 16; each pool funds one project and reviews six milestone claims,
two of them false, in random order. Behaviour follows a bounded-rationality model (all parameters
are assumptions, listed in PARAMS): a participant checks a claim with probability
logistic(alpha_i - gamma * cost_condition); checking reveals the truth with condition-specific
accuracy; non-checkers abstain or vote by default trust. Outcomes are evaluated with the analysis
plan of the protocol (GEE logistic regression clustered by participant; bootstrap CIs), and the
whole study is replicated 1,000 times to give the sampling distribution and power.
THESE ARE SIMULATED PARTICIPANTS, NOT HUMAN DATA.  Writes insilico_results.json.
"""
import json
from pathlib import Path
import numpy as np, pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

PARAMS = dict(n_per_cond=64, pool=16, claims=6, false_claims=2,
              alpha_mu=1.0, alpha_sd=1.0, gamma=0.25,            # propensity to check; minutes cost weight
              cost_min={"vote": 12.0, "dtvf": 3.0},              # median minutes to check one claim
              cost_sd=0.4,
              detect={"vote": 0.70, "dtvf": 0.97},               # P(identify a false claim | checked)
              false_alarm={"vote": 0.10, "dtvf": 0.02},          # P(flag a true claim | checked)
              vote_if_unchecked=0.5, approve_if_unchecked=0.85,  # rational-ignorance behaviour
              challenge_willing=0.8,                             # DTVF: finder posts the bond
              quorum=0.20, windows={"challenge": 3, "vote": 5})
P = PARAMS
lg = lambda x: 1 / (1 + np.exp(-x))

def study(rng):
    rows, claims = [], []
    pid = 0
    for cond in ("vote", "dtvf"):
        for pool in range(P["n_per_cond"] // P["pool"]):
            alpha = rng.normal(P["alpha_mu"], P["alpha_sd"], P["pool"])
            stake = np.full(P["pool"], 1.0)
            truth = rng.permutation([False] * P["false_claims"] + [True] * (P["claims"] - P["false_claims"]))
            ids = np.arange(pid, pid + P["pool"]); pid += P["pool"]
            for k, true_claim in enumerate(truth):
                cost = P["cost_min"][cond] * np.exp(rng.normal(0, P["cost_sd"], P["pool"]))
                check = rng.random(P["pool"]) < lg(alpha - P["gamma"] * cost)
                u = rng.random(P["pool"])
                flags = np.where(check, np.where(true_claim, u < P["false_alarm"][cond], u < P["detect"][cond]), False)
                # voting behaviour
                votes = np.full(P["pool"], 0)   # +1 approve, -1 reject, 0 abstain
                w = rng.random(P["pool"]); a = rng.random(P["pool"])
                votes[check] = np.where(flags[check], -1, 1)
                unc = ~check & (w < P["vote_if_unchecked"])
                votes[unc] = np.where(a[unc] < P["approve_if_unchecked"], 1, -1)
                if cond == "dtvf":
                    challenged = bool((flags & (rng.random(P["pool"]) < P["challenge_willing"])).any())
                    if challenged:
                        turnout = (votes != 0).sum() / P["pool"]
                        reject = turnout >= P["quorum"] and (votes == -1).sum() > (votes == 1).sum()
                        days = P["windows"]["challenge"] + P["windows"]["vote"]
                    else:
                        reject, turnout, days = False, 0.0, P["windows"]["challenge"]
                else:
                    challenged = True
                    turnout = (votes != 0).sum() / P["pool"]
                    reject = turnout >= P["quorum"] and (votes == -1).sum() > (votes == 1).sum()
                    days = P["windows"]["vote"]
                claims.append(dict(cond=cond, pool=f"{cond}{pool}", true=bool(true_claim), rejected=bool(reject),
                                   challenged=challenged, turnout=float(turnout), days=days, checkers=int(check.sum())))
                for j in range(P["pool"]):
                    correct = (votes[j] == 1 and true_claim) or (votes[j] == -1 and not true_claim)
                    rows.append(dict(pid=int(ids[j]), cond=cond, true=bool(true_claim), checked=bool(check[j]),
                                     voted=bool(votes[j] != 0), correct=bool(correct), minutes=float(cost[j]) if check[j] else 0.0))
    return pd.DataFrame(rows), pd.DataFrame(claims)

def summarise(ind, cl):
    out = {}
    for c in ("vote", "dtvf"):
        a = cl[cl.cond == c]; i = ind[ind.cond == c]
        out[c] = dict(q=float(a[~a.true].rejected.mean()), eps=float(a[a.true].rejected.mean()),
                      nu=float(i.checked.mean()), turnout=float(a[a.challenged].turnout.mean()) if a.challenged.any() else 0.0,
                      days=float(a.days.mean()), minutes=float(i.minutes.sum() / i.pid.nunique()),
                      indiv_correct_false=float(i[~i.true].correct.mean()))
    return out

rng = np.random.default_rng(20261109)
ind, cl = study(rng)
main = summarise(ind, cl)
# GEE logistic: correct judgement of FALSE claims, clustered by participant
d = ind[~ind.true].copy(); d["dtvf"] = (d.cond == "dtvf").astype(int); d["y"] = d.correct.astype(int)
gee = smf.gee("y ~ dtvf", groups="pid", data=d, family=sm.families.Binomial(), cov_struct=sm.cov_struct.Exchangeable()).fit()
d2 = ind.copy(); d2["dtvf"] = (d2.cond == "dtvf").astype(int); d2["y"] = d2.checked.astype(int)
gee2 = smf.gee("y ~ dtvf", groups="pid", data=d2, family=sm.families.Binomial(), cov_struct=sm.cov_struct.Exchangeable()).fit()
def orci(m):
    b, se = m.params["dtvf"], m.bse["dtvf"]
    return dict(OR=float(np.exp(b)), lo=float(np.exp(b - 1.96 * se)), hi=float(np.exp(b + 1.96 * se)), p=float(m.pvalues["dtvf"]))
# replications: sampling distribution and power
reps = []
for r in range(1000):
    i2, c2 = study(np.random.default_rng(10_000 + r))
    s2 = summarise(i2, c2)
    dd = i2[~i2.true]
    pv = dd.groupby(["cond", "pid"]).correct.mean().unstack(0)
    # participant-level difference in correct judgements of false claims (Welch t on means)
    from scipy import stats
    t = stats.ttest_ind(pv["dtvf"].dropna(), pv["vote"].dropna(), equal_var=False)
    reps.append(dict(**{f"{c}_{k}": v for c in s2 for k, v in s2[c].items()}, p=float(t.pvalue)))
R = pd.DataFrame(reps)
ci = lambda col: [float(R[col].quantile(.025)), float(R[col].mean()), float(R[col].quantile(.975))]
res = dict(params=P, main=main, gee_correct_false=orci(gee), gee_checked=orci(gee2),
           replications={k: ci(k) for k in R.columns if k != "p"}, power=float((R.p < 0.05).mean()),
           claims=cl.to_dict("records"))
Path(__file__).with_name("insilico_results.json").write_text(json.dumps(res, indent=1))
print(json.dumps({"main": main, "gee": res["gee_correct_false"], "gee_checked": res["gee_checked"], "power": res["power"]}, indent=1))
for k in ("vote_q", "dtvf_q", "vote_eps", "dtvf_eps", "vote_nu", "dtvf_nu"): print(k, [round(x, 3) for x in res["replications"][k]])
