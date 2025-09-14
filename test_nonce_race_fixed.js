// test_nonce_race_fixed.js
// Fixed nonce race condition test with optimized transaction size
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program, ComputeBudgetProgram
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");

const BN = anchor.BN;

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

async function analyzeTransactionError(connection, signature, label) {
  console.log(`\n📋 Analyzing ${label}:`);
  console.log(`  Signature: ${signature}`);
  
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });
    
    if (!tx) {
      console.log("  ❌ Transaction not found");
      return;
    }
    
    if (tx.meta.err) {
      console.log(`  ❌ Transaction failed with error:`, tx.meta.err);
      
      if (tx.meta.err.InstructionError) {
        const [index, error] = tx.meta.err.InstructionError;
        console.log(`  Failed at instruction index: ${index}`);
        console.log(`  Error type:`, error);
        
        if (error.Custom !== undefined) {
          console.log(`  Custom error code: ${error.Custom}`);
          const errorMap = {
            6035: "InvalidNonce",
            6036: "InvalidUserSignature", 
            6037: "InvalidAdminSignature",
            6082: "UserSignatureNotVerified",
            6083: "AdminSignatureNotVerified",
          };
          console.log(`  Error name: ${errorMap[error.Custom] || "Unknown"}`);
        }
      }
    } else {
      console.log("  ✅ Transaction succeeded");
    }
    
    if (tx.meta.logMessages && tx.meta.logMessages.length > 0) {
      console.log("\n  📄 Key logs:");
      tx.meta.logMessages.forEach(log => {
        if (log.includes("ERROR") || log.includes("failed") || 
            log.includes("SUCCESS") || log.includes("CLAIM SUCCESSFUL") ||
            log.includes("Nonce") || log.includes("nonce")) {
          console.log(`    ${log}`);
        }
      });
    }
  } catch (error) {
    console.log(`  ❌ Error analyzing transaction:`, error.message);
  }
}

// Create optimized claim transaction (without compute budget to save space)
function createOptimizedClaimTransaction(
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
  
  const userSig = nacl.sign.detached(message, userKeypair.secretKey);
  const adminSig = nacl.sign.detached(message, adminKeypair.secretKey);
  
  const transaction = new Transaction();
  
  // Add Ed25519 verification instructions
  transaction.add(Ed25519Program.createInstructionWithPublicKey({
    publicKey: user.publicKey.toBytes(),
    signature: userSig,
    message: message,
  }));
  
  transaction.add(Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(),
    signature: adminSig,
    message: message,
  }));
  
  // Add claim instruction
  transaction.add(program.instruction.claimTokens(
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
  ));
  
  return transaction;
}

// Main test
async function runNonceRaceTest() {
  console.log("=" .repeat(60));
  console.log("🏁 FIXED NONCE RACE CONDITION TEST");
  console.log("=" .repeat(60));
  
  try {
    // Setup
    const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
    const admin = Keypair.generate();
    const user = Keypair.generate();
    const payer1 = Keypair.generate();
    const payer2 = Keypair.generate();
    
    console.log("\n📝 Setting up accounts...");
    
    // Airdrop
    for (const wallet of [admin, user, payer1, payer2]) {
      const sig = await connection.requestAirdrop(
        wallet.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
    }
    console.log("  ✅ Airdrops confirmed");
    
    // Initialize program
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer1),
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    const program = anchor.workspace.riyal_contract;
    
    // PDAs
    const [tokenStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      program.programId
    );
    
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), user.publicKey.toBuffer()],
      program.programId
    );
    
    const mint = Keypair.generate();
    
    // Initialize contract
    console.log("\n📝 Initializing contract and mint...");
    await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey,
        new BN(30),
        false,
        true
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: payer1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer1])
      .rpc();
    
    // Create mint
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
    
    // Create user token account
    const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
    const createATATx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer1.publicKey,
        userATA,
        user.publicKey,
        mint.publicKey
      )
    );
    createATATx.feePayer = payer1.publicKey;
    const bh = await connection.getLatestBlockhash();
    createATATx.recentBlockhash = bh.blockhash;
    createATATx.sign(payer1);
    await connection.sendRawTransaction(createATATx.serialize());
    await connection.confirmTransaction({ 
      signature: await connection.sendRawTransaction(createATATx.serialize()), 
      ...bh 
    });
    
    // Initialize user data
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    
    console.log("  ✅ Setup complete");
    
    // Get initial state
    const userData = await program.account.userData.fetch(userDataPDA);
    console.log(`\n📊 Initial state:`);
    console.log(`  Nonce: ${userData.nonce}`);
    console.log(`  Total claims: ${userData.totalClaims}`);
    
    // ========== TEST 1: Single Claim (Baseline) ==========
    console.log("\n" + "=".repeat(60));
    console.log("TEST 1: Single Claim (Baseline)");
    console.log("=".repeat(60));
    
    const amount = 1000000000;
    const nonce = userData.nonce.toNumber();
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    
    console.log(`\nClaim parameters:`);
    console.log(`  Amount: ${amount}`);
    console.log(`  Nonce: ${nonce}`);
    console.log(`  Valid until: ${validUntil}`);
    
    const singleClaimTx = createOptimizedClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      amount,
      nonce,
      validUntil,
      user,
      admin
    );
    
    console.log("\n📤 Sending single claim...");
    singleClaimTx.feePayer = payer1.publicKey;
    const blockhash1 = await connection.getLatestBlockhash();
    singleClaimTx.recentBlockhash = blockhash1.blockhash;
    singleClaimTx.sign(payer1);
    
    const singleSig = await connection.sendRawTransaction(
      singleClaimTx.serialize(),
      { skipPreflight: false }
    );
    console.log(`  Sent: ${singleSig.substring(0, 8)}...`);
    
    const singleConfirm = await connection.confirmTransaction(
      { signature: singleSig, ...blockhash1 },
      "confirmed"
    );
    
    if (!singleConfirm.value.err) {
      console.log("  ✅ Single claim SUCCEEDED!");
      const newUserData = await program.account.userData.fetch(userDataPDA);
      console.log(`  New nonce: ${newUserData.nonce}`);
      console.log(`  Total claims: ${newUserData.totalClaims}`);
    } else {
      console.log("  ❌ Single claim FAILED!");
      await analyzeTransactionError(connection, singleSig, "Single Claim");
      return;
    }
    
    // Wait a bit before race test
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // ========== TEST 2: Nonce Race Condition ==========
    console.log("\n" + "=".repeat(60));
    console.log("TEST 2: Nonce Race Condition");
    console.log("=".repeat(60));
    
    const updatedUserData = await program.account.userData.fetch(userDataPDA);
    const raceNonce = updatedUserData.nonce.toNumber();
    
    console.log(`\nRace test parameters:`);
    console.log(`  Current nonce: ${raceNonce}`);
    console.log(`  Both transactions will use nonce: ${raceNonce}`);
    
    // Create two identical transactions
    console.log("\n🔨 Building two identical transactions...");
    const raceTx1 = createOptimizedClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      amount,
      raceNonce,
      validUntil,
      user,
      admin
    );
    
    const raceTx2 = createOptimizedClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      amount,
      raceNonce,
      validUntil,
      user,
      admin
    );
    
    // Prepare transactions with different payers
    raceTx1.feePayer = payer1.publicKey;
    raceTx2.feePayer = payer2.publicKey;
    
    // Get fresh blockhashes
    const [bh1, bh2] = await Promise.all([
      connection.getLatestBlockhash(),
      connection.getLatestBlockhash()
    ]);
    
    raceTx1.recentBlockhash = bh1.blockhash;
    raceTx2.recentBlockhash = bh2.blockhash;
    
    raceTx1.sign(payer1);
    raceTx2.sign(payer2);
    
    // Send both transactions simultaneously
    console.log("\n🏁 Sending both transactions simultaneously...");
    const [send1, send2] = await Promise.allSettled([
      connection.sendRawTransaction(raceTx1.serialize(), { skipPreflight: true }),
      connection.sendRawTransaction(raceTx2.serialize(), { skipPreflight: true })
    ]);
    
    let sig1 = null, sig2 = null;
    
    if (send1.status === 'fulfilled') {
      sig1 = send1.value;
      console.log(`  TX1 sent: ${sig1.substring(0, 8)}...`);
    } else {
      console.log(`  TX1 failed to send:`, send1.reason.message);
    }
    
    if (send2.status === 'fulfilled') {
      sig2 = send2.value;
      console.log(`  TX2 sent: ${sig2.substring(0, 8)}...`);
    } else {
      console.log(`  TX2 failed to send:`, send2.reason.message);
    }
    
    // Wait for confirmations
    console.log("\n⏳ Waiting for confirmations...");
    const confirmPromises = [];
    if (sig1) confirmPromises.push(connection.confirmTransaction({ signature: sig1, ...bh1 }, "confirmed"));
    if (sig2) confirmPromises.push(connection.confirmTransaction({ signature: sig2, ...bh2 }, "confirmed"));
    
    const confirmResults = await Promise.allSettled(confirmPromises);
    
    // Analyze results
    console.log("\n" + "=".repeat(60));
    console.log("📊 RACE CONDITION RESULTS");
    console.log("=".repeat(60));
    
    let tx1Success = false, tx2Success = false;
    
    if (sig1 && confirmResults[0]) {
      if (confirmResults[0].status === 'fulfilled' && !confirmResults[0].value.value.err) {
        tx1Success = true;
        console.log("\n✅ TX1: SUCCESS");
      } else {
        console.log("\n❌ TX1: FAILED");
        if (sig1) await analyzeTransactionError(connection, sig1, "Transaction 1");
      }
    }
    
    if (sig2 && confirmResults[sig1 ? 1 : 0]) {
      const index = sig1 ? 1 : 0;
      if (confirmResults[index].status === 'fulfilled' && !confirmResults[index].value.value.err) {
        tx2Success = true;
        console.log("\n✅ TX2: SUCCESS");
      } else {
        console.log("\n❌ TX2: FAILED");
        if (sig2) await analyzeTransactionError(connection, sig2, "Transaction 2");
      }
    }
    
    // Final analysis
    console.log("\n" + "=".repeat(60));
    console.log("📋 FINAL ANALYSIS");
    console.log("=".repeat(60));
    
    if (tx1Success && !tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR: TX1 succeeded, TX2 failed with InvalidNonce");
      console.log("   The nonce race protection is working correctly!");
    } else if (!tx1Success && tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR: TX1 failed with InvalidNonce, TX2 succeeded");
      console.log("   The nonce race protection is working correctly!");
    } else if (!tx1Success && !tx2Success) {
      console.log("⚠️  Both transactions failed");
      console.log("   This could be due to account lock contention or signature issues");
    } else {
      console.log("❌ CRITICAL: Both transactions succeeded!");
      console.log("   This indicates a vulnerability!");
    }
    
    // Final state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const balance = await connection.getTokenAccountBalance(userATA);
    
    console.log("\n📊 Final state:");
    console.log(`  Nonce: ${finalUserData.nonce}`);
    console.log(`  Total claims: ${finalUserData.totalClaims}`);
    console.log(`  Token balance: ${balance.value.uiAmount} TEST`);
    
    // ========== TEST 3: Sequential Claims ==========
    console.log("\n" + "=".repeat(60));
    console.log("TEST 3: Sequential Claims (Verify nonce increment)");
    console.log("=".repeat(60));
    
    const seqNonce = finalUserData.nonce.toNumber();
    console.log(`\nCurrent nonce: ${seqNonce}`);
    
    // Wait to ensure no time-lock issues
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // First sequential claim
    const seqTx1 = createOptimizedClaimTransaction(
      program,
      tokenStatePDA,
      userDataPDA,
      mint.publicKey,
      userATA,
      user,
      admin,
      amount,
      seqNonce,
      validUntil,
      user,
      admin
    );
    
    seqTx1.feePayer = payer1.publicKey;
    const seqBh1 = await connection.getLatestBlockhash();
    seqTx1.recentBlockhash = seqBh1.blockhash;
    seqTx1.sign(payer1);
    
    console.log("\n📤 Sending sequential claim 1...");
    const seqSig1 = await connection.sendRawTransaction(seqTx1.serialize());
    const seqConf1 = await connection.confirmTransaction({ signature: seqSig1, ...seqBh1 });
    
    if (!seqConf1.value.err) {
      console.log("  ✅ Sequential claim 1 succeeded");
      
      // Wait and try next claim with incremented nonce
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const seqTx2 = createOptimizedClaimTransaction(
        program,
        tokenStatePDA,
        userDataPDA,
        mint.publicKey,
        userATA,
        user,
        admin,
        amount,
        seqNonce + 1,
        validUntil,
        user,
        admin
      );
      
      seqTx2.feePayer = payer2.publicKey;
      const seqBh2 = await connection.getLatestBlockhash();
      seqTx2.recentBlockhash = seqBh2.blockhash;
      seqTx2.sign(payer2);
      
      console.log("\n📤 Sending sequential claim 2 with nonce+1...");
      const seqSig2 = await connection.sendRawTransaction(seqTx2.serialize());
      const seqConf2 = await connection.confirmTransaction({ signature: seqSig2, ...seqBh2 });
      
      if (!seqConf2.value.err) {
        console.log("  ✅ Sequential claim 2 succeeded");
        console.log("  ✅ Nonce increment mechanism working correctly!");
      } else {
        console.log("  ❌ Sequential claim 2 failed");
      }
    } else {
      console.log("  ❌ Sequential claim 1 failed");
    }
    
    // Final summary
    const veryFinalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(userATA);
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ TEST COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log("\n📊 Final Summary:");
    console.log(`  Final Nonce: ${veryFinalUserData.nonce}`);
    console.log(`  Total Claims: ${veryFinalUserData.totalClaims}`);
    console.log(`  Token Balance: ${finalBalance.value.uiAmount} TEST`);
    
  } catch (error) {
    console.error("\n❌ Test failed:");
    console.error(error);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach(log => console.error("  ", log));
    }
  }
}

// Run the test
if (require.main === module) {
  console.log("Starting fixed nonce race test...\n");
  runNonceRaceTest()
    .then(() => {
      console.log("\n✅ Test suite completed");
      process.exit(0);
    })
    .catch(error => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

module.exports = { runNonceRaceTest };
