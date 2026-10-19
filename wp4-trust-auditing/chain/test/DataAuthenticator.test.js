const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { py } = require("./py");

const TWIN = 1;
const SEEDS = ["sensor-0", "sensor-1", "sensor-2", "sensor-3", "sensor-4"];
const RECORDS = ["t=0 temp=21.4", "t=1 temp=21.5", "t=2 temp=21.7", "t=3 vib=0.02", "t=4 rpm=1480"];

describe("DataAuthenticator (self-judging data authentication, T4.2)", function () {
  async function deployed() {
    const [owner, relayer, reporter, outsider] = await ethers.getSigners();
    const nft = await ethers.deployContract("MockTwinNFT");
    await nft.mint(owner.address, TWIN);
    const auth = await ethers.deployContract("DataAuthenticator", [await nft.getAddress()]);
    const keys = py("signers", { seeds: SEEDS.join(",") });
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const address = await auth.getAddress();
    /** Aggregate signature of the given signer indexes on (seq, root), made by the Python reference. */
    const sign = (seq, root, idx, contract = address) =>
      py("batch", { chainId: chainId.toString(), contract, twin: String(TWIN), seq: String(seq), root, seeds: idx.map((i) => SEEDS[i]).join(",") });
    const mask = (idx) => idx.reduce((m, i) => m | (1 << i), 0);
    return { owner, relayer, reporter, outsider, nft, auth, keys, sign, mask };
  }

  /** Four signers registered, threshold 3, one batch (seq 0) signed by signers 0, 1, 2. */
  async function withBatch() {
    const f = await deployed();
    for (const k of f.keys.slice(0, 4)) await f.auth.addSigner(TWIN, k.pk1, k.pk2, k.pop);
    await f.auth.setThreshold(TWIN, 3);
    const tree = py("merkle", { records: RECORDS.join(",") });
    const s = f.sign(0, tree.root, [0, 1, 2]);
    await f.auth.connect(f.relayer).submitBatch(TWIN, 0, tree.root, f.mask([0, 1, 2]), s.sig, s.apk2);
    return { ...f, tree };
  }

  describe("feed setup", function () {
    it("registers signers that prove possession of their key", async function () {
      const { auth, keys } = await loadFixture(deployed);
      await expect(auth.addSigner(TWIN, keys[0].pk1, keys[0].pk2, keys[0].pop)).to.emit(auth, "SignerAdded").withArgs(TWIN, 0, keys[0].pk1.x, keys[0].pk1.y);
      expect((await auth.feeds(TWIN)).signerCount).to.equal(1);
      expect((await auth.signerKey(TWIN, 0)).x).to.equal(keys[0].pk1.x);
    });

    it("rejects a missing proof of possession (rogue-key defence)", async function () {
      const { auth, keys } = await loadFixture(deployed);
      await expect(auth.addSigner(TWIN, keys[0].pk1, keys[0].pk2, keys[1].pop)).to.be.revertedWithCustomError(auth, "InvalidProofOfPossession");
      // G1 and G2 keys of different secrets
      await expect(auth.addSigner(TWIN, keys[0].pk1, keys[1].pk2, keys[0].pop)).to.be.revertedWithCustomError(auth, "InvalidProofOfPossession");
    });

    it("lets only the twin owner configure the feed, with a valid threshold", async function () {
      const { auth, keys, outsider } = await loadFixture(deployed);
      await expect(auth.connect(outsider).addSigner(TWIN, keys[0].pk1, keys[0].pk2, keys[0].pop)).to.be.revertedWithCustomError(auth, "NotTwinOwner");
      await auth.addSigner(TWIN, keys[0].pk1, keys[0].pk2, keys[0].pop);
      await expect(auth.setThreshold(TWIN, 0)).to.be.revertedWithCustomError(auth, "InvalidThreshold");
      await expect(auth.setThreshold(TWIN, 2)).to.be.revertedWithCustomError(auth, "InvalidThreshold");
      await expect(auth.connect(outsider).setThreshold(TWIN, 1)).to.be.revertedWithCustomError(auth, "NotTwinOwner");
      await expect(auth.setThreshold(TWIN, 1)).to.emit(auth, "ThresholdSet").withArgs(TWIN, 1);
    });
  });

  describe("batches", function () {
    it("accepts a batch co-signed by a threshold of signers, relayed by anyone", async function () {
      const { auth, tree, relayer } = await loadFixture(withBatch);
      const b = await auth.batches(TWIN, 0);
      expect(b.root).to.equal(tree.root);
      expect(b.signers).to.equal(0b0111);
      const evs = await auth.queryFilter(auth.filters.BatchAuthenticated());
      expect(evs[0].args.submitter).to.equal(relayer.address);
    });

    it("judges single records against the authenticated root", async function () {
      const { auth, tree } = await loadFixture(withBatch);
      for (let i = 0; i < RECORDS.length; i++) expect(await auth.isAuthentic(TWIN, 0, tree.records[i], tree.proofs[i])).to.equal(true);
      expect(await auth.isAuthentic(TWIN, 0, ethers.id("t=2 temp=99.9"), tree.proofs[2])).to.equal(false);
      expect(await auth.isAuthentic(TWIN, 1, tree.records[0], tree.proofs[0])).to.equal(false);
    });

    it("rejects too few signers, wrong signer sets, forged and replayed signatures", async function () {
      const { auth, sign, mask, tree } = await loadFixture(withBatch);
      const root = ethers.id("batch 1");
      const ok = sign(1, root, [1, 2, 3]);
      await expect(auth.submitBatch(TWIN, 1, root, mask([1, 2]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignerSet");
      await expect(auth.submitBatch(TWIN, 1, root, mask([0, 2, 3]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignature");
      await expect(auth.submitBatch(TWIN, 1, root, mask([1, 2, 3, 6]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignerSet");
      await expect(auth.submitBatch(TWIN, 1, ethers.id("other"), mask([1, 2, 3]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignature");
      await expect(auth.submitBatch(TWIN, 2, root, mask([1, 2, 3]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignature");
      // signed for another deployment: rejected here
      const elsewhere = sign(1, root, [1, 2, 3], ethers.Wallet.createRandom().address);
      await expect(auth.submitBatch(TWIN, 1, root, mask([1, 2, 3]), elsewhere.sig, elsewhere.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignature");
      await expect(auth.submitBatch(TWIN, 1, ethers.ZeroHash, mask([1, 2, 3]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "EmptyRoot");
      await auth.submitBatch(TWIN, 1, root, mask([1, 2, 3]), ok.sig, ok.apk2);
      await expect(auth.submitBatch(TWIN, 1, root, mask([1, 2, 3]), ok.sig, ok.apk2)).to.be.revertedWithCustomError(auth, "AlreadySubmitted");
      expect((await auth.batches(TWIN, 0)).root).to.equal(tree.root);
    });

    it("needs a configured threshold", async function () {
      const { auth, sign, mask, keys } = await loadFixture(deployed);
      await auth.addSigner(TWIN, keys[0].pk1, keys[0].pk2, keys[0].pop);
      const s = sign(0, ethers.id("x"), [0]);
      await expect(auth.submitBatch(TWIN, 0, ethers.id("x"), mask([0]), s.sig, s.apk2)).to.be.revertedWithCustomError(auth, "InvalidThreshold");
    });
  });

  describe("equivocation (the contract as judge)", function () {
    it("revokes the signers of two conflicting roots, freezes the feed and pays the bond", async function () {
      const { auth, sign, mask, reporter } = await loadFixture(withBatch);
      await expect(auth.depositBond(TWIN, { value: ethers.parseEther("1") })).to.emit(auth, "BondDeposited");
      // signers 1 and 2 also sign a different root for seq 0, together with signer 3
      const forged = ethers.id("rewritten history");
      const s = sign(0, forged, [1, 2, 3]);
      const tx = auth.connect(reporter).reportEquivocation(TWIN, 0, forged, mask([1, 2, 3]), s.sig, s.apk2);
      await expect(tx).to.changeEtherBalance(reporter, ethers.parseEther("1"));
      await expect(tx).to.emit(auth, "EquivocationProven").withArgs(TWIN, 0, mask([1, 2]), reporter.address, ethers.parseEther("1"));
      const f = await auth.feeds(TWIN);
      expect(f.frozen).to.equal(true);
      expect(f.revoked).to.equal(mask([1, 2]));
      expect(f.bond).to.equal(0);

      const next = sign(1, ethers.id("next"), [0, 1, 3]);
      await expect(auth.submitBatch(TWIN, 1, ethers.id("next"), mask([0, 1, 3]), next.sig, next.apk2)).to.be.revertedWithCustomError(auth, "FeedFrozen");
      // only signers 0 and 3 remain honest: not enough for threshold 3
      await expect(auth.resume(TWIN)).to.be.revertedWithCustomError(auth, "StillUnsafe");
    });

    it("lets the owner resume with enough honest signers, never with revoked ones", async function () {
      const { auth, sign, mask, keys, outsider } = await loadFixture(withBatch);
      const s = sign(0, ethers.id("fork"), [1, 2, 3]);
      await auth.reportEquivocation(TWIN, 0, ethers.id("fork"), mask([1, 2, 3]), s.sig, s.apk2);
      await auth.addSigner(TWIN, keys[4].pk1, keys[4].pk2, keys[4].pop); // replacement sensor
      await expect(auth.connect(outsider).resume(TWIN)).to.be.revertedWithCustomError(auth, "NotTwinOwner");
      await expect(auth.resume(TWIN)).to.emit(auth, "FeedResumed").withArgs(TWIN);
      const withRevoked = sign(1, ethers.id("b1"), [0, 1, 4]);
      await expect(auth.submitBatch(TWIN, 1, ethers.id("b1"), mask([0, 1, 4]), withRevoked.sig, withRevoked.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignerSet");
      const honest = sign(1, ethers.id("b1"), [0, 3, 4]);
      await expect(auth.submitBatch(TWIN, 1, ethers.id("b1"), mask([0, 3, 4]), honest.sig, honest.apk2)).to.emit(auth, "BatchAuthenticated");
    });

    it("rejects reports without a conflict, a common signer or a valid signature", async function () {
      const { auth, sign, mask, tree } = await loadFixture(withBatch);
      const same = sign(0, tree.root, [1, 2, 3]);
      await expect(auth.reportEquivocation(TWIN, 0, tree.root, mask([1, 2, 3]), same.sig, same.apk2)).to.be.revertedWithCustomError(auth, "NoConflict");
      const unknown = sign(5, ethers.id("x"), [0, 1, 2]);
      await expect(auth.reportEquivocation(TWIN, 5, ethers.id("x"), mask([0, 1, 2]), unknown.sig, unknown.apk2)).to.be.revertedWithCustomError(auth, "NoConflict");
      const disjoint = sign(0, ethers.id("y"), [3]);
      await expect(auth.reportEquivocation(TWIN, 0, ethers.id("y"), mask([3]), disjoint.sig, disjoint.apk2)).to.be.revertedWithCustomError(auth, "NoCommonSigner");
      const bad = sign(0, ethers.id("y"), [1, 3]);
      await expect(auth.reportEquivocation(TWIN, 0, ethers.id("z"), mask([1, 3]), bad.sig, bad.apk2)).to.be.revertedWithCustomError(auth, "InvalidSignature");
    });
  });
});
