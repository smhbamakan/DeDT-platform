import random
import statistics

from dedt_flows.edge import AnomalyDetector, EdgeAggregator, Welford, detection_scores
from dedt_flows.pipeline import run
from dedt_flows.simulator import ROBOT_ARM, Reading, SimulationConfig, simulate


def test_welford_matches_statistics_module():
    xs = [3.1, 2.7, 9.0, -1.0, 4.4, 4.4]
    w = Welford()
    for x in xs:
        w.add(x)
    assert abs(w.mean - statistics.mean(xs)) < 1e-12
    assert abs(w.std - statistics.stdev(xs)) < 1e-12
    assert (w.lo, w.hi) == (min(xs), max(xs))


def test_windows_contain_every_on_time_reading_once():
    cfg = SimulationConfig(duration_s=5, sensors=(ROBOT_ARM[0], ROBOT_ARM[1]), anomaly_rate=0)
    edge = EdgeAggregator(window_ms=500, allowed_lateness_ms=200)
    summaries = []
    for r in simulate(cfg):
        summaries += edge.process(r)
    summaries += edge.flush()
    assert sum(s.count for s in summaries) == edge.stats.aggregated == edge.stats.received - edge.stats.late
    keys = [(s.sensor, s.window_start_ms) for s in summaries]
    assert len(keys) == len(set(keys))  # each window emitted once


def test_late_readings_are_counted_not_aggregated():
    edge = EdgeAggregator(window_ms=1000, allowed_lateness_ms=100)

    def mk(seq, t):
        return Reading("t", "s", seq, t, t, 1.0)

    edge.process(mk(0, 0))
    edge.process(mk(1, 5000))  # moves the watermark to 4900
    edge.process(mk(2, 100))  # far behind the watermark
    assert edge.stats.late == 1


def test_detector_flags_spikes_and_stuck_values_without_false_alarms():
    rng = random.Random(0)
    det = AnomalyDetector()
    flags = [det.update(10 + rng.gauss(0, 1)) for _ in range(500)]
    assert not any(flags)
    assert det.update(10 + 15)  # 15-sigma spike
    assert not det.update(10 + rng.gauss(0, 1))  # the history was not contaminated
    stuck = [det.update(7.25) for _ in range(5)]
    assert stuck[2:] == [True, True, True]


def test_level_shift_is_accepted_after_a_few_flags():
    rng = random.Random(1)
    det = AnomalyDetector()
    for _ in range(300):
        det.update(rng.gauss(0, 1))
    flags = [det.update(50 + rng.gauss(0, 1)) for _ in range(50)]
    assert sum(flags) <= 3  # not flagged forever


def test_detection_quality_on_held_out_seed():
    res = run(SimulationConfig(duration_s=30, seed=7))
    d = detection_scores(res.edge.stats.flagged)
    assert d["precision"] > 0.9 and d["recall"] > 0.6


def test_detection_scores():
    r_a = Reading("t", "s", 0, 0, 0, 0.0, anomaly=True)
    r_n = Reading("t", "s", 1, 0, 0, 0.0)
    d = detection_scores([(r_a, True), (r_n, True), (r_a, False), (r_n, False)])
    assert (d["tp"], d["fp"], d["fn"]) == (1, 1, 1)
    assert d["precision"] == d["recall"] == 0.5
