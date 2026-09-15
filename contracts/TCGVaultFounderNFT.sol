// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITCGNexusToken} from "./interfaces/ITCGNexusToken.sol";

/**
 * @title TCGVaultFounderNFT
 * @notice Founder Edition — 500 exemplaires (whitepaper §7 / C.9): 245 + 245 ventes payantes (200 / 350 USDC)
 *   + 10 réserve stratégique (mint owner, sans USDC ni bonus NEXUS). Vague 1: 7 jours puis vague 2, ou bascule anticipée si 245 vendus.
 *   Bonus: 30 % du montant en $TCGNEXUS sur chaque achat payant uniquement.
 *
 * @dev Uses classic ReentrancyGuard so Anvil/other forks work with a plain --fork-url (no --hardfork cancun required).
 */
contract TCGVaultFounderNFT is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 private immutable _usdc;
    ITCGNexusToken private immutable _nexusToken;
    /// @dev `10 ** IERC20Metadata(usdc).decimals()` — prices and NEXUS scaling follow the wired stablecoin.
    uint256 private immutable _stableUnit;

    /// @notice Wave 1 paid cap: 245 NFTs at 200 USDC.
    uint256 public constant WAVE1_SIZE = 245;
    /// @notice Wave 2 paid cap: 245 NFTs at 350 USDC.
    uint256 public constant WAVE2_SIZE = 245;
    /// @notice Max paid mints (waves 1 + 2).
    uint256 public constant PAID_TOTAL = WAVE1_SIZE + WAVE2_SIZE; // 490
    /// @notice Strategic reserve mintable by owner (no USDC, no NEXUS).
    uint256 public constant STRATEGIC_RESERVE_MAX = 10;
    /// @notice Max supply including reserve (500).
    uint256 public constant TOTAL_SUPPLY_CAP = PAID_TOTAL + STRATEGIC_RESERVE_MAX;

    /// @notice Wave 1 price in USDC base units (`200 * 10**decimals`).
    uint256 public immutable WAVE1_PRICE;
    /// @notice Wave 2 price in USDC base units (`350 * 10**decimals`).
    uint256 public immutable WAVE2_PRICE;
    uint256 public constant WAVE1_DURATION = 7 days;
    /// @dev 30% of USDC amount → NEXUS with 18 decimals: amount * 30/100 * 1e18 / _stableUnit
    uint256 private constant NEXUS_BONUS_BP = 3000; // 30%

    uint256 private _nextTokenId;
    /// @notice Active paid mints (non-cancelled); drives waves and presale linkage.
    uint256 private _activeSoldCount;
    uint256 private _strategicReserveMinted;
    /// @notice Effective wave-2 start timestamp (time-based default, accelerated on wave-1 sellout).
    uint256 private _wave2StartTimestamp;
    address private _caspUsdcRecipient;
    string private _baseTokenURI;

    uint256 private constant CANCEL_WINDOW = 14 days;
    mapping(uint256 => uint256) private _purchasedAt;
    mapping(uint256 => uint256) private _usdcPriceForToken;
    mapping(uint256 => uint256) private _nexusBonusForToken;
    mapping(uint256 => bool) private _cancelled;
    mapping(uint256 => bool) private _isStrategicReserve;

    event CaspUsdcRecipientUpdated(address caspUsdcRecipient);
    event BaseURIUpdated(string baseURI);
    event FounderMinted(address buyer, uint256 tokenId, uint256 usdcAmount, uint256 nexusAmount, uint256 purchasedAt);
    event FounderPurchaseCancelled(address buyer, uint256 tokenId, uint256 usdcRefundDue, uint256 nexusClawedBack);
    event StrategicReserveMinted(address to, uint256 tokenId);

    error Unauthorized();
    error AlreadyCancelled();
    error NotPurchasable();
    error CancellationWindowEnded();
    error ZeroAddress();
    error ExceedsSupply();
    error StrategicReserveNotCancellable();
    error StrategicReserveCapReached();
    error UnsupportedStableDecimals(uint8 decimals_);

    constructor(address usdc_, address nexusToken_, address caspUsdcRecipient_)
        ERC721("TCG-VAULT Founder", "TCGVF")
        Ownable(msg.sender)
    {
        if (usdc_ == address(0) || nexusToken_ == address(0) || caspUsdcRecipient_ == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(usdc_).decimals();
        if (d > 18) revert UnsupportedStableDecimals(d);
        _stableUnit = 10 ** uint256(d);
        WAVE1_PRICE = 200 * _stableUnit;
        WAVE2_PRICE = 350 * _stableUnit;
        _usdc = IERC20(usdc_);
        _nexusToken = ITCGNexusToken(nexusToken_);
        _caspUsdcRecipient = caspUsdcRecipient_;
        emit CaspUsdcRecipientUpdated(caspUsdcRecipient_);
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    function nexusToken() external view returns (address) {
        return address(_nexusToken);
    }

    function wave2StartTimestamp() external view returns (uint256) {
        return _wave2StartTimestamp;
    }

    function caspUsdcRecipient() external view returns (address) {
        return _caspUsdcRecipient;
    }

    /// @notice Active paid Founder mints (non-cancelled). Excludes strategic reserve NFTs.
    function soldCount() external view returns (uint256) {
        return _activeSoldCount;
    }

    /// @notice Number of strategic reserve NFTs minted so far (max 10).
    function strategicReserveMinted() external view returns (uint256) {
        return _strategicReserveMinted;
    }

    function currentWave() external view returns (uint256) {
        if (_wave2StartTimestamp == 0) return 1;
        return block.timestamp < _wave2StartTimestamp ? 1 : 2;
    }

    function currentPrice() public view returns (uint256) {
        if (_wave2StartTimestamp == 0) return WAVE1_PRICE;
        return block.timestamp < _wave2StartTimestamp ? WAVE1_PRICE : WAVE2_PRICE;
    }

    function setCaspUsdcRecipient(address caspUsdcRecipient_) external onlyOwner {
        if (caspUsdcRecipient_ == address(0)) revert ZeroAddress();
        _caspUsdcRecipient = caspUsdcRecipient_;
        emit CaspUsdcRecipientUpdated(caspUsdcRecipient_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
    }

    function _baseURI() internal view virtual override returns (string memory) {
        return _baseTokenURI;
    }

    /**
     * @notice Mint one Founder NFT (paid). USDC; 30% of price in $TCGNEXUS (whitepaper §7).
     */
    function mint() external nonReentrant {
        if (_activeSoldCount >= PAID_TOTAL) revert ExceedsSupply();
        if (_wave2StartTimestamp == 0) {
            _wave2StartTimestamp = block.timestamp + WAVE1_DURATION;
        }

        uint256 price = currentPrice();
        uint256 tokenId = _nextTokenId;
        _nextTokenId++;
        _activeSoldCount++;

        if (_activeSoldCount == WAVE1_SIZE && block.timestamp < _wave2StartTimestamp) {
            _wave2StartTimestamp = block.timestamp;
        }

        _usdc.safeTransferFrom(msg.sender, _caspUsdcRecipient, price);

        uint256 nexusAmount = (price * NEXUS_BONUS_BP * 1e18) / (10000 * _stableUnit);
        if (nexusAmount > 0) _nexusToken.mintPresaleBonus(msg.sender, nexusAmount);

        _purchasedAt[tokenId] = block.timestamp;
        _usdcPriceForToken[tokenId] = price;
        _nexusBonusForToken[tokenId] = nexusAmount;

        _safeMint(msg.sender, tokenId);

        emit FounderMinted(msg.sender, tokenId, price, nexusAmount, block.timestamp);
    }

    /**
     * @notice Mint up to 10 strategic reserve NFTs (owner). No USDC, no NEXUS; not cancellable under MiCA purchase path.
     */
    function mintStrategicReserve(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (_strategicReserveMinted >= STRATEGIC_RESERVE_MAX) revert StrategicReserveCapReached();

        uint256 tokenId = _nextTokenId;
        _nextTokenId++;
        _strategicReserveMinted++;
        _isStrategicReserve[tokenId] = true;

        _safeMint(to, tokenId);
        emit StrategicReserveMinted(to, tokenId);
    }

    /// @notice MiCA cooling-off cancellation: paid mints only — burn NFT + claw back NEXUS bonus.
    function cancelFounderPurchase(uint256 tokenId) external nonReentrant {
        if (_cancelled[tokenId]) revert AlreadyCancelled();
        if (msg.sender != ownerOf(tokenId)) revert Unauthorized();
        if (_isStrategicReserve[tokenId]) revert StrategicReserveNotCancellable();

        uint256 purchasedAt = _purchasedAt[tokenId];
        if (purchasedAt == 0) revert NotPurchasable();
        if (block.timestamp > purchasedAt + CANCEL_WINDOW) revert CancellationWindowEnded();

        _cancelled[tokenId] = true;

        uint256 usdcRefundDue = _usdcPriceForToken[tokenId];
        uint256 nexusClawedBack = _nexusBonusForToken[tokenId];
        uint256 actualNexusBurned;

        _burn(tokenId);

        if (nexusClawedBack > 0) {
            uint256 nexusBalance = IERC20(address(_nexusToken)).balanceOf(msg.sender);
            actualNexusBurned = nexusClawedBack > nexusBalance ? nexusBalance : nexusClawedBack;
            if (actualNexusBurned > 0) _nexusToken.clawBackPresaleBonus(msg.sender, actualNexusBurned);
        }

        _activeSoldCount--;

        delete _purchasedAt[tokenId];
        delete _usdcPriceForToken[tokenId];
        delete _nexusBonusForToken[tokenId];

        emit FounderPurchaseCancelled(msg.sender, tokenId, usdcRefundDue, actualNexusBurned);
    }
}
