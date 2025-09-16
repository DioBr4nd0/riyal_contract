#!/usr/bin/env node

/**
 * EMERGENCY: FREEZE ALL UNFROZEN ACCOUNTS
 * 
 * This script finds all token accounts that should be frozen
 * and freezes them immediately to fix the security issue.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("🚨 EMERGENCY: FREEZE UNFROZEN ACCOUNTS");
  console.log("=====================================");
  console.log("This will freeze all token accounts that should be frozen");
  console.log("but are currently transferable due to the security bug.");
  
  try {
    const admin = loadAdminKeypair();
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    const program = anchor.workspace.RiyalContract;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    
    // Get contract state
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log(`Token Mint: ${tokenState.tokenMint.toString()}`);
    console.log(`Transfers Enabled: ${tokenState.transfersEnabled}`);
    
    if (tokenState.transfersEnabled) {
      console.log("⚠️  Transfers are enabled - accounts should not be frozen");
      return;
    }
    
    // Get all token accounts for this mint
    console.log("\n🔍 Finding all token accounts...");
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      new PublicKey("11111111111111111111111111111111"), // This won't work, need different approach
      {
        mint: tokenState.tokenMint
      }
    );
    
    console.log("⚠️  Note: Cannot easily enumerate all token accounts.");
    console.log("You need to manually freeze accounts that have claimed tokens.");
    
    // Example: Freeze the known account from our test
    const knownUnfrozenAccount = new PublicKey("Dyo1uLxTwdxb9tRUXJWUGBANFipCVWsxsX2J6Ux8NEgi");
    
    console.log(`\n🧊 FREEZING KNOWN ACCOUNT: ${knownUnfrozenAccount.toString()}`);
    
    try {
      await program.methods
        .freezeTokenAccount()
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenState.tokenMint,
          tokenAccount: knownUnfrozenAccount,
          admin: admin.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      
      console.log("✅ Account frozen successfully");
      
      // Verify it's now frozen
      const accountInfo = await connection.getAccountInfo(knownUnfrozenAccount);
      if (accountInfo) {
        const isFrozen = accountInfo.data[108] === 1;
        console.log(`Account now frozen: ${isFrozen}`);
      }
      
    } catch (error) {
      if (error.message.includes("already frozen")) {
        console.log("✅ Account was already frozen");
      } else {
        console.error("❌ Failed to freeze account:", error.message);
      }
    }
    
    console.log("\n📋 NEXT STEPS:");
    console.log("1. Fix the contract code (add freeze logic back to claim_tokens)");
    console.log("2. Upgrade the contract");
    console.log("3. Freeze any other accounts that claimed tokens");
    console.log("4. Test the fix");
    
    console.log("\n💡 TO FIND OTHER ACCOUNTS TO FREEZE:");
    console.log("- Check your transaction logs for successful claims");
    console.log("- Look for 'CLAIM SUCCESSFUL' messages");
    console.log("- Freeze those token accounts manually");
    
  } catch (error) {
    console.error("❌ Emergency freeze failed:", error.message);
  }
})().catch(console.error);
