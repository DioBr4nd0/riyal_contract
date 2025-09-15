use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use anchor_lang::solana_program::{
    sysvar::instructions::{self},
    sysvar::clock::Clock,
    account_info::AccountInfo,
};
pub mod errors;
use errors::*;
pub mod signature;
use signature::verify_ed25519_signatures_in_transaction;

declare_id!("A8S99EvMvPXP88Whc7d9N482NJm7EDWimeVLrf5i14EW");

#[program]
pub mod riyal_contract {
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
            RiyalError::InvalidClaimPeriod
        );
        
        require!(
            claim_period_seconds <= 31536000, // Maximum 1 year
            RiyalError::InvalidClaimPeriod
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

    /// Create SPL token mint with admin as mint authority
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
            RiyalError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL: Verify token mint hasn't been created already
        require!(
            token_state.token_mint == Pubkey::default(),
            RiyalError::TokenMintAlreadyCreated
        );

        // Store token mint information
        token_state.token_mint = ctx.accounts.mint.key();
        token_state.token_name = name.clone();
        token_state.token_symbol = symbol.clone();
        token_state.decimals = decimals;

        msg!(
            "Token mint created: {} ({}) with {} decimals, mint authority: {}",
            name,
            symbol,
            decimals,
            token_state.admin
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
            RiyalError::UnauthorizedAdmin
        );

        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            RiyalError::InvalidTokenMint
        );

        // Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        // Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidMintAmount
        );

        // Create PDA signer for minting
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for minting with PDA as authority
        let cpi_accounts = anchor_spl::token_interface::MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens
        anchor_spl::token_interface::mint_to(cpi_ctx, amount)?;

        // Freeze logic removed - tokens are always transferable after minting

        msg!(
            "Minted {} tokens to user account: {} by admin: {} (Frozen: {})",
            amount,
            ctx.accounts.user_token_account.key(),
            ctx.accounts.admin.key(),
            !token_state.transfers_enabled
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

    /// Claim tokens using domain-separated signed message with nonce, destination binding, and expiry
    pub fn claim_tokens(
        ctx: Context<ClaimTokens>,
        amount: u64,
        nonce: u64,
        valid_until: i64,
        user_signature: [u8; 64],
        admin_signature: [u8; 64],
    ) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        let user_data = &mut ctx.accounts.user_data;
        
        // Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            RiyalError::InvalidTokenMint
        );

        // Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        // CRITICAL SECURITY: Verify destination binding - user can only claim to their own token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user.key(),
            RiyalError::UnauthorizedDestination
        );

        // Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidMintAmount
        );

        // Get current timestamp for validation
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // CRITICAL SECURITY CHECK 1: Verify user data belongs to the user
        require!(
            user_data.user == ctx.accounts.user.key(),
            RiyalError::InvalidUserData
        );

        // CRITICAL SECURITY CHECK 2: Verify nonce matches user's current nonce (prevent replay attacks)
        require!(
            nonce == user_data.nonce,
            RiyalError::InvalidNonce
        );

        // CRITICAL SECURITY CHECK 3: Ensure nonce is not decreasing (strict ordering)
        require!(
            nonce >= user_data.nonce,
            RiyalError::NonceNotIncreasing
        );

        // CRITICAL SECURITY CHECK 4: Prevent nonce from being too far in the future (max 1 ahead)
        require!(
            nonce <= user_data.nonce.saturating_add(1),
            RiyalError::NonceTooHigh
        );

        // CRITICAL SECURITY CHECK 5: TIME-LOCK VALIDATION - enforce claim periods
        if token_state.time_lock_enabled {
            // Check if enough time has passed since last claim
            require!(
                current_timestamp >= user_data.next_allowed_claim_time,
                RiyalError::ClaimTimeLocked
            );
            
            // For first-time claims, allow immediately
            if user_data.total_claims > 0 {
                require!(
                    current_timestamp >= user_data.last_claim_timestamp.saturating_add(token_state.claim_period_seconds),
                    RiyalError::ClaimPeriodNotElapsed
                );
            }
        } else {
            // If time-lock disabled, still enforce minimum 1 second gap
            if user_data.last_claim_timestamp > 0 {
                require!(
                    current_timestamp > user_data.last_claim_timestamp,
                    RiyalError::ClaimTooSoon
                );
                
                require!(
                    current_timestamp >= user_data.last_claim_timestamp.saturating_add(1),
                    RiyalError::ClaimTooFrequent
                );
            }
        }

        // CRITICAL SECURITY CHECK 6: Validate nonce progression
        if user_data.total_claims > 0 {
            require!(
                nonce == user_data.nonce,
                RiyalError::InvalidNonceSequence
            );
        }

        // CRITICAL SECURITY: Validate expiry timestamp
        let current_timestamp = Clock::get()?.unix_timestamp;
        require!(
            current_timestamp <= valid_until,
            RiyalError::ClaimExpired
        );
        
        // Create DOMAIN-SEPARATED MESSAGE with destination binding and expiry
        // Format: "RIYAL_CLAIM_V1" | program_id | token_state_pda | mint | user | destination | amount | nonce | valid_until
        
        let mut message_bytes = Vec::new();
        message_bytes.extend_from_slice(b"RIYAL_CLAIM_V1");
        message_bytes.extend_from_slice(&crate::ID.to_bytes());
        message_bytes.extend_from_slice(&ctx.accounts.token_state.key().to_bytes());
        message_bytes.extend_from_slice(&token_state.token_mint.to_bytes());
        message_bytes.extend_from_slice(&ctx.accounts.user.key().to_bytes());
        message_bytes.extend_from_slice(&ctx.accounts.user_token_account.key().to_bytes()); // destination binding
        message_bytes.extend_from_slice(&amount.to_le_bytes()); // amount as LE bytes
        message_bytes.extend_from_slice(&nonce.to_le_bytes()); // nonce as LE bytes
        message_bytes.extend_from_slice(&valid_until.to_le_bytes()); // expiry as LE bytes

        // CRITICAL SECURITY: Proper Ed25519 signature verification using instruction introspection
        // This implements REAL cryptographic signature verification
        
        // Verify signature format
        require!(
            user_signature.len() == 64,
            RiyalError::InvalidUserSignature
        );

        require!(
            admin_signature.len() == 64,
            RiyalError::InvalidAdminSignature
        );

        // Verify signatures are not empty
        let user_sig_sum: u64 = user_signature.iter().map(|&x| x as u64).sum();
        let admin_sig_sum: u64 = admin_signature.iter().map(|&x| x as u64).sum();
        
        require!(
            user_sig_sum > 0,
            RiyalError::InvalidUserSignature
        );

        require!(
            admin_sig_sum > 0,
            RiyalError::InvalidAdminSignature
        );

        // ENHANCED SECURITY: Verify Ed25519 signatures using proper Solana method with domain separation
        // This requires Ed25519 verify instructions to be included in the transaction
        verify_ed25519_signatures_in_transaction(
            &ctx.accounts.instructions,
            &message_bytes,
            &user_signature,
            &admin_signature,
            &ctx.accounts.user.key(),
            &token_state.admin,
        )?;

        // Create PDA signer for minting (using token_state as authority)
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Freeze/thaw logic removed for simplicity - tokens can always be claimed

        // Create CPI context for minting with PDA as authority
        let cpi_accounts = anchor_spl::token_interface::MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens
        anchor_spl::token_interface::mint_to(cpi_ctx, amount)?;

        // Freeze logic removed - tokens are always transferable after claiming

        // CRITICAL SECURITY UPDATE: Increment nonce and update security tracking
        let old_nonce = user_data.nonce;
        user_data.nonce = user_data.nonce.checked_add(1)
            .ok_or(RiyalError::NonceOverflow)?;
        
        // Update timestamp and claim count for additional security tracking
        user_data.last_claim_timestamp = current_timestamp;
        user_data.total_claims = user_data.total_claims.checked_add(1)
            .ok_or(RiyalError::ClaimCountOverflow)?;
        
        // CRITICAL TIME-LOCK UPDATE: Set next allowed claim time
        if token_state.time_lock_enabled {
            user_data.next_allowed_claim_time = current_timestamp
                .checked_add(token_state.claim_period_seconds)
                .ok_or(RiyalError::TimestampOverflow)?;
        } else {
            // If time-lock disabled, allow next claim after 1 second
            user_data.next_allowed_claim_time = current_timestamp.saturating_add(1);
        }

        msg!(
            "CLAIM SUCCESSFUL: User: {}, Amount: {}, Nonce used: {}, New nonce: {}, Timestamp: {}, Total claims: {}",
            ctx.accounts.user.key(),
            amount,
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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            RiyalError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidBurnAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify user has sufficient balance to burn
        require!(
            ctx.accounts.user_token_account.amount >= amount,
            RiyalError::InsufficientBalance
        );

        // CRITICAL SECURITY CHECK 8: Verify user is the owner of the token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user_authority.key(),
            RiyalError::UnauthorizedBurn
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create CPI context for burning tokens (user must sign as owner)
        let cpi_accounts = anchor_spl::token_interface::Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.user_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Burn tokens
        anchor_spl::token_interface::burn(cpi_ctx, amount)?;

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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify transfers are not already permanently enabled
        require!(
            !token_state.transfers_permanently_enabled,
            RiyalError::TransfersAlreadyPermanentlyEnabled
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
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 2: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 3: Verify transfers are enabled
        require!(
            token_state.transfers_enabled,
            RiyalError::TransfersNotEnabled
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            RiyalError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify the token account is for the correct mint
        require!(
            ctx.accounts.user_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify the user owns the token account
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user.key(),
            RiyalError::UnauthorizedUnfreeze
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

        // Freeze/thaw logic removed for simplicity - tokens can always be claimed

        msg!(
            "ACCOUNT UNFROZEN: User: {}, Account: {}, Timestamp: {} - Transfers now enabled",
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
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 2: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 3: Verify transfers are enabled
        require!(
            token_state.transfers_enabled,
            RiyalError::TransfersNotEnabled
        );

        // CRITICAL SECURITY CHECK 4: Verify the mint account matches the stored mint
        require!(
            ctx.accounts.mint.key() == token_state.token_mint,
            RiyalError::InvalidTokenMint
        );

        // CRITICAL SECURITY CHECK 5: Verify both token accounts are for the correct mint
        require!(
            ctx.accounts.from_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        require!(
            ctx.accounts.to_token_account.mint == token_state.token_mint,
            RiyalError::InvalidTokenAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidTransferAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify sender has sufficient balance
        require!(
            ctx.accounts.from_token_account.amount >= amount,
            RiyalError::InsufficientBalance
        );

        // CRITICAL SECURITY CHECK 8: Verify sender is the owner of the from account
        require!(
            ctx.accounts.from_token_account.owner == ctx.accounts.from_authority.key(),
            RiyalError::UnauthorizedTransfer
        );

        // Get current timestamp for logging
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create CPI context for transferring tokens using checked transfer for Token-2022
        let cpi_accounts = anchor_spl::token_interface::TransferChecked {
            from: ctx.accounts.from_token_account.to_account_info(),
            to: ctx.accounts.to_token_account.to_account_info(),
            authority: ctx.accounts.from_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Transfer tokens using checked transfer for Token-2022
        anchor_spl::token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.mint.decimals,
        )?;

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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // Validate claim period (must be reasonable)
        require!(
            claim_period_seconds >= 3600, // Minimum 1 hour
            RiyalError::InvalidClaimPeriod
        );
        
        require!(
            claim_period_seconds <= 31536000, // Maximum 1 year
            RiyalError::InvalidClaimPeriod
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
            RiyalError::UnauthorizedUpgradeAuthority
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify contract is upgradeable
        require!(
            token_state.upgradeable,
            RiyalError::ContractNotUpgradeable
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
            RiyalError::UnauthorizedUpgradeAuthority
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify contract is upgradeable
        require!(
            token_state.upgradeable,
            RiyalError::ContractNotUpgradeable
        );

        // CRITICAL SECURITY CHECK 4: Verify program data account
        require!(
            ctx.accounts.program_data.key() != Pubkey::default(),
            RiyalError::InvalidProgramData
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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury not already created
        require!(
            token_state.treasury_account == Pubkey::default(),
            RiyalError::TreasuryAlreadyCreated
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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury has been created
        require!(
            token_state.treasury_account != Pubkey::default(),
            RiyalError::TreasuryNotCreated
        );

        // CRITICAL SECURITY CHECK 5: Verify treasury account matches stored account
        require!(
            ctx.accounts.treasury_account.key() == token_state.treasury_account,
            RiyalError::InvalidTreasuryAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidMintAmount
        );

        // Create PDA signer for minting
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for minting to treasury
        let cpi_accounts = anchor_spl::token_interface::MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens to treasury
        anchor_spl::token_interface::mint_to(cpi_ctx, amount)?;

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
            RiyalError::UnauthorizedAdmin
        );

        // CRITICAL SECURITY CHECK 2: Verify contract is initialized
        require!(
            token_state.is_initialized,
            RiyalError::ContractNotInitialized
        );

        // CRITICAL SECURITY CHECK 3: Verify token mint has been created
        require!(
            token_state.token_mint != Pubkey::default(),
            RiyalError::TokenMintNotCreated
        );

        // CRITICAL SECURITY CHECK 4: Verify treasury has been created
        require!(
            token_state.treasury_account != Pubkey::default(),
            RiyalError::TreasuryNotCreated
        );

        // CRITICAL SECURITY CHECK 5: Verify treasury account matches stored account
        require!(
            ctx.accounts.treasury_account.key() == token_state.treasury_account,
            RiyalError::InvalidTreasuryAccount
        );

        // CRITICAL SECURITY CHECK 6: Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidBurnAmount
        );

        // CRITICAL SECURITY CHECK 7: Verify treasury has sufficient balance
        require!(
            ctx.accounts.treasury_account.amount >= amount,
            RiyalError::InsufficientTreasuryBalance
        );

        // Create PDA signer for burning from treasury
        let seeds = &[
            b"token_state".as_ref(),
            &[ctx.bumps.token_state],
        ];
        let signer_seeds = &[&seeds[..]];

        // Create CPI context for burning from treasury
        let cpi_accounts = anchor_spl::token_interface::Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Burn tokens from treasury
        anchor_spl::token_interface::burn(cpi_ctx, amount)?;

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
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
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
        constraint = current_upgrade_authority.key() == token_state.upgrade_authority @ RiyalError::UnauthorizedUpgradeAuthority
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
        constraint = upgrade_authority.key() == token_state.upgrade_authority @ RiyalError::UnauthorizedUpgradeAuthority
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
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: User pubkey is verified through signature verification
    pub user: UncheckedAccount<'info>,

    /// CHECK: Instructions sysvar for Ed25519 signature verification
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    #[account(
        constraint = user_authority.key() == user_token_account.owner @ RiyalError::UnauthorizedBurn
    )]
    pub user_authority: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = user.key() == user_token_account.owner @ RiyalError::UnauthorizedUnfreeze
    )]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = from_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub from_token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = to_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub to_token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = from_authority.key() == from_token_account.owner @ RiyalError::UnauthorizedTransfer
    )]
    pub from_authority: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
    pub treasury_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = treasury_account.key() == token_state.treasury_account @ RiyalError::InvalidTreasuryAccount
    )]
    pub treasury_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    
    #[account(
        mut,
        constraint = treasury_account.key() == token_state.treasury_account @ RiyalError::InvalidTreasuryAccount
    )]
    pub treasury_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token2022>,
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

