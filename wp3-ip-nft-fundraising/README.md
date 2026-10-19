<div align="center">

# 🧬 WP3 · IP-NFTs & Fundraising for Twin Teams

**Register a digital twin as an Intellectual Property NFT, prove its provenance, and crowdfund it — on-chain.**

[![WP3 contracts](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp3-contracts.yml/badge.svg)](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp3-contracts.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity)
![Hardhat](https://img.shields.io/badge/Hardhat-2.x-f0d50c?logo=ethereum&logoColor=black)
![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4e5ee4?logo=openzeppelin)
![Coverage](https://img.shields.io/badge/coverage-98%25-brightgreen)
![Objective](https://img.shields.io/badge/objective-O3-1e40af)

</div>

---

## 📌 What problem does this solve?

Digital twin teams invest heavily in models, data and know-how, but:

| Challenge | How WP3 addresses it |
|---|---|
| 🔒 **IP & commercial information** must stay confidential | Only a **hash** of the twin specification (its *birth certificate*) goes on-chain |
| 🧾 **Ownership & provenance** are hard to prove | Each twin is an **ERC-721 IP-NFT** with an append-only **version history** |
| 💰 **Early-stage funding** is scarce | **All-or-nothing crowdfunding** backed by the IP-NFT; backers receive **IP shares** |
| 🤝 **Fair rewards** for creators | **ERC-2981 royalties** on every secondary sale |

| Deliverable | Description | Status |
|---|---|---|
| D3.1 | Financial requirements of twin teams | 📝 Planned (report) |
| D3.2 | NFT funding model implementation | ✅ Prototype in this folder |
| D3.3 | Pilot experiments on NFT-funded projects | 🧪 Demo script ready; pilot data to come |

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph OffChain["🗄️ Off-chain"]
        SPEC["Twin specification<br/>(model, sensors, data)"]
        IPFS["Public metadata<br/>ipfs://…"]
    end

    subgraph OnChain["⛓️ On-chain (Ethereum)"]
        NFT["<b>DigitalTwinIPNFT</b><br/>ERC-721 + ERC-2981<br/>birth certificate · versions"]
        FR["<b>TwinFundraiser</b><br/>campaigns · escrow · refunds"]
        SH["<b>IPShareToken</b><br/>ERC-20, one per campaign"]
    end

    TEAM(["👩‍🔬 Twin team"])
    BACKER(["🧑‍💼 Backers"])

    SPEC -- "keccak256" --> NFT
    IPFS -. tokenURI .-> NFT
    TEAM -- "registerTwin / recordVersion" --> NFT
    TEAM -- "createCampaign (locks NFT)" --> FR
    NFT <-- "escrow" --> FR
    BACKER -- "contribute ETH" --> FR
    FR -- "deploys & mints" --> SH
    SH -- "claimShares" --> BACKER
```

| Contract | Standard | Responsibility |
|---|---|---|
| [`DigitalTwinIPNFT.sol`](contracts/DigitalTwinIPNFT.sol) | ERC-721, ERC-2981 | Registers twins, stores the birth certificate & provenance trail, royalties |
| [`TwinFundraiser.sol`](contracts/TwinFundraiser.sol) | ERC-721 receiver | Locks the IP-NFT, collects contributions, pays out or refunds |
| [`IPShareToken.sol`](contracts/IPShareToken.sol) | ERC-20 | Fungible shares of one IP-NFT, minted only by the fundraiser |

---

## 🔄 Fundraising flow

```mermaid
sequenceDiagram
    autonumber
    actor T as Twin team
    participant N as DigitalTwinIPNFT
    participant F as TwinFundraiser
    participant S as IPShareToken
    actor B as Backer

    T->>N: registerTwin(specHash, uri, license, royalty)
    N-->>T: mint IP-NFT #1
    T->>N: approve(fundraiser, #1)
    T->>F: createCampaign(#1, goal, duration)
    F->>N: safeTransferFrom(team → fundraiser)
    F->>S: deploy share token
    B->>F: contribute{value}
    Note over F: ⏰ deadline passes
    alt raised ≥ goal ✅
        T->>F: withdrawFunds()
        F-->>T: ETH
        B->>F: claimShares()
        F->>S: mint(backer, contribution)
    else raised < goal ❌
        B->>F: refund()
        F-->>B: ETH
        T->>F: reclaimNFT()
        F->>N: return IP-NFT #1
    end
```

### Campaign states

```mermaid
stateDiagram-v2
    [*] --> Active: createCampaign
    Active --> Active: contribute
    Active --> Succeeded: deadline ∧ raised ≥ goal
    Active --> Failed: deadline ∧ raised < goal
    Succeeded --> [*]: withdrawFunds · claimShares
    Failed --> [*]: refund · reclaimNFT
```

---

## 🚀 Quick start

Requires Node.js 18+.

```bash
cd wp3-ip-nft-fundraising
npm install
npm test          # 16 unit tests
npm run demo      # end-to-end walkthrough
npm run coverage  # coverage report
```

<details>
<summary><b>📺 Example output of <code>npm run demo</code></b></summary>

```text
[1] Twin team registers its digital twin as an IP-NFT
    token #1 owner   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
    birth cert hash  0xbcd2bed342a049cec30f338a51f28c466f4a5c4c45bc74d40e85d2556250255a
    verifySpec(original)  → true
    verifySpec(tampered)  → false

[2] The team records a model update in the provenance trail
    versions: 2

[3] The team locks the IP-NFT and opens a 30-day campaign with a 10 ETH goal
[4] Backers contribute
    raised 10.0 ETH
[5] Deadline passes → campaign succeeded
    state: Succeeded
[6] Team withdraws funds, backers claim IP shares
┌─────────┬────────┐
│ (index) │ shares │
├─────────┼────────┤
│ alice   │ '6.0'  │
│ bob     │ '4.0'  │
└─────────┴────────┘
```
</details>

### Deploy

```bash
# Local chain
npm run node            # terminal 1
npm run deploy:local    # terminal 2

# Sepolia testnet: copy .env.example to .env and fill it in
npm run deploy:sepolia
```

---

## 📖 Contract API

<details>
<summary><b>DigitalTwinIPNFT</b></summary>

| Function | Who | Description |
|---|---|---|
| `registerTwin(specHash, uri, license, royaltyBps)` | anyone | Mints a new IP-NFT; rejects empty or already registered specs |
| `recordVersion(tokenId, dataHash, note)` | owner or creator | Appends a version to the provenance trail |
| `birthCertificate(tokenId)` | view | `specHash`, `creator`, `createdAt`, `license` |
| `verifySpec(tokenId, specHash)` | view | `true` if an off-chain spec matches the registered one |
| `versionCount(tokenId)` / `versionAt(tokenId, i)` | view | Read the provenance trail |
| `tokenOfSpec(specHash)` | view | Token registered for a spec (0 if none) |
| `royaltyInfo(tokenId, price)` | view | ERC-2981 royalty |

</details>

<details>
<summary><b>TwinFundraiser</b></summary>

| Function | Who | When |
|---|---|---|
| `createCampaign(tokenId, goal, duration)` | NFT owner | duration 1 hour – 365 days |
| `contribute(id)` | anyone | Active |
| `withdrawFunds(id)` | creator | Succeeded, once |
| `claimShares(id)` | backer | Succeeded, once per backer |
| `refund(id)` | backer | Failed |
| `reclaimNFT(id)` | creator | Failed, once |
| `state(id)` / `campaign(id)` / `contributionOf(id, addr)` | view | always |

</details>

---

## 🛡️ Design notes

- **Privacy by design:** confidential twin details never touch the chain; only their hash does. WP4 extends this with zero-knowledge ownership proofs.
- **Pull payments:** each party withdraws their own funds; there are no loops over backers and no push transfers.
- **Re-entrancy protection** on every function that sends ETH (`ReentrancyGuard` and the checks-effects-interactions pattern).
- **Custom errors** for clear, gas-efficient reverts.
- **Locked IP after success:** the IP-NFT stays in the fundraiser as the asset behind the share token. Governance of that IP by shareholders is planned with the WP1 DAO.

> ⚠️ Research prototype. It has not been audited, so do not use it with real funds.

---

## 🗺️ Mapping to the proposal

| Task / deliverable | Implementation |
|---|---|
| T3.1 · NFTs for project fundraising | `TwinFundraiser` all-or-nothing model |
| T3.2 · Trusted DT architecture protecting IP | hash-only birth certificate, provenance trail |
| T3.3 · NFT-powered funding model | IP-NFT escrow + `IPShareToken` |
| T3.4 · Pilot experiments | `scripts/demo.js`, test suite (to be extended with pilot data) |
| **D3.2** · NFT-funding model implementation | this folder |

---

<sub>Part of <a href="../README.md">DeDT Platform</a> · MIT License</sub>
