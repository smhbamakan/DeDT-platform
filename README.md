<div align="center">

# 🌐 DeDT Platform

### Blockchain-powered Digital Twins Platform to Foster Trust, Transparency, and Collaboration

[![Website](https://img.shields.io/badge/website-smhbamakan.github.io%2FDeDT-1e40af)](https://smhbamakan.github.io/DeDT/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![WP1 contracts](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp1-contracts.yml/badge.svg)](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp1-contracts.yml)
[![WP2 data flows](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp2-data-flows.yml/badge.svg)](https://github.com/smhbamakan/DeDT-platform/actions/workflows/wp2-data-flows.yml)
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
        WP1["<b>WP1 · DAO + L3 collaboration</b><br/>governance · workspace · cross-chain gateway"]
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
| [`wp1-dao-collaboration/`](wp1-dao-collaboration/) | **WP1** · DAO workspace for twin teams (D1.2) + L3 collaboration across blockchains (D1.3) | O1, O2 | Solidity · Hardhat · Python | ✅ Prototype + tests + figures |
| [`wp3-ip-nft-fundraising/`](wp3-ip-nft-fundraising/) | **WP3** · IP-NFTs & fundraising | O3 | Solidity · Hardhat | ✅ Prototype + tests |
| [`wp2-big-data-flows/`](wp2-big-data-flows/) | **WP2** · Big data flows: edge processing and on-chain integrity | O2 | Python · Solidity | ✅ Prototype + tests + experiments |
| [`wp4-trust-auditing/`](wp4-trust-auditing/) | **WP4** · Trust & auditing: identity-based encryption with distributed key servers, self-judging data authentication, zero-knowledge birth-certificate proofs | O4 | Python · Solidity | ✅ Prototype + tests + benchmarks |
| [`docs/`](docs/) | Documentation & tutorials | — | Markdown | 🔜 Step 6 |

Each folder is self-contained, with its own README, install steps and tests.

## 🗺️ Roadmap

```mermaid
timeline
    title Step-by-step build of the DeDT platform
    Step 1 : WP3 IP-NFT registry : NFT-backed crowdfunding : IP share tokens
    Step 2 : WP1 L3 gateway (AEI 2025 paper) : dNFT sharing across chains : HTLC atomic swaps
    Step 3 : WP1 DAO workspace (D1.2) : reputation voting and timelock : parallel tasks, experiments, reports
    Step 4 : WP2 sensor stream simulator : edge processing and anomaly detection : Merkle anchoring on-chain
    Step 5 : WP4 identity-based encryption : self-judgment authentication : ZKP ownership proofs
    Step 6 : Integration demo : tutorials & docs
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

## 📚 Publications

> Banaeian Far, S., & Hosseini Bamakan, S. M. (2025). *Analyzing potential collaboration methods for digital twin teams developed on heterogeneous blockchains without a central authority.* **Advanced Engineering Informatics**, 68, 103616. https://doi.org/10.1016/j.aei.2025.103616

<details>
<summary>BibTeX</summary>

```bibtex
@article{banaeianfar2025collaboration,
  title   = {Analyzing potential collaboration methods for digital twin teams developed on heterogeneous blockchains without a central authority},
  author  = {Banaeian Far, Saeed and Hosseini Bamakan, Seyed Mojtaba},
  journal = {Advanced Engineering Informatics},
  volume  = {68},
  pages   = {103616},
  year    = {2025},
  doi     = {10.1016/j.aei.2025.103616}
}
```
</details>

## ⚖️ License

[MIT](LICENSE). The code is a research prototype and has not been audited; do not use it with real funds.

## 🇪🇺 Funding

This project is funded by the project “MSCAfellow7_MUNI” (CZ.02.01.01/00/22_010/0008854), co-funded by the European Union under the Operational Programme Johannes Amos Comenius (OP JAK).
