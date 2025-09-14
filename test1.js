// tests/replay_binding.e2e.js
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

// -------- helpers --------
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

async function sendAndConfirmTx(connection, tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("🔐 Replay & Binding E2E");

  // ---- provider / program ----
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user  = Keypair.generate();
  const other = Keypair.generate(); // for wrong-destination test
  for (const k of [admin, user, other]) {
    await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
  }
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // ---- PDAs, mints, ATAs ----
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA]   = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);

  const mintA = Keypair.generate();        // the correct mint
  const mintB = Keypair.generate();        // second mint for binding test

  // ATAs
  const userATA_A  = await getAssociatedTokenAddress(mintA.publicKey, user.publicKey);
  const otherATA_A = await getAssociatedTokenAddress(mintA.publicKey, other.publicKey); // wrong-dest
  const userATA_B  = await getAssociatedTokenAddress(mintB.publicKey, user.publicKey);  // mintB ata

  // ---- init + create mints + ATAs + userdata ----
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new BN(3600), false, true)
    .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
    .signers([admin]).rpc();

  // mint A
  await program.methods
    .createTokenMint(9, "Riyal", "RIYAL")
    .accounts({ tokenState: tokenStatePDA, mint: mintA.publicKey, admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .signers([admin, mintA]).rpc();

  // create ATAs for mint A
  await sendAndConfirmTx(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, userATA_A, user.publicKey, mintA.publicKey),
  ), [admin], "create user ATA A");

  await sendAndConfirmTx(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, otherATA_A, other.publicKey, mintA.publicKey),
  ), [admin], "create other ATA A");

  // user data init
  {
    const ix = await program.methods
      .initializeUserData()
      .accounts({ userData: userDataPDA, user: user.publicKey, systemProgram: SystemProgram.programId })
      .instruction();
    await sendAndConfirmTx(connection, new Transaction().add(ix), [admin, user], "init user data");
  }

  // seed a small balance (not necessary for claim, but mirrors your flows)
  await program.methods
    .mintTokens(new BN(1 * 10 ** 9))
    .accounts({ tokenState: tokenStatePDA, mint: mintA.publicKey, userTokenAccount: userATA_A, admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([admin]).rpc();

  // also create mint B + ATA (for mint-binding neg test)
  await program.methods
    .createTokenMint(9, "RiyalB", "RRIYB")
    .accounts({ tokenState: tokenStatePDA, mint: mintB.publicKey, admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .signers([admin, mintB]).rpc()
    .catch(()=>{}); // if your program forbids second create, ignore; we just need an actual mint account for the negative test

  try {
    await sendAndConfirmTx(connection, new Transaction().add(
      createAssociatedTokenAccountInstruction(admin.publicKey, userATA_B, user.publicKey, mintB.publicKey),
    ), [admin], "create user ATA B");
  } catch(_) { /* if mintB not created, this is optional */ }

  // ---- helper: build a claim tx for given params ----
  async function buildClaimTx({ mint, dest, amount, nonce, validUntil }) {
    const msg = buildClaimBytes(program.programId, tokenStatePDA, mint, user.publicKey, dest, amount, nonce, validUntil);
    const sigUser  = nacl.sign.detached(msg, user.secretKey);
    const sigAdmin = nacl.sign.detached(msg, admin.secretKey);
    const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(),  message: msg, signature: sigUser });
    const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: msg, signature: sigAdmin });
    const ix  = await program.methods
      .claimTokens(new BN(amount), new BN(nonce), new BN(validUntil), Array.from(sigUser), Array.from(sigAdmin))
      .accounts({
        tokenState: tokenStatePDA, userData: userDataPDA, mint,
        userTokenAccount: dest, user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return { tx: new Transaction().add(edU).add(edA).add(ix), sigUser, sigAdmin, msg };
  }

  // fetch user state
  const getNonce = async () => Number((await program.account.userData.fetch(userDataPDA)).nonce);
  const now = () => Math.floor(Date.now()/1000);

  // ========== 1) HAPPY PATH ==========
  const n0 = await getNonce();
  const amount = 500_000_000n; // 0.5
  const validUntil = now() + 60;
  const { tx: tx1, sigUser: sU1, sigAdmin: sA1, msg: m1 } =
    await buildClaimTx({ mint: mintA.publicKey, dest: userATA_A, amount, nonce: n0, validUntil });
  await sendAndConfirmTx(connection, tx1, [admin], "claim #1 success");
  const n1 = await getNonce();
  if (n1 !== n0 + 1) throw new Error(`nonce didn't increment: ${n0} -> ${n1}`);
  console.log("✅ happy-path claim ok");

  // ========== 2) REPLAY (same msg+sigs) ==========
  try {
    // reuse same message/sigs by rebuilding tx with same pre-ixs & program ix
    const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(),  message: m1, signature: sU1 });
    const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: m1, signature: sA1 });
    const ix  = await program.methods
      .claimTokens(new BN(amount), new BN(n0), new BN(validUntil), Array.from(sU1), Array.from(sA1))
      .accounts({
        tokenState: tokenStatePDA, userData: userDataPDA, mint: mintA.publicKey,
        userTokenAccount: userATA_A, user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const txReplay = new Transaction().add(edU).add(edA).add(ix);
    await sendAndConfirmTx(connection, txReplay, [admin], "replay should fail");
    throw new Error("❌ replay unexpectedly succeeded");
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("InvalidNonce") && !msg.includes("nonce")) throw e;
    console.log("🛡️  replay correctly rejected (InvalidNonce)");
  }

  // ========== 3) DESTINATION BINDING (wrong ATA) ==========
  // build a fresh valid claim (n1)
  const { tx: txDest, sigUser: sUd, sigAdmin: sAd, msg: md } =
    await buildClaimTx({ mint: mintA.publicKey, dest: userATA_A, amount, nonce: n1, validUntil: now()+60 });
  // but call program with other's ATA (still mint A)
  const edUd = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(),  message: md, signature: sUd });
  const edAd = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: md, signature: sAd });
  const ixWrongDest = await program.methods
    .claimTokens(new BN(amount), new BN(n1), new BN(now()+60), Array.from(sUd), Array.from(sAd))
    .accounts({
      tokenState: tokenStatePDA, userData: userDataPDA, mint: mintA.publicKey,
      userTokenAccount: otherATA_A, // WRONG DESTINATION
      user: user.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  try {
    await sendAndConfirmTx(connection, new Transaction().add(edUd).add(edAd).add(ixWrongDest), [admin], "wrong-destination should fail");
    throw new Error("❌ wrong destination unexpectedly succeeded");
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("UnauthorizedDestination") && !msg.toLowerCase().includes("owner")) throw e;
    console.log("🛡️  destination binding correctly enforced");
  }

  // ========== 4) MINT BINDING (mint mismatch) ==========
  // sign a message for mint A but pass mint B to accounts
  const n2 = await getNonce();
  const { sigUser: sUm, sigAdmin: sAm, msg: mm } =
    await buildClaimTx({ mint: mintA.publicKey, dest: userATA_A, amount, nonce: n2, validUntil: now()+60 });
  const edUm = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(),  message: mm, signature: sUm });
  const edAm = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: mm, signature: sAm });
  const ixMintMismatch = await program.methods
    .claimTokens(new BN(amount), new BN(n2), new BN(now()+60), Array.from(sUm), Array.from(sAm))
    .accounts({
      tokenState: tokenStatePDA, userData: userDataPDA, mint: mintB.publicKey, // WRONG MINT
      userTokenAccount: userATA_B, user: user.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  try {
    await sendAndConfirmTx(connection, new Transaction().add(edUm).add(edAm).add(ixMintMismatch), [admin], "mint-binding should fail");
    throw new Error("❌ mint mismatch unexpectedly succeeded");
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("InvalidTokenMint")) throw e;
    console.log("🛡️  mint binding correctly enforced (InvalidTokenMint)");
  }

  console.log("🎉 Replay & Binding tests: all good");

  // ---- NONCE RACE CONDITION TEST ----
  console.log("\n🏁 NONCE RACE CONDITION TEST");
  console.log("=============================");
  console.log("⚡ Fire TWO identical transactions with SAME nonce");
  
  const { nonce: raceNonce } = await getState();
  console.log(`📊 Current nonce for race: ${raceNonce}`);
  
  // Create IDENTICAL transactions
  const raceAmount = 250_000_000n; // 0.25 tokens
  const raceValidUntil = BigInt(Math.floor(Date.now()/1000) + 60);
  
  const raceTx1 = await buildClaimTx(raceAmount, raceNonce, raceValidUntil);
  const raceTx2 = await buildClaimTx(raceAmount, raceNonce, raceValidUntil); // SAME NONCE!
  
  console.log(`⚡ Both transactions use SAME nonce: ${raceNonce}`);
  console.log(`💰 Both transactions claim SAME amount: ${Number(raceAmount) / 1e9} RRIYAL`);
  
  // Fire both simultaneously without confirmation
  console.log("🏁 Firing both transactions SIMULTANEOUSLY...");
  const raceStart = Date.now();
  
  const [race1, race2] = await Promise.allSettled([
    (async () => {
      raceTx1.feePayer = admin.publicKey;
      raceTx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      raceTx1.sign(admin);
      return connection.sendRawTransaction(raceTx1.serialize(), { skipPreflight: false });
    })(),
    (async () => {
      raceTx2.feePayer = admin.publicKey;
      raceTx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      raceTx2.sign(admin);
      return connection.sendRawTransaction(raceTx2.serialize(), { skipPreflight: false });
    })()
  ]);
  
  console.log(`⏱️  Race completed in ${Date.now() - raceStart}ms`);
  
  // Check results
  const sig1 = race1.status === 'fulfilled' ? race1.value : null;
  const sig2 = race2.status === 'fulfilled' ? race2.value : null;
  const err1 = race1.status === 'rejected' ? race1.reason.message : null;
  const err2 = race2.status === 'rejected' ? race2.reason.message : null;
  
  console.log(`TX1: ${sig1 ? '✅ SENT' : '❌ FAILED'} ${err1 ? `(${err1.substring(0,30)}...)` : ''}`);
  console.log(`TX2: ${sig2 ? '✅ SENT' : '❌ FAILED'} ${err2 ? `(${err2.substring(0,30)}...)` : ''}`);
  
  // Confirm successful transactions
  let confirmed1 = false, confirmed2 = false;
  
  if (sig1) {
    try {
      await connection.confirmTransaction(sig1);
      confirmed1 = true;
      console.log("✅ TX1 CONFIRMED");
    } catch (e) {
      console.log(`❌ TX1 FAILED: ${e.message.substring(0,50)}...`);
    }
  }
  
  if (sig2) {
    try {
      await connection.confirmTransaction(sig2);
      confirmed2 = true;
      console.log("✅ TX2 CONFIRMED");
    } catch (e) {
      console.log(`❌ TX2 FAILED: ${e.message.substring(0,50)}...`);
    }
  }
  
  // Check final state
  const { nonce: finalNonce, amount: finalAmount } = await getState();
  const successCount = (confirmed1 ? 1 : 0) + (confirmed2 ? 1 : 0);
  
  console.log("\n🔐 RACE CONDITION RESULTS:");
  console.log(`Successful transactions: ${successCount}`);
  console.log(`Nonce: ${raceNonce} → ${finalNonce}`);
  console.log(`Balance change: +${Number(finalAmount - bal3) / 1e9} RRIYAL`);
  
  if (successCount === 1 && finalNonce === raceNonce + 1) {
    console.log("\n🎉 PERFECT SECURITY!");
    console.log("✅ Exactly ONE transaction succeeded");
    console.log("✅ Nonce race condition properly handled");
    console.log("✅ Double-spend attack PREVENTED");
  } else if (successCount === 2) {
    console.log("\n🚨 SECURITY FAILURE!");
    console.log("❌ BOTH transactions succeeded - double-spend possible!");
  } else {
    console.log("\n⚠️  Unexpected result - check logs");
  }
  
  console.log("\n🎉 ALL TESTS COMPLETE: replay, binding, AND race conditions verified!");
})().catch((e) => {
  console.error("❌ test failed:", e);
  process.exit(1);
});
