/**
 * COMPREHENSIVE CLAIM SIGNER TEST SUITE
 * Tests the new claim_signer role and rotation functionality
 */

const anchor = require("@coral-xyz/anchor");
const { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  Ed25519Program
} = require("@solana/web3.js");
const { 
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount
} = require("@solana/spl-token");
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const fs = require('fs');

// Configuration
const CLUSTER = "devnet";
const PROGRAM_ID = new PublicKey("3SkrCb3S7ocBxLZFrSYpNqTcNvdkvFpocXtpf3dZZyCo");
const MINT = new PublicKey("4Z9rj8XZzHhZcrHBF8dnXUQM2pirFE8U8nQ8u9g4w9qb");

// Helper to load wallet
function loadWallet() {
  const walletPath = process.env.HOME + "/.config/solana/id.json";
  const keypairData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

// Generate test users
function generateTestUser(name) {
  const keypair = Keypair.generate();
  console.log(`📝 ${name} Generated:`);
  console.log(`   Public Key: ${keypair.publicKey.toString()}`);
  console.log(`   Private Key (Base58): ${bs58.encode(keypair.secretKey)}`);
  return keypair;
}

// Helper to build and sign claim transaction
async function buildClaimTransaction(
  program,
  claimer,
  signerKeypair,
  claimAmount,
  nonce
) {
  const [tokenState] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  const userAta = await getAssociatedTokenAddress(
    MINT,
    claimer.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), claimer.publicKey.toBuffer()],
    program.programId
  );

  // Create claim payload (for contract call - uses anchor.BN and camelCase!)
  const expiryTime = Math.floor(Date.now() / 1000) + 3600;
  const payload = {
    userAddress: claimer.publicKey,  // camelCase for Anchor!
    claimAmount: new anchor.BN(claimAmount),
    expiryTime: new anchor.BN(expiryTime),
    nonce: new anchor.BN(nonce),
  };

  // Serialize claim payload for signing (convert to regular numbers)
  const buffer = Buffer.alloc(32 + 8 + 8 + 8);
  let offset = 0;
  
  payload.userAddress.toBuffer().copy(buffer, offset);
  offset += 32;
  
  buffer.writeBigUInt64LE(BigInt(claimAmount), offset);
  offset += 8;
  
  buffer.writeBigInt64LE(BigInt(expiryTime), offset);
  offset += 8;
  
  buffer.writeBigUInt64LE(BigInt(nonce), offset);
  
  // Build message for signing
  const message = Buffer.concat([
    Buffer.from("MERCLE_CLAIM_V1"),
    program.programId.toBuffer(),
    buffer
  ]);

  // Sign with the provided signer keypair using nacl
  const nacl = require("tweetnacl");
  const signatureBytes = nacl.sign.detached(message, signerKeypair.secretKey);

  // Build Ed25519 instruction
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: signerKeypair.publicKey.toBytes(),
    message: message,
    signature: signatureBytes,
  });

  // Build claim instruction
  const tx = await program.methods
    .claimTokens(payload, Array.from(signatureBytes))
    .accounts({
      user: claimer.publicKey,
      tokenState: tokenState,
      userData: userDataPDA,
      mint: MINT,
      userTokenAccount: userAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .transaction();

  // Combine instructions
  const fullTx = new Transaction();
  fullTx.add(ed25519Ix);
  fullTx.add(tx.instructions[0]);

  return { transaction: fullTx, payload, signatureBytes };
}

// Helper to fund account with SOL
async function fundAccount(connection, from, to, solAmount) {
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to.publicKey,
        lamports: Math.floor(solAmount * anchor.web3.LAMPORTS_PER_SOL),
      })
    );
    const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [from]);
    console.log(`💸 Funded ${to.publicKey.toString()} with ${solAmount} SOL`);
    return sig;
  } catch (error) {
    console.log(`⚠️  Failed to fund ${to.publicKey.toString()}: ${error.message}`);
    throw error;
  }
}

// Helper to create ATA if needed
async function ensureAta(connection, payer, mint, owner) {
  const ata = await getAssociatedTokenAddress(mint, owner.publicKey, false, TOKEN_PROGRAM_ID);
  
  try {
    await getAccount(connection, ata);
    console.log(`✅ ATA already exists for ${owner.publicKey.toString()}`);
  } catch (e) {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner.publicKey,
      mint,
      TOKEN_PROGRAM_ID
    );
    const tx = new Transaction().add(ix);
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`✅ Created ATA for ${owner.publicKey.toString()}`);
  }
  
  return ata;
}

// Helper to initialize user data if needed
async function ensureUserData(program, user) {
  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user.publicKey.toBuffer()],
    program.programId
  );
  
  try {
    const userData = await program.account.userData.fetch(userDataPDA);
    console.log(`✅ User data exists, current nonce: ${userData.nonce.toString()}`);
    return userData;
  } catch (e) {
    console.log(`🏗️  Initializing user data for ${user.publicKey.toString()}...`);
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    
    const userData = await program.account.userData.fetch(userDataPDA);
    console.log(`✅ User data initialized, nonce: ${userData.nonce.toString()}`);
    return userData;
  }
}

// Helper to get current nonce for a user
async function getCurrentNonce(program, user) {
  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user.publicKey.toBuffer()],
    program.programId
  );
  const userData = await program.account.userData.fetch(userDataPDA);
  return userData.nonce;
}

// Helper to get current claim_signer
async function getCurrentClaimSigner(program) {
  const [tokenState] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );
  const state = await program.account.tokenState.fetch(tokenState);
  return state.claimSigner;
}

// Helper to update claim signer
async function updateClaimSigner(program, admin, newSignerPubkey) {
  const [tokenState] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  const tx = await program.methods
    .updateClaimSigner(newSignerPubkey)
    .accounts({
      tokenState: tokenState,
      admin: admin.publicKey,
    })
    .signers([admin])
    .rpc();

  console.log(`✅ Updated claim signer to: ${newSignerPubkey.toString()}`);
  console.log(`   Tx: ${tx}`);
  return tx;
}

// MAIN TEST SUITE
async function runTests() {
  console.log("\n" + "=".repeat(80));
  console.log("🧪 COMPREHENSIVE CLAIM SIGNER TEST SUITE");
  console.log("=".repeat(80) + "\n");

  // Setup
  const connection = new anchor.web3.Connection(
    anchor.web3.clusterApiUrl(CLUSTER),
    "confirmed"
  );
  
  const wallet = new anchor.Wallet(loadWallet());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.MercleToken;

  console.log(`📡 Connected to ${CLUSTER}`);
  console.log(`💼 Admin Wallet: ${wallet.publicKey.toString()}`);
  console.log(`🏦 Program ID: ${PROGRAM_ID.toString()}`);
  console.log(`🪙 Token Mint: ${MINT.toString()}\n`);

  // Test counters
  let passed = 0;
  let failed = 0;

  // ========================================================================
  // TEST 1: Generate first signer, update contract, and test claims
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 1: Generate First Signer & Test Claims");
  console.log("─".repeat(80));
  
  const signer1 = generateTestUser("Signer 1");
  const claimer1 = generateTestUser("Claimer 1");
  
  try {
    // FIRST: Update the contract to use Signer 1
    console.log(`🔄 Updating contract claim_signer to Signer 1...`);
    await updateClaimSigner(program, wallet.payer, signer1.publicKey);
    
    // Fund claimer (reduced to save SOL)
    await fundAccount(connection, wallet.payer, claimer1, 0.1);
    
    // Create ATA
    await ensureAta(connection, wallet.payer, MINT, claimer1);
    
    // Initialize user data
    await ensureUserData(program, claimer1);
    
    // Get current nonce
    const nonce1 = await getCurrentNonce(program, claimer1);
    console.log(`📊 Current Nonce: ${nonce1.toString()}`);
    
    // Build and send claim with signer1
    const { transaction, payload } = await buildClaimTransaction(
      program,
      claimer1,
      signer1,
      10000_000000000, // 10,000 tokens
      nonce1.toNumber()
    );
    
    transaction.feePayer = claimer1.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(claimer1);
    
    const sig = await connection.sendTransaction(transaction, [claimer1]);
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ TEST 1 PASSED: Claim with Signer 1 succeeded`);
    console.log(`   Tx: ${sig}`);
    passed++;
  } catch (error) {
    console.log(`❌ TEST 1 FAILED: ${error.message}`);
    failed++;
  }

  // Wait for timelock
  console.log(`\n⏳ Waiting 1 second before next test...`);
  await new Promise(resolve => setTimeout(resolve, 1000));

  // ========================================================================
  // TEST 2: Update to new signer
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 2: Update Claim Signer");
  console.log("─".repeat(80));
  
  const signer2 = generateTestUser("Signer 2");
  
  try {
    // Check current signer
    const currentSigner = await getCurrentClaimSigner(program);
    console.log(`📊 Current Claim Signer: ${currentSigner.toString()}`);
    
    // Update to signer2
    await updateClaimSigner(program, wallet.payer, signer2.publicKey);
    
    // Verify update
    const newSigner = await getCurrentClaimSigner(program);
    console.log(`📊 New Claim Signer: ${newSigner.toString()}`);
    
    if (newSigner.equals(signer2.publicKey)) {
      console.log(`✅ TEST 2 PASSED: Claim signer updated successfully`);
      passed++;
    } else {
      console.log(`❌ TEST 2 FAILED: Claim signer not updated correctly`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ TEST 2 FAILED: ${error.message}`);
    failed++;
  }

  // ========================================================================
  // TEST 3: Try to claim with OLD signer (should fail)
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 3: Attempt Claim with OLD Signer (Should Fail)");
  console.log("─".repeat(80));
  
  const claimer2 = generateTestUser("Claimer 2");
  
  try {
    // Fund claimer (reduced to save SOL)
    await fundAccount(connection, wallet.payer, claimer2, 0.1);
    
    // Create ATA
    await ensureAta(connection, wallet.payer, MINT, claimer2);
    
    // Initialize user data
    await ensureUserData(program, claimer2);
    
    // Get current nonce
    const nonce2 = await getCurrentNonce(program, claimer2);
    console.log(`📊 Current Nonce: ${nonce2.toString()}`);
    
    // Build and send claim with OLD signer1
    const { transaction } = await buildClaimTransaction(
      program,
      claimer2,
      signer1, // OLD SIGNER (should fail!)
      5000_000000000, // 5,000 tokens
      nonce2.toNumber()
    );
    
    transaction.feePayer = claimer2.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(claimer2);
    
    const sig = await connection.sendTransaction(transaction, [claimer2]);
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`❌ TEST 3 FAILED: Claim with old signer should have been rejected!`);
    console.log(`   Tx: ${sig}`);
    failed++;
  } catch (error) {
    if (error.message.includes("InvalidSignature") || error.message.includes("custom program error")) {
      console.log(`✅ TEST 3 PASSED: Old signer correctly rejected`);
      console.log(`   Error: ${error.message.split('\n')[0]}`);
      passed++;
    } else {
      console.log(`❌ TEST 3 FAILED: Unexpected error: ${error.message}`);
      failed++;
    }
  }

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 1000));

  // ========================================================================
  // TEST 4: Claim with NEW signer (should succeed)
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 4: Claim with NEW Signer (Should Succeed)");
  console.log("─".repeat(80));
  
  const claimer3 = generateTestUser("Claimer 3");
  
  try {
    // Fund claimer (reduced to save SOL)
    await fundAccount(connection, wallet.payer, claimer3, 0.1);
    
    // Create ATA
    await ensureAta(connection, wallet.payer, MINT, claimer3);
    
    // Initialize user data
    await ensureUserData(program, claimer3);
    
    // Get current nonce
    const nonce3 = await getCurrentNonce(program, claimer3);
    console.log(`📊 Current Nonce: ${nonce3.toString()}`);
    
    // Build and send claim with NEW signer2
    const { transaction } = await buildClaimTransaction(
      program,
      claimer3,
      signer2, // NEW SIGNER
      7500_000000000, // 7,500 tokens
      nonce3.toNumber()
    );
    
    transaction.feePayer = claimer3.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(claimer3);
    
    const sig = await connection.sendTransaction(transaction, [claimer3]);
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ TEST 4 PASSED: Claim with new signer succeeded`);
    console.log(`   Tx: ${sig}`);
    passed++;
  } catch (error) {
    console.log(`❌ TEST 4 FAILED: ${error.message}`);
    failed++;
  }

  // ========================================================================
  // TEST 5: Non-admin tries to update signer (should fail)
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 5: Non-Admin Tries to Update Signer (Should Fail)");
  console.log("─".repeat(80));
  
  const attacker = generateTestUser("Attacker");
  
  try {
    // Fund attacker (reduced to save SOL)
    await fundAccount(connection, wallet.payer, attacker, 0.05);
    
    // Try to update signer as non-admin
    const [tokenState] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      program.programId
    );
    
    const fakeSigner = Keypair.generate();
    const tx = await program.methods
      .updateClaimSigner(fakeSigner.publicKey)
      .accounts({
        tokenState: tokenState,
        admin: attacker.publicKey, // NOT THE ADMIN!
      })
      .signers([attacker])
      .rpc();
    
    console.log(`❌ TEST 5 FAILED: Non-admin was able to update signer!`);
    console.log(`   Tx: ${tx}`);
    failed++;
  } catch (error) {
    if (error.message.includes("UnauthorizedAdmin") || error.message.includes("ConstraintRaw")) {
      console.log(`✅ TEST 5 PASSED: Non-admin correctly rejected`);
      console.log(`   Error: ${error.message.split('\n')[0]}`);
      passed++;
    } else {
      console.log(`❌ TEST 5 FAILED: Unexpected error: ${error.message}`);
      failed++;
    }
  }

  // ========================================================================
  // TEST 6: Verify token balances
  // ========================================================================
  console.log("\n" + "─".repeat(80));
  console.log("TEST 6: Verify Token Balances");
  console.log("─".repeat(80));
  
  try {
    const ata1 = await getAssociatedTokenAddress(MINT, claimer1.publicKey, false, TOKEN_PROGRAM_ID);
    const ata3 = await getAssociatedTokenAddress(MINT, claimer3.publicKey, false, TOKEN_PROGRAM_ID);
    
    const account1 = await getAccount(connection, ata1);
    const account3 = await getAccount(connection, ata3);
    
    console.log(`📊 Claimer 1 Balance: ${account1.amount.toString()} (Expected: 10000000000000)`);
    console.log(`📊 Claimer 3 Balance: ${account3.amount.toString()} (Expected: 7500000000000)`);
    
    if (account1.amount.toString() === "10000000000000" && 
        account3.amount.toString() === "7500000000000") {
      console.log(`✅ TEST 6 PASSED: Balances are correct`);
      passed++;
    } else {
      console.log(`❌ TEST 6 FAILED: Balances don't match expected values`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ TEST 6 FAILED: ${error.message}`);
    failed++;
  }

  // ========================================================================
  // FINAL REPORT
  // ========================================================================
  console.log("\n" + "=".repeat(80));
  console.log("📊 FINAL TEST REPORT");
  console.log("=".repeat(80));
  console.log(`✅ Passed: ${passed}/6`);
  console.log(`❌ Failed: ${failed}/6`);
  console.log(`📈 Success Rate: ${((passed / 6) * 100).toFixed(1)}%`);
  
  if (failed === 0) {
    console.log("\n🎉 ALL TESTS PASSED! The claim_signer feature is working perfectly!");
    console.log("\n🔑 IMPORTANT - SAVE THESE KEYS:");
    console.log("\n   SIGNER 1 (OLD, NO LONGER VALID):");
    console.log(`   Public: ${signer1.publicKey.toString()}`);
    console.log(`   Private: ${bs58.encode(signer1.secretKey)}`);
    console.log("\n   SIGNER 2 (CURRENT ACTIVE SIGNER):");
    console.log(`   Public: ${signer2.publicKey.toString()}`);
    console.log(`   Private: ${bs58.encode(signer2.secretKey)}`);
    console.log("\n⚠️  YOU MUST USE SIGNER 2's PRIVATE KEY IN YOUR BACKEND!");
  } else {
    console.log("\n⚠️  Some tests failed. Review the errors above.");
  }
  
  console.log("\n" + "=".repeat(80) + "\n");
}

// Run the test suite
runTests().catch(console.error);

