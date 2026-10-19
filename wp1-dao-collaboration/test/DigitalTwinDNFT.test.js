const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { relayPending } = require("../lib/l3");
const { twoChains, DOMAIN_A, DOMAIN_B } = require("./fixtures");

const h = (s) => ethers.id(s);

describe("DigitalTwinDNFT over the L3 network (paper Fig. 3, Steps 1–13)", function () {
  const relayAtoB = (f) => relayPending({ source: f.gatewayA, dest: f.gatewayB, validators: f.validators, relayer: f.relayer });
  const relayBtoA = (f) => relayPending({ source: f.gatewayB, dest: f.gatewayA, validators: f.validators, relayer: f.relayer });

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

    it("rejects a contribution that arrives after the share was revoked", async function () {
      const f = await loadFixture(shared);
      await f.dnftB.connect(f.team2).contribute(f.mirrorId, h("in-flight"), ""); // dispatched on B
      await f.dnftA.connect(f.team1).revokeShare(1, DOMAIN_B, f.team2.address); // revoked on A first
      await expect(relayBtoA(f)).to.be.revertedWithCustomError(f.dnftA, "NotShared");
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
        ["tuple(uint8,uint256,address,address,bytes32,string)"],
        [[0, 1, f.outsider.address, f.outsider.address, h("fake"), ""]]
      );
      await f.gatewayA.connect(f.outsider).dispatch(DOMAIN_B, await f.dnftB.getAddress(), fake);
      await expect(relayAtoB(f)).to.be.revertedWithCustomError(f.dnftB, "UntrustedRemote");
    });
  });
});
