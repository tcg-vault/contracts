// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title TCGRToken (TCGR)
 * @notice Jeton de parrainage — récompenses referral pour achats validés via routeur uniquement.
 * @dev Soulbound (non transférable). À l'inscription on enregistre un parrain une seule fois (non révocable).
 *      Seuls les achats validés via le BuyRouter déclenchent 0,5 % en TCGR pour le parrain (whitepaper).
 *      L'owner peut bannir un parrain ou un filleul du programme (fraude) : plus de récompenses TCGR pour ces achats.
 */
contract TCGRToken is ERC20, Ownable2Step {
    /// @notice 0.5% of USDC value minted as TCGR (18 decimals) per validated buy.
    uint256 public constant REFERRAL_BP = 50;
    /// @notice Fixed referral vesting period bucket (next bucket unlocks prior bucket rewards).
    uint256 public constant REFERRAL_VESTING_BUCKET = 30 days;

    /// @dev Scale USDC base units to 18 decimals: `10 ** (18 - usdc.decimals())`.
    uint256 private immutable _usdcTo18Scale;

    address private _minter;
    address private _converter;
    address private _qualifyingNft;

    /// @notice referee => parrain (set once by referee at registration).
    mapping(address referee => address referrer) private _referrerOf;

    /// @notice If true, `processValidatedBuy` pays no TCGR for this address as buyer and mints nothing to this address as referrer.
    mapping(address account => bool) private _bannedFromReferralProgram;

    /// @notice Last vesting bucket index tracked for account.
    mapping(address account => uint256 bucket) private _lastReferralBucket;
    /// @notice Whether `_lastReferralBucket` has been initialized for account.
    mapping(address account => bool initialized) private _referralBucketInitialized;
    /// @notice TCGR earned in current bucket (unlocks next bucket).
    mapping(address account => uint256 amount) private _lockedReferralBalance;
    /// @notice TCGR already unlocked and eligible for conversion.
    mapping(address account => uint256 amount) private _unlockedReferralBalance;

    event ReferrerBound(address referee, address referrer);
    event ReferralRewarded(address referee, address referrer, uint256 amount);
    event ReferralProgramBanUpdated(address account, bool banned);
    event Converted(address account, uint256 amount);
    event MinterUpdated(address minter);
    event ConverterUpdated(address converter);
    event QualifyingNftUpdated(address nft);

    error OnlyMinter();
    error OnlyConverter();
    error ZeroAddress();
    error SoulboundTransferNotAllowed();
    error InsufficientBalance();
    error InsufficientUnlockedBalance();
    error ReferrerAlreadySet();
    error SelfReferralNotAllowed();
    error UnsupportedStableDecimals(uint8 decimals_);

    constructor(address minter_, address usdc_) ERC20("TCG-Referral", "TCGR") Ownable(msg.sender) {
        if (minter_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(usdc_).decimals();
        if (d > 18) revert UnsupportedStableDecimals(d);
        _usdcTo18Scale = 10 ** uint256(18 - d);
        _minter = minter_;
        emit MinterUpdated(minter_);
        emit ConverterUpdated(address(0));
        emit QualifyingNftUpdated(address(0));
    }

    function minter() external view returns (address) {
        return _minter;
    }

    function converter() external view returns (address) {
        return _converter;
    }

    function qualifyingNft() external view returns (address) {
        return _qualifyingNft;
    }

    function unlockedReferralBalance(address account) external view returns (uint256) {
        return _unlockedReferralBalance[account] + _maturedLockedReferralBalance(account);
    }

    function lockedReferralBalance(address account) external view returns (uint256) {
        uint256 currentBucket = _currentReferralBucket();
        if (_lastReferralBucket[account] < currentBucket) return 0;
        return _lockedReferralBalance[account];
    }

    function referrerOf(address referee) external view returns (address) {
        return _referrerOf[referee];
    }

    function isBannedFromReferralProgram(address account) external view returns (bool) {
        return _bannedFromReferralProgram[account];
    }

    /// @notice Suspend referral rewards involving `account`: as **buyer** (no reward to their referrer) or as **referrer** (no rewards from any referee).
    function setBannedFromReferralProgram(address account, bool banned) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _bannedFromReferralProgram[account] = banned;
        emit ReferralProgramBanUpdated(account, banned);
    }

    /**
     * @notice Set the only address allowed to record validated buys (e.g. TCGVaultBuyRouter).
     */
    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        _minter = minter_;
        emit MinterUpdated(minter_);
    }

    /**
     * @notice Set the converter contract that can burn TCGR in exchange for TCGV.
     */
    function setConverter(address converter_) external onlyOwner {
        _converter = converter_;
        emit ConverterUpdated(converter_);
    }

    /**
     * @notice Set the NFT contract required for referrer eligibility (`balanceOf(referrer) > 0`).
     * @dev `address(0)` disables eligibility gating.
     */
    function setQualifyingNft(address nft_) external onlyOwner {
        _qualifyingNft = nft_;
        emit QualifyingNftUpdated(nft_);
    }

    /**
     * @notice Attach to a referrer once. Cannot be changed or cleared. Cannot refer yourself.
     * @dev Durable sponsorship link at registration (whitepaper). No TCGR is minted here.
     */
    function setReferrer(address referrer) external {
        if (referrer == address(0)) revert ZeroAddress();
        if (referrer == msg.sender) revert SelfReferralNotAllowed();
        if (_referrerOf[msg.sender] != address(0)) revert ReferrerAlreadySet();
        _referrerOf[msg.sender] = referrer;
        emit ReferrerBound(msg.sender, referrer);
    }

    /**
     * @notice After a validated USDC buy via router: mint 0.5% of USDC value (scaled to 18 decimals) to the buyer's referrer.
     * @dev Only minter. No-op if buyer or referrer is banned, buyer has no referrer, or amount rounds to zero.
     */
    function processValidatedBuy(address buyer, uint256 usdcAmount) external {
        if (msg.sender != _minter) revert OnlyMinter();
        if (usdcAmount == 0) return;
        if (_bannedFromReferralProgram[buyer]) return;
        address ref = _referrerOf[buyer];
        if (ref == address(0)) return;
        if (_bannedFromReferralProgram[ref]) return;
        if (_qualifyingNft != address(0) && IERC721(_qualifyingNft).balanceOf(ref) == 0) return;
        uint256 amount = (usdcAmount * _usdcTo18Scale * REFERRAL_BP) / 10000;
        if (amount == 0) return;
        _settleReferralUnlock(ref);
        _mint(ref, amount);
        _lockedReferralBalance[ref] += amount;
        emit ReferralRewarded(buyer, ref, amount);
    }

    /**
     * @notice Burn TCGR from `account` for TCGR→TCGV conversion.
     * @dev Only the converter may call. `account` must have approved the converter for at least `amount` (standard ERC-20 allowance to the converter contract).
     */
    function burnForConversion(address account, uint256 amount) external {
        if (msg.sender != _converter) revert OnlyConverter();
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        _settleReferralUnlock(account);
        if (balanceOf(account) < amount) revert InsufficientBalance();
        if (_unlockedReferralBalance[account] < amount) revert InsufficientUnlockedBalance();
        _spendAllowance(account, msg.sender, amount);
        _unlockedReferralBalance[account] -= amount;
        _burn(account, amount);
        emit Converted(account, amount);
    }

    function _currentReferralBucket() private view returns (uint256) {
        return block.timestamp / REFERRAL_VESTING_BUCKET;
    }

    function _maturedLockedReferralBalance(address account) private view returns (uint256) {
        if (_lastReferralBucket[account] < _currentReferralBucket()) return _lockedReferralBalance[account];
        return 0;
    }

    function _settleReferralUnlock(address account) private {
        uint256 currentBucket = _currentReferralBucket();
        if (!_referralBucketInitialized[account]) {
            _lastReferralBucket[account] = currentBucket;
            _referralBucketInitialized[account] = true;
            return;
        }
        uint256 lastBucket = _lastReferralBucket[account];
        if (lastBucket < currentBucket) {
            uint256 matured = _lockedReferralBalance[account];
            if (matured != 0) {
                _unlockedReferralBalance[account] += matured;
                _lockedReferralBalance[account] = 0;
            }
            _lastReferralBucket[account] = currentBucket;
        }
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) revert SoulboundTransferNotAllowed();
        super._update(from, to, amount);
    }
}
