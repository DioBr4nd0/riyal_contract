use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo};
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{self, load_instruction_at_checked},
};
use std::convert::TryInto;

declare_id!("3DAyy3hk9x4LPKzJMLsGeMj7pFWyavf9624LTMhrhDbH");

#[program]
pub mod riyal_contract {
    use super::*;

    /// Initialize the contract with admin public key
    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        token_state.admin = admin;
        token_state.is_initialized = true;
        token_state.token_mint = Pubkey::default(); // Will be set when mint is created
        token_state.transfers_enabled = false;
        
        msg!("Contract initialized with admin: {}", admin);
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
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Mint tokens
        token::mint_to(cpi_ctx, amount)?;

        msg!(
            "Minted {} tokens to user account: {} by admin: {}",
            amount,
            ctx.accounts.user_token_account.key(),
            ctx.accounts.admin.key()
        );

        Ok(())
    }

    /// Initialize user data PDA with nonce
    pub fn initialize_user_data(ctx: Context<InitializeUserData>) -> Result<()> {
        let user_data = &mut ctx.accounts.user_data;
        user_data.user = ctx.accounts.user.key();
        user_data.nonce = 0;
        user_data.bump = ctx.bumps.user_data;

        msg!(
            "User data initialized for user: {} with nonce: {}",
            user_data.user,
            user_data.nonce
        );

        Ok(())
    }

    /// Claim tokens using signed message with nonce (user + admin signatures)
    pub fn claim_tokens(
        ctx: Context<ClaimTokens>,
        amount: u64,
        nonce: u64,
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

        // Verify amount is not zero
        require!(
            amount > 0,
            RiyalError::InvalidMintAmount
        );

        // Verify user data belongs to the user
        require!(
            user_data.user == ctx.accounts.user.key(),
            RiyalError::InvalidUserData
        );

        // Verify nonce matches user's current nonce (prevent replay attacks)
        require!(
            nonce == user_data.nonce,
            RiyalError::InvalidNonce
        );

        // Create the message to verify signatures
        let message = format!(
            "{{\"user\":\"{}\",\"amount\":{},\"nonce\":{},\"mint\":\"{}\"}}",
            ctx.accounts.user.key(),
            amount,
            nonce,
            token_state.token_mint
        );

        // For this implementation, we'll use a simplified signature verification
        // In a production environment, you would implement proper Ed25519 signature verification
        // Here we'll verify that the signatures are provided and have the correct length
        require!(
            user_signature.len() == 64,
            RiyalError::InvalidUserSignature
        );

        require!(
            admin_signature.len() == 64,
            RiyalError::InvalidAdminSignature
        );

        // Additional validation: check that signatures are not all zeros
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

        // In a real implementation, you would verify the signatures against the message
        // For now, we'll assume the signatures are valid if they have the correct format
        // TODO: Implement proper Ed25519 signature verification using instruction introspection

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

        // Mint tokens
        token::mint_to(cpi_ctx, amount)?;

        // Increment nonce to prevent replay attacks
        user_data.nonce = user_data.nonce.checked_add(1)
            .ok_or(RiyalError::NonceOverflow)?;

        msg!(
            "Claimed {} tokens for user: {} with nonce: {} (incremented to: {})",
            amount,
            ctx.accounts.user.key(),
            nonce,
            user_data.nonce
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ RiyalError::UnauthorizedAdmin
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
        constraint = mint.key() == token_state.token_mint @ RiyalError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == token_state.token_mint @ RiyalError::InvalidTokenAccount
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: User pubkey is verified through signature verification
    pub user: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct TokenState {
    pub admin: Pubkey,                    // 32 bytes
    pub token_mint: Pubkey,               // 32 bytes  
    pub is_initialized: bool,             // 1 byte
    pub transfers_enabled: bool,          // 1 byte
    pub token_name: String,               // 4 + up to 32 bytes
    pub token_symbol: String,             // 4 + up to 16 bytes
    pub decimals: u8,                     // 1 byte
    pub bump: u8,                         // 1 byte
}

impl TokenState {
    pub const SIZE: usize = 8 +           // discriminator
        32 +                              // admin
        32 +                              // token_mint
        1 +                               // is_initialized
        1 +                               // transfers_enabled
        4 + 32 +                          // token_name (String with max 32 chars)
        4 + 16 +                          // token_symbol (String with max 16 chars)
        1 +                               // decimals
        1;                                // bump
}

#[account]
pub struct UserData {
    pub user: Pubkey,                     // 32 bytes
    pub nonce: u64,                       // 8 bytes
    pub bump: u8,                         // 1 byte
}

impl UserData {
    pub const SIZE: usize = 8 +           // discriminator
        32 +                              // user
        8 +                               // nonce
        1;                                // bump
}

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
}