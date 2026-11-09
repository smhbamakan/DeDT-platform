# Tutorial 1 · One twin through the whole platform

**Goal:** follow the robot-arm twin *robot-arm-07* from raw sensor data to a funded, completed project,
and check every step yourself. Time: about 10 minutes. Set-up: [Getting started](../getting-started.md).

## 1. Produce twin data and KPIs (WP2)

```bash
python integration/twin_trust.py
```

The WP2 simulator streams six sensors through the edge pipeline. Readings are sealed into Merkle batches
whose hashes form a chain. Three KPIs are computed from the data:

| KPI | Value | Milestone target |
|---|---|---|
| Completeness of readings | 99.55% | ≥ 99% |
| Anomaly-detection F1 | 0.862 | ≥ 0.80 |
| Data reduction at the edge | 158× | ≥ 100× |

For each KPI an **evidence hash** binds the value to the data (hash-chain head) *and* to the model
configuration. Without the configuration, a team could claim results of a different model — this was
the main lesson of the D3.3 pilot.

## 2. Add the trust layer (WP4)

The same script shows three WP4 functions on this twin: the sensors co-sign the last batch with one
aggregated BLS signature; the birth certificate is committed and proven in zero knowledge (disclosing
only the manufacturer); and the twin package is encrypted to a partner team's *identity* and decrypted
with partial keys from three of five key servers. The certificate commitment becomes the twin's
specification hash in both NFTs.

## 3. Adopt the funding plan in the DAO (WP1)

```bash
cd wp1-dao-collaboration && npx hardhat run scripts/integration-step.js
```

The three team members (reputation 45/35/20) vote on a proposal whose description contains the hash of the
funding plan (milestones, budgets, split, θ, bond). It passes 75 : 20 and is executed through the timelock.

## 4. Finance the twin (WP3)

```bash
cd wp3-ip-nft-fundraising && npx hardhat run scripts/integration-step.js
```

The IP-NFT's version trail now reads: birth certificate → DAO decision → three KPI evidences. Fourteen
backers fund 100,000 mEUR; each milestone is claimed with its evidence, survives the challenge window
and releases the next tranche. A first income payment is split 30 % to backers, 70 % to the team.

## 5. Audit the chain

```bash
python integration/verify.py
```

Eleven checks recompute every link from the outputs, for example that the IP-NFT's second version equals
the hash of the DAO decision. Results are in `integration/out/traceability.md`.

**Try this:** change the detector threshold in `twin_trust.py` (`DETECTOR = {"k": 12, …}`) and run again.
The F1 falls below 0.80, so the team cannot claim milestone 2 truthfully — and a false claim would be
exposed because the evidence no longer matches the committed configuration.
