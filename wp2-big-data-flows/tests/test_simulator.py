from dedt_flows.simulator import ROBOT_ARM, SimulationConfig, simulate


def test_deterministic_for_a_seed():
    cfg = SimulationConfig(duration_s=2, seed=3)
    assert list(simulate(cfg)) == list(simulate(cfg))
    assert list(simulate(SimulationConfig(duration_s=2, seed=4))) != list(simulate(cfg))


def test_rates_loss_and_arrival_order():
    cfg = SimulationConfig(duration_s=10, loss_rate=0.01, seed=1)
    rs = list(simulate(cfg))
    expected = sum(int(10 * s.rate_hz) for s in ROBOT_ARM)
    assert 0.97 * expected < len(rs) < expected  # about 1% lost
    arrivals = [r.t_arrival_ms for r in rs]
    assert arrivals == sorted(arrivals)  # yielded in arrival order
    assert all(r.t_arrival_ms >= r.t_event_ms for r in rs)
    events = [r.t_event_ms for r in rs]
    assert events != sorted(events)  # but out of event-time order


def test_anomalies_are_injected_and_labelled():
    rs = list(simulate(SimulationConfig(duration_s=30, anomaly_rate=0.01, seed=2)))
    share = sum(r.anomaly for r in rs) / len(rs)
    assert 0.005 < share < 0.05


def test_no_anomalies_when_disabled():
    rs = list(simulate(SimulationConfig(duration_s=5, anomaly_rate=0.0, loss_rate=0.0)))
    assert not any(r.anomaly for r in rs)
