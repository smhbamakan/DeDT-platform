# Architecture

DeDT gives teams that build a digital twin together four things they lack: a way to **govern** the work
(WP1), **trustworthy data** (WP2), a way to **finance** it (WP3) and **cryptographic trust** between parties
that do not know each other (WP4).

```mermaid
flowchart TB
  subgraph WP2["WP2 · Big-data flows"]
    S["Sensors / twin"] --> E["Edge pipeline<br/>windows · anomalies"] --> M["Merkle batches<br/>hash chain"] --> AN["DataAnchor contract"]
  end
  subgraph WP4["WP4 · Trust & auditing"]
    BLS["BLS co-signatures<br/>DataAuthenticator"]
    ZK["Birth-certificate commitment<br/>ZK proofs"]
    IBE["Identity-based encryption<br/>t-of-n key servers (DKG)"]
  end
  subgraph WP1["WP1 · Collaboration"]
    DAO["Governor · timelock · reputation<br/>TwinWorkspace"]
    L3["L3 gateway · dNFT<br/>cross-chain sharing"]
  end
  subgraph WP3["WP3 · Financing"]
    NFT["IP-NFT<br/>certificate + version trail"]
    DTVF["TwinVerifiedFinancing<br/>staged, KPI-verified"]
    QF["QuadraticMatchingPool"]
  end
  M --> BLS
  M -->|KPI evidence| NFT
  ZK -->|commitment = spec hash| NFT
  DAO -->|key servers, plan approval| IBE
  DAO -->|decision hash| NFT
  NFT --> DTVF
  IBE -->|encrypted twin packages| L3
```

## What links the modules

| Link | Carried by |
|---|---|
| Data → financing | KPI evidence = keccak(KPI id ‖ value ‖ hash-chain head ‖ model configuration), recorded in the IP-NFT version trail and referenced by each milestone claim |
| Certificate → NFTs | The Pedersen commitment to the birth certificate is the IP-NFT's specification hash and the dNFT's state hash |
| Governance → financing | The hash of the DAO decision that adopts a funding plan is recorded in the IP-NFT version trail |
| Governance → trust | The DAO timelock owns the key-server registry and the data authenticator settings |

All links are hashes, so a third party can verify them without trusting any team
([`integration/verify.py`](../integration/verify.py)).
