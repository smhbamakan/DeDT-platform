"""Integration demo, step 5: an independent auditor checks the chain of evidence across all modules.
Recomputes every link from the published outputs and writes out/traceability.md."""
import json, sys
from pathlib import Path
from Crypto.Hash import keccak as _k
OUT = Path(__file__).with_name("out")
def k(b): h = _k.new(digest_bits=256); h.update(b); return h.digest()
hx = lambda b: "0x" + b.hex()
tt, dao, fu = (json.loads((OUT / f).read_text()) for f in ("twin_trust.json", "dao.json", "funding.json"))
plan_hash = hx(k(json.dumps(tt["fundingPlan"], sort_keys=True, separators=(",", ":")).encode()))
trail = fu["versionTrail"]
checks = [
 ("WP2→WP3", "KPI evidence = keccak(KPI id ‖ value ‖ data hash-chain head ‖ model configuration)",
  all(tt["evidence"][kpi] == hx(k(bytes.fromhex(tt["kpiIds"][kpi][2:]) + v.to_bytes(32, "big") + bytes.fromhex(tt["chainHead"][2:]) + bytes.fromhex(tt["modelConfigHash"][2:])))
      for kpi, v in tt["kpis"].items())),
 ("WP4", "Last data batch co-signed by the twin's sensors (aggregated BLS)", tt["checks"]["blsBatchSignature"]),
 ("WP4", "Birth certificate proven in zero knowledge", tt["checks"]["zkBirthCertificate"]),
 ("WP4", "Twin package decrypted by the partner via 3-of-5 key servers", tt["checks"]["ibeShare"]),
 ("WP4→WP1", "dNFT minted with the birth-certificate commitment", dao["dnftSpecHash"] == tt["specHash"]),
 ("WP1", "Funding plan hash recomputed from the plan", plan_hash == tt["fundingPlanHash"] == dao["fundingPlanHash"]),
 ("WP1", "DAO proposal adopting the plan executed", dao["state"] == "Executed"),
 ("WP4→WP3", "IP-NFT birth entry = birth-certificate commitment", trail[0]["dataHash"] == tt["specHash"]),
 ("WP1→WP3", "IP-NFT version 1 = hash of the DAO decision", trail[1]["dataHash"] == dao["descriptionHash"]),
 ("WP2→WP3", "IP-NFT versions 2–4 = KPI evidence, and claims point to them",
  [t["dataHash"] for t in trail[2:5]] == [tt["evidence"][m["kpi"]] for m in fu["milestones"]] == [m["evidence"] for m in fu["milestones"]]),
 ("WP3", "All milestones accepted and the full budget released", fu["phase"] == "Completed" and fu["released"] == fu["raised"]),
]
lines = ["# DeDT integration demo: traceability report", "", f"Twin: **{tt['twin']}** · {tt['readings']:,} readings · {tt['batches']} batches",
         "", "| Link | Check | Result |", "|---|---|---|"]
lines += [f"| {a} | {b} | {'✅' if ok else '❌'} |" for a, b, ok in checks]
(OUT / "traceability.md").write_text("\n".join(lines) + "\n")
for a, b, ok in checks: print(f"  {'✔' if ok else '✘'} [{a}] {b}")
sys.exit(0 if all(ok for *_, ok in checks) else 1)
