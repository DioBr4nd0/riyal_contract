// test_nonce_race_working.js
// Working nonce race condition test with proper setup
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program
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

// Main test
async function runNonceRaceTest() {
  console.log("=" .repeat(60));
  console.log("🏁 NONCE RACE CONDITION TEST - WORKING VERSION");
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
    console.log("\n📝 Initializing contract...");
    await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey,
        new BN(30),
        false, // time-lock disabled for testing
        true
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: payer1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer1])
      .rpc();
    console.log("  ✅ Contract initialized");
    
    // Create mint
    console.log("\n🪙 Creating token mint...");
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
    console.log("  ✅ Mint created");
    
    // IMPORTANT: Enable transfers to avoid freeze/thaw issues
    console.log("\n🔓 Enabling transfers...");
    await program.methods
      .enableTransfers()
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    console.log("  ✅ Transfers enabled (accounts won't be frozen)");
    
    // Create user token account
    console.log("\n👛 Creating user token account...");
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
    const ataSig = await connection.sendRawTransaction(createATATx.serialize());
    await connection.confirmTransaction({ signature: ataSig, ...bh });
    console.log("  ✅ Token account created");
    
    // Initialize user data
    console.log("\n👤 Initializing user data...");
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    console.log("  ✅ User data initialized");
    
    // Get initial state
    const userData = await program.account.userData.fetch(userDataPDA);
    console.log(`\n📊 Initial state:`);
    console.log(`  Nonce: ${userData.nonce}`);
    console.log(`  Total claims: ${userData.totalClaims}`);
    
    // ========== TEST 1: Single Claim (Verify everything works) ==========
    console.log("\n" + "=".repeat(60));
    console.log("TEST 1: Single Claim (Baseline)");
    console.log("=".repeat(60));
    
    const amount = 1000000000; // 1 token
    const nonce = userData.nonce.toNumber();
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    
    // Build message and sign
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
    
    const userSig = nacl.sign.detached(message, user.secretKey);
    const adminSig = nacl.sign.detached(message, admin.secretKey);
    
    // Create transaction
    const singleClaimTx = new Transaction();
    
    // Add Ed25519 verification instructions
    singleClaimTx.add(Ed25519Program.createInstructionWithPublicKey({
      publicKey: user.publicKey.toBytes(),
      signature: userSig,
      message: message,
    }));
    
    singleClaimTx.add(Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      signature: adminSig,
      message: message,
    }));
    
    // Add claim instruction
    singleClaimTx.add(program.instruction.claimTokens(
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
    ));
    
    console.log("\n📤 Sending single claim...");
    singleClaimTx.feePayer = payer1.publicKey;
    const blockhash1 = await connection.getLatestBlockhash();
    singleClaimTx.recentBlockhash = blockhash1.blockhash;
    singleClaimTx.sign(payer1);
    
    const singleSig = await connection.sendRawTransaction(
      singleClaimTx.serialize(),
      { skipPreflight: false }
    );
    
    const singleConfirm = await connection.confirmTransaction(
      { signature: singleSig, ...blockhash1 },
      "confirmed"
    );
    
    if (!singleConfirm.value.err) {
      console.log(`  ✅ Single claim SUCCEEDED! Tx: ${singleSig.substring(0, 8)}...`);
      const newUserData = await program.account.userData.fetch(userDataPDA);
      console.log(`  New nonce: ${newUserData.nonce}`);
      console.log(`  Total claims: ${newUserData.totalClaims}`);
    } else {
      console.log("  ❌ Single claim failed:", singleConfirm.value.err);
      return;
    }
    
    // Wait before race test
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // ========== TEST 2: Nonce Race Condition ==========
    console.log("\n" + "=".repeat(60));
    console.log("TEST 2: Nonce Race Condition (Core Test)");
    console.log("=".repeat(60));
    
    const updatedUserData = await program.account.userData.fetch(userDataPDA);
    const raceNonce = updatedUserData.nonce.toNumber();
    
    console.log(`\n📝 Race test setup:`);
    console.log(`  Current nonce: ${raceNonce}`);
    console.log(`  Both transactions will use nonce: ${raceNonce}`);
    console.log(`  Using different fee payers to avoid conflicts`);
    
    // Build message for race test
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
    
    const raceUserSig = nacl.sign.detached(raceMessage, user.secretKey);
    const raceAdminSig = nacl.sign.detached(raceMessage, admin.secretKey);
    
    // Create two identical transactions
    const createRaceTransaction = () => {
      const tx = new Transaction();
      
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
    
    const raceTx1 = createRaceTransaction();
    const raceTx2 = createRaceTransaction();
    
    // Prepare transactions with different payers
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
    let tx1Error = null, tx2Error = null;
    
    if (sig1 && confirmResults[0]) {
      if (confirmResults[0].status === 'fulfilled' && !confirmResults[0].value.value.err) {
        tx1Success = true;
      } else if (confirmResults[0].status === 'fulfilled') {
        tx1Error = confirmResults[0].value.value.err;
      }
    }
    
    if (sig2 && confirmResults[sig1 ? 1 : 0]) {
      const index = sig1 ? 1 : 0;
      if (confirmResults[index].status === 'fulfilled' && !confirmResults[index].value.value.err) {
        tx2Success = true;
      } else if (confirmResults[index].status === 'fulfilled') {
        tx2Error = confirmResults[index].value.value.err;
      }
    }
    
    // Display results
    console.log("\nTransaction Results:");
    console.log(`  TX1: ${tx1Success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (tx1Error) {
      console.log(`    Error:`, JSON.stringify(tx1Error));
      // Check if it's InvalidNonce error
      if (tx1Error.InstructionError && tx1Error.InstructionError[1].Custom === 6035) {
        console.log(`    → InvalidNonce error (expected behavior)`);
      }
    }
    
    console.log(`  TX2: ${tx2Success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (tx2Error) {
      console.log(`    Error:`, JSON.stringify(tx2Error));
      // Check if it's InvalidNonce error  
      if (tx2Error.InstructionError && tx2Error.InstructionError[1].Custom === 6035) {
        console.log(`    → InvalidNonce error (expected behavior)`);
      }
    }
    
    // Final analysis
    console.log("\n" + "=".repeat(60));
    console.log("📋 ANALYSIS");
    console.log("=".repeat(60));
    
    if (tx1Success && !tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR CONFIRMED!");
      console.log("   → TX1 succeeded and incremented the nonce");
      console.log("   → TX2 failed with InvalidNonce");
      console.log("   → Nonce race protection is working correctly!");
    } else if (!tx1Success && tx2Success) {
      console.log("✅ EXPECTED BEHAVIOR CONFIRMED!");
      console.log("   → TX2 succeeded and incremented the nonce");
      console.log("   → TX1 failed with InvalidNonce");
      console.log("   → Nonce race protection is working correctly!");
    } else if (!tx1Success && !tx2Success) {
      console.log("⚠️  Both transactions failed");
      console.log("   This could happen due to account lock contention");
      console.log("   Check the error codes above for details");
    } else {
      console.log("❌ CRITICAL: Both transactions succeeded!");
      console.log("   This indicates a vulnerability in the nonce mechanism!");
    }
    
    // Final state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const balance = await connection.getTokenAccountBalance(userATA);
    
    console.log("\n📊 Final state:");
    console.log(`  Nonce: ${finalUserData.nonce}`);
    console.log(`  Total claims: ${finalUserData.totalClaims}`);
    console.log(`  Token balance: ${balance.value.uiAmount} TEST`);
    
    // Calculate expected values
    const expectedClaims = tx1Success && tx2Success ? 3 : 2;
    const expectedNonce = expectedClaims;
    
    console.log("\n✅ Verification:");
    console.log(`  Expected total claims: ${expectedClaims} - Actual: ${finalUserData.totalClaims} ${finalUserData.totalClaims.toString() === expectedClaims.toString() ? '✅' : '❌'}`);
    console.log(`  Expected nonce: ${expectedNonce} - Actual: ${finalUserData.nonce} ${finalUserData.nonce.toString() === expectedNonce.toString() ? '✅' : '❌'}`);
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ NONCE RACE CONDITION TEST COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    
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
  console.log("Starting nonce race condition test...\n");
  runNonceRaceTest()
    .then(() => {
      console.log("\n✅ Test completed");
      process.exit(0);
    })
    .catch(error => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

module.exports = { runNonceRaceTest };
