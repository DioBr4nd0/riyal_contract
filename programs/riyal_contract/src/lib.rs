use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount, freeze_account, thaw_account, FreezeAccount, ThawAccount, mint_to, burn, transfer, MintTo, Burn, Transfer, set_authority, SetAuthority};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::{
    sysvar::instructions::{self},
    sysvar::clock::Clock,
};
pub mod errors;
use errors::MercleError;
pub mod signature;
use signature::verify_admin_signature_only;

declare_id!("2XWNXNwRdT9rfKUjsmtwi5St4yaLNDKoHiKiASyn3rLZ");

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimPayload {
    pub user_address: Pubkey,
    pub claim_amount: u64,
    pub expiry_time: i64,
    pub nonce: u64,
}

#[program]
pub mod mercle_token {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey, upgrade_authority: Pubkey, claim_period_seconds: i64, time_lock_enabled: bool, upgradeable: bool) -> Result<()> {
        require!(claim_period_seconds >= 30 && claim_period_seconds <= 31536000, MercleError::InvalidClaimPeriod);

        let token_state = &mut ctx.accounts.token_state;
        token_state.admin = admin;
        token_state.upgrade_authority = upgrade_authority;
        token_state.is_initialized = true;
        token_state.token_mint = Pubkey::default();
        token_state.treasury_account = Pubkey::default();
        token_state.transfers_enabled = false;
        token_state.transfers_permanently_enabled = false;
        token_state.transfer_enable_timestamp = 0;
        token_state.claim_period_seconds = claim_period_seconds;
        token_state.time_lock_enabled = time_lock_enabled;
        token_state.upgradeable = upgradeable;
        
        Ok(())
    }

    pub fn create_token_mint(ctx: Context<CreateTokenMint>, _decimals: u8, name: String, symbol: String) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        token_state.token_mint = ctx.accounts.mint.key();
        token_state.token_name = name;
        token_state.token_symbol = symbol;
        token_state.decimals = _decimals;
        token_state.transfers_enabled = false;

        Ok(())
    }

    pub fn update_token_mint(ctx: Context<UpdateTokenMint>, decimals: u8, name: String, symbol: String) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        token_state.token_mint = ctx.accounts.mint.key();
        token_state.token_name = name;
        token_state.token_symbol = symbol;
        token_state.decimals = decimals;
        token_state.treasury_account = Pubkey::default();

        Ok(())
    }


    pub fn pause_transfers(ctx: Context<PauseTransfers>) -> Result<()> {
        require!(!ctx.accounts.token_state.transfers_permanently_enabled, MercleError::TransfersPermanentlyEnabled);
        ctx.accounts.token_state.transfers_enabled = false;
        Ok(())
    }

    pub fn resume_transfers(ctx: Context<ResumeTransfers>) -> Result<()> {
        ctx.accounts.token_state.transfers_enabled = true;
        ctx.accounts.token_state.transfer_enable_timestamp = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn permanently_enable_transfers(ctx: Context<PermanentlyEnableTransfers>) -> Result<()> {
        let s = &mut ctx.accounts.token_state;
        s.transfers_enabled = true;
        s.transfers_permanently_enabled = true;
        s.transfer_enable_timestamp = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn mint_tokens(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        require!(amount > 0, MercleError::InvalidMintAmount);

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        mint_to(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ), amount)?;

        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ))?;

        Ok(())
    }

    pub fn freeze_token_account(ctx: Context<FreezeTokenAccount>) -> Result<()> {
        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
            account: ctx.accounts.token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ))?;
        Ok(())
    }

    pub fn unfreeze_token_account(ctx: Context<UnfreezeTokenAccount>) -> Result<()> {
        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
            account: ctx.accounts.token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ))?;
        Ok(())
    }

    pub fn initialize_user_data(ctx: Context<InitializeUserData>) -> Result<()> {
        let d = &mut ctx.accounts.user_data;
        d.user = ctx.accounts.user.key();
        d.nonce = 0;
        d.last_claim_timestamp = 0;
        d.next_allowed_claim_time = 0;
        d.total_claims = 0;
        d.bump = ctx.bumps.user_data;
        Ok(())
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>, payload: ClaimPayload, admin_signature: [u8; 64]) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        let user_data = &mut ctx.accounts.user_data;
        let current_timestamp = Clock::get()?.unix_timestamp;

        require!(payload.user_address == ctx.accounts.user.key(), MercleError::UnauthorizedDestination);
        require!(ctx.accounts.user_token_account.owner == ctx.accounts.user.key(), MercleError::UnauthorizedDestination);
        require!(payload.claim_amount > 0, MercleError::InvalidMintAmount);
        require!(payload.nonce == user_data.nonce, MercleError::InvalidNonce);
        require!(current_timestamp <= payload.expiry_time, MercleError::ClaimExpired);

        if token_state.time_lock_enabled {
            require!(current_timestamp >= user_data.next_allowed_claim_time, MercleError::ClaimTimeLocked);
            if user_data.total_claims > 0 {
                require!(current_timestamp >= user_data.last_claim_timestamp.saturating_add(token_state.claim_period_seconds), MercleError::ClaimPeriodNotElapsed);
            }
        } else if user_data.last_claim_timestamp > 0 {
            require!(current_timestamp >= user_data.last_claim_timestamp.saturating_add(1), MercleError::ClaimTooFrequent);
        }

        let payload_bytes = payload.try_to_vec().map_err(|_| MercleError::InvalidClaimPayload)?;
        let mut message_bytes = Vec::new();
        message_bytes.extend_from_slice(b"MERCLE_CLAIM_V1");
        message_bytes.extend_from_slice(&crate::ID.to_bytes());
        message_bytes.extend_from_slice(&payload_bytes);

        let admin_sig_sum: u64 = admin_signature.iter().map(|&x| x as u64).sum();
        require!(admin_sig_sum > 0, MercleError::InvalidAdminSignature);

        verify_admin_signature_only(&ctx.accounts.instructions, &message_bytes, &admin_signature, &token_state.admin)?;

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        mint_to(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ), payload.claim_amount)?;

        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ))?;

        user_data.nonce = user_data.nonce.checked_add(1).ok_or(MercleError::NonceOverflow)?;
        user_data.last_claim_timestamp = current_timestamp;
        user_data.total_claims = user_data.total_claims.checked_add(1).ok_or(MercleError::ClaimCountOverflow)?;
        user_data.next_allowed_claim_time = if token_state.time_lock_enabled {
            current_timestamp.checked_add(token_state.claim_period_seconds).ok_or(MercleError::TimestampOverflow)?
        } else {
            current_timestamp.saturating_add(1)
        };

        Ok(())
    }

    pub fn burn_tokens(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        require!(amount > 0, MercleError::InvalidBurnAmount);
        require!(ctx.accounts.user_token_account.amount >= amount, MercleError::InsufficientBalance);

        burn(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.user_authority.to_account_info(),
            },
        ), amount)?;

        Ok(())
    }

    pub fn enable_transfers(ctx: Context<EnableTransfers>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        require!(!token_state.transfers_permanently_enabled, MercleError::TransfersAlreadyPermanentlyEnabled);

        token_state.transfers_enabled = true;
        token_state.transfers_permanently_enabled = true;
        token_state.transfer_enable_timestamp = Clock::get()?.unix_timestamp;

        Ok(())
    }

    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        require!(ctx.accounts.token_state.transfers_permanently_enabled, MercleError::TransfersNotPermanentlyEnabled);

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ))?;

        Ok(())
    }

    pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        require!(ctx.accounts.token_state.transfers_enabled, MercleError::TransfersNotEnabled);
        require!(amount > 0, MercleError::InvalidTransferAmount);
        require!(ctx.accounts.from_token_account.amount >= amount, MercleError::InsufficientBalance);

        transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
            from: ctx.accounts.from_token_account.to_account_info(),
            to: ctx.accounts.to_token_account.to_account_info(),
            authority: ctx.accounts.from_authority.to_account_info(),
            },
        ), amount)?;

        Ok(())
    }

    pub fn update_time_lock(ctx: Context<UpdateTimeLock>, claim_period_seconds: i64, time_lock_enabled: bool) -> Result<()> {
        require!(claim_period_seconds >= 30 && claim_period_seconds <= 31536000, MercleError::InvalidClaimPeriod);

        let token_state = &mut ctx.accounts.token_state;
        token_state.claim_period_seconds = claim_period_seconds;
        token_state.time_lock_enabled = time_lock_enabled;

        Ok(())
    }

    pub fn set_upgrade_authority(ctx: Context<SetUpgradeAuthority>, new_upgrade_authority: Option<Pubkey>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        match new_upgrade_authority {
            Some(new_auth) => token_state.upgrade_authority = new_auth,
            None => {
                token_state.upgrade_authority = Pubkey::default();
                token_state.upgradeable = false;
            }
        }
        Ok(())
    }

    pub fn validate_upgrade(ctx: Context<ValidateUpgrade>) -> Result<()> {
        require!(ctx.accounts.program_data.key() != Pubkey::default(), MercleError::InvalidProgramData);
        Ok(())
    }

    pub fn create_treasury(ctx: Context<CreateTreasury>) -> Result<()> {
        ctx.accounts.token_state.treasury_account = ctx.accounts.treasury_account.key();
        Ok(())
    }

    pub fn mint_to_treasury(ctx: Context<MintToTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, MercleError::InvalidMintAmount);

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        mint_to(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury_account.to_account_info(),
            authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ), amount)?;

        Ok(())
    }

    pub fn burn_from_treasury(ctx: Context<BurnFromTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, MercleError::InvalidBurnAmount);
        require!(ctx.accounts.treasury_account.amount >= amount, MercleError::InsufficientTreasuryBalance);

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        burn(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.treasury_account.to_account_info(),
                authority: ctx.accounts.token_state.to_account_info(),
            },
            &[&seeds[..]],
        ), amount)?;

        Ok(())
    }

    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        
        require!(
            ctx.accounts.admin.key() == token_state.admin,
            MercleError::UnauthorizedAdmin
        );

        require!(
            token_state.is_initialized,
            MercleError::ContractNotInitialized
        );

        let old_admin = token_state.admin;
        token_state.admin = new_admin;

        msg!(
            "Admin updated: {} → {}",
            old_admin,
            new_admin
        );

        Ok(())
    }

    pub fn create_metadata(ctx: Context<CreateMetadata>, name: String, symbol: String, uri: String) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        require!(ctx.accounts.admin.key() == token_state.admin, MercleError::UnauthorizedAdmin);
        require!(token_state.is_initialized, MercleError::ContractNotInitialized);
        require!(name.len() <= 32, MercleError::InvalidTokenNameLength);
        require!(symbol.len() <= 16, MercleError::InvalidTokenSymbolLength);

        let seeds = &[b"token_state".as_ref(), &[ctx.bumps.token_state]];
        let signer_seeds = &[&seeds[..]];

        // Create metadata account using CPI
        let create_metadata_accounts = anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.token_metadata_program.key(),
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.metadata.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.token_state.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.admin.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.admin.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
            ],
            data: {
                let mut data = vec![33u8]; // CreateMetadataAccountV3 discriminator
                data.extend_from_slice(&(name.len() as u32).to_le_bytes());
                data.extend_from_slice(name.as_bytes());
                data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
                data.extend_from_slice(symbol.as_bytes());
                data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
                data.extend_from_slice(uri.as_bytes());
                data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
                data.push(0u8); // creators (None)
                data.push(0u8); // collection (None)
                data.push(0u8); // uses (None)
                data.push(1u8); // is_mutable
                data
            },
        };

        anchor_lang::solana_program::program::invoke_signed(
            &create_metadata_accounts,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.token_state.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!("Metadata created: {} ({}), URI: {}", name, symbol, uri);
        Ok(())
    }

    pub fn transfer_mint_authority_to_pda(ctx: Context<TransferMintAuthority>) -> Result<()> {
        let token_state = &ctx.accounts.token_state;
        require!(ctx.accounts.admin.key() == token_state.admin, MercleError::UnauthorizedAdmin);
        require!(token_state.is_initialized, MercleError::ContractNotInitialized);

        // Transfer mint authority from admin to PDA
        set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                    current_authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            Some(ctx.accounts.token_state.key()),
        )?;

        msg!("Mint authority transferred from admin to PDA: {}", ctx.accounts.token_state.key());
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
        mint::authority = admin.key(),
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

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
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
pub struct CreateMetadata<'info> {
    #[account(
        mut,
        seeds = [b"token_state"],
        bump
    )]
    pub token_state: Account<'info, TokenState>,
    
    #[account(
        constraint = mint.key() == token_state.token_mint @ MercleError::InvalidTokenMint
    )]
    pub mint: Account<'info, Mint>,
    
    /// CHECK: Metadata account to be created
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    
    #[account(
        mut,
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    /// CHECK: Token Metadata Program
    pub token_metadata_program: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TransferMintAuthority<'info> {
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
        constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
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

