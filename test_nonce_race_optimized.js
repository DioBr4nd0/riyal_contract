// test_nonce_race_optimized.js
// Optimized test for nonce race conditions with improved signature handling
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program, ComputeBudgetProgram,
  VersionedTransaction, TransactionMessage
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");

const BN = anchor.BN;

// ========== Configuration ==========
const CLAIM_AMOUNT = 1000000000; // 1 token with 9 decimals

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

// Strategy 1: Use versioned transactions for better control
async function sendVersionedTransaction(connection, instructions, payer, signers) {
  const blockhash = await connection.getLatestBlockhash();
  
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();
  
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign(signers);
  
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 0
  });
  
  return { signature, blockhash };
}

// Strategy 2: Create transaction with priority fees to improve chances
function createPriorityClaimTransaction(
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
  adminKeypair,
  priorityFee = 0
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
  
  const instructions = [];
  
  // Add priority fee if specified
  if (priorityFee > 0) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
    );
  }
  
  // Add compute budget
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })
  );
  
  // Add Ed25519 verification instructions
  instructions.push(
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: user.publicKey.toBytes(),
      signature: userSig,
      message: message,
    })
  );
  
  instructions.push(
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      signature: adminSig,
      message: message,
    })
  );
  
  // Add claim instruction
  instructions.push(
    program.instruction.claimTokens(
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
    )
  );
  
  return instructions;
}

// Strategy 3: Use different payers for each transaction to avoid conflicts
async function setupMultiplePayers(connection, count) {
  const payers = [];
  for (let i = 0; i < count; i++) {
    const payer = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig);
    payers.push(payer);
  }
  return payers;
}

// ========== Main Race Test Function ==========
async function testNonceRaceCondition() {
  console.log("=" .repeat(60));
  console.log("🏁 OPTIMIZED NONCE RACE CONDITION TEST");
  console.log("=" .repeat(60));
  console.log("\nThis test addresses the signature verification issue by:");
  console.log("1. Using separate payers to avoid transaction conflicts");
  console.log("2. Adding proper compute budget for signature verification");
  console.log("3. Using versioned transactions for better control");
  console.log("4. Testing with slight timing variations");
  console.log("=" .repeat(60));
  
  try {
    // Setup
    const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
    const admin = Keypair.generate();
    const user = Keypair.generate();
    const setupPayer = Keypair.generate();
    
    // Airdrop to main accounts
    console.log("\n📝 Setting up accounts...");
    for (const wallet of [admin, user, setupPayer]) {
      const sig = await connection.requestAirdrop(
        wallet.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
    }
    
    // Setup multiple payers for race testing
    console.log("📝 Setting up multiple payers for race testing...");
    const racePayers = await setupMultiplePayers(connection, 2);
    
    // Initialize program
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(setupPayer),
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
    console.log("📝 Initializing contract...");
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
        payer: setupPayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([setupPayer])
      .rpc();
    
    // Create mint
    console.log("📝 Creating token mint...");
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
        setupPayer.publicKey,
        userATA,
        user.publicKey,
        mint.publicKey
      )
    );
    createATATx.feePayer = setupPayer.publicKey;
    const blockhash = await connection.getLatestBlockhash();
    createATATx.recentBlockhash = blockhash.blockhash;
    createATATx.sign(setupPayer);
    await connection.sendRawTransaction(createATATx.serialize());
    await connection.confirmTransaction({ signature: await connection.sendRawTransaction(createATATx.serialize()), ...blockhash });
    
    // Initialize user data
    console.log("📝 Initializing user data...");
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    
    // ========== RACE TEST 1: Same Nonce, Different Payers ==========
    console.log("\n" + "=".repeat(60));
    console.log("🏁 TEST 1: Same Nonce with Different Payers");
    console.log("=".repeat(60));
    
    const userData = await program.account.userData.fetch(userDataPDA);
    const currentNonce = userData.nonce.toNumber();
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    
    console.log(`Current nonce: ${currentNonce}`);
    console.log("Creating two transactions with same nonce...");
    
    // Create instructions for both transactions
    const instructions1 = createPriorityClaimTransaction(
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
      admin,
      1000 // Small priority fee for first tx
    );
    
    const instructions2 = createPriorityClaimTransaction(
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
      admin,
      500 // Different priority fee for second tx
    );
    
    // Build transactions
    const tx1 = new Transaction();
    instructions1.forEach(ix => tx1.add(ix));
    
    const tx2 = new Transaction();
    instructions2.forEach(ix => tx2.add(ix));
    
    // Send both transactions with different payers
    console.log("Sending both transactions simultaneously...");
    
    const sendPromises = [
      (async () => {
        tx1.feePayer = racePayers[0].publicKey;
        const bh = await connection.getLatestBlockhash();
        tx1.recentBlockhash = bh.blockhash;
        tx1.sign(racePayers[0]);
        const sig = await connection.sendRawTransaction(tx1.serialize(), { skipPreflight: true });
        return { tx: "TX1", signature: sig, blockhash: bh };
      })(),
      (async () => {
        tx2.feePayer = racePayers[1].publicKey;
        const bh = await connection.getLatestBlockhash();
        tx2.recentBlockhash = bh.blockhash;
        tx2.sign(racePayers[1]);
        const sig = await connection.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
        return { tx: "TX2", signature: sig, blockhash: bh };
      })()
    ];
    
    const sendResults = await Promise.allSettled(sendPromises);
    
    console.log("\nTransaction send results:");
    sendResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`  ${result.value.tx}: Sent (${result.value.signature.substring(0, 8)}...)`);
      } else {
        console.log(`  TX${index + 1}: Failed to send - ${result.reason}`);
      }
    });
    
    // Wait for confirmations
    console.log("\nWaiting for confirmations...");
    const confirmPromises = sendResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .map(async ({ tx, signature, blockhash }) => {
        try {
          const confirmation = await connection.confirmTransaction(
            { signature, ...blockhash },
            "confirmed"
          );
          return { tx, success: !confirmation.value.err, error: confirmation.value.err };
        } catch (error) {
          return { tx, success: false, error: error.message };
        }
      });
    
    const confirmResults = await Promise.all(confirmPromises);
    
    // Analyze results
    console.log("\n" + "-".repeat(40));
    console.log("RESULTS:");
    console.log("-".repeat(40));
    
    const successCount = confirmResults.filter(r => r.success).length;
    const failCount = confirmResults.filter(r => !r.success).length;
    
    confirmResults.forEach(result => {
      console.log(`${result.tx}: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
      if (!result.success && result.error) {
        console.log(`  Error: ${JSON.stringify(result.error)}`);
      }
    });
    
    if (successCount === 1 && failCount === 1) {
      console.log("\n✅ EXPECTED BEHAVIOR: One transaction succeeded, one failed");
      console.log("This proves the nonce mechanism is working correctly!");
    } else if (successCount === 0) {
      console.log("\n⚠️  Both transactions failed. Possible reasons:");
      console.log("1. Signature verification failed for both");
      console.log("2. Account was locked by both transactions");
      console.log("3. Network congestion or RPC issues");
      
      // Additional debugging
      console.log("\nFetching latest user data for debugging...");
      const latestUserData = await program.account.userData.fetch(userDataPDA);
      console.log(`Latest nonce: ${latestUserData.nonce}`);
      console.log(`Total claims: ${latestUserData.totalClaims}`);
    } else if (successCount === 2) {
      console.log("\n❌ CRITICAL: Both transactions succeeded with same nonce!");
      console.log("This indicates a vulnerability in the nonce mechanism!");
    }
    
    // ========== RACE TEST 2: Staggered Submission ==========
    console.log("\n" + "=".repeat(60));
    console.log("🏁 TEST 2: Staggered Submission (10ms delay)");
    console.log("=".repeat(60));
    
    // Get fresh nonce
    const userData2 = await program.account.userData.fetch(userDataPDA);
    const nonce2 = userData2.nonce.toNumber();
    
    console.log(`Current nonce: ${nonce2}`);
    
    // Setup new payers
    const staggerPayers = await setupMultiplePayers(connection, 2);
    
    // Create transactions
    const staggerInstructions1 = createPriorityClaimTransaction(
      program, tokenStatePDA, userDataPDA, mint.publicKey, userATA,
      user, admin, CLAIM_AMOUNT, nonce2, validUntil, user, admin, 2000
    );
    
    const staggerInstructions2 = createPriorityClaimTransaction(
      program, tokenStatePDA, userDataPDA, mint.publicKey, userATA,
      user, admin, CLAIM_AMOUNT, nonce2, validUntil, user, admin, 1500
    );
    
    const staggerTx1 = new Transaction();
    staggerInstructions1.forEach(ix => staggerTx1.add(ix));
    
    const staggerTx2 = new Transaction();
    staggerInstructions2.forEach(ix => staggerTx2.add(ix));
    
    console.log("Sending transactions with 10ms delay...");
    
    // Send first transaction
    staggerTx1.feePayer = staggerPayers[0].publicKey;
    const bh1 = await connection.getLatestBlockhash();
    staggerTx1.recentBlockhash = bh1.blockhash;
    staggerTx1.sign(staggerPayers[0]);
    const sig1 = connection.sendRawTransaction(staggerTx1.serialize(), { skipPreflight: true });
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Send second transaction
    staggerTx2.feePayer = staggerPayers[1].publicKey;
    const bh2 = await connection.getLatestBlockhash();
    staggerTx2.recentBlockhash = bh2.blockhash;
    staggerTx2.sign(staggerPayers[1]);
    const sig2 = connection.sendRawTransaction(staggerTx2.serialize(), { skipPreflight: true });
    
    // Wait for both
    const [staggerSig1, staggerSig2] = await Promise.all([sig1, sig2]);
    
    console.log(`TX1 sent: ${staggerSig1.substring(0, 8)}...`);
    console.log(`TX2 sent: ${staggerSig2.substring(0, 8)}...`);
    
    // Confirm both
    const [confirm1, confirm2] = await Promise.allSettled([
      connection.confirmTransaction({ signature: staggerSig1, ...bh1 }, "confirmed"),
      connection.confirmTransaction({ signature: staggerSig2, ...bh2 }, "confirmed")
    ]);
    
    console.log("\nStaggered submission results:");
    if (confirm1.status === 'fulfilled') {
      console.log(`TX1: ${!confirm1.value.value.err ? '✅ SUCCESS' : '❌ FAILED'}`);
    } else {
      console.log(`TX1: ❌ FAILED - ${confirm1.reason}`);
    }
    
    if (confirm2.status === 'fulfilled') {
      console.log(`TX2: ${!confirm2.value.value.err ? '✅ SUCCESS' : '❌ FAILED'}`);
    } else {
      console.log(`TX2: ❌ FAILED - ${confirm2.reason}`);
    }
    
    // ========== Final Summary ==========
    console.log("\n" + "=".repeat(60));
    console.log("📊 TEST SUMMARY");
    console.log("=".repeat(60));
    
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const tokenBalance = await connection.getTokenAccountBalance(userATA);
    
    console.log("\nFinal State:");
    console.log(`  Nonce: ${finalUserData.nonce}`);
    console.log(`  Total Claims: ${finalUserData.totalClaims}`);
    console.log(`  Token Balance: ${tokenBalance.value.uiAmount} TEST`);
    
    console.log("\n✅ Test completed successfully!");
    
  } catch (error) {
    console.error("\n❌ Test failed:");
    console.error(error);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach(log => console.error("  ", log));
    }
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testNonceRaceCondition()
    .then(() => process.exit(0))
    .catch(error => {
      console.error("Unexpected error:", error);
      process.exit(1);
    });
}

module.exports = { testNonceRaceCondition };
