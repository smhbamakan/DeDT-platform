"""Integration demo, steps 1–2 (Python): WP2 twin data and WP4 trust layer.

Step 1 · WP2  The robot-arm twin streams readings through the edge pipeline; readings are sealed into
              Merkle batches linked by a hash chain; three milestone KPIs are computed from the data.
Step 2 · WP4  (a) The twin's sensors co-sign the last batch root with one aggregated BLS signature.
              (b) The twin's birth certificate is committed (Pedersen) and proven in zero knowledge,
                  disclosing only the manufacturer; the commitment becomes the IP-NFT's specification hash.
              (c) The twin package (model configuration + batch roots) is IBE-encrypted to the partner
                  team's identity under a master key shared by 3-of-5 key servers (DKG).
Writes out/twin_trust.json, consumed by the WP1 and WP3 steps.
"""
import json, random, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "wp2-big-data-flows"), str(ROOT / "wp4-trust-auditing")]
from dedt_flows.pipeline import run
from dedt_flows.simulator import SimulationConfig
from dedt_trust import bls, dkg, ibe, zkp
from dedt_trust.bn254 import keccak

OUT = Path(__file__).with_name("out"); OUT.mkdir(exist_ok=True)
rng = random.Random(2026)
hx = lambda b: "0x" + b.hex()
def pt_hash(p):  # canonical hash of a BN254 G1 point
    return keccak(int(p[0]).to_bytes(32, "big") + int(p[1]).to_bytes(32, "big"))
def kid(name): return keccak(name.encode())

# ---- Step 1 · WP2
DETECTOR = {"k": 4.5, "alpha": 0.02, "order": 1}
res = run(SimulationConfig(duration_s=30, seed=21))
m = res.metrics()
head = res.builder.batches[-1].chain
config_hash = keccak(json.dumps(DETECTOR, sort_keys=True).encode())
kpis = {"completeness": round(10_000 * (1 - m["loss_ratio"])), "anomaly_f1": round(10_000 * m["anomaly_detection"]["f1"]),
        "reduction": round(m["reduction_factor"])}
targets = {"completeness": 9900, "anomaly_f1": 8000, "reduction": 100}
# evidence commits to KPI id, value, data (hash-chain head) and model configuration (lesson of D3.3)
evidence = {k: hx(keccak(kid(k) + v.to_bytes(32, "big") + head + config_hash)) for k, v in kpis.items()}
print(f"[WP2] {m['readings_received']:,} readings → {len(res.builder.batches)} Merkle batches; chain head {hx(head)[:18]}…")
print(f"[WP2] KPIs: completeness {kpis['completeness']/100:.2f}%, F1 {kpis['anomaly_f1']/1e4:.3f}, reduction {kpis['reduction']}×")

# ---- Step 2a · WP4 BLS co-signature on the last batch root
sensors = [bls.Signer.from_seed(f"robot-arm-07/sensor-{i}") for i in range(4)]
root = res.builder.batches[-1].root
msg = bls.batch_message(31337, "0x" + "da" * 20, 7, len(res.builder.batches) - 1, root)
ms = bls.multisign(sensors[:3], msg)
sig_ok = bls.verify_dual(ms["sig"], ms["apk1"], ms["apk2"], msg)
print(f"[WP4] last batch root co-signed by 3 of 4 sensors (aggregated BLS): valid = {sig_ok}")

# ---- Step 2b · WP4 birth certificate commitment and ZK proof
cert = ["robot-arm-07", "DeDT reference lab, Masaryk University", "SN-RA-0007", 20260301, b"kinematic-model-v1", hx(config_hash).encode()]
mm = [zkp.attribute(v) for v in cert]
r = rng.getrandbits(250)
C = zkp.commit(mm, r)
ctx = {"chain_id": 31337, "contract": "0x" + "bc" * 20, "token_id": 1, "prover": "0x" + "a1" * 20}
proof = zkp.prove_certificate(mm, r, 0b000010, ctx, rng)
zk_ok = zkp.verify_certificate(C, 6, proof, ctx)
spec_hash = pt_hash(C)
print(f"[WP4] birth certificate committed; ZK proof (discloses manufacturer only) valid = {zk_ok}")

# ---- Step 2c · WP4 IBE to the partner team via 3-of-5 key servers
net = dkg.KeyServerNetwork.setup(5, 3, rng)
partner = ibe.team_identity(31337, "0x" + "b2" * 20, "2026-11")
package = json.dumps({"twin": "robot-arm-07", "detector": DETECTOR, "chainHead": hx(head)}).encode()
ct = ibe.encrypt(net.master_public, partner, package, aad=b"robot-arm-07")
key = dkg.obtain_key(net, partner, [1, 3, 5])
ibe_ok = ibe.decrypt(key, partner, ct, aad=b"robot-arm-07") == package
print(f"[WP4] twin package IBE-encrypted to {partner}; partner decrypts with keys from servers 1,3,5 = {ibe_ok}")

out = {
    "twin": "robot-arm-07", "readings": m["readings_received"], "batches": len(res.builder.batches),
    "chainHead": hx(head), "lastRoot": hx(root), "modelConfigHash": hx(config_hash),
    "kpis": kpis, "targets": targets, "kpiIds": {k: hx(kid(k)) for k in kpis}, "evidence": evidence,
    "specHash": hx(spec_hash), "checks": {"blsBatchSignature": sig_ok, "zkBirthCertificate": zk_ok, "ibeShare": ibe_ok},
    "ciphertextBytes": len(ct),
}
plan = {"twin": "robot-arm-07", "milestones": [{"kpi": k, "target": targets[k]} for k in kpis], "advance": 20000,
        "budgets": [30000, 30000, 20000], "split": {"lead": 4500, "modeller": 3500, "dataOwner": 2000}, "thetaBps": 3000,
        "bondBps": 1500, "specHash": hx(spec_hash), "modelConfigHash": hx(config_hash)}
out["fundingPlan"] = plan
out["fundingPlanHash"] = hx(keccak(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()))
(OUT / "twin_trust.json").write_text(json.dumps(out, indent=2))
print(f"[plan] funding plan hash {out['fundingPlanHash'][:18]}… → out/twin_trust.json")
