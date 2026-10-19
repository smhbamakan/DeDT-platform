import dataclasses

from dedt_flows.integrity import ZERO, BatchBuilder, audit, chain_hash, verify_reading
from dedt_flows.pipeline import run
from dedt_flows.simulator import SimulationConfig


def flow(seconds=5):
    res = run(SimulationConfig(duration_s=seconds, seed=5), batch_readings=256, batch_interval_ms=500)
    anchors = [b.to_anchor(res.cfg.twin) for b in res.builder.batches]
    log = [list(b.readings) for b in res.builder.batches]
    return res, anchors, log


def test_batches_cover_every_received_reading_and_respect_limits():
    res, _, _ = flow()
    bs = res.builder.batches
    assert sum(b.count for b in bs) == res.edge.stats.received
    assert all(b.count <= 256 for b in bs)


def test_hash_chain_links_batches():
    res, _, _ = flow()
    prev = ZERO
    for b in res.builder.batches:
        assert b.prev_chain == prev
        assert b.chain == chain_hash(prev, b.root, b.summary_hash, b.index, b.count, b.start_ms, b.end_ms)
        prev = b.chain


def test_every_reading_is_provable_against_its_root():
    res, _, _ = flow(2)
    for b in res.builder.batches:
        for i, r in enumerate(b.readings):
            assert verify_reading(r, b.proof(i), b.root)


def test_audit_accepts_an_untouched_log():
    _, anchors, log = flow()
    assert audit(log, anchors).ok


def test_audit_detects_modification_deletion_insertion_and_reordering():
    _, anchors, log = flow()
    modified = [list(b) for b in log]
    modified[3][7] = dataclasses.replace(modified[3][7], value=modified[3][7].value + 0.000001)
    assert audit(modified, anchors).bad_batches == [3]

    deleted = [list(b) for b in log]
    del deleted[5][0]
    assert audit(deleted, anchors).bad_batches == [5]

    inserted = [list(b) for b in log]
    inserted[2].append(inserted[2][0])
    assert audit(inserted, anchors).bad_batches == [2]

    assert not audit(log[:-1], anchors).ok  # a whole batch missing

    swapped = list(anchors)
    swapped[1], swapped[2] = swapped[2], swapped[1]
    assert not audit([log[0], log[2], log[1]] + log[3:], swapped).chain_ok  # reordering breaks the chain


def test_order_of_readings_inside_a_batch_does_not_matter():
    _, anchors, log = flow()
    shuffled = [list(reversed(b)) for b in log]
    assert audit(shuffled, anchors).ok


def test_builder_seals_by_time():
    res = run(SimulationConfig(duration_s=3, seed=1), batch_readings=10**9, batch_interval_ms=1000)
    assert 2 <= len(res.builder.batches) <= 4
    assert BatchBuilder().flush() is None
