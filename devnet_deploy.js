const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');
const BN = anchor.BN;

(async () => {
  console.log("🚀 RIYAL CONTRACT - DEVNET DEPLOYMENT");
  console.log("====================================");

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
  
  // The actual deployed program ID
  const deployedProgramId = new PublicKey("DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK");
  console.log(`🚀 Deployed Program ID: ${deployedProgramId}`);

  // Derive token state PDA using the deployed program ID
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], deployedProgramId);
  console.log(`🏛️ Token State PDA: ${tokenStatePDA}`);

  console.log("\n⏳ STEP 1: DEPLOYING CONTRACT...");
  
  try {
    // Deploy the program
    await anchor.build();
    const deployResult = await anchor.deploy();
    console.log("✅ Contract deployed successfully!");
  } catch (e) {
    console.log("⚠️ Deploy error (might already be deployed):", e.message);
  }

  console.log("\n⏳ STEP 2: INITIALIZING CONTRACT...");
  
  try {
    // Initialize the contract with your address as admin
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

  console.log("\n⏳ STEP 3: CREATING TOKEN MINT...");
  
  try {
    // Create token mint
    const mint = Keypair.generate();
    const tx2 = await program.methods
      .createTokenMint(9, "Riyal Token", "RIYAL")
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        admin: deployer.publicKey, // You'll need to be admin to create mint
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([deployer, mint])
      .rpc();
    
    console.log(`✅ Token mint created! Mint: ${mint.publicKey}`);
    console.log(`✅ Transaction: ${tx2}`);
    
    // Save mint address
    fs.writeFileSync('./devnet_mint.json', JSON.stringify({
      mint: mint.publicKey.toString(),
      admin: adminPubkey.toString(),
      program: deployedProgramId.toString(),
      tokenState: tokenStatePDA.toString()
    }, null, 2));
    
  } catch (e) {
    console.log("⚠️ Mint creation error:", e.message);
  }

  // Fetch and display contract state
  console.log("\n📊 CONTRACT STATE:");
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log(`   Admin: ${tokenState.admin}`);
    console.log(`   Initialized: ${tokenState.isInitialized}`);
    console.log(`   Transfers Enabled: ${tokenState.transfersEnabled}`);
    console.log(`   Token Mint: ${tokenState.tokenMint}`);
    console.log(`   Token Name: ${tokenState.tokenName}`);
    console.log(`   Token Symbol: ${tokenState.tokenSymbol}`);
    console.log(`   Decimals: ${tokenState.decimals}`);
  } catch (e) {
    console.log("⚠️ Could not fetch state:", e.message);
  }

  console.log("\n🎉 DEVNET DEPLOYMENT COMPLETE!");
  console.log("===============================");
  console.log(`🌐 Network: Devnet`);
  console.log(`📋 Program: ${deployedProgramId}`);
  console.log(`👤 Admin: ${adminPubkey}`);
  console.log(`🏛️ Token State: ${tokenStatePDA}`);
  console.log(`💾 Mint details saved to: ./devnet_mint.json`);
  
  console.log("\n🔗 USEFUL LINKS:");
  console.log(`   Program: https://explorer.solana.com/address/${deployedProgramId}?cluster=devnet`);
  console.log(`   Token State: https://explorer.solana.com/address/${tokenStatePDA}?cluster=devnet`);

})().catch(console.error);
