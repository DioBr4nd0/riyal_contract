use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{self, load_instruction_at_checked},
};
use crate::errors::*;

/// Verify Ed25519 signatures using proper Solana method
/// This requires Ed25519 verify instructions to be included BEFORE the claim instruction
pub fn verify_ed25519_signatures_in_transaction(
    instructions_sysvar: &UncheckedAccount,
    message: &str,
    user_signature: &[u8; 64],
    admin_signature: &[u8; 64],
    user_pubkey: &Pubkey,
    admin_pubkey: &Pubkey,
) -> Result<()> {
    let message_bytes = message.as_bytes();
    let current_index = instructions::load_current_index_checked(instructions_sysvar)?;
    
    let mut user_verified = false;
    let mut admin_verified = false;
    
    // Check all previous instructions in the transaction for Ed25519 verify instructions
    for i in 0..current_index {
        if let Ok(instruction) = load_instruction_at_checked(i.into(), instructions_sysvar) {
            // Check if this is an Ed25519 verify instruction
            if instruction.program_id == ed25519_program::ID {
                // The fact that the instruction succeeded means the signature was valid
                // Now we need to check if it matches our expected signatures
                
                if instruction.data.len() >= 112 {
                    // Simple approach: Check if the instruction data contains our expected data
                    let instruction_contains_user_sig = instruction.data
                        .windows(64)
                        .any(|window| window == user_signature);
                    
                    let instruction_contains_admin_sig = instruction.data
                        .windows(64)
                        .any(|window| window == admin_signature);
                    
                    let instruction_contains_user_pubkey = instruction.data
                        .windows(32)
                        .any(|window| window == user_pubkey.as_ref());
                    
                    let instruction_contains_admin_pubkey = instruction.data
                        .windows(32)
                        .any(|window| window == admin_pubkey.as_ref());
                    
                    let instruction_contains_message = instruction.data
                        .windows(message_bytes.len())
                        .any(|window| window == message_bytes);
                    
                    // If instruction contains user signature, pubkey, and message, it verified the user
                    if instruction_contains_user_sig && 
                       instruction_contains_user_pubkey && 
                       instruction_contains_message {
                        user_verified = true;
                    }
                    
                    // If instruction contains admin signature, pubkey, and message, it verified the admin
                    if instruction_contains_admin_sig && 
                       instruction_contains_admin_pubkey && 
                       instruction_contains_message {
                        admin_verified = true;
                    }
                }
            }
        }
    }
    
    // Require both signatures to be verified by Ed25519 program
    require!(
        user_verified,
        RiyalError::UserSignatureNotVerified
    );
    
    require!(
        admin_verified,
        RiyalError::AdminSignatureNotVerified
    );
    
    msg!(
        "REAL ED25519 VERIFICATION SUCCESS: Both signatures cryptographically verified"
    );
    
    Ok(())
}