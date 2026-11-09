# D3.3 technical pilot

Runs complete DTVF projects on a local Hardhat network, driven by milestone KPIs computed from
the WP2 robot-arm twin (completeness, anomaly-detection F1, data reduction).

```bash
pip install pycryptodome           # WP2 dependency
python pilot/kpi.py                # computes KPIs and evidence hashes -> pilot/evidence.json
npx hardhat run pilot/run-pilot.js # scenarios S1–S4 + QF round -> pilot/pilot-results.json
python pilot/figs.py               # figures
```

Scenarios: S1 honest team · S2 false claim challenged by a watcher · S3 frivolous challenge ·
S4 missed deadline. The field pilot with people (Part B of D3.3) is planned, not yet run.
