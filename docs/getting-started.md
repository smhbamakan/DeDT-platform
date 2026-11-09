# Getting started

**Requirements:** Node.js 18+ and Python 3.11+. Each module is self-contained; install only what you need.

| Module | Install | Test | Demo |
|---|---|---|---|
| WP1 DAO + L3 collaboration | `cd wp1-dao-collaboration && npm ci` | `npm test` | `npm run dao-demo` · `npm run demo` |
| WP2 big-data flows | `cd wp2-big-data-flows && pip install -r requirements.txt` | `python -m pytest -q` · `cd chain && npm ci && npm test` | `python -m dedt_flows.experiments` |
| WP3 IP-NFTs + DTVF | `cd wp3-ip-nft-fundraising && npm ci` | `npm test` (42 tests) | `npm run demo` · `npx hardhat run pilot/run-pilot.js` |
| WP4 trust & auditing | `cd wp4-trust-auditing && pip install -r requirements.txt` | `python -m pytest -q` · `cd chain && npm ci && npx hardhat test` | `python -m dedt_trust.demo` |
| Integration | all of the above | — | `integration/run_demo.sh` |

Tip: use a virtual environment for Python (`python -m venv .venv`). On Windows, run the integration steps
listed in [`integration/run_demo.sh`](../integration/run_demo.sh) one by one.
