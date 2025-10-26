use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{self, load_instruction_at_checked},
};
use crate::errors::MercleError;

pub fn verify_admin_signature_only(
    instructions_sysvar: &UncheckedAccount,
    message_bytes: &[u8],
    admin_signature: &[u8; 64],
    admin_pubkey: &Pubkey,
) -> Result<()> {
    let idx = instructions::load_current_index_checked(instructions_sysvar)?;
    let mut verified = false;

    fn u16_le(d: &[u8], o: usize) -> Option<u16> {
        let b = d.get(o..o+2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn parse(d: &[u8]) -> Option<([u8; 32], [u8; 64], &[u8])> {
        if d.len() < 16 || d.get(0)? != &1 { return None; }
        let sig_off = u16_le(d, 2)? as usize;
        let pk_off = u16_le(d, 6)? as usize;
        let msg_off = u16_le(d, 10)? as usize;
        let msg_sz = u16_le(d, 12)? as usize;
        if pk_off+32 > d.len() || sig_off+64 > d.len() || msg_off+msg_sz > d.len() { return None; }
        let mut pk = [0u8; 32]; pk.copy_from_slice(&d[pk_off..pk_off+32]);
        let mut sig = [0u8; 64]; sig.copy_from_slice(&d[sig_off..sig_off+64]);
        Some((pk, sig, &d[msg_off..msg_off+msg_sz]))
    }

    for i in 0..idx {
        if let Ok(inst) = load_instruction_at_checked(i.into(), instructions_sysvar) {
            if inst.program_id == ed25519_program::ID {
                if let Some((pk, sig, msg)) = parse(&inst.data) {
                    if msg == message_bytes && pk.as_ref() == admin_pubkey.as_ref() && sig.as_ref() == admin_signature {
                        verified = true;
                    }
                }
            }
        }
    }

    require!(verified, MercleError::AdminSignatureNotVerified);
    Ok(())
}