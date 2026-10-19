const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { attest, relayPending, utsFromEvent } = require("../lib/l3");
const { twoChains, DOMAIN_A, DOMAIN_B, THRESHOLD } = require("./fixtures");

const h = (s) => ethers.id(s);

describe("DigitalTwinDNFT over the L3 network (paper Fig. 3, Steps 1–13)", function () {
  const relayAtoB = (f) => relayPending({ source: f.gatewayA, dest: f.gatewayB, validators: f.validators, relayer: f.relayer });
  const relayBtoA = (f) => relayPending({ source: f.gatewayB, dest: f.gatewayA, validators: f.validators, relayer: f.relayer });
  /** Messages dispatched on chain A for chain B and not yet delivered, in dispatch order. */
  const pendingAtoB = async (f) => {
    const evs = await f.gatewayA.queryFilter(f.gatewayA.filters.MessageDispatched(null, DOMAIN_B));
    const out = [];
    for (const ev of evs) if (!(await f.gatewayB.delivered(ev.args.id))) out.push(ev);
    return out;
  };
  const deliverOne = async (f, ev) =>
    f.gatewayB.connect(f.relayer).deliver(utsFromEvent(DOMAIN_A, ev), await attest(ev.args.id, f.validators.slice(0, THRESHOLD), f.gatewayB));

  /** Steps 1–2: team #1 launches and develops its twin on chain A. */
  async function minted() {
    const f = await twoChains();
    await f.dnftA.connect(f.team1).mint(h("turbine-v1"), "ipfs://turbine");
    return f;
  }

  /** Steps 6–12: team #1 shares the twin with team #2 on chain B. */
  async function shared() {
    const f = await minted();
    await f.dnftA.connect(f.team1).shareTwin(1, DOMAIN_B, f.team2.address);
    await relayAtoB(f);
    return { ...f, mirrorId: await f.dnftB.mirrorOf(DOMAIN_A, 1, f.team2.address) };
  }

  describe("native twins", function () {
    it("mints a dNFT with its first revision", async function () {
      const { dnftA, team1 } = await loadFixture(minted);
      const t = await dnftA.twin(1);
      expect(await dnftA.ownerOf(1)).to.equal(team1.address);
      expect(t.stateHash).to.equal(h("turbine-v1"));
      expect(t.version).to.equal(1);
      expect(t.originDomain).to.equal(0);
      expect(await dnftA.tokenURI(1)).to.equal("ipfs://turbine");
      expect((await dnftA.revisionAt(1, 0)).author).to.equal(team1.address);
    });

    it("lets the owner and collaborators evolve the state, S(t+1) = f(S(t), C)", async function () {
      const { dnftA, team1, outsider } = await loadFixture(minted);
      await expect(dnftA.connect(outsider).updateState(1, h("x"), "")).to.be.revertedWithCustomError(dnftA, "NotAuthorized");
      await expect(dnftA.connect(outsider).setCollaborator(1, outsider.address, true)).to.be.revertedWithCustomError(dnftA, "NotAuthorized");
      await dnftA.connect(team1).setCollaborator(1, outsider.address, true);
      await expect(dnftA.connect(outsider).updateState(1, h("turbine-v2"), "ipfs://turbine-v2"))
        .to.emit(dnftA, "StateUpdated")
        .withArgs(1, 2, h("turbine-v2"), outsider.address, DOMAIN_A);
      expect(await dnftA.tokenURI(1)).to.equal("ipfs://turbine-v2");
      expect(await dnftA.historyLength(1)).to.equal(2);
    });
  });

  describe("cross-chain collaboration", function () {
    it("gives team #2 a mirror dNFT on chain B", async function () {
      const { dnftB, team2, mirrorId } = await loadFixture(shared);
      expect(mirrorId).to.equal(1);
      expect(await dnftB.ownerOf(mirrorId)).to.equal(team2.address);
      const t = await dnftB.twin(mirrorId);
      expect(t.originDomain).to.equal(DOMAIN_A);
      expect(t.originTokenId).to.equal(1);
      expect(t.stateHash).to.equal(h("turbine-v1"));
      expect(await dnftB.tokenURI(mirrorId)).to.equal("ipfs://turbine");
    });

    it("Step 13: team #2's contribution is recorded on the origin twin", async function () {
      const f = await loadFixture(shared);
      await f.dnftB.connect(f.team2).contribute(f.mirrorId, h("turbine-v2-by-team2"), "");
      await relayBtoA(f);

      const t = await f.dnftA.twin(1);
      expect(t.stateHash).to.equal(h("turbine-v2-by-team2"));
      expect(t.version).to.equal(2);
      const rev = await f.dnftA.revisionAt(1, 1);
      expect(rev.author).to.equal(f.team2.address);
      expect(rev.authorDomain).to.equal(DOMAIN_B);
    });

    it("syncs the origin's latest state to the mirror", async function () {
      const f = await loadFixture(shared);
      await f.dnftA.connect(f.team1).updateState(1, h("turbine-v3"), "");
      await f.dnftA.connect(f.team1).syncTwin(1, DOMAIN_B, f.team2.address);
      await relayAtoB(f);
      expect((await f.dnftB.twin(f.mirrorId)).stateHash).to.equal(h("turbine-v3"));
    });

    it("revoking access freezes the mirror, and re-sharing restores it", async function () {
      const f = await loadFixture(shared);
      await f.dnftA.connect(f.team1).revokeShare(1, DOMAIN_B, f.team2.address);
      await relayAtoB(f);
      expect((await f.dnftB.twin(f.mirrorId)).revoked).to.equal(true);
      await expect(f.dnftB.connect(f.team2).contribute(f.mirrorId, h("late"), "")).to.be.revertedWithCustomError(f.dnftB, "MirrorRevoked");

      await f.dnftA.connect(f.team1).shareTwin(1, DOMAIN_B, f.team2.address);
      await relayAtoB(f);
      expect((await f.dnftB.twin(f.mirrorId)).revoked).to.equal(false);
      expect(await f.dnftB.mirrorOf(DOMAIN_A, 1, f.team2.address)).to.equal(f.mirrorId);
    });

    it("rejects a contribution that arrives after the share was revoked, without blocking the channel", async function () {
      const f = await loadFixture(shared);
      await f.dnftB.connect(f.team2).contribute(f.mirrorId, h("in-flight"), ""); // dispatched on B
      await f.dnftA.connect(f.team1).revokeShare(1, DOMAIN_B, f.team2.address); // revoked on A first
      await relayBtoA(f); // delivered, but without effect
      const [rej] = await f.dnftA.queryFilter(f.dnftA.filters.ContributionRejected());
      expect(rej.args).to.deep.equal([1n, BigInt(DOMAIN_B), f.team2.address, 0n]);
      expect(await f.dnftA.historyLength(1)).to.equal(1);

      // after a re-share, the next contribution on the same channel is accepted
      await f.dnftA.connect(f.team1).shareTwin(1, DOMAIN_B, f.team2.address);
      await relayAtoB(f); // Revoke, then Share, in order
      await f.dnftB.connect(f.team2).contribute(f.mirrorId, h("after-reshare"), "");
      await relayBtoA(f);
      expect((await f.dnftA.twin(1)).stateHash).to.equal(h("after-reshare"));
    });

    it("applies messages of a channel strictly in order (revoke, then re-share)", async function () {
      const f = await loadFixture(shared);
      await f.dnftA.connect(f.team1).revokeShare(1, DOMAIN_B, f.team2.address); // seq 1
      await f.dnftA.connect(f.team1).shareTwin(1, DOMAIN_B, f.team2.address); // seq 2
      const [revoke, reshare] = await pendingAtoB(f);

      // a relayer delivers the re-share first: it is refused and stays deliverable
      const ch = await f.dnftB.channelId(DOMAIN_A, 1, DOMAIN_B, f.team2.address, false);
      await expect(deliverOne(f, reshare)).to.be.revertedWithCustomError(f.dnftB, "OutOfOrder").withArgs(ch, 1, 2);
      expect(await f.gatewayB.delivered(reshare.args.id)).to.equal(false);

      await deliverOne(f, revoke);
      expect((await f.dnftB.twin(f.mirrorId)).revoked).to.equal(true);
      await deliverOne(f, reshare);
      // the final state matches the origin: shared, not revoked
      expect((await f.dnftB.twin(f.mirrorId)).revoked).to.equal(false);
      expect(await f.dnftA.sharedWith(1, DOMAIN_B, f.team2.address)).to.equal(true);
      expect(await f.dnftB.nextInSeq(ch)).to.equal(3);
      expect(await f.dnftA.nextOutSeq(ch)).to.equal(3);
    });

    it("mirrors cannot be transferred and only their holder can contribute", async function () {
      const { dnftB, team2, outsider, mirrorId } = await loadFixture(shared);
      await expect(dnftB.connect(team2).transferFrom(team2.address, outsider.address, mirrorId)).to.be.revertedWithCustomError(dnftB, "MirrorNotTransferable");
      await expect(dnftB.connect(outsider).contribute(mirrorId, h("x"), "")).to.be.revertedWithCustomError(dnftB, "NotAuthorized");
    });

    it("guards native-only and mirror-only operations", async function () {
      const { dnftA, dnftB, team1, team2, mirrorId } = await loadFixture(shared);
      await expect(dnftB.connect(team2).updateState(mirrorId, h("x"), "")).to.be.revertedWithCustomError(dnftB, "NotNative");
      await expect(dnftB.connect(team2).shareTwin(mirrorId, DOMAIN_A, team1.address)).to.be.revertedWithCustomError(dnftB, "NotNative");
      await expect(dnftA.connect(team1).contribute(1, h("x"), "")).to.be.revertedWithCustomError(dnftA, "NotMirror");
      await expect(dnftA.connect(team1).syncTwin(1, DOMAIN_B, team1.address)).to.be.revertedWithCustomError(dnftA, "NotShared");
      await expect(dnftA.connect(team1).revokeShare(1, DOMAIN_B, team1.address)).to.be.revertedWithCustomError(dnftA, "NotShared");
    });

    it("only accepts messages from the gateway and trusted remotes", async function () {
      const f = await loadFixture(shared);
      await expect(f.dnftB.handleL3Message(DOMAIN_A, await f.dnftA.getAddress(), "0x")).to.be.revertedWithCustomError(f.dnftB, "OnlyGateway");

      // an attacker contract on chain A dispatches a fake "share" through the real gateway
      const fake = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8,uint256,address,address,bytes32,string,uint64)"],
        [[0, 1, f.outsider.address, f.outsider.address, h("fake"), "", 0]]
      );
      await f.gatewayA.connect(f.outsider).dispatch(DOMAIN_B, await f.dnftB.getAddress(), fake);
      await expect(relayAtoB(f)).to.be.revertedWithCustomError(f.dnftB, "UntrustedRemote");
    });
  });
});
