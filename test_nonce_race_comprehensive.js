// test_nonce_race_comprehensive.js
// Comprehensive test for nonce race conditions in concurrent transactions
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program, ComputeBudgetProgram,
  sendAndConfirmTransaction
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");

const BN = anchor.BN;

// ========== Configuration ==========
const VERBOSE_LOGGING = true;
const CLAIM_AMOUNT = 1000000000; // 1 token with 9 decimals
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// ========== Helpers ==========
const u64le = (x) => { 
  const b = new ArrayBuffer(8); 
  new DataView(b).setBigUint64(0, BigInt(x), true); 
  return Buffer.from(b); 
};

const i64le = (x) => { 
  const b = new ArrayBuffer(8); 
  new DataView(b).setBigInt64(0, BigInt(x), true);  
  return Buffer.from(b); 
};

function log(message, data = null) {
  if (VERBOSE_LOGGING) {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (data) {
      console.log(`  Data:`, data);
    }
  }
}

function buildClaimMessage(programId, tokenStatePDA, mint, user, dest, amount, nonce, validUntil) {
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V1"),
    programId.toBuffer(),
    tokenStatePDA.toBuffer(),
    mint.toBuffer(),
    user.toBuffer(),
    dest.toBuffer(),
    u64le(amount),
    u64le(nonce),
    i64le(validUntil),
  ]);
}

async function sendTransactionWithRetry(connection, transaction, signers, label, maxRetries = RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      transaction.feePayer = signers[0].publicKey;
      const blockhash = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash.blockhash;
      transaction.sign(...signers);
      
      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        { 
          skipPreflight: false,
          maxRetries: 0  // We handle retries manually
        }
      );
      
      log(`${label} - Transaction sent: ${signature}`);
      
      const confirmation = await connection.confirmTransaction(
        { signature, ...blockhash },
        "confirmed"
      );
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      log(`${label} - Transaction confirmed: ${signature}`);
      return { success: true, signature, error: null };
    } catch (error) {
      log(`${label} - Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        return { success: false, signature: null, error: error.message };
      }
      
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function sendTransactionNoWait(connection, transaction, signers, label) {
  try {
    transaction.feePayer = signers[0].publicKey;
    const blockhash = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.sign(...signers);
    
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { 
        skipPreflight: true,  // Skip preflight for race condition testing
        maxRetries: 0
      }
    );
    
    log(`${label} - Transaction sent (no-wait): ${signature}`);
    return { signature, blockhash };
  } catch (error) {
    log(`${label} - Failed to send:`, error.message);
    return { signature: null, blockhash: null, error: error.message };
  }
}

async function waitForTransaction(connection, signature, blockhash, label) {
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, ...blockhash },
      "confirmed"
    );
    
    if (confirmation.value.err) {
      log(`${label} - Transaction failed:`, confirmation.value.err);
      return { success: false, error: confirmation.value.err };
    }
    
    log(`${label} - Transaction confirmed: ${signature}`);
    return { success: true, error: null };
  } catch (error) {
    log(`${label} - Confirmation error:`, error.message);
    return { success: false, error: error.message };
  }
}

function createClaimTransaction(
  program,
  tokenStatePDA,
  userDataPDA,
  mint,
  userATA,
  user,
  admin,
  amount,
  nonce,
  validUntil,
  userKeypair,
  adminKeypair
) {
  // Build the message for signing
  const message = buildClaimMessage(
    program.programId,
    tokenStatePDA,
    mint,
    user.publicKey,
    userATA,
    amount,
    nonce,
    validUntil
  );
  
  // Sign the message
  const userSig = nacl.sign.detached(message, userKeypair.secretKey);
  const adminSig = nacl.sign.detached(message, adminKeypair.secretKey);
  
  // Create Ed25519 verification instructions
  const userEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: user.publicKey.toBytes(),
    signature: userSig,
    message: message,
  });
  
  const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(),
    signature: adminSig,
    message: message,
  });
  
  // Create the claim instruction
  const claimIx = program.instruction.claimTokens(
    new BN(amount),
    new BN(nonce),
    new BN(validUntil),
    Array.from(userSig),
    Array.from(adminSig),
    {
      accounts: {
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: mint,
        userTokenAccount: userATA,
        user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
    }
  );
  
  // Build transaction with compute budget
  const transaction = new Transaction();
  
  // Add compute budget instructions for better performance
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 })
  );
  
  // Add Ed25519 verification instructions BEFORE the claim instruction
  transaction.add(userEd25519Ix);
  transaction.add(adminEd25519Ix);
  
  // Add the claim instruction
  transaction.add(claimIx);
  
  return transaction;
}

// ========== Main Test Function ==========
async function runNonceRaceTest() {
  console.log("=" .repeat(60));
  console.log("🏁 NONCE RACE CONDITION TEST");
  console.log("=" .repeat(60));
  
  try {
    // Setup connection and wallets
    log("Setting up connection and wallets...");
    const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
    
    const admin = Keypair.generate();
    const user = Keypair.generate();
    const payer = Keypair.generate();
    
    // Airdrop SOL
    log("Requesting airdrops...");
    for (const wallet of [admin, user, payer]) {
      const airdropSig = await connection.requestAirdrop(
        wallet.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);
    }
    
    // Setup provider and program
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer),
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    const program = anchor.workspace.riyal_contract;
    
    // Derive PDAs
    const [tokenStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      program.programId
    );
    
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), user.publicKey.toBuffer()],
      program.programId
    );
    
    // Create mint keypair
    const mint = Keypair.generate();
    
    // ========== Initialize Contract ==========
    log("Initializing contract...");
    await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey,
        new BN(30), // 30 seconds claim period for testing
        false, // time-lock disabled for easier testing
        true
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();
    
    // ========== Create Token Mint ==========
    log("Creating token mint...");
    await program.methods
      .createTokenMint(9, "TestToken", "TEST")
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mint])
      .rpc();
    
    // ========== Create User Token Account ==========
    log("Creating user token account...");
    const userATA = await getAssociatedTokenAddress(
      mint.publicKey,
      user.publicKey
    );
    
    const createATATx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userATA,
        user.publicKey,
        mint.publicKey
      )
    );
    
    await sendTransactionWithRetry(
      connection,
      createATATx,
      [payer],
      "Create User ATA"
    );
    
    // ========== Initialize User Data ==========
    log("Initializing user data...");
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    
    // Get initial user data
    const initialUserData = await program.account.userData.fetch(userDataPDA);
    log("Initial user data:", {
      nonce: initialUserData.nonce.toString(),
      totalClaims: initialUserData.totalClaims.toString()
    });
    
    // ========== TEST 1: Sequential Claims (Baseline) ==========
    console.log("\n" + "=".repeat(60));
    console.log("📝 TEST 1: Sequential Claims (Baseline)");
    console.log("=".repeat(60));
    
    const currentNonce = initialUserData.nonce.toNumber();
    const validUntil = Math.floor(Date.now() / 1000) + 3600; // Valid for 1 hour
    
    // First sequential claim
    log("Sending first sequential claim...");
    const tx1 = createClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      CLAIM_AMOUNT,
      currentNonce,
      validUntil,
      user,
      admin
    );
    
    const result1 = await sendTransactionWithRetry(
      connection,
      tx1,
      [payer],
      "Sequential Claim 1"
    );
    
    if (result1.success) {
      console.log("✅ First sequential claim succeeded");
      
      // Fetch updated user data
      const userData1 = await program.account.userData.fetch(userDataPDA);
      log("Updated user data after first claim:", {
        nonce: userData1.nonce.toString(),
        totalClaims: userData1.totalClaims.toString()
      });
      
      // Wait a bit before second claim
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Second sequential claim with incremented nonce
      log("Sending second sequential claim with incremented nonce...");
      const tx2 = createClaimTransaction(
        program,
        tokenStatePDA,
        userDataPDA,
        mint.publicKey,
        userATA,
        user,
        admin,
        CLAIM_AMOUNT,
        currentNonce + 1,
        validUntil,
        user,
        admin
      );
      
      const result2 = await sendTransactionWithRetry(
        connection,
        tx2,
        [payer],
        "Sequential Claim 2"
      );
      
      if (result2.success) {
        console.log("✅ Second sequential claim succeeded");
      } else {
        console.log("❌ Second sequential claim failed:", result2.error);
      }
    } else {
      console.log("❌ First sequential claim failed:", result1.error);
    }
    
    // ========== TEST 2: Parallel Claims with Same Nonce (Race Condition) ==========
    console.log("\n" + "=".repeat(60));
    console.log("🏁 TEST 2: Parallel Claims with Same Nonce (Race Condition)");
    console.log("=".repeat(60));
    
    // Get current nonce
    const currentUserData = await program.account.userData.fetch(userDataPDA);
    const raceNonce = currentUserData.nonce.toNumber();
    log("Current nonce for race test:", raceNonce);
    
    // Create two identical transactions with the same nonce
    log("Creating two identical transactions with same nonce...");
    const raceTx1 = createClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      CLAIM_AMOUNT,
      raceNonce,
      validUntil,
      user,
      admin
    );
    
    const raceTx2 = createClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      CLAIM_AMOUNT,
      raceNonce,
      validUntil,
      user,
      admin
    );
    
    // Send both transactions in parallel without waiting
    log("Sending both transactions in parallel...");
    const [send1, send2] = await Promise.all([
      sendTransactionNoWait(connection, raceTx1, [payer], "Race TX 1"),
      sendTransactionNoWait(connection, raceTx2, [payer], "Race TX 2")
    ]);
    
    // Wait for both to be confirmed
    log("Waiting for transaction confirmations...");
    const [confirm1, confirm2] = await Promise.all([
      send1.signature ? waitForTransaction(connection, send1.signature, send1.blockhash, "Race TX 1") : Promise.resolve({ success: false, error: send1.error }),
      send2.signature ? waitForTransaction(connection, send2.signature, send2.blockhash, "Race TX 2") : Promise.resolve({ success: false, error: send2.error })
    ]);
    
    // Analyze results
    console.log("\n" + "-".repeat(40));
    console.log("RACE CONDITION RESULTS:");
    console.log("-".repeat(40));
    
    if (confirm1.success && !confirm2.success) {
      console.log("✅ EXPECTED BEHAVIOR: Transaction 1 succeeded, Transaction 2 failed");
      console.log("  TX1: SUCCESS");
      console.log("  TX2: FAILED -", confirm2.error);
    } else if (!confirm1.success && confirm2.success) {
      console.log("✅ EXPECTED BEHAVIOR: Transaction 1 failed, Transaction 2 succeeded");
      console.log("  TX1: FAILED -", confirm1.error);
      console.log("  TX2: SUCCESS");
    } else if (!confirm1.success && !confirm2.success) {
      console.log("❌ UNEXPECTED: Both transactions failed");
      console.log("  TX1: FAILED -", confirm1.error);
      console.log("  TX2: FAILED -", confirm2.error);
      
      // Additional debugging
      console.log("\n📊 Debugging Information:");
      const finalUserData = await program.account.userData.fetch(userDataPDA);
      console.log("  Final nonce:", finalUserData.nonce.toString());
      console.log("  Total claims:", finalUserData.totalClaims.toString());
      
      // Try to parse error messages
      if (confirm1.error && typeof confirm1.error === 'object') {
        console.log("  TX1 Error Details:", JSON.stringify(confirm1.error, null, 2));
      }
      if (confirm2.error && typeof confirm2.error === 'object') {
        console.log("  TX2 Error Details:", JSON.stringify(confirm2.error, null, 2));
      }
    } else {
      console.log("⚠️  CRITICAL ISSUE: Both transactions succeeded with same nonce!");
      console.log("  This should never happen - indicates a serious vulnerability");
    }
    
    // ========== TEST 3: Rapid Sequential Claims ==========
    console.log("\n" + "=".repeat(60));
    console.log("⚡ TEST 3: Rapid Sequential Claims");
    console.log("=".repeat(60));
    
    const rapidUserData = await program.account.userData.fetch(userDataPDA);
    let rapidNonce = rapidUserData.nonce.toNumber();
    
    log("Starting rapid sequential claims...");
    const rapidResults = [];
    
    for (let i = 0; i < 3; i++) {
      // Small delay to ensure we don't hit rate limits
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      
      const rapidTx = createClaimTransaction(
        program,
        tokenStatePDA,
        userDataPDA,
        mint.publicKey,
        userATA,
        user,
        admin,
        CLAIM_AMOUNT,
        rapidNonce,
        validUntil,
        user,
        admin
      );
      
      const result = await sendTransactionWithRetry(
        connection,
        rapidTx,
        [payer],
        `Rapid Claim ${i + 1}`,
        1 // Only one retry for rapid testing
      );
      
      rapidResults.push(result);
      
      if (result.success) {
        rapidNonce++; // Increment for next claim
        log(`Rapid claim ${i + 1} succeeded, incrementing nonce to ${rapidNonce}`);
      } else {
        log(`Rapid claim ${i + 1} failed:`, result.error);
        break; // Stop on first failure
      }
    }
    
    console.log("\nRapid Claims Summary:");
    rapidResults.forEach((result, index) => {
      console.log(`  Claim ${index + 1}: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
    });
    
    // ========== Final Summary ==========
    console.log("\n" + "=".repeat(60));
    console.log("📊 FINAL TEST SUMMARY");
    console.log("=".repeat(60));
    
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const tokenAccount = await connection.getTokenAccountBalance(userATA);
    
    console.log("Final State:");
    console.log(`  User Nonce: ${finalUserData.nonce}`);
    console.log(`  Total Claims: ${finalUserData.totalClaims}`);
    console.log(`  Token Balance: ${tokenAccount.value.uiAmount} TEST`);
    console.log(`  Last Claim Timestamp: ${new Date(finalUserData.lastClaimTimestamp.toNumber() * 1000).toISOString()}`);
    
    console.log("\n✅ Nonce race condition test completed!");
    
  } catch (error) {
    console.error("\n❌ Test failed with error:");
    console.error(error);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach(log => console.error("  ", log));
    }
    process.exit(1);
  }
}

// ========== Run the test ==========
if (require.main === module) {
  runNonceRaceTest()
    .then(() => {
      console.log("\n👍 All tests completed");
      process.exit(0);
    })
    .catch(error => {
      console.error("\n💥 Unexpected error:", error);
      process.exit(1);
    });
}

module.exports = { runNonceRaceTest };
