#![allow(unused_imports)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{self, load_instruction_at_checked},
};
use crate::errors::MercleError;

/// Verify admin Ed25519 signature only using proper Solana method with domain-separated binary messages
/// This requires an Ed25519 verify instruction to be included BEFORE the claim instruction
pub fn verify_admin_signature_only(
    instructions_sysvar: &UncheckedAccount,
    message_bytes: &[u8],
    admin_signature: &[u8; 64],
    admin_pubkey: &Pubkey,
) -> Result<()> {
    let current_index = instructions::load_current_index_checked(instructions_sysvar)?;
    
    let mut admin_verified = false;
    
    // Helper to safely read little-endian integers
    fn read_u8(data: &[u8], offset: usize) -> Option<u8> {
        data.get(offset).copied()
    }
    fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
        let bytes = data.get(offset..offset + 2)?;
        Some(u16::from_le_bytes([bytes[0], bytes[1]]))
    }
    
    // Parse a single-sig Ed25519 instruction created by web3.js createInstructionWithPublicKey
    // Layout (LE):
    //   u8  numSignatures
    //   u8  padding
    //   u16 signatureOffset
    //   u16 signatureInstructionIndex
    //   u16 publicKeyOffset
    //   u16 publicKeyInstructionIndex
    //   u16 messageDataOffset
    //   u16 messageDataSize
    //   u16 messageInstructionIndex
    // Followed by: publicKey (32) | signature (64) | message (msg_len)
    fn parse_ed25519_single(data: &[u8]) -> Option<([u8; 32], [u8; 64], &[u8])> {
        // Require at least 16-byte header
        if data.len() < 16 { return None; }
        let num_sigs = read_u8(data, 0)?;
        if num_sigs != 1 { return None; }
        let _padding = read_u8(data, 1)?;
        let sig_off = read_u16_le(data, 2)? as usize;
        let _sig_ix = read_u16_le(data, 4)?;
        let pk_off = read_u16_le(data, 6)? as usize;
        let _pk_ix = read_u16_le(data, 8)?;
        let msg_off = read_u16_le(data, 10)? as usize;
        let msg_size = read_u16_le(data, 12)? as usize;
        let _msg_ix = read_u16_le(data, 14)?;
        
        // Bounds checks
        if pk_off.checked_add(32).filter(|&end| end <= data.len()).is_none() { return None; }
        if sig_off.checked_add(64).filter(|&end| end <= data.len()).is_none() { return None; }
        if msg_off.checked_add(msg_size).filter(|&end| end <= data.len()).is_none() { return None; }
        
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&data[pk_off..pk_off + 32]);
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&data[sig_off..sig_off + 64]);
        let msg = &data[msg_off..msg_off + msg_size];
        Some((pk, sig, msg))
    }
    
    // Check all previous instructions for Ed25519 verifies and match against expected
    for i in 0..current_index {
        if let Ok(instruction) = load_instruction_at_checked(i.into(), instructions_sysvar) {
            if instruction.program_id == ed25519_program::ID {
                if let Some((pk, sig, msg)) = parse_ed25519_single(&instruction.data) {
                    // Require exact message match
                    if msg == message_bytes {
                        if !admin_verified && pk.as_ref() == admin_pubkey.as_ref() && sig.as_ref() == admin_signature {
                            admin_verified = true;
                        }
                    }
                }
            }
        }
    }
    
    // Require admin signature to be verified by Ed25519 program
    require!(
        admin_verified,
        MercleError::AdminSignatureNotVerified
    );
    
    msg!(
        "REAL ED25519 VERIFICATION SUCCESS: Admin signature cryptographically verified"
    );
    
    Ok(())
}