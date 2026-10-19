// The fixture is produced by the Python pipeline (python -m dedt_flows.pipeline), so these tests
// prove that leaves, Merkle proofs and chain hashes are computed identically in Python and Solidity.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fixture = require("./fixtures/batch.json");

describe("DataAnchor", function () {
  async function deployed() {
    const [owner, edge, outsider] = await ethers.getSigners();
    const anchor = await ethers.deployContract("DataAnchor");
    const twinId = fixture.batch.twinId;
    await anchor.registerTwin(twinId);
    await anchor.setSubmitter(twinId, edge.address, true);
    return { anchor, owner, edge, outsider, twinId };
  }

  const args = (b) => [b.twinId, b.index, b.merkleRoot, b.summaryHash, b.count, b.startMs, b.endMs];

  async function anchored() {
    const f = await deployed();
    await f.anchor.connect(f.edge).anchor(...args(fixture.batch));
    return f;
  }

  it("computes the same chain hash as the Python pipeline", async function () {
    const { anchor, edge, twinId } = await loadFixture(deployed);
    await expect(anchor.connect(edge).anchor(...args(fixture.batch)))
      .to.emit(anchor, "BatchAnchored")
      .withArgs(twinId, 0, fixture.batch.merkleRoot, fixture.batch.summaryHash, fixture.batch.chain, fixture.batch.count);
    await anchor.connect(edge).anchor(...args(fixture.next));
    const t = await anchor.twins(twinId);
    expect(t.head).to.equal(fixture.next.chain);
    expect(t.nextIndex).to.equal(2);
  });

  it("verifies readings with Merkle proofs produced in Python", async function () {
    const { anchor, twinId } = await loadFixture(anchored);
    for (const r of fixture.readings) {
      expect(await anchor.verifyReading(twinId, 0, r.sensorId, r.seq, r.tEventMs, r.valueMicro, r.proof)).to.equal(true);
    }
  });

  it("rejects a tampered value, sequence number or proof", async function () {
    const { anchor, twinId } = await loadFixture(anchored);
    const r = fixture.readings[0];
    expect(await anchor.verifyReading(twinId, 0, r.sensorId, r.seq, r.tEventMs, BigInt(r.valueMicro) + 1n, r.proof)).to.equal(false);
    expect(await anchor.verifyReading(twinId, 0, r.sensorId, r.seq + 1, r.tEventMs, r.valueMicro, r.proof)).to.equal(false);
    expect(await anchor.verifyReading(twinId, 0, r.sensorId, r.seq, r.tEventMs, r.valueMicro, r.proof.slice(1))).to.equal(false);
    await expect(anchor.verifyReading(twinId, 7, r.sensorId, r.seq, r.tEventMs, r.valueMicro, r.proof)).to.be.revertedWithCustomError(anchor, "UnknownBatch");
  });

  it("enforces order, authorisation and non-empty batches", async function () {
    const { anchor, edge, outsider, twinId } = await loadFixture(deployed);
    await expect(anchor.connect(outsider).anchor(...args(fixture.batch))).to.be.revertedWithCustomError(anchor, "NotSubmitter");
    await expect(anchor.connect(edge).anchor(...args(fixture.next)))
      .to.be.revertedWithCustomError(anchor, "WrongIndex")
      .withArgs(0, 1);
    const empty = { ...fixture.batch, count: 0 };
    await expect(anchor.connect(edge).anchor(...args(empty))).to.be.revertedWithCustomError(anchor, "EmptyBatch");
  });

  it("lets only the twin owner manage edge nodes, and registers a twin once", async function () {
    const { anchor, edge, outsider, twinId } = await loadFixture(deployed);
    await expect(anchor.connect(outsider).setSubmitter(twinId, outsider.address, true)).to.be.revertedWithCustomError(anchor, "NotOwner");
    await expect(anchor.registerTwin(twinId)).to.be.revertedWithCustomError(anchor, "AlreadyRegistered");
    await anchor.setSubmitter(twinId, edge.address, false);
    await expect(anchor.connect(edge).anchor(...args(fixture.batch))).to.be.revertedWithCustomError(anchor, "NotSubmitter");
  });

  it("stores the batch record", async function () {
    const { anchor, twinId } = await loadFixture(anchored);
    const b = await anchor.batch(twinId, 0);
    expect(b.root).to.equal(fixture.batch.merkleRoot);
    expect(b.count).to.equal(fixture.batch.count);
    expect(b.chain).to.equal(fixture.batch.chain);
  });
});
