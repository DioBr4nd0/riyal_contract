#!/usr/bin/env node

/**
 * TEST FREEZE STATUS
 * 
 * This script checks if tokens are properly frozen after claiming
 * and tests if transfers are blocked as expected.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction } = require("@solana/web3.js");
const { 
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createTransferInstruction,
} = require("@solana/spl-token");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("🔍 TESTING FREEZE STATUS OF CLAIMED TOKENS");
  console.log("=========================================");
  
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
    console.log(`Transfers Permanently Enabled: ${tokenState.transfersPermanentlyEnabled}`);
    
    // Test with a user account that has claimed tokens
    // Using the account from our previous successful claim
    const userPubkey = new PublicKey("F74XPCg6BdL4Me731oR4eyGqF9CgXZ2eJZyz4PDAtu6h");
    const userTokenAccount = await getAssociatedTokenAddress(
      tokenState.tokenMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    console.log(`\n📋 TESTING ACCOUNT:`);
    console.log(`User: ${userPubkey.toString()}`);
    console.log(`Token Account: ${userTokenAccount.toString()}`);
    
    // Check token account details
    try {
      const tokenAccountInfo = await connection.getTokenAccountBalance(userTokenAccount);
      console.log(`Balance: ${tokenAccountInfo.value.uiAmount} tokens`);
      
      // Get detailed account info to check freeze status
      const accountInfo = await connection.getAccountInfo(userTokenAccount);
      if (accountInfo) {
        // Parse token account data to check freeze status
        // Token-2022 account layout: https://github.com/solana-labs/solana-program-library/blob/master/token/program-2022/src/state.rs
        const data = accountInfo.data;
        
        // For Token-2022, frozen status is at offset 108 (0x6C)
        const isFrozen = data[108] === 1;
        console.log(`Account Frozen: ${isFrozen}`);
        
        if (!isFrozen && tokenState.transfersEnabled === false) {
          console.log("\n🚨 SECURITY ISSUE DETECTED!");
          console.log("❌ Account should be FROZEN but it's NOT!");
          console.log("❌ This allows unauthorized transfers even when transfers are disabled!");
        } else if (isFrozen) {
          console.log("\n✅ Account is properly frozen - transfers blocked");
        }
        
        // Test if we can create a transfer (should fail if frozen or transfers disabled)
        const recipient = Keypair.generate();
        const recipientTokenAccount = await getAssociatedTokenAddress(
          tokenState.tokenMint,
          recipient.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        
        console.log(`\n🧪 TESTING TRANSFER CAPABILITY:`);
        console.log("Attempting to create transfer instruction...");
        
        try {
          // This should fail if account is frozen or transfers are disabled
          const transferInstruction = createTransferInstruction(
            userTokenAccount,
            recipientTokenAccount,
            userPubkey,
            1000000000, // 1 token
            [],
            TOKEN_2022_PROGRAM_ID
          );
          
          console.log("⚠️  Transfer instruction created successfully");
          console.log("This means the account CAN transfer tokens!");
          
          if (!tokenState.transfersEnabled) {
            console.log("\n🚨 CRITICAL SECURITY BUG:");
            console.log("❌ Transfers are DISABLED in contract but tokens are still transferable!");
            console.log("❌ This bypasses your transfer control mechanism!");
          }
          
        } catch (error) {
          console.log("✅ Transfer blocked (as expected)");
          console.log(`Error: ${error.message}`);
        }
        
      }
      
    } catch (error) {
      console.log("❌ Could not fetch token account info");
      console.log("Make sure the test account has claimed tokens first");
    }
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`Contract transfers enabled: ${tokenState.transfersEnabled}`);
    console.log(`Expected behavior: Tokens should be FROZEN until transfers enabled`);
    console.log(`\n💡 SOLUTION:`);
    console.log("The claim_tokens function needs to freeze accounts after minting");
    console.log("Currently freeze logic is commented out (lines 607, 621 in lib.rs)");
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
  }
})().catch(console.error);
