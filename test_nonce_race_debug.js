// test_nonce_race_debug.js
// Debug-focused test to identify why both transactions fail in nonce race condition
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

// Debug helper to analyze transaction errors
async function analyzeTransactionError(connection, signature, label) {
  console.log(`\n📋 Analyzing ${label}:`);
  console.log(`  Signature: ${signature}`);
  
  try {
    // Get transaction details
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });
    
    if (!tx) {
      console.log("  ❌ Transaction not found");
      return;
    }
    
    // Check if transaction succeeded or failed
    if (tx.meta.err) {
      console.log(`  ❌ Transaction failed with error:`, tx.meta.err);
      
      // Parse error details
      if (tx.meta.err.InstructionError) {
        const [index, error] = tx.meta.err.InstructionError;
        console.log(`  Failed at instruction index: ${index}`);
        console.log(`  Error type:`, error);
        
        if (error.Custom !== undefined) {
          console.log(`  Custom error code: ${error.Custom}`);
          // Map to your error codes if possible
          const errorMap = {
            6035: "InvalidNonce",
            6036: "InvalidUserSignature", 
            6037: "InvalidAdminSignature",
            6082: "UserSignatureNotVerified",
            6083: "AdminSignatureNotVerified",
            // Add more mappings based on your errors.rs
          };
          console.log(`  Error name: ${errorMap[error.Custom] || "Unknown"}`);
        }
      }
    } else {
      console.log("  ✅ Transaction succeeded");
    }
    
    // Show logs
    if (tx.meta.logMessages && tx.meta.logMessages.length > 0) {
      console.log("\n  📄 Transaction logs:");
      tx.meta.logMessages.forEach((log, i) => {
        // Highlight important logs
        if (log.includes("ERROR") || log.includes("failed") || log.includes("Error")) {
          console.log(`    ${i}: ❌ ${log}`);
        } else if (log.includes("SUCCESS") || log.includes("CLAIM SUCCESSFUL")) {
          console.log(`    ${i}: ✅ ${log}`);
        } else if (log.includes("Program log:")) {
          console.log(`    ${i}: 📝 ${log}`);
        } else {
          console.log(`    ${i}: ${log}`);
        }
      });
    }
    
    // Check compute units used
    if (tx.meta.computeUnitsConsumed !== undefined) {
      console.log(`\n  ⚡ Compute units consumed: ${tx.meta.computeUnitsConsumed}`);
    }
    
  } catch (error) {
    console.log(`  ❌ Error analyzing transaction:`, error.message);
  }
}

// Main debug test
async function debugNonceRace() {
  console.log("=" .repeat(60));
  console.log("🔍 NONCE RACE CONDITION DEBUG TEST");
  console.log("=" .repeat(60));
  
  try {
    // Setup
    const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
    const admin = Keypair.generate();
    const user = Keypair.generate();
    const payer1 = Keypair.generate();
    const payer2 = Keypair.generate();
    
    console.log("\n📝 Account Setup:");
    console.log(`  Admin: ${admin.publicKey.toString()}`);
    console.log(`  User: ${user.publicKey.toString()}`);
    console.log(`  Payer1: ${payer1.publicKey.toString()}`);
    console.log(`  Payer2: ${payer2.publicKey.toString()}`);
    
    // Airdrop
    console.log("\n💰 Requesting airdrops...");
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
    
    console.log(`\n📦 Program ID: ${program.programId.toString()}`);
    
    // PDAs
    const [tokenStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      program.programId
    );
    
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), user.publicKey.toBuffer()],
      program.programId
    );
    
    console.log(`\n🔑 PDAs:`);
    console.log(`  TokenState: ${tokenStatePDA.toString()}`);
    console.log(`  UserData: ${userDataPDA.toString()}`);
    
    const mint = Keypair.generate();
    console.log(`  Mint: ${mint.publicKey.toString()}`);
    
    // Initialize contract
    console.log("\n📝 Initializing contract...");
    const initTx = await program.methods
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
    console.log(`  ✅ Initialized: ${initTx}`);
    
    // Create mint
    console.log("\n🪙 Creating token mint...");
    const mintTx = await program.methods
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
    console.log(`  ✅ Mint created: ${mintTx}`);
    
    // Create user token account
    console.log("\n👛 Creating user token account...");
    const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
    console.log(`  ATA address: ${userATA.toString()}`);
    
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
    const ataSig = await connection.sendRawTransaction(createATATx.serialize());
    await connection.confirmTransaction({ signature: ataSig, ...bh });
    console.log(`  ✅ ATA created: ${ataSig}`);
    
    // Initialize user data
    console.log("\n👤 Initializing user data...");
    const userDataTx = await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    console.log(`  ✅ User data initialized: ${userDataTx}`);
    
    // Fetch initial state
    const userData = await program.account.userData.fetch(userDataPDA);
    console.log(`\n📊 Initial user data state:`);
    console.log(`  Nonce: ${userData.nonce}`);
    console.log(`  Total claims: ${userData.totalClaims}`);
    
    // ========== STEP 1: Test Single Claim First ==========
    console.log("\n" + "=".repeat(60));
    console.log("STEP 1: Testing Single Claim (Baseline)");
    console.log("=".repeat(60));
    
    const amount = 1000000000; // 1 token
    const nonce = userData.nonce.toNumber();
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    
    console.log(`\n📝 Claim parameters:`);
    console.log(`  Amount: ${amount}`);
    console.log(`  Nonce: ${nonce}`);
    console.log(`  Valid until: ${validUntil}`);
    
    // Build message
    const message = buildClaimMessage(
      program.programId,
      tokenStatePDA,
      mint.publicKey,
      user.publicKey,
      userATA,
      amount,
      nonce,
      validUntil
    );
    console.log(`  Message length: ${message.length} bytes`);
    
    // Sign message
    const userSig = nacl.sign.detached(message, user.secretKey);
    const adminSig = nacl.sign.detached(message, admin.secretKey);
    console.log(`  User signature: ${Buffer.from(userSig).toString('hex').substring(0, 16)}...`);
    console.log(`  Admin signature: ${Buffer.from(adminSig).toString('hex').substring(0, 16)}...`);
    
    // Create single claim transaction
    const singleClaimTx = new Transaction();
    
    // Add compute budget
    singleClaimTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })
    );
    
    // Add Ed25519 instructions
    console.log("\n🔐 Adding Ed25519 verification instructions...");
    const userEd25519 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user.publicKey.toBytes(),
      signature: userSig,
      message: message,
    });
    singleClaimTx.add(userEd25519);
    console.log(`  ✅ User Ed25519 instruction added`);
    
    const adminEd25519 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      signature: adminSig,
      message: message,
    });
    singleClaimTx.add(adminEd25519);
    console.log(`  ✅ Admin Ed25519 instruction added`);
    
    // Add claim instruction
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
          mint: mint.publicKey,
          userTokenAccount: userATA,
          user: user.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
      }
    );
    singleClaimTx.add(claimIx);
    console.log(`  ✅ Claim instruction added`);
    
    // Send single claim
    console.log("\n📤 Sending single claim transaction...");
    singleClaimTx.feePayer = payer1.publicKey;
    const blockhash1 = await connection.getLatestBlockhash();
    singleClaimTx.recentBlockhash = blockhash1.blockhash;
    singleClaimTx.sign(payer1);
    
    const singleSig = await connection.sendRawTransaction(
      singleClaimTx.serialize(),
      { skipPreflight: false }
    );
    console.log(`  Transaction sent: ${singleSig}`);
    
    // Wait and analyze
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
      console.log("\n⚠️  Single claim failed - cannot proceed with race test");
      console.log("  Fix the single claim issue first!");
      return;
    }
    
    // ========== STEP 2: Test Race Condition ==========
    console.log("\n" + "=".repeat(60));
    console.log("STEP 2: Testing Nonce Race Condition");
    console.log("=".repeat(60));
    
    // Get updated nonce
    const updatedUserData = await program.account.userData.fetch(userDataPDA);
    const raceNonce = updatedUserData.nonce.toNumber();
    
    console.log(`\n📝 Race test parameters:`);
    console.log(`  Current nonce: ${raceNonce}`);
    console.log(`  Both transactions will use nonce: ${raceNonce}`);
    
    // Build new message for race test
    const raceMessage = buildClaimMessage(
      program.programId,
      tokenStatePDA,
      mint.publicKey,
      user.publicKey,
      userATA,
      amount,
      raceNonce,
      validUntil
    );
    
    // Sign for race test
    const raceUserSig = nacl.sign.detached(raceMessage, user.secretKey);
    const raceAdminSig = nacl.sign.detached(raceMessage, admin.secretKey);
    
    // Create two identical transactions
    console.log("\n🔨 Building two identical transactions...");
    
    const buildRaceTransaction = () => {
      const tx = new Transaction();
      
      // Compute budget
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
      
      // Ed25519 verifications
      tx.add(Ed25519Program.createInstructionWithPublicKey({
        publicKey: user.publicKey.toBytes(),
        signature: raceUserSig,
        message: raceMessage,
      }));
      
      tx.add(Ed25519Program.createInstructionWithPublicKey({
        publicKey: admin.publicKey.toBytes(),
        signature: raceAdminSig,
        message: raceMessage,
      }));
      
      // Claim instruction
      tx.add(program.instruction.claimTokens(
        new BN(amount),
        new BN(raceNonce),
        new BN(validUntil),
        Array.from(raceUserSig),
        Array.from(raceAdminSig),
        {
          accounts: {
            tokenState: tokenStatePDA,
            userData: userDataPDA,
            mint: mint.publicKey,
            userTokenAccount: userATA,
            user: user.publicKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
          },
        }
      ));
      
      return tx;
    };
    
    const raceTx1 = buildRaceTransaction();
    const raceTx2 = buildRaceTransaction();
    console.log("  ✅ Both transactions built identically");
    
    // Send both transactions in parallel
    console.log("\n🏁 Sending both transactions simultaneously...");
    
    // Prepare transactions
    raceTx1.feePayer = payer1.publicKey;
    raceTx2.feePayer = payer2.publicKey;
    
    const [bh1, bh2] = await Promise.all([
      connection.getLatestBlockhash(),
      connection.getLatestBlockhash()
    ]);
    
    raceTx1.recentBlockhash = bh1.blockhash;
    raceTx2.recentBlockhash = bh2.blockhash;
    
    raceTx1.sign(payer1);
    raceTx2.sign(payer2);
    
    // Send both at the same time
    const [send1, send2] = await Promise.allSettled([
      connection.sendRawTransaction(raceTx1.serialize(), { skipPreflight: true }),
      connection.sendRawTransaction(raceTx2.serialize(), { skipPreflight: true })
    ]);
    
    // Process send results
    let sig1 = null, sig2 = null;
    
    if (send1.status === 'fulfilled') {
      sig1 = send1.value;
      console.log(`  TX1 sent: ${sig1}`);
    } else {
      console.log(`  TX1 failed to send:`, send1.reason);
    }
    
    if (send2.status === 'fulfilled') {
      sig2 = send2.value;
      console.log(`  TX2 sent: ${sig2}`);
    } else {
      console.log(`  TX2 failed to send:`, send2.reason);
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
        await analyzeTransactionError(connection, sig1, "Transaction 1");
      }
    }
    
    if (sig2 && confirmResults[sig1 ? 1 : 0]) {
      const index = sig1 ? 1 : 0;
      if (confirmResults[index].status === 'fulfilled' && !confirmResults[index].value.value.err) {
        tx2Success = true;
        console.log("\n✅ TX2: SUCCESS");
      } else {
        console.log("\n❌ TX2: FAILED");
        await analyzeTransactionError(connection, sig2, "Transaction 2");
      }
    }
    
    // Final analysis
    console.log("\n" + "=".repeat(60));
    console.log("📋 FINAL ANALYSIS");
    console.log("=".repeat(60));
    
    if (tx1Success && !tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR: TX1 succeeded, TX2 failed");
      console.log("   The nonce mechanism is working correctly!");
    } else if (!tx1Success && tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR: TX1 failed, TX2 succeeded");
      console.log("   The nonce mechanism is working correctly!");
    } else if (!tx1Success && !tx2Success) {
      console.log("⚠️  UNEXPECTED: Both transactions failed");
      console.log("\nPossible causes:");
      console.log("1. Signature verification issue (check Ed25519 instruction format)");
      console.log("2. Both transactions hit account lock at exact same time");
      console.log("3. RPC node issues or rate limiting");
      console.log("4. Insufficient compute units for signature verification");
      console.log("\nRecommendations:");
      console.log("- Check if single claims work consistently");
      console.log("- Try increasing delay between transactions");
      console.log("- Verify Ed25519 instructions are properly formatted");
      console.log("- Consider moving signature verification before nonce check in contract");
    } else {
      console.log("❌ CRITICAL: Both transactions succeeded!");
      console.log("   This indicates a serious vulnerability in the nonce mechanism!");
    }
    
    // Final state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    console.log("\n📊 Final user data state:");
    console.log(`  Nonce: ${finalUserData.nonce}`);
    console.log(`  Total claims: ${finalUserData.totalClaims}`);
    
    const balance = await connection.getTokenAccountBalance(userATA);
    console.log(`  Token balance: ${balance.value.uiAmount} TEST`);
    
  } catch (error) {
    console.error("\n❌ Test failed with unexpected error:");
    console.error(error);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach(log => console.error("  ", log));
    }
  }
}

// Run the debug test
if (require.main === module) {
  console.log("Starting debug test...\n");
  debugNonceRace()
    .then(() => {
      console.log("\n✅ Debug test completed");
      process.exit(0);
    })
    .catch(error => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

module.exports = { debugNonceRace };
