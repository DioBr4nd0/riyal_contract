const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const fs = require('fs');
const BN = anchor.BN;

(async () => {
  console.log("🔑 RIYAL TOKEN - ACCOUNT GENERATION & MINTING");
  console.log("============================================");

  // Load deployment details
  const deploymentData = JSON.parse(fs.readFileSync('./devnet_mint.json', 'utf8'));
  const programId = new PublicKey(deploymentData.program);
  const tokenMint = new PublicKey(deploymentData.mint);
  const tokenStatePDA = new PublicKey(deploymentData.tokenState);
  const adminPubkey = new PublicKey(deploymentData.admin);

  console.log(`📋 Program: ${programId}`);
  console.log(`🪙 Token Mint: ${tokenMint}`);
  console.log(`👤 Admin: ${adminPubkey}`);

  // Connect to devnet
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  
  // Load your admin keypair
  const adminKeypairData = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  
  // Load the program
  const program = anchor.workspace.riyal_contract;

  console.log(`💰 Admin Balance: ${await connection.getBalance(admin.publicKey) / 1e9} SOL\n`);

  // Generate 4 accounts
  const accounts = [];
  const accountsData = [];
  
  for (let i = 1; i <= 4; i++) {
    const keypair = Keypair.generate();
    accounts.push(keypair);
    
    const accountData = {
      id: i,
      publicKey: keypair.publicKey.toString(),
      secretKey: Array.from(keypair.secretKey), // Save as array for easy reconstruction
      secretKeyBase58: anchor.utils.bytes.bs58.encode(keypair.secretKey) // Alternative format
    };
    accountsData.push(accountData);
    
    console.log(`🆔 Account ${i}:`);
    console.log(`   Public Key: ${keypair.publicKey}`);
    console.log(`   Secret Key: [${keypair.secretKey.slice(0, 8).join(', ')}...] (${keypair.secretKey.length} bytes)`);
    console.log(`   Secret Key (Base58): ${accountData.secretKeyBase58}`);
  }

  console.log("\n⏳ STEP 1: AIRDROPPING SOL TO ACCOUNTS...");
  
  // Airdrop SOL to each account for transaction fees
  for (let i = 0; i < accounts.length; i++) {
    try {
      const signature = await connection.requestAirdrop(accounts[i].publicKey, 1 * 1e9); // 1 SOL
      await connection.confirmTransaction(signature);
      console.log(`✅ Account ${i + 1}: Airdropped 1 SOL`);
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Airdrop failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 2: CREATING ASSOCIATED TOKEN ACCOUNTS...");
  
  // Create ATAs for each account
  const atas = [];
  for (let i = 0; i < accounts.length; i++) {
    const ata = getAssociatedTokenAddressSync(
      tokenMint,
      accounts[i].publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    atas.push(ata);
    
    try {
      // Create ATA instruction
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey, // payer
        ata,
        accounts[i].publicKey, // owner
        tokenMint,
        TOKEN_2022_PROGRAM_ID
      );
      
      const tx = new anchor.web3.Transaction().add(createAtaIx);
      const signature = await connection.sendTransaction(tx, [admin]);
      await connection.confirmTransaction(signature);
      
      console.log(`✅ Account ${i + 1}: ATA created - ${ata}`);
      accountsData[i].ata = ata.toString();
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: ATA creation failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 3: MINTING 50 TOKENS TO EACH ACCOUNT...");
  
  // Mint 50 tokens to each account
  const mintAmount = new BN(50 * 1e9); // 50 tokens with 9 decimals
  
  for (let i = 0; i < accounts.length; i++) {
    try {
      const tx = await program.methods
        .mintTokens(mintAmount)
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint,
          toTokenAccount: atas[i],
          admin: admin.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      
      console.log(`✅ Account ${i + 1}: Minted 50 RIYAL tokens`);
      console.log(`   Transaction: ${tx}`);
      
      // Verify balance
      const balance = await connection.getTokenAccountBalance(atas[i]);
      console.log(`   Balance: ${balance.value.uiAmount} RIYAL`);
      
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Minting failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 4: SAVING ACCOUNT DATA...");
  
  // Save all account data to file
  const saveData = {
    generated_at: new Date().toISOString(),
    network: "devnet",
    token_mint: tokenMint.toString(),
    program_id: programId.toString(),
    admin: adminPubkey.toString(),
    accounts: accountsData
  };
  
  fs.writeFileSync('./generated_accounts.json', JSON.stringify(saveData, null, 2));
  
  // Also save individual keypair files for easy import
  for (let i = 0; i < accountsData.length; i++) {
    const keypairFile = `./account_${i + 1}_keypair.json`;
    fs.writeFileSync(keypairFile, JSON.stringify(accountsData[i].secretKey));
    console.log(`💾 Account ${i + 1}: Keypair saved to ${keypairFile}`);
  }

  console.log("\n🎉 ACCOUNT GENERATION COMPLETE!");
  console.log("===============================");
  console.log(`📁 All data saved to: ./generated_accounts.json`);
  console.log(`🔑 Individual keypairs saved as: ./account_X_keypair.json`);
  
  console.log("\n📊 SUMMARY:");
  for (let i = 0; i < accountsData.length; i++) {
    console.log(`   Account ${i + 1}:`);
    console.log(`     Address: ${accountsData[i].publicKey}`);
    console.log(`     ATA: ${accountsData[i].ata || 'Failed to create'}`);
    console.log(`     Secret Key: ${accountsData[i].secretKeyBase58}`);
  }
  
  console.log("\n🔧 HOW TO USE THESE ACCOUNTS:");
  console.log("   1. Load keypair from JSON: Keypair.fromSecretKey(new Uint8Array(secretKeyArray))");
  console.log("   2. Load from Base58: Keypair.fromSecretKey(bs58.decode(secretKeyBase58))");
  console.log("   3. Import keypair file: solana config set --keypair ./account_X_keypair.json");
  
  console.log("\n🌐 EXPLORER LINKS:");
  for (let i = 0; i < accountsData.length; i++) {
    console.log(`   Account ${i + 1}: https://explorer.solana.com/address/${accountsData[i].publicKey}?cluster=devnet`);
  }

})().catch(console.error);
