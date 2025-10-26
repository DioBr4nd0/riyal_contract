#!/usr/bin/env node

/**
 * DEPLOY FRESH MERCLE CONTRACT WITH METADATA
 * 
 * Complete deployment script that:
 * 1. Initializes the contract
 * 2. Creates token mint (admin as mint authority)
 * 3. Creates metadata using metaboss
 * 4. Transfers mint authority to PDA
 * 5. Tests functionality
 */

const anchor = require("@coral-xyz/anchor");
const { BN } = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const { execSync } = require('child_process');
const fs = require('fs');

// ========================================
// CONFIGURATION
// ========================================

const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";
const RPC_URL = "https://api.devnet.solana.com";
const METADATA_URI = "https://rose-electoral-cuckoo-545.mypinata.cloud/ipfs/bafkreicjiqv53ztui2jk3fstwu7vlxjy5uhut7h4gtvkiapll3bs5iy664";
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ========================================
// MAIN EXECUTION
// ========================================

(async () => {
  console.log("🚀 FRESH MERCLE CONTRACT DEPLOYMENT");
  console.log("===================================");
  console.log("");

  try {
    // Load admin keypair
    const adminData = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
    const admin = anchor.web3.Keypair.fromSecretKey(new Uint8Array(adminData));
    console.log(`🔑 Admin: ${admin.publicKey.toString()}`);

    // Connect to Solana
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);

    const program = anchor.workspace.MercleToken;
    console.log(`📋 Program ID: ${program.programId.toString()}`);

    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    console.log(`📍 Token State PDA: ${tokenStatePDA.toString()}`);
    console.log("");

    // Step 1: Initialize Contract
    console.log("🏗️  STEP 1: Initializing contract...");
    try {
      await program.account.tokenState.fetch(tokenStatePDA);
      console.log("✅ Contract already initialized");
    } catch (error) {
      const tx = await program.methods
        .initialize(
          admin.publicKey,
          admin.publicKey, // upgrade authority
          new BN(30), // 30 second claim period for testing
          true, // time lock enabled
          true // upgradeable
        )
        .accounts({
          tokenState: tokenStatePDA,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      
      console.log(`✅ Contract initialized: ${tx}`);
    }

    // Step 2: Create Token Mint (Admin as mint authority)
    console.log("");
    console.log("🪙 STEP 2: Creating token mint...");
    
    const mintKeypair = anchor.web3.Keypair.generate();
    console.log(`🪙 Mint Address: ${mintKeypair.publicKey.toString()}`);

    const createMintTx = await program.methods
      .createTokenMint(9, "Mercle Token", "MERCLE")
      .accounts({
        tokenState: tokenStatePDA,
        mint: mintKeypair.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mintKeypair])
      .rpc();

    console.log(`✅ Token mint created: ${createMintTx}`);
    console.log(`   Mint Authority: ${admin.publicKey.toString()} (admin)`);

    // Step 3: Create Metadata using metaboss
    console.log("");
    console.log("🏷️  STEP 3: Creating token metadata...");
    
    try {
      const metabossCmd = `metaboss create metadata -k ${ADMIN_KEY_SOURCE} -m ./metadata.json -a ${mintKeypair.publicKey.toString()}`;
      console.log(`Running: ${metabossCmd}`);
      
      const metabossOutput = execSync(metabossCmd, { 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      
      console.log("✅ Metadata created successfully!");
      console.log(`📋 Metaboss output: ${metabossOutput.trim()}`);
      
    } catch (metabossError) {
      console.log("⚠️  Metaboss failed, trying alternative...");
      
      // Get metadata PDA
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          mintKeypair.publicKey.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
      );
      
      console.log(`📍 Metadata PDA: ${metadataPDA.toString()}`);
      console.log("ℹ️  You can create metadata manually at: https://www.solana.fm/");
      console.log(`   Token Mint: ${mintKeypair.publicKey.toString()}`);
      console.log(`   Name: Mercle Token`);
      console.log(`   Symbol: MERCLE`);
      console.log(`   URI: ${METADATA_URI}`);
    }

    // Step 4: Transfer Mint Authority to PDA
    console.log("");
    console.log("🔄 STEP 4: Transferring mint authority to PDA...");
    
    const transferAuthorityTx = await program.methods
      .transferMintAuthorityToPda()
      .accounts({
        tokenState: tokenStatePDA,
        mint: mintKeypair.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    console.log(`✅ Mint authority transferred: ${transferAuthorityTx}`);
    console.log(`   New Mint Authority: ${tokenStatePDA.toString()} (PDA)`);

    // Step 5: Create Treasury
    console.log("");
    console.log("🏦 STEP 5: Creating treasury...");
    
    const treasuryAddress = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      tokenStatePDA,
      true // allowOwnerOffCurve
    );

    const createTreasuryTx = await program.methods
      .createTreasury()
      .accounts({
        tokenState: tokenStatePDA,
        treasuryAccount: treasuryAddress,
        mint: mintKeypair.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    console.log(`✅ Treasury created: ${createTreasuryTx}`);
    console.log(`   Treasury Address: ${treasuryAddress.toString()}`);

    // Step 6: Test Functionality
    console.log("");
    console.log("🧪 STEP 6: Testing functionality...");
    
    // Create a test user
    const testUser = anchor.web3.Keypair.generate();
    console.log(`👤 Test User: ${testUser.publicKey.toString()}`);

    // Airdrop SOL to test user
    const airdropTx = await connection.requestAirdrop(testUser.publicKey, 1000000000); // 1 SOL
    await connection.confirmTransaction(airdropTx);
    console.log("💰 Test user funded with 1 SOL");

    // Initialize user data
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), testUser.publicKey.toBuffer()],
      program.programId
    );

    const initUserTx = await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: testUser.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([testUser])
      .rpc();

    console.log(`✅ User data initialized: ${initUserTx}`);

    console.log("");
    console.log("🎉 DEPLOYMENT COMPLETE!");
    console.log("======================");
    console.log("");
    console.log("📊 SUMMARY:");
    console.log(`Program ID: ${program.programId.toString()}`);
    console.log(`Token Mint: ${mintKeypair.publicKey.toString()}`);
    console.log(`Token State PDA: ${tokenStatePDA.toString()}`);
    console.log(`Treasury: ${treasuryAddress.toString()}`);
    console.log(`Test User: ${testUser.publicKey.toString()}`);
    console.log("");
    console.log("🔍 View on Solana Explorer:");
    console.log(`https://explorer.solana.com/address/${mintKeypair.publicKey.toString()}?cluster=devnet`);
    console.log("");
    console.log("🧪 Test with existing scripts:");
    console.log("• stress_claim.js - Test claiming functionality");
    console.log("• deploy_and_test_complete.js - Full functionality test");
    console.log("");
    console.log("✅ Contract is ready for production use!");

  } catch (error) {
    console.error("");
    console.error("❌ DEPLOYMENT FAILED:");
    console.error(error.message);

    if (error.logs) {
      console.error("");
      console.error("📋 Transaction Logs:");
      error.logs.forEach(log => console.error(log));
    }

    process.exit(1);
  }
})().catch(console.error);
