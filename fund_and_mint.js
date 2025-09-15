const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');
const BN = anchor.BN;

(async () => {
  console.log("💰 FUNDING ACCOUNTS & MINTING TOKENS");
  console.log("===================================");

  // Load generated accounts
  const accountsData = JSON.parse(fs.readFileSync('./generated_accounts.json', 'utf8'));
  const deploymentData = JSON.parse(fs.readFileSync('./devnet_mint.json', 'utf8'));
  
  const programId = new PublicKey(deploymentData.program);
  const tokenMint = new PublicKey(deploymentData.mint);
  const tokenStatePDA = new PublicKey(deploymentData.tokenState);

  // Connect to devnet
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  
  // Load your admin keypair
  const adminKeypairData = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  
  const program = anchor.workspace.riyal_contract;

  console.log(`💰 Admin Balance: ${await connection.getBalance(admin.publicKey) / 1e9} SOL`);
  console.log(`🪙 Token Mint: ${tokenMint}`);

  console.log("\n⏳ STEP 1: TRANSFERRING SOL TO ACCOUNTS...");
  
  // Transfer 0.1 SOL to each account for transaction fees
  const transferAmount = 0.1 * 1e9; // 0.1 SOL in lamports
  
  for (let i = 0; i < accountsData.accounts.length; i++) {
    const account = accountsData.accounts[i];
    const recipientPubkey = new PublicKey(account.publicKey);
    
    try {
      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: recipientPubkey,
          lamports: transferAmount,
        })
      );
      
      const signature = await connection.sendTransaction(transferTx, [admin]);
      await connection.confirmTransaction(signature);
      
      const balance = await connection.getBalance(recipientPubkey);
      console.log(`✅ Account ${i + 1}: Transferred 0.1 SOL (Balance: ${balance / 1e9} SOL)`);
      
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Transfer failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 2: MINTING 50 TOKENS TO EACH ACCOUNT...");
  
  // Mint 50 tokens to each account
  const mintAmount = new BN(50 * 1e9); // 50 tokens with 9 decimals
  
  for (let i = 0; i < accountsData.accounts.length; i++) {
    const account = accountsData.accounts[i];
    const ata = new PublicKey(account.ata);
    
    try {
      const tx = await program.methods
        .mintTokens(mintAmount)
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint,
          userTokenAccount: ata,
          admin: admin.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      
      console.log(`✅ Account ${i + 1}: Minted 50 RIYAL tokens`);
      console.log(`   Transaction: ${tx}`);
      
      // Verify balance
      const balance = await connection.getTokenAccountBalance(ata);
      console.log(`   Token Balance: ${balance.value.uiAmount} RIYAL`);
      
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Minting failed - ${e.message}`);
    }
  }

  console.log("\n🎉 FUNDING & MINTING COMPLETE!");
  console.log("===============================");
  
  console.log("\n📊 FINAL ACCOUNT STATUS:");
  for (let i = 0; i < accountsData.accounts.length; i++) {
    const account = accountsData.accounts[i];
    const pubkey = new PublicKey(account.publicKey);
    const ata = new PublicKey(account.ata);
    
    try {
      const solBalance = await connection.getBalance(pubkey);
      const tokenBalance = await connection.getTokenAccountBalance(ata);
      
      console.log(`   Account ${i + 1}:`);
      console.log(`     Address: ${account.publicKey}`);
      console.log(`     SOL Balance: ${solBalance / 1e9} SOL`);
      console.log(`     RIYAL Balance: ${tokenBalance.value.uiAmount} RIYAL`);
      console.log(`     Secret Key: ${account.secretKeyBase58}`);
    } catch (e) {
      console.log(`   Account ${i + 1}: Error checking balances - ${e.message}`);
    }
  }

})().catch(console.error);
