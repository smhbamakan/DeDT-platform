# DTVF simulation (D3.2)

Monte Carlo agent-based comparison of four funding mechanisms for collaborative digital twins:
keep-it-all, all-or-nothing (both with lump-sum release), vote-gated tranches (DAICO-style) and
Digital-Twin-Verified Financing (DTVF). All parameters in `sim.py` are modelling assumptions;
results are simulated, not observed.

```bash
pip install numpy matplotlib
python sim.py    # writes sim.json
python figs.py   # writes fig_sim.png, fig_heat.png, fig_stage.png
```
