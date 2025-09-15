use anchor_lang::prelude::*;

#[error_code]
pub enum RiyalError {
    #[msg("Unauthorized admin access")]
    UnauthorizedAdmin,
    
    #[msg("Contract not initialized")]
    ContractNotInitialized,
    
    #[msg("Token mint already created")]
    TokenMintAlreadyCreated,
    
    #[msg("Invalid token name length")]
    InvalidTokenNameLength,
    
    #[msg("Invalid token symbol length")]
    InvalidTokenSymbolLength,
    
    #[msg("Token mint not created")]
    TokenMintNotCreated,
    
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    
    #[msg("Invalid mint amount")]
    InvalidMintAmount,
    
    #[msg("Invalid user data")]
    InvalidUserData,
    
    #[msg("Invalid nonce")]
    InvalidNonce,
    
    #[msg("Invalid user signature")]
    InvalidUserSignature,
    
    #[msg("Invalid admin signature")]
    InvalidAdminSignature,
    
    #[msg("Nonce overflow")]
    NonceOverflow,
    
    #[msg("Nonce is not increasing (strict ordering required)")]
    NonceNotIncreasing,
    
    #[msg("Nonce is too high (maximum 1 increment allowed)")]
    NonceTooHigh,
    
    #[msg("Claim attempted too soon after previous claim")]
    ClaimTooSoon,
    
    #[msg("Claims are too frequent (minimum 1 second gap required)")]
    ClaimTooFrequent,
    
    #[msg("Invalid nonce sequence")]
    InvalidNonceSequence,
    
    #[msg("Claim count overflow")]
    ClaimCountOverflow,
    
    #[msg("Invalid burn amount")]
    InvalidBurnAmount,
    
    #[msg("Insufficient balance for burn operation")]
    InsufficientBalance,
    
    #[msg("Transfers are not enabled")]
    TransfersNotEnabled,
    
    #[msg("Invalid transfer amount")]
    InvalidTransferAmount,
    
    #[msg("Unauthorized transfer - not token account owner")]
    UnauthorizedTransfer,
    
    #[msg("Unauthorized burn - not token account owner")]
    UnauthorizedBurn,
    
    #[msg("Unauthorized unfreeze - not token account owner")]
    UnauthorizedUnfreeze,
    
    #[msg("User signature not verified by Ed25519 program")]
    UserSignatureNotVerified,
    
    #[msg("Admin signature not verified by Ed25519 program")]
    AdminSignatureNotVerified,
    
    #[msg("Invalid Ed25519 instruction format")]
    InvalidEd25519Instruction,
    
    #[msg("Treasury already created")]
    TreasuryAlreadyCreated,
    
    #[msg("Treasury not created")]
    TreasuryNotCreated,
    
    #[msg("Invalid treasury account")]
    InvalidTreasuryAccount,
    
    #[msg("Insufficient treasury balance")]
    InsufficientTreasuryBalance,
    
    #[msg("Invalid claim period - must be between 1 hour and 1 year")]
    InvalidClaimPeriod,
    
    #[msg("Claim is time-locked - wait for next allowed claim time")]
    ClaimTimeLocked,
    
    #[msg("Claim period has not elapsed since last claim")]
    ClaimPeriodNotElapsed,
    
    #[msg("Timestamp overflow in calculation")]
    TimestampOverflow,
    
    #[msg("Unauthorized upgrade authority")]
    UnauthorizedUpgradeAuthority,
    
    #[msg("Contract is not upgradeable")]
    ContractNotUpgradeable,
    
    #[msg("Invalid program data account")]
    InvalidProgramData,
    
    #[msg("Transfers are already permanently enabled and cannot be changed")]
    TransfersAlreadyPermanentlyEnabled,
    
    #[msg("Transfers cannot be disabled once permanently enabled")]
    TransfersCannotBeDisabled,
    
    #[msg("Unauthorized destination - user can only claim to their own token account")]
    UnauthorizedDestination,
    
    #[msg("Claim has expired - valid_until timestamp has passed")]
    ClaimExpired,
    
    #[msg("Invalid claim payload - failed to deserialize")]
    InvalidClaimPayload,
    
    #[msg("Transfers are paused - token transfers are currently disabled")]
    TransfersPaused,
    
    #[msg("Transfers are permanently enabled and cannot be paused")]
    TransfersPermanentlyEnabled,
}