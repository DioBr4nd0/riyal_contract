#!/usr/bin/env node

/**
 * DEBUG FREEZE ISSUE
 * 
 * This script helps debug why the freeze mechanism isn't working
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("🔍 DEBUGGING FREEZE MECHANISM");
  console.log("=============================");
  
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
    
    // Test with the known account from previous test
    const testUser = new PublicKey("5681LVRPDphoLVVPX2MJqaiSSnoPui6pt5XHpseFyexj");
    const userTokenAccount = await getAssociatedTokenAddress(
      tokenState.tokenMint,
      testUser,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    console.log(`\n📋 CHECKING ACCOUNT: ${userTokenAccount.toString()}`);
    
    // Get detailed account info
    const accountInfo = await connection.getAccountInfo(userTokenAccount);
    if (accountInfo) {
      console.log(`Account Owner: ${accountInfo.owner.toString()}`);
      console.log(`Account Data Length: ${accountInfo.data.length}`);
      console.log(`Account Executable: ${accountInfo.executable}`);
      
      // Check if this is Token-2022 or regular Token
      const isToken2022 = accountInfo.owner.toString() === TOKEN_2022_PROGRAM_ID.toString();
      console.log(`Is Token-2022: ${isToken2022}`);
      
      // Parse account data
      if (isToken2022) {
        // Token-2022 has different layout
        console.log("Parsing Token-2022 account...");
        
        // For Token-2022, we need to check the account state
        // The freeze status might be in a different location
        const data = accountInfo.data;
        
        // Try different offsets for frozen flag
        console.log(`Byte at offset 108: ${data[108]} (traditional location)`);
        console.log(`Byte at offset 72: ${data[72]} (alternative location)`);
        console.log(`Byte at offset 104: ${data[104]} (another alternative)`);
        
        // Show first 120 bytes in hex for analysis
        console.log("\nFirst 120 bytes of account data:");
        for (let i = 0; i < Math.min(120, data.length); i += 16) {
          const chunk = data.slice(i, i + 16);
          const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const offset = i.toString().padStart(3, '0');
          console.log(`${offset}: ${hex}`);
        }
      } else {
        console.log("This is a regular SPL Token account");
        const isFrozen = accountInfo.data[108] === 1;
        console.log(`Account Frozen: ${isFrozen}`);
      }
      
      // Try to get token account balance and state
      try {
        const balance = await connection.getTokenAccountBalance(userTokenAccount);
        console.log(`\nToken Balance: ${balance.value.uiAmount}`);
        console.log(`Balance Amount: ${balance.value.amount}`);
        console.log(`Balance Decimals: ${balance.value.decimals}`);
      } catch (error) {
        console.log(`Balance Error: ${error.message}`);
      }
      
    } else {
      console.log("❌ Account not found");
    }
    
    // Let's also check the mint account
    console.log(`\n📋 CHECKING MINT: ${tokenState.tokenMint.toString()}`);
    const mintInfo = await connection.getAccountInfo(tokenState.tokenMint);
    if (mintInfo) {
      console.log(`Mint Owner: ${mintInfo.owner.toString()}`);
      console.log(`Mint Data Length: ${mintInfo.data.length}`);
      
      // Check if mint has freeze authority
      const mintData = mintInfo.data;
      console.log("First 100 bytes of mint data:");
      for (let i = 0; i < Math.min(100, mintData.length); i += 16) {
        const chunk = mintData.slice(i, i + 16);
        const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const offset = i.toString().padStart(3, '0');
        console.log(`${offset}: ${hex}`);
      }
    }
    
  } catch (error) {
    console.error("❌ Debug failed:", error.message);
  }
})().catch(console.error);
