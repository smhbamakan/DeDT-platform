"""Synthetic multi-sensor data flows of a digital twin (proposal T2.1: volume, velocity, variety).

Each sensor has its own sampling rate, unit, baseline signal, noise and drift. The simulator
injects the defects that make real twin data flows hard to manage:

  * anomalies  — spikes and stuck-at values, recorded as ground truth for detection experiments
  * loss       — readings dropped in transit
  * disorder   — network jitter, so readings arrive out of event-time order

It is deterministic for a given seed.
"""
from __future__ import annotations

import heapq
import math
import random
from dataclasses import dataclass, field
from typing import Iterator

from .encoding import encode_reading, name_id, to_micro


@dataclass(frozen=True)
class SensorSpec:
    name: str
    unit: str
    rate_hz: float
    baseline: float
    amplitude: float  # periodic component (machine cycle)
    period_s: float
    noise: float  # standard deviation of white noise
    drift_per_hour: float = 0.0  # slow degradation


@dataclass(frozen=True)
class Reading:
    twin: str
    sensor: str
    seq: int  # per-sensor sequence number
    t_event_ms: int  # when it was measured
    t_arrival_ms: int  # when the edge node received it
    value: float
    anomaly: bool = field(default=False, compare=False)  # ground truth, not part of the record

    def encode(self) -> bytes:
        return encode_reading(name_id(self.twin), name_id(self.sensor), self.seq, self.t_event_ms, to_micro(self.value))

    @property
    def size_bytes(self) -> int:
        return 160  # five ABI words


# A robot-arm digital twin, as in the WP1 scenarios
ROBOT_ARM = [
    SensorSpec("joint1.torque", "N·m", 100.0, 42.0, 6.0, 4.0, 0.8, drift_per_hour=0.5),
    SensorSpec("joint1.temperature", "°C", 1.0, 55.0, 1.5, 120.0, 0.2, drift_per_hour=0.8),
    SensorSpec("gearbox.vibration", "mm/s", 200.0, 2.4, 0.6, 0.5, 0.15),
    SensorSpec("motor.current", "A", 50.0, 11.0, 2.0, 4.0, 0.3),
    SensorSpec("hydraulic.pressure", "bar", 10.0, 180.0, 4.0, 30.0, 1.2, drift_per_hour=-1.0),
    SensorSpec("tool.position", "mm", 20.0, 0.0, 250.0, 4.0, 0.05),
]


@dataclass
class SimulationConfig:
    twin: str = "robot-arm-07"
    sensors: tuple[SensorSpec, ...] = tuple(ROBOT_ARM)
    duration_s: float = 60.0
    anomaly_rate: float = 0.002  # probability that a reading starts an anomaly
    loss_rate: float = 0.005
    jitter_ms: tuple[float, float] = (5.0, 40.0)  # mean and std of network delay
    seed: int = 7


def _signal(spec: SensorSpec, t: float) -> float:
    return spec.baseline + spec.amplitude * math.sin(2 * math.pi * t / spec.period_s) + spec.drift_per_hour * t / 3600


def simulate(cfg: SimulationConfig) -> Iterator[Reading]:
    """Yield readings in *arrival* order (out of event-time order, with losses)."""
    rng = random.Random(cfg.seed)
    events: list[tuple[int, int, Reading]] = []  # heap ordered by arrival time
    tie = 0
    mu, sigma = cfg.jitter_ms
    for spec in cfg.sensors:
        n = int(cfg.duration_s * spec.rate_hz)
        stuck_left = 0
        stuck_value = 0.0
        for seq in range(n):
            t = seq / spec.rate_hz
            value = _signal(spec, t) + rng.gauss(0.0, spec.noise)
            anomaly = False
            if stuck_left > 0:  # stuck-at sensor
                value, anomaly, stuck_left = stuck_value, True, stuck_left - 1
            elif rng.random() < cfg.anomaly_rate:
                anomaly = True
                if rng.random() < 0.7:  # spike of 6–12 standard deviations
                    value += rng.choice((-1, 1)) * rng.uniform(6, 12) * max(spec.noise, 1e-6)
                else:  # sensor stuck for a short time
                    stuck_value, stuck_left = value, rng.randint(3, 15)
            if rng.random() < cfg.loss_rate:
                continue
            t_event = round(t * 1000)
            t_arrival = t_event + max(0, round(rng.gauss(mu, sigma)))
            r = Reading(cfg.twin, spec.name, seq, t_event, t_arrival, round(value, 6), anomaly)
            heapq.heappush(events, (t_arrival, tie, r))
            tie += 1
    while events:
        yield heapq.heappop(events)[2]
