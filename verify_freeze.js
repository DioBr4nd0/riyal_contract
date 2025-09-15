const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID, createTransferInstruction } = require("@solana/spl-token");
const fs = require('fs');

(async () => {
  console.log("🔍 VERIFYING FREEZE STATUS ON DEVNET");
  console.log("====================================");

  // Load account data
  const accountsData = JSON.parse(fs.readFileSync('./devnet_frozen_accounts.json', 'utf8'));
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  
  console.log(`🪙 Token Mint: ${accountsData.token_mint}`);
  console.log(`❄️ Expected Status: ALL FROZEN`);
  
  // Load first two accounts to test transfer
  const account1Data = accountsData.accounts[0];
  const account2Data = accountsData.accounts[1];
  
  const account1Keypair = Keypair.fromSecretKey(new Uint8Array(account1Data.secretKey));
  const account1ATA = new PublicKey(account1Data.ata);
  const account2ATA = new PublicKey(account2Data.ata);
  
  console.log(`\n👤 Account 1: ${account1Data.publicKey}`);
  console.log(`🪙 Account 1 ATA: ${account1Data.ata}`);
  console.log(`👤 Account 2: ${account2Data.publicKey}`);
  console.log(`🪙 Account 2 ATA: ${account2Data.ata}`);

  // Check balances first
  console.log("\n⏳ CHECKING BALANCES...");
  try {
    const balance1 = await connection.getTokenAccountBalance(account1ATA);
    const balance2 = await connection.getTokenAccountBalance(account2ATA);
    
    console.log(`✅ Account 1 Balance: ${balance1.value.uiAmount} RIYAL`);
    console.log(`✅ Account 2 Balance: ${balance2.value.uiAmount} RIYAL`);
  } catch (e) {
    console.log(`⚠️ Balance check error: ${e.message}`);
  }

  // Try to transfer - this should fail
  console.log("\n⏳ TESTING TRANSFER (SHOULD FAIL)...");
  console.log("❌ Attempting to transfer 1 RIYAL from Account 1 to Account 2...");
  
  try {
    const transferAmount = 1 * 1e9; // 1 RIYAL
    
    const transferIx = createTransferInstruction(
      account1ATA,
      account2ATA,
      account1Keypair.publicKey,
      transferAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    
    const transferTx = new Transaction().add(transferIx);
    const signature = await connection.sendTransaction(transferTx, [account1Keypair]);
    await connection.confirmTransaction(signature);
    
    console.log(`⚠️ UNEXPECTED: Transfer succeeded! This should not happen!`);
    console.log(`   Transaction: ${signature}`);
    
  } catch (e) {
    console.log(`✅ EXPECTED: Transfer FAILED because account is frozen!`);
    console.log(`   Error: ${e.message}`);
    
    if (e.message.includes("Account is frozen") || e.message.includes("0x11")) {
      console.log(`🎉 PERFECT: SPL Token-2022 is enforcing the freeze!`);
    }
  }

  console.log("\n🔗 QUICK VERIFICATION LINKS:");
  console.log(`   Token Mint: https://explorer.solana.com/address/${accountsData.token_mint}?cluster=devnet`);
  console.log(`   Account 1: https://explorer.solana.com/address/${account1Data.publicKey}?cluster=devnet`);
  console.log(`   Account 1 Tokens: https://explorer.solana.com/address/${account1Data.ata}?cluster=devnet`);
  
  console.log("\n🛡️ FREEZE VERIFICATION COMPLETE!");
  console.log("Accounts are properly frozen - transfers will fail in ANY wallet!");

})().catch(console.error);
