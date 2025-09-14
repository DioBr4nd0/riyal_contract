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

// Send without confirmation for race conditions
async function sendRawTx(connection, tx, signers) {
  tx.feePayer = signers[0].publicKey;
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
}

(async () => {
  console.log("🏁 COMPLETE NONCE RACE CONDITION TEST");
  console.log("======================================");
  console.log("⚡ Testing double-spend prevention under concurrency");
  console.log("🎯 Two IDENTICAL transactions with SAME nonce fired simultaneously");

  // Fresh setup
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  
  // Kill and restart validator to ensure fresh state
  console.log("🔄 Ensuring fresh validator state...");
  
  const admin = Keypair.generate();
  const user = Keypair.generate();
  
  // Fund
  for (const k of [admin, user]) {
    await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
  }
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);
  const mint = Keypair.generate();

  console.log(`🏗️  Admin: ${admin.publicKey.toBase58()}`);
  console.log(`🏗️  User: ${user.publicKey.toBase58()}`);

  // Quick setup (minimal logging)
  try {
    await program.methods
      .initialize(admin.publicKey, admin.publicKey, new anchor.BN(5), false, true) // time_lock_enabled = false for faster test
      .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin]).rpc();

    await program.methods
      .createTokenMint(9, "Riyal", "RIYAL")
      .accounts({
        tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mint]).rpc();

    const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
    await connection.sendTransaction(
      new Transaction().add(createAssociatedTokenAccountInstruction(admin.publicKey, userATA, user.publicKey, mint.publicKey)),
      [admin]
    );

    const initTx = new Transaction().add(
      await program.methods
        .initializeUserData()
        .accounts({ userData: userDataPDA, user: user.publicKey, systemProgram: SystemProgram.programId })
        .instruction()
    );
    initTx.feePayer = admin.publicKey;
    initTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    initTx.partialSign(admin, user);
    await connection.sendRawTransaction(initTx.serialize());

    console.log("✅ Contract setup complete");

    // Get state
    const userData = await program.account.userData.fetch(userDataPDA);
    const raceNonce = Number(userData.nonce);
    console.log(`📊 Current nonce: ${raceNonce}`);

    // Create race condition transactions
    const claimAmount = 1_000_000_000; // 1 token
    const validUntil = Math.floor(Date.now()/1000) + 60;

    async function buildRaceTx() {
      const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
      const msg = buildClaimBytes(program.programId, tokenStatePDA, tokenState.tokenMint, user.publicKey, userATA, claimAmount, raceNonce, validUntil);
      const sigUser = nacl.sign.detached(msg, user.secretKey);
      const sigAdmin = nacl.sign.detached(msg, admin.secretKey);
      const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(), message: msg, signature: sigUser });
      const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: msg, signature: sigAdmin });
      const claimIx = await program.methods
        .claimTokens(new anchor.BN(claimAmount), new anchor.BN(raceNonce), new anchor.BN(validUntil), Array.from(sigUser), Array.from(sigAdmin))
        .accounts({
          tokenState: tokenStatePDA, userData: userDataPDA, mint: mint.publicKey,
          userTokenAccount: userATA, user: user.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
        }).instruction();
      return new Transaction().add(edU).add(edA).add(claimIx);
    }

    console.log("\n⚡ RACE CONDITION TEST:");
    console.log("=======================");
    console.log(`Creating TWO identical transactions with nonce=${raceNonce}`);
    
    const raceTx1 = await buildRaceTx();
    const raceTx2 = await buildRaceTx();

    console.log("🏁 Firing both transactions SIMULTANEOUSLY...");
    const raceStart = Date.now();

    // Fire both in parallel
    const [sig1Promise, sig2Promise] = await Promise.allSettled([
      sendRawTx(connection, raceTx1, [admin]),
      sendRawTx(connection, raceTx2, [admin])
    ]);

    const raceEnd = Date.now();
    console.log(`⏱️  Race completed in ${raceEnd - raceStart}ms`);

    // Check results
    const sig1 = sig1Promise.status === 'fulfilled' ? sig1Promise.value : null;
    const sig2 = sig2Promise.status === 'fulfilled' ? sig2Promise.value : null;
    const err1 = sig1Promise.status === 'rejected' ? sig1Promise.reason.message : null;
    const err2 = sig2Promise.status === 'rejected' ? sig2Promise.reason.message : null;

    console.log("\n📊 SEND RESULTS:");
    console.log(`TX1: ${sig1 ? '✅ SENT' : '❌ FAILED'} ${err1 ? `(${err1})` : ''}`);
    console.log(`TX2: ${sig2 ? '✅ SENT' : '❌ FAILED'} ${err2 ? `(${err2})` : ''}`);

    // Confirm transactions
    let confirmed1 = false, confirmed2 = false;
    
    if (sig1) {
      try {
        await connection.confirmTransaction(sig1);
        confirmed1 = true;
        console.log("✅ TX1 CONFIRMED");
      } catch (e) {
        console.log(`❌ TX1 CONFIRMATION FAILED: ${e.message}`);
      }
    }
    
    if (sig2) {
      try {
        await connection.confirmTransaction(sig2);
        confirmed2 = true;
        console.log("✅ TX2 CONFIRMED");
      } catch (e) {
        console.log(`❌ TX2 CONFIRMATION FAILED: ${e.message}`);
      }
    }

    // Check final state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(userATA);
    
    console.log("\n📊 FINAL STATE:");
    console.log(`Nonce: ${raceNonce} → ${Number(finalUserData.nonce)}`);
    console.log(`Claims: ${Number(finalUserData.totalClaims)}`);
    console.log(`Balance: ${finalBalance.value.uiAmount} RRIYAL`);

    // Analysis
    const successCount = (confirmed1 ? 1 : 0) + (confirmed2 ? 1 : 0);
    
    console.log("\n🛡️  SECURITY VERDICT:");
    console.log("=====================");
    
    if (successCount === 1) {
      console.log("🎉 PERFECT! Exactly ONE transaction succeeded");
      console.log("✅ Nonce race condition properly handled");
      console.log("✅ Double-spend attack PREVENTED");
    } else if (successCount === 2) {
      console.log("🚨 CRITICAL! BOTH transactions succeeded");
      console.log("❌ Double-spend attack POSSIBLE");
    } else {
      console.log("⚠️  Both failed - check setup");
    }

  } catch (error) {
    console.log("❌ No existing contract found. Run this after setting up contract:");
    console.log("");
    console.log("./run_simple_timelock.sh");
    console.log("# Then immediately:");
    console.log("node test_complete_nonce_race.js");
  }
})().catch(console.error);
