use anchor_lang::prelude::*;

#[error_code]
pub enum MercleError {
    #[msg("Unauthorized")]
    UnauthorizedAdmin,
    #[msg("Not initialized")]
    ContractNotInitialized,
    #[msg("Mint exists")]
    TokenMintAlreadyCreated,
    #[msg("Invalid name")]
    InvalidTokenNameLength,
    #[msg("Invalid symbol")]
    InvalidTokenSymbolLength,
    #[msg("No mint")]
    TokenMintNotCreated,
    #[msg("Invalid mint")]
    InvalidTokenMint,
    #[msg("Invalid account")]
    InvalidTokenAccount,
    #[msg("Invalid amount")]
    InvalidMintAmount,
    #[msg("Invalid data")]
    InvalidUserData,
    #[msg("Invalid nonce")]
    InvalidNonce,
    #[msg("Bad user sig")]
    InvalidUserSignature,
    #[msg("Bad admin sig")]
    InvalidAdminSignature,
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("Nonce sequence")]
    NonceNotIncreasing,
    #[msg("Nonce too high")]
    NonceTooHigh,
    #[msg("Too soon")]
    ClaimTooSoon,
    #[msg("Too frequent")]
    ClaimTooFrequent,
    #[msg("Nonce error")]
    InvalidNonceSequence,
    #[msg("Count overflow")]
    ClaimCountOverflow,
    #[msg("Bad burn amt")]
    InvalidBurnAmount,
    #[msg("Low balance")]
    InsufficientBalance,
    #[msg("Disabled")]
    TransfersNotEnabled,
    #[msg("Bad xfer amt")]
    InvalidTransferAmount,
    #[msg("Unauth xfer")]
    UnauthorizedTransfer,
    #[msg("Unauth burn")]
    UnauthorizedBurn,
    #[msg("Unauth unfreeze")]
    UnauthorizedUnfreeze,
    #[msg("User sig fail")]
    UserSignatureNotVerified,
    #[msg("Admin sig fail")]
    AdminSignatureNotVerified,
    #[msg("Bad ed25519")]
    InvalidEd25519Instruction,
    #[msg("Treasury exists")]
    TreasuryAlreadyCreated,
    #[msg("No treasury")]
    TreasuryNotCreated,
    #[msg("Bad treasury")]
    InvalidTreasuryAccount,
    #[msg("Low treasury")]
    InsufficientTreasuryBalance,
    #[msg("Bad period")]
    InvalidClaimPeriod,
    #[msg("Locked")]
    ClaimTimeLocked,
    #[msg("Period active")]
    ClaimPeriodNotElapsed,
    #[msg("Time overflow")]
    TimestampOverflow,
    #[msg("Unauth upgrade")]
    UnauthorizedUpgradeAuthority,
    #[msg("Not upgradeable")]
    ContractNotUpgradeable,
    #[msg("Bad program data")]
    InvalidProgramData,
    #[msg("Already enabled")]
    TransfersAlreadyPermanentlyEnabled,
    #[msg("Cannot disable")]
    TransfersCannotBeDisabled,
    #[msg("Wrong dest")]
    UnauthorizedDestination,
    #[msg("Expired")]
    ClaimExpired,
    #[msg("Bad payload")]
    InvalidClaimPayload,
    #[msg("Paused")]
    TransfersPaused,
    #[msg("Permanent")]
    TransfersPermanentlyEnabled,
    #[msg("Not permanent")]
    TransfersNotPermanentlyEnabled,
    #[msg("Already initialized")]
    AlreadyInitialized,
    #[msg("Unauth deployer")]
    UnauthorizedDeployer,
}