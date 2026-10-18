// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title GenesisPass
/// @notice 500 soulbound passes minted once to the top 500 members by points at the snapshot.
///         tokenId = rank. No paid mint, no allowlist, nothing to claim: the issuer mints straight to
///         each member's Sway wallet within 24 hours of the snapshot. Implements ERC-5192 (locked).
/// @dev UNAUDITED.
contract GenesisPass is ERC721, Ownable2Step {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 500;

    address public issuer;
    uint256 public totalMinted;
    /// @notice keccak256 of the published snapshot list, committed before minting.
    bytes32 public snapshotHash;
    uint64 public snapshotAt;
    string public snapshotURI;
    string private baseURI_;

    /// ERC-5192
    event Locked(uint256 tokenId);
    event SnapshotCommitted(bytes32 listHash, uint64 takenAt, string listURI);
    event IssuerSet(address issuer);

    error Soulbound();
    error NotIssuer();
    error InvalidRank();
    error AlreadyHasPass();
    error SnapshotNotCommitted();
    error SnapshotAlreadyCommitted();
    error LengthMismatch();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor(address initialOwner, address issuer_, string memory baseURI)
        ERC721("Sway Genesis Pass", "SWAYGEN")
        Ownable(initialOwner)
    {
        issuer = issuer_;
        baseURI_ = baseURI;
        emit IssuerSet(issuer_);
    }

    function setIssuer(address issuer_) external onlyOwner {
        issuer = issuer_;
        emit IssuerSet(issuer_);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI_ = uri;
    }

    /// @notice Commits the frozen snapshot list once. Minting is only possible after this.
    function commitSnapshot(bytes32 listHash, uint64 takenAt, string calldata listURI) external onlyIssuer {
        if (snapshotHash != bytes32(0)) revert SnapshotAlreadyCommitted();
        snapshotHash = listHash;
        snapshotAt = takenAt;
        snapshotURI = listURI;
        emit SnapshotCommitted(listHash, takenAt, listURI);
    }

    function mint(address to, uint256 rank) public onlyIssuer {
        if (snapshotHash == bytes32(0)) revert SnapshotNotCommitted();
        if (rank == 0 || rank > MAX_SUPPLY) revert InvalidRank();
        if (balanceOf(to) != 0) revert AlreadyHasPass();
        totalMinted++;
        _safeMint(to, rank);
        emit Locked(rank);
    }

    function mintBatch(address[] calldata to, uint256[] calldata ranks) external onlyIssuer {
        if (to.length != ranks.length) revert LengthMismatch();
        for (uint256 i; i < to.length; ++i) mint(to[i], ranks[i]);
    }

    /// ERC-5192: every pass is locked forever.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return bytes(baseURI_).length == 0 ? "" : string.concat(baseURI_, tokenId.toString());
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId); // ERC-5192
    }

    /// @dev Only mints: transfers and burns revert.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }
}
