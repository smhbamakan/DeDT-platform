const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { attest, sortBySigner, utsFromEvent } = require("../lib/l3");
const { twoChains, DOMAIN_A, DOMAIN_B, THRESHOLD } = require("./fixtures");

describe("L3Gateway", function () {
  /** Dispatch a message from team1 on chain A to a receiver contract on chain B. */
  async function dispatched() {
    const f = await twoChains();
    const receiver = await ethers.deployContract("MockReceiver");
    const tx = await f.gatewayA.connect(f.team1).dispatch(DOMAIN_B, await receiver.getAddress(), "0xc0ffee");
    const ev = (await f.gatewayA.queryFilter(f.gatewayA.filters.MessageDispatched(), tx.blockNumber))[0];
    return { ...f, receiver, ev, uts: utsFromEvent(DOMAIN_A, ev), id: ev.args.id };
  }

  describe("dispatch (Algorithm 3)", function () {
    it("derives the message ID from the UTS and increments the nonce", async function () {
      const { gatewayA, uts, id } = await loadFixture(dispatched);
      expect(await gatewayA.messageId(uts)).to.equal(id);
      expect(uts.nonce).to.equal(0);
      expect(await gatewayA.outboundNonce()).to.equal(1);
    });

    it("rejects messages to its own domain", async function () {
      const { gatewayA, team1 } = await loadFixture(dispatched);
      await expect(gatewayA.connect(team1).dispatch(DOMAIN_A, team1.address, "0x"))
        .to.be.revertedWithCustomError(gatewayA, "WrongDomain")
        .withArgs(DOMAIN_A);
    });
  });

  describe("deliver (Algorithm 4)", function () {
    it("executes the message when a quorum of validators attests it", async function () {
      const { gatewayB, receiver, validators, relayer, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await expect(gatewayB.connect(relayer).deliver(uts, sigs))
        .to.emit(gatewayB, "MessageDelivered")
        .withArgs(id, DOMAIN_A, await receiver.getAddress(), relayer.address);
      expect(await receiver.lastPayload()).to.equal("0xc0ffee");
      expect(await receiver.lastOrigin()).to.equal(DOMAIN_A);
      expect(await gatewayB.delivered(id)).to.equal(true);
    });

    it("prevents replay of a delivered message", async function () {
      const { gatewayB, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await gatewayB.deliver(uts, sigs);
      await expect(gatewayB.deliver(uts, sigs)).to.be.revertedWithCustomError(gatewayB, "AlreadyDelivered").withArgs(id);
    });

    it("rejects delivery on the wrong chain", async function () {
      const { gatewayA, gatewayB, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await expect(gatewayA.deliver(uts, sigs)).to.be.revertedWithCustomError(gatewayA, "WrongDomain");
    });

    it("requires a quorum", async function () {
      const { gatewayB, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD - 1), gatewayB);
      await expect(gatewayB.deliver(uts, sigs))
        .to.be.revertedWithCustomError(gatewayB, "InsufficientSignatures")
        .withArgs(THRESHOLD - 1, THRESHOLD);
    });

    it("rejects duplicate, unsorted or unknown signers", async function () {
      const { gatewayB, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await expect(gatewayB.deliver(uts, [sigs[0], sigs[0], sigs[1]])).to.be.revertedWithCustomError(gatewayB, "UnsortedOrDuplicateSigner");
      await expect(gatewayB.deliver(uts, [...sigs].reverse())).to.be.revertedWithCustomError(gatewayB, "UnsortedOrDuplicateSigner");

      const intruders = Array.from({ length: THRESHOLD }, () => ethers.Wallet.createRandom());
      await expect(gatewayB.deliver(uts, await attest(id, intruders, gatewayB))).to.be.revertedWithCustomError(gatewayB, "UnknownValidator");
    });

    it("rejects a tampered payload", async function () {
      const { gatewayB, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await expect(gatewayB.deliver({ ...uts, payload: "0xdeadbeef" }, sigs)).to.be.revertedWithCustomError(gatewayB, "UnknownValidator");
    });

    it("binds attestations to the destination gateway (no reuse on another deployment)", async function () {
      const { gatewayB, validators, uts, id } = await loadFixture(dispatched);
      // a second gateway with the same domain number and the same validators
      const twin = await ethers.deployContract("L3Gateway", [DOMAIN_B, validators.map((v) => v.address), THRESHOLD]);
      const sigsForB = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await expect(twin.deliver(uts, sigsForB)).to.be.revertedWithCustomError(twin, "UnknownValidator");
      await twin.deliver(uts, await attest(id, validators.slice(0, THRESHOLD), twin));
      expect(await twin.delivered(id)).to.equal(true);
      expect(await gatewayB.delivered(id)).to.equal(false);
    });

    it("can be retried if the recipient reverts", async function () {
      const { gatewayB, receiver, validators, uts, id } = await loadFixture(dispatched);
      const sigs = await attest(id, validators.slice(0, THRESHOLD), gatewayB);
      await receiver.setFail(true);
      await expect(gatewayB.deliver(uts, sigs)).to.be.revertedWith("receiver failed");
      expect(await gatewayB.delivered(id)).to.equal(false);
      await receiver.setFail(false);
      await gatewayB.deliver(uts, sigs);
      expect(await gatewayB.delivered(id)).to.equal(true);
    });
  });

  describe("validator governance (no admin)", function () {
    it("rotates the validator set with a quorum of the current set", async function () {
      const { gatewayB, validators } = await loadFixture(dispatched);
      const fresh = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
      const newSet = fresh.map((v) => v.address);
      const digest = await gatewayB.validatorSetDigest(newSet, 3);
      // digest is already EIP-191 prefixed, so sign the raw hash
      const sign = (v) => ({ signer: v.address.toLowerCase(), sig: v.signingKey.sign(digest).serialized });
      const sigs = sortBySigner(validators.slice(0, THRESHOLD).map(sign));

      await expect(gatewayB.updateValidators(newSet, 3, sigs)).to.emit(gatewayB, "ValidatorSetUpdated").withArgs(2, newSet, 3);
      expect(await gatewayB.isValidator(validators[0].address)).to.equal(false);
      expect(await gatewayB.isValidator(fresh[0].address)).to.equal(true);
      expect(await gatewayB.threshold()).to.equal(3);
      // the old signatures cannot be reused: the version has changed
      await expect(gatewayB.updateValidators(newSet, 3, sigs)).to.be.revertedWithCustomError(gatewayB, "UnknownValidator");
    });

    it("rejects invalid validator sets", async function () {
      const { validators } = await loadFixture(dispatched);
      const a = validators[0].address;
      const Gateway = await ethers.getContractFactory("L3Gateway");
      await expect(Gateway.deploy(1, [], 1)).to.be.revertedWithCustomError(Gateway, "InvalidValidatorSet");
      await expect(Gateway.deploy(1, [a], 2)).to.be.revertedWithCustomError(Gateway, "InvalidValidatorSet");
      await expect(Gateway.deploy(1, [a, a], 1)).to.be.revertedWithCustomError(Gateway, "InvalidValidatorSet");
      await expect(Gateway.deploy(1, [ethers.ZeroAddress], 1)).to.be.revertedWithCustomError(Gateway, "InvalidValidatorSet");
    });
  });
});
