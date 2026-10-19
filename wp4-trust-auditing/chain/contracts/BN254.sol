// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BN254
/// @notice Minimal BN254 (alt_bn128) arithmetic on the EVM precompiles: 0x05 modexp,
///         0x06 G1 addition, 0x07 G1 scalar multiplication (EIP-196) and 0x08 pairing check
///         (EIP-197). Mirrors dedt_trust/bn254.py so that Python and Solidity agree bit for bit.
/// @dev G2 points use the EIP-197 encoding [x_imag, x_real, y_imag, y_real]. The pairing
///      precompile rejects G2 points that are not on the twist or not in the order-q subgroup.
library BN254 {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    struct G2Point {
        uint256[2] x; // [imag, real]
        uint256[2] y; // [imag, real]
    }

    error PrecompileFailed(uint256 precompile);
    error InvalidG1Point();

    function g1() internal pure returns (G1Point memory) {
        return G1Point(1, 2);
    }

    function g2() internal pure returns (G2Point memory) {
        return G2Point(
            [
                11559732032986387107991004021392285783925812861821192530917403151452391805634,
                10857046999023057135944570762232829481370756359578518086990519993285655852781
            ],
            [
                4082367875863433681332203403145435568316851327593401208105741076214120093531,
                8495653923123431417604973247489272438418190587263600148770280649306958101930
            ]
        );
    }

    /// @notice -g2 (negating y in F_p^2 negates both coordinates).
    function negG2() internal pure returns (G2Point memory n) {
        n = g2();
        n.y[0] = P - n.y[0];
        n.y[1] = P - n.y[1];
    }

    function isOnCurve(G1Point memory p) internal pure returns (bool) {
        if (p.x >= P || p.y >= P) return false;
        if (p.x == 0 && p.y == 0) return true; // point at infinity
        return mulmod(p.y, p.y, P) == addmod(mulmod(mulmod(p.x, p.x, P), p.x, P), 3, P);
    }

    function neg(G1Point memory p) internal pure returns (G1Point memory) {
        if (p.x == 0 && p.y == 0) return p;
        return G1Point(p.x, P - (p.y % P));
    }

    function add(G1Point memory a, G1Point memory b) internal view returns (G1Point memory r) {
        uint256[4] memory input = [a.x, a.y, b.x, b.y];
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x06, input, 0x80, r, 0x40)
        }
        if (!ok) revert PrecompileFailed(6);
    }

    function mul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
        uint256[3] memory input = [p.x, p.y, s];
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x07, input, 0x60, r, 0x40)
        }
        if (!ok) revert PrecompileFailed(7);
    }

    /// @notice e(a1, b1) · e(a2, b2) == 1
    function pairing2(G1Point memory a1, G2Point memory b1, G1Point memory a2, G2Point memory b2)
        internal
        view
        returns (bool)
    {
        uint256[12] memory input = [
            a1.x, a1.y, b1.x[0], b1.x[1], b1.y[0], b1.y[1],
            a2.x, a2.y, b2.x[0], b2.x[1], b2.y[0], b2.y[1]
        ];
        uint256[1] memory out;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x08, input, 0x180, out, 0x20)
        }
        if (!ok) revert PrecompileFailed(8);
        return out[0] == 1;
    }

    function expMod(uint256 base, uint256 e, uint256 m) internal view returns (uint256 r) {
        uint256[6] memory input = [uint256(32), 32, 32, base, e, m];
        uint256[1] memory out;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x05, input, 0xc0, out, 0x20)
        }
        if (!ok) revert PrecompileFailed(5);
        r = out[0];
    }

    /// @notice Try-and-increment hash to G1 (identical to bn254.hash_to_g1 in Python).
    ///         p ≡ 3 (mod 4), so a square root is a power (p+1)/4. G1 has cofactor 1.
    function hashToG1(bytes32 dst, bytes32 message) internal view returns (G1Point memory point) {
        for (uint256 ctr = 0; ; ++ctr) {
            uint256 x = uint256(keccak256(abi.encode(dst, message, ctr))) % P;
            uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
            uint256 y = expMod(rhs, (P + 1) / 4, P);
            if (mulmod(y, y, P) == rhs) return G1Point(x, y);
        }
    }
}
