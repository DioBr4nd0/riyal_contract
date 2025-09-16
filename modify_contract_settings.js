#!/usr/bin/env node

/**
 * MODIFY CONTRACT SETTINGS
 * 
 * This script allows you to modify your deployed contract settings
 * without redeploying. Your contract is upgradeable and has admin functions.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("🔧 CONTRACT SETTINGS MODIFIER");
  console.log("=============================");
  
  try {
    const admin = loadAdminKeypair();
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    const program = anchor.workspace.RiyalContract;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    
    console.log(`Program ID: ${program.programId.toString()}`);
    console.log(`Admin: ${admin.publicKey.toString()}`);
    
    // Get current state
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    
    console.log("\n📋 CURRENT SETTINGS:");
    console.log(`Token Name: ${tokenState.tokenName}`);
    console.log(`Token Symbol: ${tokenState.tokenSymbol}`);
    console.log(`Decimals: ${tokenState.decimals}`);
    console.log(`Claim Period: ${tokenState.claimPeriodSeconds} seconds (${tokenState.claimPeriodSeconds / 3600} hours)`);
    console.log(`Time Lock Enabled: ${tokenState.timeLockEnabled}`);
    console.log(`Transfers Enabled: ${tokenState.transfersEnabled}`);
    console.log(`Transfers Permanently Enabled: ${tokenState.transfersPermanentlyEnabled}`);
    console.log(`Upgradeable: ${tokenState.upgradeable}`);
    console.log(`Treasury Created: ${tokenState.treasuryAccount.toString() !== '11111111111111111111111111111111'}`);
    
    console.log("\n🔧 AVAILABLE MODIFICATIONS:");
    console.log("1. Update claim period (time-lock settings)");
    console.log("2. Create treasury account");
    console.log("3. Enable transfers (PERMANENT - cannot be undone)");
    console.log("4. Pause/Resume transfers (if not permanently enabled)");
    
    // Example: Update time-lock to 1 hour instead of 24 hours
    const newClaimPeriod = 3600; // 1 hour in seconds
    
    console.log(`\n⏰ UPDATING CLAIM PERIOD: 24 hours → 1 hour...`);
    await program.methods
      .updateTimeLock(
        new anchor.BN(newClaimPeriod), // 1 hour
        true // keep time-lock enabled
      )
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    
    console.log("✅ Claim period updated to 1 hour");
    
    // Create treasury if not exists
    if (tokenState.treasuryAccount.toString() === '11111111111111111111111111111111') {
      console.log("\n🏦 CREATING TREASURY ACCOUNT...");
      
      const [treasuryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury"), tokenState.tokenMint.toBuffer()],
        program.programId
      );
      
      await program.methods
        .createTreasury()
        .accounts({
          tokenState: tokenStatePDA,
          treasuryAccount: treasuryPDA,
          mint: tokenState.tokenMint,
          admin: admin.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      
      console.log("✅ Treasury account created");
    }
    
    // Get updated state
    const updatedState = await program.account.tokenState.fetch(tokenStatePDA);
    
    console.log("\n📋 UPDATED SETTINGS:");
    console.log(`Claim Period: ${updatedState.claimPeriodSeconds} seconds (${updatedState.claimPeriodSeconds / 3600} hours)`);
    console.log(`Treasury Created: ${updatedState.treasuryAccount.toString() !== '11111111111111111111111111111111'}`);
    if (updatedState.treasuryAccount.toString() !== '11111111111111111111111111111111') {
      console.log(`Treasury Address: ${updatedState.treasuryAccount.toString()}`);
    }
    
    console.log("\n✅ CONTRACT SETTINGS UPDATED SUCCESSFULLY!");
    console.log("\n💡 OTHER THINGS YOU CAN DO:");
    console.log("- Mint tokens to treasury: program.methods.mintToTreasury()");
    console.log("- Enable transfers permanently: program.methods.enableTransfers()");
    console.log("- Update upgrade authority: program.methods.setUpgradeAuthority()");
    
  } catch (error) {
    console.error("❌ Failed to modify settings:", error.message);
  }
})().catch(console.error);
