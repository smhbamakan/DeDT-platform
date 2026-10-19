<div align="center">

# 🔗 WP1 · L3 Collaboration for Digital Twin Teams

**Digital twin teams on *different* blockchains share and co-develop a twin, with no central authority.**

[![WP1 contracts](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp1-contracts.yml/badge.svg)](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp1-contracts.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity)
![Hardhat](https://img.shields.io/badge/Hardhat-2.x-f0d50c?logo=ethereum&logoColor=black)
![Tests](https://img.shields.io/badge/tests-26%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-99%25-brightgreen)
![Objectives](https://img.shields.io/badge/objectives-O1%20%C2%B7%20O2-1e40af)

</div>

> **Reference implementation of**
> S. Banaeian Far, S. M. Hosseini Bamakan, *Analyzing potential collaboration methods for digital twin teams developed on heterogeneous blockchains without a central authority*, **Advanced Engineering Informatics** 68 (2025) 103616. [doi:10.1016/j.aei.2025.103616](https://doi.org/10.1016/j.aei.2025.103616)
>
> The paper proposes a generic, modular **Layer-3 (L3) framework** (its Fig. 3 and Algorithms 1–4) and analyses four L3 mechanisms. It does not include a prototype (§6.1, *"Prototype absence"*). This folder provides one, and corrects the weak points of the paper's pseudocode along the way.

---

## 📦 What's inside

| Component | Paper | What it does |
|---|---|---|
| [`L3Gateway.sol`](contracts/L3Gateway.sol) | Table 14, Algorithms 1, 3, 4 | One gateway per chain. Encodes messages in a **Universal Transaction Schema (UTS)**; delivers them only with a **k-of-n validator quorum**; blocks replays. |
| [`DigitalTwinDNFT.sol`](contracts/DigitalTwinDNFT.sol) | Steps 1, 2, 13 · §2.3.3 | A twin project as a **dynamic NFT**, `S(t+1) = f(S(t), C)`. Can be shared with a team on another chain, which gets a *mirror* dNFT and can contribute back. |
| [`HashTimeLock.sol`](contracts/HashTimeLock.sol) | §3.1.1 (atomic swap) | **HTLC** for trustless cross-chain swaps, e.g. a twin dNFT on chain A for ETH on chain B. No validators involved. |
| [`lib/l3.js`](lib/l3.js) | Steps 9–12 | Off-chain validators (attest) and a permissionless relayer (deliver). Works with two real RPC endpoints or one local network. |
| [`analysis/make_figures.py`](analysis/make_figures.py) | Tables 7, 17, 23 | Charts from our gas measurements and from the paper's evaluation tables. |

---

## 🏗️ Architecture (paper Fig. 3)

```mermaid
flowchart LR
    subgraph A["⛓️ Public blockchain A · domain 1001"]
        T1(["👥 DT team #1"])
        D1["DigitalTwinDNFT<br/><i>native twin</i>"]
        G1["L3Gateway A"]
        T1 -- "mint · update · share" --> D1
        D1 -- "dispatch(UTS)" --> G1
    end

    subgraph L3["🌐 The L3 network"]
        V["Validators<br/>k-of-n signatures"]
        R["Relayer<br/>(anyone)"]
        V --> R
    end

    subgraph B["⛓️ Public blockchain B · domain 2002"]
        G2["L3Gateway B"]
        D2["DigitalTwinDNFT<br/><i>mirror twin</i>"]
        T2(["👥 DT team #2"])
        G2 -- "handleL3Message" --> D2
        D2 -- "mirror dNFT" --> T2
    end

    G1 -. "MessageDispatched event" .-> V
    R -- "deliver(UTS, signatures)" --> G2
    T2 -. "contribute → flows back to A" .-> D2
```

### The 13 steps of the paper, as implemented

```mermaid
sequenceDiagram
    autonumber
    actor T1 as DT team #1
    participant NA as dNFT (chain A)
    participant GA as Gateway A
    participant V as Validators
    participant GB as Gateway B
    participant NB as dNFT (chain B)
    actor T2 as DT team #2

    rect rgba(30,64,175,0.08)
    Note over T1,T2: Phase 1 · Initialization
    T1->>NA: mint(stateHash, uri)
    T1->>NA: updateState(…)
    Note over GA,GB: L3 network launched: gateways on A and B,<br/>validator set and quorum, trusted remotes
    end

    rect rgba(14,147,132,0.08)
    Note over T1,T2: Phase 2 · Data sharing
    T1-->>T2: request / accept collaboration (off-chain)
    T1->>NA: shareTwin(#1, domain B, team #2)
    NA->>GA: dispatch(UTS)
    GA-->>V: MessageDispatched(id, …)
    V->>V: verify on chain A, sign id
    V->>GB: deliver(UTS, k signatures) via relayer
    GB->>NB: handleL3Message(origin, sender, payload)
    NB->>T2: mint mirror dNFT
    end

    rect rgba(234,161,0,0.10)
    Note over T1,T2: Phase 3 · Data using
    T2->>NB: contribute(mirror, newStateHash)
    NB->>GB: dispatch(UTS) back to A
    Note over GB,GA: same attest + relay path
    GA->>NA: revision recorded: author = team #2, chain = B
    end
```

---

## 🛠️ Corrections to the paper's pseudocode (Table 14)

The paper's `L3Network` contract shows the idea, but it reintroduces the central authority the framework is meant to remove. This implementation fixes that:

| # | Paper pseudocode | Problem | This implementation |
|---|---|---|---|
| 1 | `validateTransaction` is `onlyAdmin` | A single admin is a central authority and a single point of failure | **k-of-n validator quorum**; signatures must be sorted by signer, so duplicates are rejected |
| 2 | Users pass their own `transactionId` | IDs can collide or be front-run, and nothing binds them to the content | The gateway **derives the ID** from origin, destination, nonce, sender, recipient and payload hash |
| 3 | No chain binding | An attested message could be replayed on another chain | The ID includes **both domains**; `deliver` checks the destination; each ID is delivered **once** |
| 4 | `initiateTransaction` stores nothing | The "already exists" check never fires | **Nonce per gateway**, and the event carries the full UTS |
| 5 | Validation only sets a flag | Nothing happens on chain B | `deliver` **executes** the message on the recipient (`IL3Receiver`) |
| 6 | `string data` | Unstructured, expensive | `bytes payload`, with typed application messages (Share, Sync, Contribute, Revoke) |
| 7 | Fixed admin forever | No way to change who validates | **Validator rotation** signed by a quorum of the current set; old approvals cannot be replayed |
| 8 | Failure handling not specified | A failed delivery could be lost | If the recipient reverts, nothing is marked delivered and the message **can be relayed again** |

---

## 📊 Results

### Our measurements (this prototype, Hardhat EVM, `npm run benchmark`)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/gas-vs-quorum-dark.png">
  <img alt="Line chart: gas per delivered message rises linearly from 134k with 1 signature to 261k with 17 signatures, about 7.9k gas per signature." src="docs/figures/gas-vs-quorum-light.png" width="720">
</picture>

Delivery cost is **≈ 126k + 7.9k × signatures**. Adding validators makes the bridge more decentralized at a predictable, linear cost. For example, a BFT quorum of 7 out of 10 validators costs 182k gas.

<details>
<summary>Data table</summary>

| Validators | Quorum (⌊2n/3⌋+1) | Gas to deliver |
|---:|---:|---:|
| 1 | 1 | 134,383 |
| 4 | 3 | 150,246 |
| 7 | 5 | 166,146 |
| 10 | 7 | 182,035 |
| 13 | 9 | 197,935 |
| 16 | 11 | 213,800 |
| 19 | 13 | 229,678 |
| 22 | 15 | 245,592 |
| 25 | 17 | 261,458 |

Dispatch cost by payload size: 32 B → 32,429 · 256 B → 37,933 · 1 KB → 63,400 · 4 KB → 185,920 gas. This is why only hashes and URIs of twin data go through the bridge.
</details>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/workflow-gas-dark.png">
  <img alt="Bar chart of gas per workflow step: mint 213k, update 88k, share 92k, deliver share 322k, contribute 128k, deliver contribution 151k, HTLC lock 221k, HTLC claim 81k." src="docs/figures/workflow-gas-light.png" width="720">
</picture>

<details>
<summary>Data table</summary>

| Step | Gas |
|---|---:|
| Mint twin dNFT | 213,173 |
| Update state | 88,134 |
| Share (chain A) | 92,339 |
| Deliver share (chain B, creates the mirror) | 322,430 |
| Contribute (chain B) | 127,775 |
| Deliver contribution (chain A) | 151,384 |
| HTLC lock dNFT | 221,253 |
| HTLC claim | 80,822 |
</details>

### From the paper's evaluation (values transcribed, simulated in the paper)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/paper-table23-dark.png">
  <img alt="Three bar panels comparing cross-chain bridge, IBC, relay chain and L3 ZK rollup: L3 has the lowest time (120 ms) and cost (0.05 USD) and the highest efficiency (166.7)." src="docs/figures/paper-table23-light.png" width="900">
</picture>

`analysis/make_figures.py` recomputes the paper's efficiency metric, `Efficiency = 1 / (T_tx[s] · C_tx[USD])` (§4.6), from the time and cost columns: 3.66 · 3.77 · 22.22 · 166.67. This matches Table 23, except that the paper prints 3.75 for IBC.

<table>
<tr>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/paper-complexity-dark.png">
  <img alt="Log-scale curves of asymptotic overhead: cross-chain O(log n) lowest, then para-chain O(n), super-chain O(n log n), side-chain O(n squared) highest." src="docs/figures/paper-complexity-light.png">
</picture>
</td>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/paper-profile-dark.png">
  <img alt="Heatmap of qualitative ratings from paper Table 7 for scalability, interoperability, customization, flexibility, latency and complexity of the four mechanisms." src="docs/figures/paper-profile-light.png">
</picture>
</td>
</tr>
</table>

**Which mechanism does this prototype use?** `L3Gateway` is a **cross-chain bridge with decentralized relayers** (paper §4.2): it keeps each chain sovereign, needs no shared relay chain, and its verification cost grows only with the quorum. `HashTimeLock` adds the **atomic-swap** path (§3.1.1) for value exchange without any validators.

---

## 🚀 Quick start

```bash
cd wp1-dao-collaboration
npm install
npm test             # 26 tests
npm run demo         # the paper's 13 steps, end to end
npm run benchmark    # gas measurements → results/gas.json
npm run coverage
```

Regenerating the figures needs Python 3.10+ with matplotlib:

```bash
python -m venv .venv && .venv/bin/pip install matplotlib numpy   # Windows: .venv\Scripts\pip
.venv/bin/python analysis/make_figures.py
```

<details>
<summary><b>📺 Output of <code>npm run demo</code></b></summary>

```text
━━ Phase 1 · Initialization ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Step  1] DT team #1 launches its project as a dNFT on public blockchain A
[Step  2] Team #1 develops the twin (new state version)
           twin #1 version 2
[Step  3] L3 developers collect the protocols of blockchains A and B
[Step  4] Algorithm 1: launch the L3 network — 5 validators, quorum 3, no admin
[Step  5] Deploy the L3 smart contracts on A and B and link the dNFT apps

━━ Phase 2 · Data sharing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Step  6] Team #1 asks team #2 to collaborate (off-chain agreement)
[Step  7] Team #1 looks up the L3 mechanism on blockchain A
[Step  8] Team #1 submits the L3 request: shareTwin(#1 → team #2 on B)
[Step  9] Algorithm 3: gateway A encodes the UTS and derives the message ID
[Step 10] The L3 transaction is emitted for the validators
[Step 11] Algorithm 4: validators verify and sign it
[Step 12] Relayer submits it to blockchain B
           3/5 validators attest 0x836af4ed…; relayer delivers it
           delivered on domain 2002 (gas 322502)
           team #2 now holds mirror dNFT #1 on B

━━ Phase 3 · Data using ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Step 13] Team #2 modifies the shared twin; the change flows back to A
           3/5 validators attest 0xaac8ef82…; relayer delivers it
           delivered on domain 1001 (gas 151420)

  Provenance of twin #1 on blockchain A:
┌─────────┬─────────┬───────────┬───────┬───────────────┐
│ (index) │ version │ author    │ chain │ stateHash     │
├─────────┼─────────┼───────────┼───────┼───────────────┤
│ 0       │ 1       │ 'team #1' │ 'A'   │ '0x97eb8c2e…' │
│ 1       │ 2       │ 'team #1' │ 'A'   │ '0x063a4ebd…' │
│ 2       │ 3       │ 'team #2' │ 'B'   │ '0x09784748…' │
└─────────┴─────────┴───────────┴───────┴───────────────┘
```
</details>

---

## 📖 API

<details>
<summary><b>L3Gateway</b></summary>

| Function | Who | Description |
|---|---|---|
| `dispatch(destDomain, recipient, payload)` | any contract / account | Emits a UTS message; returns its ID |
| `deliver(uts, signatures)` | anyone (relayer) | Verifies the quorum, marks the message delivered, calls `recipient.handleL3Message` |
| `updateValidators(set, threshold, signatures)` | quorum of current validators | Rotates the validator set |
| `messageId(uts)` · `attestationDigest(id)` · `validatorSetDigest(set, t)` | view | What is hashed and signed |
| `delivered(id)` · `validators()` · `threshold()` | view | State |

</details>

<details>
<summary><b>DigitalTwinDNFT</b></summary>

| Function | Who | Description |
|---|---|---|
| `mint(stateHash, uri)` | anyone | New native twin (Step 1) |
| `updateState(id, stateHash, uri)` | owner or collaborator | New version of a native twin (Step 2) |
| `setCollaborator(id, account, allowed)` | owner | Local team members |
| `shareTwin(id, destDomain, team)` | owner | Sends a Share message, creating a mirror for `team` (Steps 6–12) |
| `syncTwin` · `revokeShare` | owner | Push the latest state / withdraw access |
| `contribute(mirrorId, stateHash, uri)` | mirror holder | Updates the mirror and sends the change to the origin (Step 13) |
| `twin(id)` · `historyLength(id)` · `revisionAt(id, i)` | view | State and provenance (author + chain of every revision) |

Mirrors are **non-transferable**: access was granted to one specific team.
</details>

<details>
<summary><b>HashTimeLock</b></summary>

| Function | Description |
|---|---|
| `lockETH(receiver, hashlock, timelock)` / `lockNFT(receiver, token, id, hashlock, timelock)` | Lock under `H(s)` until `timelock` |
| `claim(id, s)` | Pays the receiver if `keccak256(s) == hashlock` before expiry; publishes `s` |
| `refund(id)` | Sender takes the asset back after expiry |

</details>

---

## 🛡️ Security model and limitations

- **Trust assumption:** a message is accepted only if at least `threshold` of the `n` validators sign it. With `threshold = ⌊2n/3⌋ + 1`, the bridge tolerates up to ⌊(n−1)/3⌋ faulty or malicious validators.
- **Liveness:** relaying is permissionless, so anyone can deliver an attested message. Validators that go offline only delay delivery.
- **Privacy:** only hashes and URIs cross the bridge. Zero-knowledge ownership proofs (paper §3.6.1) are planned in WP4.
- **Two domains, one EVM:** tests and the demo simulate chains A and B as two gateways on one local network with different domain IDs. `lib/l3.js` takes ordinary ethers contracts, so the same code can relay between two real RPC endpoints.
- **Not yet implemented:** validator staking and slashing, fees for relayers, and para-, side- and super-chain variants of the framework.

> ⚠️ Research prototype. It has not been audited, so do not use it with real assets.

---

## 🗺️ Mapping to the proposal

| Proposal | Status |
|---|---|
| **T1.1** Review blockchain, NFT and DAO protocols & standards | ✅ Published: the AEI 2025 review above (§2–3) |
| **T1.3** Framework for integrating Web 3 technologies into digital twins | ✅ Generic L3 framework (paper §4) + this implementation |
| **D1.3** Secure and accessible data-sharing platform | 🧪 Prototype: `L3Gateway` + `DigitalTwinDNFT` |
| **D1.2** DAO platform for twin teams | 🔜 Next: governance of the validator set and shared twins |

---

<sub>Part of <a href="../README.md">DeDT Platform</a> · MIT License</sub>
