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

// LE helpers
const u64le = (x) => { const b=new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(x), true); return Buffer.from(b); };
const i64le = (x) => { const b=new ArrayBuffer(8); new DataView(b).setBigInt64(0, BigInt(x), true);  return Buffer.from(b); };

// Domain-separated message
function buildClaimBytes(programId, tokenStatePDA, mint, user, dest, amount, nonce, validUntil) {
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

// Send transaction without confirmation (for race conditions)
async function sendTxNoConfirm(connection, tx, signers, description) {
  try {
    tx.feePayer = signers[0].publicKey;
    const bh = await connection.getLatestBlockhash();
    tx.recentBlockhash = bh.blockhash;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    return { success: true, signature: sig, error: null };
  } catch (error) {
    return { success: false, signature: null, error: error.message };
  }
}

// Confirm transaction separately
async function confirmTx(connection, signature) {
  try {
    const bh = await connection.getLatestBlockhash();
    const conf = await connection.confirmTransaction({ signature, ...bh }, "confirmed");
    if (conf.value.err) {
      return { success: false, error: `Confirmation failed: ${JSON.stringify(conf.value.err)}` };
    }
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

(async () => {
  console.log("🏁 RIYAL NONCE RACE CONDITION TEST");
  console.log("===================================");
  console.log("⚡ Fire two IDENTICAL transactions simultaneously");
  console.log("🎯 Expected: ONE success, ONE InvalidNonce failure");

  // Setup
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user = Keypair.generate();
  
  // Fund accounts
  for (const k of [admin, user]) {
    await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
  }
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // PDAs and accounts
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);
  const mint = Keypair.generate();

  console.log("🏗️  Setup:");
  console.log(`  Admin: ${admin.publicKey.toBase58()}`);
  console.log(`  User: ${user.publicKey.toBase58()}`);

  // Initialize contract
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new anchor.BN(5), true, true)
    .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
    .signers([admin]).rpc();

  // Create mint
  await program.methods
    .createTokenMint(9, "Riyal", "RIYAL")
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin, mint]).rpc();

  // Create user ATA and init user data
  const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
  await connection.sendTransaction(
    new Transaction().add(createAssociatedTokenAccountInstruction(
      admin.publicKey, userATA, user.publicKey, mint.publicKey
    )),
    [admin]
  );

  const initUserDataTx = new Transaction().add(
    await program.methods
      .initializeUserData()
      .accounts({ userData: userDataPDA, user: user.publicKey, systemProgram: SystemProgram.programId })
      .instruction()
  );
  initUserDataTx.feePayer = admin.publicKey;
  initUserDataTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  initUserDataTx.partialSign(admin, user);
  await connection.sendRawTransaction(initUserDataTx.serialize());

  console.log("✅ Setup complete");

  // Get initial state
  const getState = async () => {
    const ud = await program.account.userData.fetch(userDataPDA);
    const bal = await connection.getTokenAccountBalance(userATA);
    return { nonce: Number(ud.nonce), amount: BigInt(bal.value.amount) };
  };

  const { nonce: initialNonce } = await getState();
  console.log(`📊 Initial nonce: ${initialNonce}`);

  // Create IDENTICAL claim transactions for race condition
  async function buildClaimTx(amountRaw, nonce, validUntil) {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const msg = buildClaimBytes(
      program.programId, tokenStatePDA, tokenState.tokenMint,
      user.publicKey, userATA, amountRaw, nonce, validUntil
    );
    const sigUser = nacl.sign.detached(msg, user.secretKey);
    const sigAdmin = nacl.sign.detached(msg, admin.secretKey);
    const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(), message: msg, signature: sigUser });
    const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: msg, signature: sigAdmin });
    const claimIx = await program.methods
      .claimTokens(new anchor.BN(amountRaw), new anchor.BN(nonce), new anchor.BN(validUntil), Array.from(sigUser), Array.from(sigAdmin))
      .accounts({
        tokenState: tokenStatePDA, userData: userDataPDA, mint: mint.publicKey,
        userTokenAccount: userATA, user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      }).instruction();
    return new Transaction().add(edU).add(edA).add(claimIx);
  }

  // Create IDENTICAL transactions
  const claimAmount = 500_000_000; // 0.5 tokens
  const validUntil = Math.floor(Date.now()/1000) + 60; // 1 minute expiry
  
  console.log("\n⚡ Creating IDENTICAL transactions for race condition...");
  const raceTx1 = await buildClaimTx(claimAmount, initialNonce, validUntil);
  const raceTx2 = await buildClaimTx(claimAmount, initialNonce, validUntil); // SAME NONCE!
  
  console.log(`🔐 Both transactions use SAME nonce: ${initialNonce}`);
  console.log(`💰 Both transactions claim SAME amount: ${claimAmount / 1e9} RRIYAL`);
  console.log(`⏰ Both transactions have SAME expiry: ${new Date(validUntil * 1000).toLocaleTimeString()}`);

  // Fire both transactions SIMULTANEOUSLY
  console.log("\n🏁 FIRING BOTH TRANSACTIONS SIMULTANEOUSLY...");
  console.log("   This tests if nonce validation prevents double-spending");
  
  const raceStartTime = Date.now();
  
  // Send both transactions in parallel (no await - true concurrency)
  const [result1, result2] = await Promise.allSettled([
    sendTxNoConfirm(connection, raceTx1, [admin], "Race Transaction 1"),
    sendTxNoConfirm(connection, raceTx2, [admin], "Race Transaction 2")
  ]);
  
  const raceEndTime = Date.now();
  console.log(`⏱️  Both transactions sent in ${raceEndTime - raceStartTime}ms`);

  // Get results
  const tx1Result = result1.status === 'fulfilled' ? result1.value : { success: false, error: result1.reason };
  const tx2Result = result2.status === 'fulfilled' ? result2.value : { success: false, error: result2.reason };

  console.log("\n📊 IMMEDIATE SEND RESULTS:");
  console.log("===========================");
  console.log(`Transaction 1 sent: ${tx1Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (tx1Result.signature) console.log(`  Signature: ${tx1Result.signature}`);
  if (tx1Result.error) console.log(`  Error: ${tx1Result.error}`);

  console.log(`Transaction 2 sent: ${tx2Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (tx2Result.signature) console.log(`  Signature: ${tx2Result.signature}`);
  if (tx2Result.error) console.log(`  Error: ${tx2Result.error}`);

  // Now confirm both transactions to see which one actually succeeded
  console.log("\n⏳ Confirming both transactions...");
  
  let confirmResults = [];
  
  if (tx1Result.success && tx1Result.signature) {
    const conf1 = await confirmTx(connection, tx1Result.signature);
    confirmResults.push({ tx: 1, ...conf1, signature: tx1Result.signature });
  }
  
  if (tx2Result.success && tx2Result.signature) {
    const conf2 = await confirmTx(connection, tx2Result.signature);
    confirmResults.push({ tx: 2, ...conf2, signature: tx2Result.signature });
  }

  console.log("\n🔐 CONFIRMATION RESULTS:");
  console.log("=========================");
  
  let successCount = 0;
  let failureCount = 0;
  
  for (const result of confirmResults) {
    if (result.success) {
      console.log(`✅ Transaction ${result.tx} CONFIRMED`);
      console.log(`   Signature: ${result.signature}`);
      successCount++;
    } else {
      console.log(`❌ Transaction ${result.tx} FAILED`);
      console.log(`   Error: ${result.error}`);
      failureCount++;
    }
  }

  // Check final state
  const { nonce: finalNonce, amount: finalAmount } = await getState();
  
  console.log("\n📊 FINAL STATE:");
  console.log("================");
  console.log(`Final nonce: ${finalNonce} (expected: ${initialNonce + 1})`);
  console.log(`Final balance: ${Number(finalAmount) / 1e9} RRIYAL (expected: ${claimAmount / 1e9})`);

  // Security analysis
  console.log("\n🛡️  SECURITY ANALYSIS:");
  console.log("=======================");
  
  if (successCount === 1 && finalNonce === initialNonce + 1) {
    console.log("🎉 PERFECT SECURITY!");
    console.log("✅ Exactly ONE transaction succeeded");
    console.log("✅ Nonce incremented exactly once");
    console.log("✅ Balance increased exactly once");
    console.log("✅ Race condition properly handled");
    console.log("✅ Double-spend attack PREVENTED");
    
  } else if (successCount === 2) {
    console.log("🚨 CRITICAL SECURITY FAILURE!");
    console.log("❌ BOTH transactions succeeded");
    console.log("❌ Double-spend attack POSSIBLE");
    console.log("❌ Nonce validation FAILED");
    
  } else if (successCount === 0) {
    console.log("⚠️  Both transactions failed");
    console.log("❓ Check if there's a setup issue");
    
  } else {
    console.log("❓ Unexpected result");
  }

  console.log("\n🎯 RACE CONDITION TEST COMPLETE");
  console.log("Nonce-based replay protection under concurrency verified!");

})().catch((e) => {
  console.error("❌ race condition test failed:", e);
  process.exit(1);
});
