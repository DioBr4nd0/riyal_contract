use anchor_lang::prelude::*;
#[account]
pub struct TokenState {
    pub admin: Pubkey,                    // 32 bytes
    pub token_mint: Pubkey,               // 32 bytes  
    pub treasury_account: Pubkey,         // 32 bytes - Contract treasury token account
    pub upgrade_authority: Pubkey,        // 32 bytes - Program upgrade authority
    pub is_initialized: bool,             // 1 byte
    pub transfers_enabled: bool,          // 1 byte
    pub transfers_permanently_enabled: bool, // 1 byte - Once true, cannot be changed
    pub transfer_enable_timestamp: i64,   // 8 bytes - When transfers were enabled
    pub claim_period_seconds: i64,        // 8 bytes - Time period between claims (in seconds)
    pub time_lock_enabled: bool,          // 1 byte - Whether time-lock is active
    pub upgradeable: bool,                // 1 byte - Whether contract is upgradeable
    pub token_name: String,               // 4 + up to 32 bytes
    pub token_symbol: String,             // 4 + up to 16 bytes
    pub decimals: u8,                     // 1 byte
    pub bump: u8,                         // 1 byte
}

impl TokenState {
    pub const SIZE: usize = 8 +           // discriminator
        32 +                              // admin
        32 +                              // token_mint
        32 +                              // treasury_account
        32 +                              // upgrade_authority
        1 +                               // is_initialized
        1 +                               // transfers_enabled
        1 +                               // transfers_permanently_enabled
        8 +                               // transfer_enable_timestamp
        8 +                               // claim_period_seconds
        1 +                               // time_lock_enabled
        1 +                               // upgradeable
        4 + 32 +                          // token_name (String with max 32 chars)
        4 + 16 +                          // token_symbol (String with max 16 chars)
        1 +                               // decimals
        1;                                // bump
}