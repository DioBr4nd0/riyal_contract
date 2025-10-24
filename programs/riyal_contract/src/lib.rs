#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount, freeze_account, thaw_account, FreezeAccount, ThawAccount, mint_to, burn, transfer, MintTo, Burn, Transfer};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::{
    sysvar::instructions::{self},
    sysvar::clock::Clock,
    account_info::AccountInfo,
};
pub mod errors;
use errors::MercleError;
pub mod signature;
use signature::verify_admin_signature_only;

declare_id!("DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK");

/// Mercle token claim payload structure that gets signed by admin
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimPayload {
    pub user_address: Pubkey,
    pub claim_amount: u64,
    pub expiry_time: i64,
    pub nonce: u64,
}

#[program]
pub mod mercle_token {
    use super::*;

    /// Initialize the contract with admin public key, time-lock settings, and upgrade authority
    pub fn initialize(
        ctx: Context<Initialize>, 
        admin: Pubkey,
        upgrade_authority: Pubkey,
        claim_period_seconds: i64,
        time_lock_enabled: bool,
        upgradeable: bool,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Validate claim period (must be reasonable) - allowing shorter periods for testing
        require!(
            claim_period_seconds >= 30, // Minimum 30 seconds (for testing)
            MercleError::InvalidClaimPeriod
        );
        
        require!(
            claim_period_seconds <= 31536000, // Maximum 1 year
            MercleError::InvalidClaimPeriod
        );
        
        token_state.admin = admin;
        token_state.upgrade_authority = upgrade_authority;
        token_state.is_initialized = true;
        token_state.token_mint = Pubkey::default(); // Will be set when mint is created
        token_state.treasury_account = Pubkey::default(); // Will be set when treasury is created
        token_state.transfers_enabled = false;
        token_state.transfers_permanently_enabled = false; // Will be set when transfers enabled
        token_state.transfer_enable_timestamp = 0; // Will be set when transfers enabled
        token_state.claim_period_seconds = claim_period_seconds;
        token_state.time_lock_enabled = time_lock_enabled;
        token_state.upgradeable = upgradeable;
        
        msg!(
            "Contract initialized - Admin: {}, Upgrade Authority: {}, Claim Period: {}s, Time-lock: {}, Upgradeable: {}",
            admin,
            upgrade_authority,
            claim_period_seconds,
            time_lock_enabled,
            upgradeable
        );
        Ok(())
    }

    /// Create Mercle SPL Token mint (starts with transfers paused)
    pub fn create_token_mint(
        ctx: Context<CreateTokenMint>,
        decimals: u8,
        name: String,
        symbol: String,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL: Verify token mint hasn't been created already
        require!(
            token_state.token_mint == Pubkey::default(),
            MercleError::TokenMintAlreadyCreated
        );

        // Store token mint information
        token_state.token_mint = ctx.accounts.mint.key();
        token_state.token_name = name.clone();
        token_state.token_symbol = symbol.clone();
        token_state.decimals = decimals;
        
        // Start with transfers DISABLED (paused)
        token_state.transfers_enabled = false;

        msg!(
            "Token mint created: {} ({}) with {} decimals, mint authority: {}, transfers: PAUSED",
            name,
            symbol,
            decimals,
            token_state.admin
        );

        Ok(())
    }

    /// Update token mint (admin only) - for migration purposes
    pub fn update_token_mint(
        ctx: Context<UpdateTokenMint>,
        decimals: u8,
        name: String,
        symbol: String,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Store new token mint information
        token_state.token_mint = ctx.accounts.mint.key();
        token_state.token_name = name.clone();
        token_state.token_symbol = symbol.clone();
        token_state.decimals = decimals;
        
        // Reset treasury account as it needs to be recreated for new mint
        token_state.treasury_account = Pubkey::default();

        msg!(
            "Token mint UPDATED: {} ({}) with {} decimals, mint authority: {}, OLD MINT REPLACED",
            name,
            symbol,
            decimals,
            token_state.admin
        );

        Ok(())
    }

    /// Check if transfers are enabled (used by transfer functions)
    pub fn check_transfers_enabled(ctx: Context<CheckTransfersEnabled>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;

        // Check if transfers are enabled
        require!(
            token_state.transfers_enabled,
            MercleError::TransfersPaused
        );

        msg!(
            "Transfers are enabled: {}",
            token_state.transfers_enabled
        );

        Ok(())
    }

    /// Pause token transfers (admin only)
    pub fn pause_transfers(ctx: Context<PauseTransfers>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Check if transfers are permanently enabled (cannot be paused)
        require!(
            !token_state.transfers_permanently_enabled,
            MercleError::TransfersPermanentlyEnabled
        );

        token_state.transfers_enabled = false;

        msg!(
            "TRANSFERS PAUSED by admin: {}",
            ctx.accounts.admin.key()
        );

        Ok(())
    }

    /// Resume token transfers (admin only)
    pub fn resume_transfers(ctx: Context<ResumeTransfers>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        token_state.transfers_enabled = true;

        // Get current timestamp
        let clock = Clock::get()?;
        token_state.transfer_enable_timestamp = clock.unix_timestamp;

        msg!(
            "TRANSFERS RESUMED by admin: {} at timestamp: {}",
            ctx.accounts.admin.key(),
            clock.unix_timestamp
        );

        Ok(())
    }

    /// Permanently enable transfers (admin only) - cannot be undone
    pub fn permanently_enable_transfers(ctx: Context<PermanentlyEnableTransfers>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        token_state.transfers_enabled = true;
        token_state.transfers_permanently_enabled = true;

        // Get current timestamp
        let clock = Clock::get()?;
        token_state.transfer_enable_timestamp = clock.unix_timestamp;

        msg!(
            "TRANSFERS PERMANENTLY ENABLED by admin: {} at timestamp: {} - CANNOT BE REVERSED",
            ctx.accounts.admin.key(),
            clock.unix_timestamp
        );

        Ok(())
    }

    /// Mint tokens to a user's token account (admin only)
    pub fn mint_tokens(
        ctx: Context<MintTokens>,
        amount: u64,
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // Verify amount is not zero
        require!(
            amount > 0,
            MercleError::InvalidMintAmount
        );

        // Create PDA signer for minting
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for minting with PDA as authority
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens
        mint_to(cpi_ctx, amount)?;

        // AUTO-FREEZE: Immediately freeze the token account after minting
        let freeze_seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let freeze_signer_seeds = &[&freeze_seeds[..]];

        let freeze_cpi_accounts = FreezeAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let freeze_cpi_program = ctx.accounts.token_program.to_account_info();
        let freeze_cpi_ctx = CpiContext::new_with_signer(freeze_cpi_program, freeze_cpi_accounts, freeze_signer_seeds);

        // Freeze the account immediately after minting
        freeze_account(freeze_cpi_ctx)?;

        msg!(
            "Minted {} tokens to user account: {} by admin: {} - ACCOUNT IMMEDIATELY FROZEN",
            amount,
            ctx.accounts.user_token_account.key(),
            ctx.accounts.admin.key()
        );

        Ok(())
    }

    /// Freeze a user's token account (admin only) - prevents all transfers
    pub fn freeze_token_account(ctx: Context<FreezeTokenAccount>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Verify the mint matches
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // Verify the token account belongs to this mint
        require!(
            ctx.accounts.token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // Create signer seeds for PDA authority
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for freezing
        let cpi_accounts = FreezeAccount {
            account: ctx.accounts.token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Freeze the account
        freeze_account(cpi_ctx)?;

        msg!(
            "Token account {} FROZEN by admin: {} - NO TRANSFERS ALLOWED",
            ctx.accounts.token_account.key(),
            ctx.accounts.admin.key()
        );

        Ok(())
    }

    /// Unfreeze a user's token account (admin only) - allows transfers again
    pub fn unfreeze_token_account(ctx: Context<UnfreezeTokenAccount>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Verify the mint matches
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // Verify the token account belongs to this mint
        require!(
            ctx.accounts.token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // Create signer seeds for PDA authority
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for thawing (unfreezing)
        let cpi_accounts = ThawAccount {
            account: ctx.accounts.token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Unfreeze the account
        thaw_account(cpi_ctx)?;

        msg!(
            "Token account {} UNFROZEN by admin: {} - TRANSFERS NOW ALLOWED",
            ctx.accounts.token_account.key(),
            ctx.accounts.admin.key()
        );

        Ok(())
    }

    /// Initialize user data PDA with nonce and security tracking
    pub fn initialize_user_data(ctx: Context<InitializeUserData>) -> Result<()> {
        let user_data = &mut ctx.accounts.user_data;
        let clock = Clock::get()?;
        
        user_data.user = ctx.accounts.user.key();
        user_data.nonce = 0;
        user_data.last_claim_timestamp = 0; // No claims yet
        user_data.next_allowed_claim_time = 0; // Can claim immediately on first attempt
        user_data.total_claims = 0;
        user_data.bump = ctx.bumps.user_data;

        msg!(
            "User data initialized for user: {} with nonce: {} at timestamp: {}, next claim allowed immediately",
            user_data.user,
            user_data.nonce,
            clock.unix_timestamp
        );

        Ok(())
    }

    /// Claim tokens using admin-signed payload with user verification
    pub fn claim_tokens(
        ctx: Context<ClaimTokens>,
        payload: ClaimPayload,
        admin_signature: [u8; 64],
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        let user_data = &mut ctx.accounts.user_data;
        
        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // CRITICAL: This check should come FIRST
        require!(
        payload.user_address == ctx.accounts.user.key(),
        MercleError::UnauthorizedDestination
        );
        // CRITICAL SECURITY: Verify destination binding - user can only claim to their own token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user.key(),
            MercleError::UnauthorizedDestination
        );

        // Verify amount is not zero
        require!(
            payload.claim_amount > 0,
            MercleError::InvalidMintAmount
        );

        // Get current timestamp for validation
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // CRITICAL SECURITY CHECK 1: Verify user data belongs to the user
        require!(
            user_data.user == ctx.accounts.user.key(),
            MercleError::InvalidUserData
        );

        // CRITICAL SECURITY CHECK 2: Verify nonce matches user's current nonce (prevent replay attacks)
        require!(
            payload.nonce == user_data.nonce,
            MercleError::InvalidNonce
        );

        // CRITICAL SECURITY CHECK 5: TIME-LOCK VALIDATION - enforce claim periods
        if token_state.time_lock_enabled {
            // Check if enough time has passed since last claim
            require!(
                current_timestamp >= user_data.next_allowed_claim_time,
                MercleError::ClaimTimeLocked
            );
            
            // For first-time claims, allow immediately
            if user_data.total_claims > 0 {
                require!(
                    current_timestamp >= user_data.last_claim_timestamp.saturating_add(token_state.claim_period_seconds),
                    MercleError::ClaimPeriodNotElapsed
                );
            }
        } else {
            // If time-lock disabled, still enforce minimum 1 second gap
            if user_data.last_claim_timestamp > 0 {
                require!(
                    current_timestamp > user_data.last_claim_timestamp,
                    MercleError::ClaimTooSoon
                );
                
                require!(
                    current_timestamp >= user_data.last_claim_timestamp.saturating_add(1),
                    MercleError::ClaimTooFrequent
                );
            }
        }

        // CRITICAL SECURITY CHECK 6: Validate nonce progression
        if user_data.total_claims > 0 {
            require!(
                payload.nonce == user_data.nonce,
                MercleError::InvalidNonceSequence
            );
        }

        // CRITICAL SECURITY: Validate expiry timestamp
        require!(
            current_timestamp <= payload.expiry_time,
            MercleError::ClaimExpired
        );
        
        // Serialize the payload to create the message that was signed by admin
        let payload_bytes = payload.try_to_vec().map_err(|_| MercleError::InvalidClaimPayload)?;
        
        // Create DOMAIN-SEPARATED MESSAGE with the payload
        // Format: "MERCLE_CLAIM_V1" | program_id | payload_bytes
        let mut message_bytes = Vec::new();
        message_bytes.extend_from_slice(b"MERCLE_CLAIM_V1");
        message_bytes.extend_from_slice(&crate::ID.to_bytes());
        message_bytes.extend_from_slice(&payload_bytes);

        // CRITICAL SECURITY: Verify admin signature format
        require!(
            admin_signature.len() == 64,
            MercleError::InvalidAdminSignature
        );

        // Verify signature is not empty
        let admin_sig_sum: u64 = admin_signature.iter().map(|&x| x as u64).sum();
        require!(
            admin_sig_sum > 0,
            MercleError::InvalidAdminSignature
        );

        // ENHANCED SECURITY: Verify only admin signature using Ed25519 program
        // This requires an Ed25519 verify instruction to be included in the transaction
        verify_admin_signature_only(
            &ctx.accounts.instructions,
            &message_bytes,
            &admin_signature,
            &token_state.admin,
        )?;

        // Create PDA signer for minting (using token_state as authority)
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for minting with PDA as authority
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens first
        mint_to(cpi_ctx, payload.claim_amount)?;

        // CRITICAL SECURITY: Immediately freeze the account after minting to prevent transfers
        let freeze_seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let freeze_signer_seeds = &[&freeze_seeds[..]];

        let freeze_cpi_accounts = FreezeAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let freeze_cpi_program = ctx.accounts.token_program.to_account_info();
        let freeze_cpi_ctx = CpiContext::new_with_signer(freeze_cpi_program, freeze_cpi_accounts, freeze_signer_seeds);

        // Freeze the account immediately after claiming
        freeze_account(freeze_cpi_ctx)?;

        // CRITICAL SECURITY UPDATE: Increment nonce and update security tracking
        let old_nonce = user_data.nonce;
        user_data.nonce = user_data.nonce.checked_add(1)
            .ok_or(MercleError::NonceOverflow)?;
        
        // Update timestamp and claim count for additional security tracking
        user_data.last_claim_timestamp = current_timestamp;
        user_data.total_claims = user_data.total_claims.checked_add(1)
            .ok_or(MercleError::ClaimCountOverflow)?;
        
        // CRITICAL TIME-LOCK UPDATE: Set next allowed claim time
        if token_state.time_lock_enabled {
            user_data.next_allowed_claim_time = current_timestamp
                .checked_add(token_state.claim_period_seconds)
                .ok_or(MercleError::TimestampOverflow)?;
        } else {
            // If time-lock disabled, allow next claim after 1 second
            user_data.next_allowed_claim_time = current_timestamp.saturating_add(1);
        }

        msg!(
            "CLAIM SUCCESSFUL: User: {}, Amount: {}, Nonce used: {}, New nonce: {}, Timestamp: {}, Total claims: {}",
            ctx.accounts.user.key(),
            payload.claim_amount,
            old_nonce,
            user_data.nonce,
            current_timestamp,
            user_data.total_claims
        );

        Ok(())
    }

    /// Burn tokens from user's account (admin authorized, user must sign)
    pub fn burn_tokens(
        ctx: Context<BurnTokens>,
        amount: u64,
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            MercleError::InvalidBurnAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify user has sufficient balance to burn
        require!(
            ctx.accounts.user_token_account.amount >= amount,
            MercleError::InsufficientBalance
        );

        // CRITICAL SECURITY CHECK 8: Verify user is the owner of the token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user_authority.key(),
            MercleError::UnauthorizedBurn
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create CPI context for burning tokens (user must sign as owner)
        let cpi_accounts = Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.user_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Burn tokens
        burn(cpi_ctx, amount)?;

        msg!(
            "BURN SUCCESSFUL: Admin: {}, User: {}, User Account: {}, Amount Burned: {}, Timestamp: {}",
            ctx.accounts.admin.key(),
            ctx.accounts.user_authority.key(),
            ctx.accounts.user_token_account.key(),
            amount,
            current_timestamp
        );

        Ok(())
    }

    /// Enable token transfers (admin only, PERMANENT one-way operation)
    pub fn enable_transfers(ctx: Context<EnableTransfers>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify transfers are not already permanently enabled
        require!(
            !token_state.transfers_permanently_enabled,
            MercleError::TransfersAlreadyPermanentlyEnabled
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // PERMANENT OPERATION: Enable transfers with immutable lock
        token_state.transfers_enabled = true;
        token_state.transfers_permanently_enabled = true; // CANNOT BE CHANGED BACK
        token_state.transfer_enable_timestamp = current_timestamp;

        msg!(
            "TRANSFERS PERMANENTLY ENABLED: Admin: {}, Token: {}, Timestamp: {} - IRREVERSIBLE CHANGE. Users can now unfreeze accounts.",
            ctx.accounts.admin.key(),
            token_state.token_mint,
            current_timestamp
        );

        // Log the permanent nature of this operation
        msg!(
            "WARNING: Transfer enabling is PERMANENT and IRREVERSIBLE. transfers_permanently_enabled = true"
        );

        Ok(())
    }

    /// Unfreeze user's token account (only callable after transfers are enabled)
    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 2: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 3: Verify transfers are enabled
        require!(
            token_state.transfers_enabled,
            MercleError::TransfersNotEnabled
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify the user owns the token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user.key(),
            MercleError::UnauthorizedUnfreeze
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create PDA signer for minting
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let _signer_seeds = &[&seeds[..]];

        // CRITICAL SECURITY: Only unfreeze if transfers are permanently enabled
        // This prevents temporary unfreezing exploits
        require!(
            token_state.transfers_permanently_enabled,
            MercleError::TransfersNotPermanentlyEnabled
        );

        // Create PDA signer for unfreezing
        let unfreeze_seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let unfreeze_signer_seeds = &[&unfreeze_seeds[..]];

        // Create CPI context for unfreezing
        let unfreeze_cpi_accounts = ThawAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let unfreeze_cpi_program = ctx.accounts.token_program.to_account_info();
        let unfreeze_cpi_ctx = CpiContext::new_with_signer(unfreeze_cpi_program, unfreeze_cpi_accounts, unfreeze_signer_seeds);

        // Unfreeze the account (only when transfers are permanently enabled)
        thaw_account(unfreeze_cpi_ctx)?;

        msg!(
            "ACCOUNT UNFROZEN: User: {}, Account: {}, Timestamp: {} - PERMANENT TRANSFERS ENABLED",
            ctx.accounts.user.key(),
            ctx.accounts.user_token_account.key(),
            current_timestamp
        );

        Ok(())
    }

    /// Transfer tokens between users (requires transfers to be enabled)
    pub fn transfer_tokens(
        ctx: Context<TransferTokens>,
        amount: u64,
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 2: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 3: Verify transfers are enabled
        require!(
            token_state.transfers_enabled,
            MercleError::TransfersNotEnabled
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            MercleError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify both token accounts are for the correct mint
        require!(
            ctx.accounts.from_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        require!(
            ctx.accounts.to_token_account.mint == token_state.token_mint,
            MercleError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            MercleError::InvalidTransferAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify sender has sufficient balance
        require!(
            ctx.accounts.from_token_account.amount >= amount,
            MercleError::InsufficientBalance
        );

        // CRITICAL SECURITY CHECK 8: Verify sender is the owner of the from account
        require!(
            ctx.accounts.from_token_account.owner == ctx.accounts.from_authority.key(),
            MercleError::UnauthorizedTransfer
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create CPI context for transferring tokens
        let cpi_accounts = Transfer {
            from: ctx.accounts.from_token_account.to_account_info(),
            to: ctx.accounts.to_token_account.to_account_info(),
            authority: ctx.accounts.from_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Transfer tokens
        transfer(cpi_ctx, amount)?;

        msg!(
            "TRANSFER SUCCESSFUL: From: {}, To: {}, Amount: {}, Timestamp: {}",
            ctx.accounts.from_token_account.key(),
            ctx.accounts.to_token_account.key(),
            amount,
            current_timestamp
        );

        Ok(())
    }

    /// Update time-lock settings (admin only)
    pub fn update_time_lock(
        ctx: Context<UpdateTimeLock>,
        claim_period_seconds: i64,
        time_lock_enabled: bool,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // Validate claim period (must be reasonable)
        require!(
            claim_period_seconds >= 3600, // Minimum 1 hour
            MercleError::InvalidClaimPeriod
        );
        
        require!(
            claim_period_seconds <= 31536000, // Maximum 1 year
            MercleError::InvalidClaimPeriod
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Update time-lock settings
        let old_period = token_state.claim_period_seconds;
        let old_enabled = token_state.time_lock_enabled;
        
        token_state.claim_period_seconds = claim_period_seconds;
        token_state.time_lock_enabled = time_lock_enabled;

        msg!(
            "TIME-LOCK UPDATED: Admin: {}, Period: {} → {} seconds, Enabled: {} → {}, Timestamp: {}",
            ctx.accounts.admin.key(),
            old_period,
            claim_period_seconds,
            old_enabled,
            time_lock_enabled,
            current_timestamp
        );

        Ok(())
    }

    /// Set upgrade authority (current upgrade authority only)
    pub fn set_upgrade_authority(
        ctx: Context<SetUpgradeAuthority>,
        new_upgrade_authority: Option<Pubkey>,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify current upgrade authority is calling this function
        require!(
            ctx.accounts.current_upgrade_authority.key() == token_state.upgrade_authority,
            MercleError::UnauthorizedUpgradeAuthority
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify contract is upgradeable
        require!(
            token_state.upgradeable,
            MercleError::ContractNotUpgradeable
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        let old_authority = token_state.upgrade_authority;

        match new_upgrade_authority {
            Some(new_auth) => {
                token_state.upgrade_authority = new_auth;
                msg!(
                    "UPGRADE AUTHORITY CHANGED: {} → {}, Timestamp: {}",
                    old_authority,
                    new_auth,
                    current_timestamp
                );
            }
            None => {
                // Setting to None makes contract non-upgradeable permanently
                token_state.upgrade_authority = Pubkey::default();
                token_state.upgradeable = false;
                msg!(
                    "UPGRADE AUTHORITY REMOVED: Contract is now IMMUTABLE, Timestamp: {}",
                    current_timestamp
                );
            }
        }

        Ok(())
    }

    /// Validate upgrade authorization (called before upgrades)
    pub fn validate_upgrade(ctx: Context<ValidateUpgrade>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify upgrade authority is calling this function
        require!(
            ctx.accounts.upgrade_authority.key() == token_state.upgrade_authority,
            MercleError::UnauthorizedUpgradeAuthority
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify contract is upgradeable
        require!(
            token_state.upgradeable,
            MercleError::ContractNotUpgradeable
        );

        // CRITICAL SECURITY CHECK 4: Verify program data account
        require!(
            ctx.accounts.program_data.key() != Pubkey::default(),
            MercleError::InvalidProgramData
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        msg!(
            "UPGRADE VALIDATED: Authority: {}, Program: {}, Timestamp: {} - UPGRADE AUTHORIZED",
            ctx.accounts.upgrade_authority.key(),
            ctx.program_id,
            current_timestamp
        );

        Ok(())
    }

    /// Create contract treasury account (admin only)
    pub fn create_treasury(ctx: Context<CreateTreasury>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury not already created
        require!(
            token_state.treasury_account == Pubkey::default(),
            MercleError::TreasuryAlreadyCreated
        );

        // Store treasury account
        token_state.treasury_account = ctx.accounts.treasury_account.key();

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        msg!(
            "TREASURY CREATED: Admin: {}, Treasury Account: {}, Timestamp: {}",
            ctx.accounts.admin.key(),
            ctx.accounts.treasury_account.key(),
            current_timestamp
        );

        Ok(())
    }

    /// Mint tokens to contract treasury (admin only)
    pub fn mint_to_treasury(
        ctx: Context<MintToTreasury>,
        amount: u64,
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury has been created
        require!(
            token_state.treasury_account != Pubkey::default(),
            MercleError::TreasuryNotCreated
        );

        // CRITICAL SECURITY CHECK 5: Verify treasury account matches stored account
        require!(
            ctx.accounts.treasury_account.key() == token_state.treasury_account,
            MercleError::InvalidTreasuryAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            MercleError::InvalidMintAmount
        );

        // Create PDA signer for minting
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for minting to treasury
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens to treasury
        mint_to(cpi_ctx, amount)?;

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        msg!(
            "MINTED TO TREASURY: Admin: {}, Amount: {}, Treasury: {}, Timestamp: {}",
            ctx.accounts.admin.key(),
            amount,
            ctx.accounts.treasury_account.key(),
            current_timestamp
        );

        Ok(())
    }

    /// Burn tokens from contract treasury (admin only)
    pub fn burn_from_treasury(
        ctx: Context<BurnFromTreasury>,
        amount: u64,
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        
        // CRITICAL SECURITY CHECK 1: Verify admin is calling this function
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            MercleError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury has been created
        require!(
            token_state.treasury_account != Pubkey::default(),
            MercleError::TreasuryNotCreated
        );

        // CRITICAL SECURITY CHECK 5: Verify treasury account matches stored account
        require!(
            ctx.accounts.treasury_account.key() == token_state.treasury_account,
            MercleError::InvalidTreasuryAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            MercleError::InvalidBurnAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify treasury has sufficient balance
        require!(
            ctx.accounts.treasury_account.amount >= amount,
            MercleError::InsufficientTreasuryBalance
        );

        // Create PDA signer for burning from treasury
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for burning from treasury
        let cpi_accounts = Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Burn tokens from treasury
        burn(cpi_ctx, amount)?;

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        msg!(
            "BURNED FROM TREASURY: Admin: {}, Amount: {}, Treasury: {}, Timestamp: {}, Remaining: {}",
            ctx.accounts.admin.key(),
            amount,
            ctx.accounts.treasury_account.key(),
            current_timestamp,
            ctx.accounts.treasury_account.amount.saturating_sub(amount)
        );

        Ok(())
    }
}



#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = TokenState::SIZE,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTimeLock<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetUpgradeAuthority<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = current_upgrade_authority.key() == token_state.upgrade_authority @ MercleError::UnauthorizedUpgradeAuthority
    )]
    pub current_upgrade_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ValidateUpgrade<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = upgrade_authority.key() == token_state.upgrade_authority @ MercleError::UnauthorizedUpgradeAuthority
    )]
    pub upgrade_authority: Signer<'info>,
    
    /// CHECK: Program data account for BPF loader upgradeable
    pub program_data: UncheckedAccount<'info>,
    
    /// CHECK: The program being upgraded
    #[account(executable)]
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct UpdateTokenMint<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = mint.mint_authority == COption::Some(token_state.key()) @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct CreateTokenMint<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        init,
        payer = admin,
        mint::decimals = decimals,
        mint::authority = token_state.key(),
        mint::freeze_authority = token_state.key(),
        mint::token_program = token_program,
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FreezeTokenAccount<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UnfreezeTokenAccount<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeUserData<'info> {
    #[account(
        init,
        payer = user,
        space = UserData::SIZE,
        seeds = [b"user_data", user.key().as_ref()],
        bump
    )]
    pub user_data: Account<'info, UserData>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,

    #[account(
        mut,
        seeds = [b"user_data", user.key().as_ref()],
        bump
    )]
    pub user_data: Account<'info, UserData>,

    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// User must sign the transaction to prove ownership
    pub user: Signer<'info>,

    /// CHECK: Instructions sysvar for Ed25519 signature verification
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    #[account(
        constraint = user_authority.key() == user_token_account.owner @ MercleError::UnauthorizedBurn
    )]
    pub user_authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EnableTransfers<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = user.key() == user_token_account.owner @ MercleError::UnauthorizedUnfreeze
    )]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = from_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub from_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = to_token_account.mint == token_state.token_mint @ MercleError::InvalidTokenAccount
    )]
    pub to_token_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = from_authority.key() == from_token_account.owner @ MercleError::UnauthorizedTransfer
    )]
    pub from_authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateTreasury<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = token_state,
        associated_token::token_program = token_program,
    )]
    pub treasury_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintToTreasury<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = treasury_account.key() == token_state.treasury_account @ MercleError::InvalidTreasuryAccount
    )]
    pub treasury_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnFromTreasury<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        mut,
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = treasury_account.key() == token_state.treasury_account @ MercleError::InvalidTreasuryAccount
    )]
    pub treasury_account: Account<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CheckTransfersEnabled<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
}

#[derive(Accounts)]
pub struct PauseTransfers<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResumeTransfers<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct PermanentlyEnableTransfers<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
}

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

#[account]
pub struct UserData {
    pub user: Pubkey,                     // 32 bytes
    pub nonce: u64,                       // 8 bytes
    pub last_claim_timestamp: i64,        // 8 bytes - Unix timestamp of last claim
    pub next_allowed_claim_time: i64,     // 8 bytes - Unix timestamp of next allowed claim
    pub total_claims: u64,                // 8 bytes - Total number of successful claims
    pub bump: u8,                         // 1 byte
}


impl UserData {
    pub const SIZE: usize = 8 +           // discriminator
        32 +                              // user
        8 +                               // nonce
        8 +                               // last_claim_timestamp
        8 +                               // next_allowed_claim_time
        8 +                               // total_claims
        1;                                // bump
}

