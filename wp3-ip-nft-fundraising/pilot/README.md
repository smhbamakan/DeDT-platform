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
S4 missed deadline.

## Part C · in-silico run of the pilot protocol (simulated participants, not human data)

```bash
pip install numpy pandas scipy statsmodels matplotlib
python pilot/kpi_variability.py     # KPI distribution over 40 twin runs (H1)
python pilot/insilico_experiment.py # 128 simulated participants, vote vs DTVF, 1,000 replications (H2, H3)
python pilot/calibrate.py           # sensitivity + D3.2 simulation re-run with estimated parameters
python pilot/figs_c.py
```
