<div align="center">

# 🌐 DeDT Platform

### Blockchain-powered Digital Twins Platform to Foster Trust, Transparency, and Collaboration

[![Website](https://img.shields.io/badge/website-smhbamakan.github.io%2FDeDT-1e40af)](https://smhbamakan.github.io/DeDT/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![WP3 contracts](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp3-contracts.yml/badge.svg)](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp3-contracts.yml)
![MSCA](https://img.shields.io/badge/MSCA-Postdoctoral%20Fellowship-003399)
![Masaryk University](https://img.shields.io/badge/host-Masaryk%20University-0e9384)

</div>

Open-source code of the **DeDT** research project. DeDT explores how Web 3.0 technologies (**blockchain, NFTs and DAOs**) can solve the main problems of digital twin projects: tamper-proof data sharing, IP protection, decentralized fundraising and auditable predictive analytics.

---

## 🏗️ Platform overview

```mermaid
flowchart TB
    subgraph Physical["🏭 Physical world"]
        S["Sensors · machines · simulations"]
    end

    subgraph WP2["WP2 · Big data flows"]
        E["Edge aggregation"] --> M["Merkle batching<br/>integrity anchoring"]
    end

    subgraph Chain["⛓️ Blockchain layer"]
        WP1["<b>WP1 · DAO</b><br/>collaboration & governance"]
        WP3["<b>WP3 · IP-NFT</b><br/>provenance & fundraising"]
        WP4["<b>WP4 · Trust</b><br/>IBE · authentication · ZKP"]
    end

    subgraph Users["👥 Stakeholders"]
        T["Twin teams"]
        B["Backers / industry"]
        R["Auditors / regulators"]
    end

    S --> E
    M --> WP4
    T <--> WP1
    T --> WP3
    B --> WP3
    WP3 --- WP1
    WP4 --- WP3
    R --> WP4
```

---

## 📦 Repository structure

| Folder | Work package | Objective | Tech | Status |
|---|---|---|---|---|
| [`wp3-ip-nft-fundraising/`](wp3-ip-nft-fundraising/) | **WP3** · IP-NFTs & fundraising | O3 | Solidity · Hardhat | ✅ Prototype + tests |
| [`wp1-dao-collaboration/`](wp1-dao-collaboration/) | **WP1** · Distributed collaboration (DAO) | O1, O2 | Solidity · Hardhat | 🔜 Step 2 |
| [`wp2-big-data-flows/`](wp2-big-data-flows/) | **WP2** · Big data flows | O2 | Python | 🔜 Step 3 |
| [`wp4-trust-auditing/`](wp4-trust-auditing/) | **WP4** · Trust & auditing | O4 | Python · Solidity | 🔜 Step 4 |
| [`docs/`](docs/) | Documentation & tutorials | — | Markdown | 🔜 Step 5 |

Each folder is self-contained, with its own README, install steps and tests.

## 🗺️ Roadmap

```mermaid
timeline
    title Step-by-step build of the DeDT platform
    Step 1 : WP3 IP-NFT registry : NFT-backed crowdfunding : IP share tokens
    Step 2 : WP1 DAO for twin teams : proposals & voting : data-sharing access control
    Step 3 : WP2 sensor stream simulator : edge aggregation : Merkle anchoring on-chain
    Step 4 : WP4 identity-based encryption : self-judgment authentication : ZKP ownership proofs
    Step 5 : Integration demo : tutorials & docs
```

---

## 🎯 Research objectives

| | Objective | Code |
|---|---|---|
| **O1** | Identify the crucial challenges of digital twin projects and evaluate how Web 3.0 technologies can resolve them | WP1 |
| **O2** | Develop a tamper-proof, decentralized collaboration platform for digital twin data sharing and federated learning | WP1, WP2 |
| **O3** | Design an IP-NFT framework for digital twin provenance and decentralized fundraising | WP3 |
| **O4** | Provide a blockchain-based predictive analytics platform for trust, transparency and auditability | WP4 |

## 👥 Team

- **Dr. Seyed Mojtaba Hosseini Bamakan**, MSCA Postdoctoral Fellow (Principal Investigator), Department of Business Management, Masaryk University · [Google Scholar](https://scholar.google.com/citations?user=YqXUN0AAAAAJ&hl=en&oi=ao)
- **Prof. Ahad Zareravasan**, Supervisor, Department of Business Management, Masaryk University

## 📚 Citation

> Hosseini Bamakan, S. M., et al. *DeDTs: A Decentralized Digital Twins Platform Based on Blockchain Technology and Web3.* Blockchain: Research and Applications (Elsevier). https://www.sciencedirect.com/science/article/pii/S2772918424000304

## ⚖️ License

[MIT](LICENSE). The code is a research prototype and has not been audited; do not use it with real funds.

## 🇪🇺 Funding

This project is funded by the project “MSCAfellow7_MUNI” (CZ.02.01.01/00/22_010/0008854), co-funded by the European Union under the Operational Programme Johannes Amos Comenius (OP JAK).
