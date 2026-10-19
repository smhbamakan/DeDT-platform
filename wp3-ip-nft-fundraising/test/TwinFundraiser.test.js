const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ETH = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const State = { Active: 0, Succeeded: 1, Failed: 2 };

describe("TwinFundraiser", function () {
  async function campaignOpen() {
    const [team, alice, bob, stranger] = await ethers.getSigners();
    const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
    const fundraiser = await ethers.deployContract("TwinFundraiser", [await ipnft.getAddress()]);

    await ipnft.registerTwin(ethers.id("wind-turbine-twin"), "ipfs://turbine", "CC-BY-4.0", 250);
    await ipnft.approve(await fundraiser.getAddress(), 1);
    await fundraiser.createCampaign(1, ETH(10), 30 * DAY);

    const shares = await ethers.getContractAt("IPShareToken", (await fundraiser.campaign(0)).shares);
    return { ipnft, fundraiser, shares, team, alice, bob, stranger };
  }

  async function succeeded() {
    const f = await campaignOpen();
    await f.fundraiser.connect(f.alice).contribute(0, { value: ETH(6) });
    await f.fundraiser.connect(f.bob).contribute(0, { value: ETH(4) });
    await time.increase(30 * DAY);
    return f;
  }

  async function failed() {
    const f = await campaignOpen();
    await f.fundraiser.connect(f.alice).contribute(0, { value: ETH(3) });
    await time.increase(30 * DAY);
    return f;
  }

  describe("creating a campaign", function () {
    it("locks the IP-NFT and deploys a share token", async function () {
      const { ipnft, fundraiser, shares } = await loadFixture(campaignOpen);
      expect(await ipnft.ownerOf(1)).to.equal(await fundraiser.getAddress());
      expect(await fundraiser.state(0)).to.equal(State.Active);
      expect(await shares.name()).to.equal("DeDT IP Share #1");
      expect(await shares.ipTokenId()).to.equal(1);
    });

    it("validates owner, goal and duration", async function () {
      const { ipnft, fundraiser, alice } = await loadFixture(campaignOpen);
      await ipnft.connect(alice).registerTwin(ethers.id("other"), "", "", 0);
      await expect(fundraiser.createCampaign(2, ETH(1), DAY)).to.be.revertedWithCustomError(fundraiser, "NotTokenOwner");
      await ipnft.connect(alice).approve(await fundraiser.getAddress(), 2);
      await expect(fundraiser.connect(alice).createCampaign(2, 0, DAY)).to.be.revertedWithCustomError(fundraiser, "InvalidGoal");
      await expect(fundraiser.connect(alice).createCampaign(2, ETH(1), 60)).to.be.revertedWithCustomError(fundraiser, "InvalidDuration");
    });

    it("lets the creator keep recording versions while the NFT is locked", async function () {
      const { ipnft } = await loadFixture(campaignOpen);
      await ipnft.recordVersion(1, ethers.id("model-v2"), "update during campaign");
      expect(await ipnft.versionCount(1)).to.equal(2);
    });

    it("rejects NFTs from other contracts", async function () {
      const { fundraiser, alice } = await loadFixture(campaignOpen);
      await expect(
        fundraiser.connect(alice).onERC721Received(alice.address, alice.address, 1, "0x")
      ).to.be.revertedWithCustomError(fundraiser, "UnexpectedNFT");
    });
  });

  describe("successful campaign", function () {
    it("lets the team withdraw the funds exactly once", async function () {
      const { fundraiser, team, alice } = await loadFixture(succeeded);
      expect(await fundraiser.state(0)).to.equal(State.Succeeded);
      await expect(fundraiser.connect(alice).withdrawFunds(0)).to.be.revertedWithCustomError(fundraiser, "NotCreator");
      await expect(fundraiser.withdrawFunds(0)).to.changeEtherBalance(team, ETH(10));
      await expect(fundraiser.withdrawFunds(0)).to.be.revertedWithCustomError(fundraiser, "AlreadyDone");
    });

    it("mints shares 1:1 to backers, once each", async function () {
      const { fundraiser, shares, alice, bob, stranger } = await loadFixture(succeeded);
      await fundraiser.connect(alice).claimShares(0);
      await fundraiser.connect(bob).claimShares(0);
      expect(await shares.balanceOf(alice.address)).to.equal(ETH(6));
      expect(await shares.balanceOf(bob.address)).to.equal(ETH(4));
      expect(await shares.totalSupply()).to.equal(ETH(10));
      await expect(fundraiser.connect(alice).claimShares(0)).to.be.revertedWithCustomError(fundraiser, "NothingToClaim");
      await expect(fundraiser.connect(stranger).claimShares(0)).to.be.revertedWithCustomError(fundraiser, "NothingToClaim");
    });

    it("keeps the IP-NFT locked and blocks refunds", async function () {
      const { ipnft, fundraiser, alice } = await loadFixture(succeeded);
      expect(await ipnft.ownerOf(1)).to.equal(await fundraiser.getAddress());
      await expect(fundraiser.connect(alice).refund(0))
        .to.be.revertedWithCustomError(fundraiser, "WrongState")
        .withArgs(State.Failed, State.Succeeded);
      await expect(fundraiser.reclaimNFT(0)).to.be.revertedWithCustomError(fundraiser, "WrongState");
    });

    it("only the fundraiser can mint shares", async function () {
      const { shares, alice } = await loadFixture(succeeded);
      await expect(shares.connect(alice).mint(alice.address, 1)).to.be.revertedWithCustomError(shares, "OnlyMinter");
    });
  });

  describe("failed campaign", function () {
    it("refunds backers and returns the NFT to the team", async function () {
      const { ipnft, fundraiser, team, alice } = await loadFixture(failed);
      expect(await fundraiser.state(0)).to.equal(State.Failed);
      await expect(fundraiser.connect(alice).refund(0)).to.changeEtherBalance(alice, ETH(3));
      await expect(fundraiser.connect(alice).refund(0)).to.be.revertedWithCustomError(fundraiser, "NothingToClaim");

      await expect(fundraiser.connect(alice).reclaimNFT(0)).to.be.revertedWithCustomError(fundraiser, "NotCreator");
      await fundraiser.reclaimNFT(0);
      expect(await ipnft.ownerOf(1)).to.equal(team.address);
      await expect(fundraiser.reclaimNFT(0)).to.be.revertedWithCustomError(fundraiser, "AlreadyDone");
    });

    it("blocks withdrawals and share claims", async function () {
      const { fundraiser, alice } = await loadFixture(failed);
      await expect(fundraiser.withdrawFunds(0)).to.be.revertedWithCustomError(fundraiser, "WrongState");
      await expect(fundraiser.connect(alice).claimShares(0)).to.be.revertedWithCustomError(fundraiser, "WrongState");
    });
  });

  describe("while active", function () {
    it("accepts contributions and rejects them after the deadline", async function () {
      const { fundraiser, alice } = await loadFixture(campaignOpen);
      await expect(fundraiser.connect(alice).contribute(0, { value: 0 })).to.be.revertedWithCustomError(fundraiser, "NothingToClaim");
      await expect(fundraiser.connect(alice).contribute(0, { value: ETH(1) }))
        .to.emit(fundraiser, "Contributed")
        .withArgs(0, alice.address, ETH(1));
      expect(await fundraiser.contributionOf(0, alice.address)).to.equal(ETH(1));
      await expect(fundraiser.withdrawFunds(0)).to.be.revertedWithCustomError(fundraiser, "WrongState");

      await time.increase(30 * DAY);
      await expect(fundraiser.connect(alice).contribute(0, { value: ETH(1) })).to.be.revertedWithCustomError(fundraiser, "WrongState");
    });
  });
});
