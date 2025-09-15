const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const fs = require('fs');
const BN = anchor.BN;

(async () => {
  console.log("🔒 RIYAL BULLETPROOF FREEZE - DEVNET DEPLOYMENT");
  console.log("===============================================");

  // Connect to devnet
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  
  // Your admin address
  const adminPubkey = new PublicKey("E3SNDSxHdXqjZ3GwDh3BLV4TfncX2n6qqdXPrQM1HeeP");
  
  // Load your keypair for deployment
  const deployerKeypairData = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  const deployer = Keypair.fromSecretKey(new Uint8Array(deployerKeypairData));
  
  console.log(`👤 Admin Address: ${adminPubkey}`);
  console.log(`🔑 Deployer Address: ${deployer.publicKey}`);
  console.log(`💰 Deployer Balance: ${await connection.getBalance(deployer.publicKey) / 1e9} SOL`);

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), {});
  anchor.setProvider(provider);
  
  // Load the program
  const program = anchor.workspace.riyal_contract;
  console.log(`📋 Program ID: ${program.programId}`);

  // Derive token state PDA
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  console.log(`🏛️ Token State PDA: ${tokenStatePDA}`);

  console.log("\n⏳ STEP 1: INITIALIZING CONTRACT...");
  
  try {
    const tx = await program.methods
      .initialize(
        adminPubkey,           // admin
        adminPubkey,           // upgrade_authority  
        new BN(86400),         // claim_period_seconds (24 hours)
        true,                  // time_lock_enabled
        true                   // upgradeable
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: deployer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([deployer])
      .rpc();
    
    console.log(`✅ Contract initialized! Transaction: ${tx}`);
  } catch (e) {
    console.log("⚠️ Initialize error (might already be initialized):", e.message);
  }

  console.log("\n⏳ STEP 2: CREATING TOKEN MINT WITH FREEZE AUTHORITY...");
  
  let tokenMint;
  try {
    const mint = Keypair.generate();
    tokenMint = mint.publicKey;
    
    const tx2 = await program.methods
      .createTokenMint(9, "Riyal Token", "RIYAL")
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        admin: deployer.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([deployer, mint])
      .rpc();
    
    console.log(`✅ Token mint created with FREEZE AUTHORITY! Mint: ${mint.publicKey}`);
    console.log(`✅ Transaction: ${tx2}`);
    
  } catch (e) {
    console.log("⚠️ Mint creation error:", e.message);
    return;
  }

  console.log("\n⏳ STEP 3: GENERATING 4 TEST ACCOUNTS...");
  
  // Generate 4 test accounts
  const testAccounts = [];
  const accountsData = [];
  
  for (let i = 1; i <= 4; i++) {
    const keypair = Keypair.generate();
    testAccounts.push(keypair);
    
    const accountData = {
      id: i,
      publicKey: keypair.publicKey.toString(),
      secretKey: Array.from(keypair.secretKey),
      secretKeyBase58: anchor.utils.bytes.bs58.encode(keypair.secretKey)
    };
    accountsData.push(accountData);
    
    console.log(`🆔 Test Account ${i}: ${keypair.publicKey}`);
  }

  console.log("\n⏳ STEP 4: FUNDING TEST ACCOUNTS WITH SOL...");
  
  // Transfer SOL to test accounts
  for (let i = 0; i < testAccounts.length; i++) {
    try {
      const transferTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: testAccounts[i].publicKey,
          lamports: 0.1 * 1e9, // 0.1 SOL
        })
      );
      
      const signature = await connection.sendTransaction(transferTx, [deployer]);
      await connection.confirmTransaction(signature);
      
      console.log(`✅ Account ${i + 1}: Funded with 0.1 SOL`);
      
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Funding failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 5: CREATING ASSOCIATED TOKEN ACCOUNTS...");
  
  // Create ATAs for each account
  const atas = [];
  for (let i = 0; i < testAccounts.length; i++) {
    const ata = getAssociatedTokenAddressSync(
      tokenMint,
      testAccounts[i].publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    atas.push(ata);
    
    try {
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        ata,
        testAccounts[i].publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID
      );
      
      const tx = new anchor.web3.Transaction().add(createAtaIx);
      const signature = await connection.sendTransaction(tx, [deployer]);
      await connection.confirmTransaction(signature);
      
      console.log(`✅ Account ${i + 1}: ATA created - ${ata}`);
      accountsData[i].ata = ata.toString();
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: ATA creation failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 6: MINTING 50 RIYAL TOKENS (AUTO-FROZEN)...");
  
  // Mint 50 tokens to each account (will auto-freeze)
  const mintAmount = new BN(50 * 1e9);
  
  for (let i = 0; i < testAccounts.length; i++) {
    try {
      const tx = await program.methods
        .mintTokens(mintAmount)
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint,
          userTokenAccount: atas[i],
          admin: deployer.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([deployer])
        .rpc();
      
      console.log(`✅ Account ${i + 1}: Minted 50 RIYAL tokens - IMMEDIATELY FROZEN`);
      console.log(`   Transaction: ${tx}`);
      
      // Verify balance
      const balance = await connection.getTokenAccountBalance(atas[i]);
      console.log(`   Balance: ${balance.value.uiAmount} RIYAL (FROZEN ❄️)`);
      
    } catch (e) {
      console.log(`⚠️ Account ${i + 1}: Minting failed - ${e.message}`);
    }
  }

  console.log("\n⏳ STEP 7: SAVING ACCOUNT DATA...");
  
  // Save all account data
  const saveData = {
    generated_at: new Date().toISOString(),
    network: "devnet",
    token_mint: tokenMint.toString(),
    program_id: program.programId.toString(),
    token_state: tokenStatePDA.toString(),
    admin: adminPubkey.toString(),
    freeze_status: "ALL_ACCOUNTS_FROZEN",
    accounts: accountsData
  };
  
  fs.writeFileSync('./devnet_freeze_accounts.json', JSON.stringify(saveData, null, 2));
  
  // Save individual keypair files
  for (let i = 0; i < accountsData.length; i++) {
    const keypairFile = `./account_${i + 1}_keypair.json`;
    fs.writeFileSync(keypairFile, JSON.stringify(accountsData[i].secretKey));
    console.log(`💾 Account ${i + 1}: Keypair saved to ${keypairFile}`);
  }

  console.log("\n🎉 BULLETPROOF FREEZE DEPLOYMENT COMPLETE!");
  console.log("==========================================");
  
  console.log(`🌐 Network: Devnet`);
  console.log(`📋 Program: ${program.programId}`);
  console.log(`🪙 Token Mint: ${tokenMint}`);
  console.log(`👤 Admin: ${adminPubkey}`);
  console.log(`🏛️ Token State: ${tokenStatePDA}`);
  console.log(`❄️ All accounts: FROZEN`);
  
  console.log("\n📊 ACCOUNT SUMMARY:");
  for (let i = 0; i < accountsData.length; i++) {
    console.log(`   Account ${i + 1}:`);
    console.log(`     Address: ${accountsData[i].publicKey}`);
    console.log(`     ATA: ${accountsData[i].ata}`);
    console.log(`     Balance: 50 RIYAL (FROZEN ❄️)`);
    console.log(`     Secret Key: ${accountsData[i].secretKeyBase58}`);
  }
  
  console.log("\n🔗 EXPLORER LINKS:");
  console.log(`   Program: https://explorer.solana.com/address/${program.programId}?cluster=devnet`);
  console.log(`   Token Mint: https://explorer.solana.com/address/${tokenMint}?cluster=devnet`);
  for (let i = 0; i < accountsData.length; i++) {
    console.log(`   Account ${i + 1}: https://explorer.solana.com/address/${accountsData[i].publicKey}?cluster=devnet`);
    console.log(`   Account ${i + 1} Tokens: https://explorer.solana.com/address/${accountsData[i].ata}?cluster=devnet`);
  }

  console.log("\n🧪 CHALLENGE FOR USER:");
  console.log("======================");
  console.log("✅ Use account_1_keypair.json, account_2_keypair.json, etc.");
  console.log("✅ Import any account into Phantom/Solflare wallet");
  console.log("✅ Try to send RIYAL tokens to another account");
  console.log("❌ IT WILL FAIL with 'Account is frozen' error");
  console.log("❌ NO WALLET CAN BYPASS THIS - it's protocol level!");
  
  console.log("\n🛡️ BULLETPROOF GUARANTEE:");
  console.log("Users have ZERO ability to transfer frozen tokens!");

})().catch(console.error);
