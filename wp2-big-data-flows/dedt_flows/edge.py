"""Edge processing of twin data flows (proposal T2.3 and T2.4).

* Event-time tumbling windows per sensor, closed by a watermark
  W = (max event time seen) − allowed_lateness, so out-of-order readings are still counted;
  readings later than the watermark are counted as late and not aggregated.
* Streaming statistics per window with Welford's algorithm (O(1) memory per sensor and window).
* Online anomaly detection per sensor (defaults chosen by the threshold sweep in experiments.py):
    - spikes: |Δx − μ| > k·σ on the first difference Δx_t = x_t − x_{t−1} (or the second difference
      with order=2), which removes slow trends; μ, σ are bias-corrected EWMA estimates, a flagged
      value is replaced by its prediction, and repeated flags are treated as a level shift;
    - stuck sensors: the same value repeated `flat_run` times in a row.

The output of a window is a compact summary, which is what the edge sends upstream instead of
the raw stream (data reduction).
"""
from __future__ import annotations

import heapq
import math
from collections import defaultdict
from dataclasses import dataclass, field

from .simulator import Reading

SUMMARY_BYTES = 8 * 8  # count, min, max, mean, std, anomalies, late, window start


@dataclass
class Welford:
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0
    lo: float = math.inf
    hi: float = -math.inf

    def add(self, x: float) -> None:
        self.n += 1
        d = x - self.mean
        self.mean += d / self.n
        self.m2 += d * (x - self.mean)
        self.lo = min(self.lo, x)
        self.hi = max(self.hi, x)

    @property
    def std(self) -> float:
        return math.sqrt(self.m2 / (self.n - 1)) if self.n > 1 else 0.0


@dataclass
class AnomalyDetector:
    k: float = 4.5  # threshold in standard deviations (chosen by a sweep on seed 11)
    alpha: float = 0.02  # EWMA smoothing
    order: int = 1  # 1: first difference x_t − x_{t−1} (default); 2: second difference
    flat_run: int = 3
    warmup: int = 30
    max_replace: int = 2  # consecutive spikes before treating the change as a level shift
    _prev: list[float] = field(default_factory=list)
    _spike_run: int = 0
    _mu: float = 0.0
    _var: float = 0.0
    _n: int = 0
    _same: int = 0

    def update(self, x: float) -> bool:
        flat = False
        if self._prev and x == self._prev[-1]:
            self._same += 1
            flat = self._same + 1 >= self.flat_run
        else:
            self._same = 0
        spike = False
        stored = x
        if len(self._prev) == 2:
            d = x - 2 * self._prev[-1] + self._prev[-2] if self.order == 2 else x - self._prev[-1]
            # EWMA variance is biased towards 0 at the start; correct it like Adam's second moment
            var = self._var / (1 - (1 - self.alpha) ** self._n) if self._n else 0.0
            sd = math.sqrt(var)
            if self._n >= self.warmup and sd > 0 and abs(d - self._mu) > self.k * sd:
                self._spike_run += 1
                if self._spike_run <= self.max_replace:
                    spike = True
                    # keep the history clean: remember the predicted value instead of the spike,
                    # so the next second differences are not contaminated by it
                    stored = (2 * self._prev[-1] - self._prev[-2] if self.order == 2 else self._prev[-1]) + self._mu
                else:
                    # several "spikes" in a row are a level shift (e.g. a sensor recovering from
                    # a stuck state): accept the new level and restart the history from it
                    self._spike_run = 0
                    self._prev = []
            else:
                self._spike_run = 0
                self._n += 1
                delta = d - self._mu
                self._mu += self.alpha * delta
                self._var = (1 - self.alpha) * (self._var + self.alpha * delta * delta)
        self._prev = (self._prev + [stored])[-2:]
        return spike or flat


@dataclass
class WindowSummary:
    sensor: str
    window_start_ms: int
    count: int
    minimum: float
    maximum: float
    mean: float
    std: float
    anomalies: int


@dataclass
class EdgeStats:
    received: int = 0
    aggregated: int = 0
    late: int = 0
    windows: int = 0
    flagged: list[tuple[Reading, bool]] = field(default_factory=list)  # (reading, flagged)


class EdgeAggregator:
    """Reorders, analyses and aggregates one twin's readings at the edge.

    Readings arrive out of order. Each sensor has a reorder buffer; a reading is released (in
    event-time order) once the watermark W = max event time − allowed lateness has passed it, then
    checked for anomalies and added to its window. A reading that arrives with an event time
    already behind W is late and dropped from aggregation (it is still part of the integrity log).
    """

    def __init__(self, window_ms: int = 1000, allowed_lateness_ms: int = 200, detector: dict | None = None):
        self.window_ms = window_ms
        self.lateness = allowed_lateness_ms
        self._buffers: dict[str, list[tuple[int, int, Reading]]] = defaultdict(list)
        self._open: dict[tuple[str, int], tuple[Welford, list[int]]] = {}
        self._detectors: dict[str, AnomalyDetector] = defaultdict(lambda: AnomalyDetector(**(detector or {})))
        self._watermark = -math.inf
        self.stats = EdgeStats()

    def process(self, r: Reading) -> list[WindowSummary]:
        """Consume one reading (arrival order); return the windows that the watermark closed."""
        self.stats.received += 1
        if r.t_event_ms <= self._watermark:
            self.stats.late += 1
            return []
        heapq.heappush(self._buffers[r.sensor], (r.t_event_ms, r.seq, r))
        self._watermark = max(self._watermark, r.t_event_ms - self.lateness)
        self._release(self._watermark)
        return self._close(self._watermark)

    def flush(self) -> list[WindowSummary]:
        self._release(math.inf)
        return self._close(math.inf)

    def _release(self, watermark: float) -> None:
        for sensor, buf in self._buffers.items():
            while buf and buf[0][0] <= watermark:
                _, _, r = heapq.heappop(buf)
                flagged = self._detectors[sensor].update(r.value)
                self.stats.flagged.append((r, flagged))
                start = r.t_event_ms - r.t_event_ms % self.window_ms
                w, flags = self._open.setdefault((sensor, start), (Welford(), [0]))
                w.add(r.value)
                flags[0] += int(flagged)
                self.stats.aggregated += 1

    def _close(self, watermark: float) -> list[WindowSummary]:
        out = []
        for sensor, start in sorted(k for k in self._open if k[1] + self.window_ms <= watermark):
            w, flags = self._open.pop((sensor, start))
            out.append(WindowSummary(sensor, start, w.n, w.lo, w.hi, w.mean, w.std, flags[0]))
            self.stats.windows += 1
        return out


def detection_scores(flagged: list[tuple[Reading, bool]]) -> dict[str, float]:
    tp = sum(1 for r, f in flagged if f and r.anomaly)
    fp = sum(1 for r, f in flagged if f and not r.anomaly)
    fn = sum(1 for r, f in flagged if not f and r.anomaly)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}
