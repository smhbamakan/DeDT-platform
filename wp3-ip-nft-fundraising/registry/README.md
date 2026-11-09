# 🏷️ Registered IP-NFT · token #1

The project's technical disclosure is registered as an IP-NFT on the **Ethereum mainnet**. This folder keeps the deployed contract source and the token metadata as a permanent record.

| Item | Value |
|---|---|
| Document | *Zero-Knowledge-Verified Provenance, Ownership and Access Control for Digital Twins Bound to Non-Fungible Tokens* (defensive publication) |
| Authors | Seyed Mojtaba Hosseini Bamakan, Ahad Zareravasan |
| DOI (all versions) | [10.5281/zenodo.24075040](https://doi.org/10.5281/zenodo.24075040) |
| DOI (version 1.1) | [10.5281/zenodo.24076114](https://doi.org/10.5281/zenodo.24076114) |
| Contract | [`0x0bDB2c4a4ECcE150bBB930833D8ce17d22d81bab`](https://etherscan.io/address/0x0bDB2c4a4ECcE150bBB930833D8ce17d22d81bab) |
| Token | [#1](https://etherscan.io/nft/0x0bDB2c4a4ECcE150bBB930833D8ce17d22d81bab/1) (`DeDT IP-NFT` · `DEDTIP`) |
| Registration tx | [`0x5bcc…a1cb`](https://etherscan.io/tx/0x5bcc7497e0e7226bdc478844556987b565d95d5b8260dc69777b0f73db59a1cb) · block 26376348 |
| SHA-256 of the PDF | `e8e183cec2ff1cae419d5608227c20f5242c3026ce26a867563eda4f45afa964` |
| Document on IPFS | `bafybeib3y75yabu5jmt75fn2qlsd7ehyhuhlzikbr5kgczy4bfub4kcd6y` |
| Token metadata | `ipfs://bafkreiepqz2pzgcjjnofjdpl5fdv646pajj24sikjjih6o67atvdzwpvzi` ([copy](token-1-metadata.json)) |
| Licence | CC BY 4.0 |

## ✅ How to verify

1. Download the PDF from Zenodo and compute its SHA-256 digest (`sha256sum file.pdf`, or `Get-FileHash file.pdf -Algorithm SHA256` on Windows).
2. Read `documentDigest(1)` and `documentDOI(1)` from the contract on Etherscan (*Contract → Read*).
3. The digest and the DOI must match the values above.

`token-1-metadata.json` is byte-identical to the file pinned on IPFS, so its CID can be recomputed locally.

## 📄 Contract

[`DeDTIPNFT.sol`](DeDTIPNFT.sol) is an ERC-721 registry (OpenZeppelin 5.0.2): the owner registers a document with its metadata URI, SHA-256 digest and DOI, and each registration emits `DocumentRegistered`. It is kept here as deployed and is not part of this folder's Hardhat build.

---

<sub>Part of <a href="../README.md">WP3</a> · <a href="../../README.md">DeDT Platform</a></sub>
