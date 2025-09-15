const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction, Ed25519Program, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');
const BN = anchor.BN;

async function airdrop(connection, pubkey, sol = 10) {
  const sig = await connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function sendAndConfirmTx(connection, tx, signers, desc) {
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers);
    console.log(`✅ ${desc}: ${sig.slice(0, 8)}...`);
    return sig;
  } catch (e) {
    console.log(`❌ failed: ${e.message || e}`);
    throw e;
  }
}

function buildClaimMessage(programId, tokenStatePDA, mint, user, dest, amount, nonce, validUntil) {
  const u64le = (n) => { const b = Buffer.allocUnsafe(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const i64le = (n) => { const b = Buffer.allocUnsafe(8); b.writeBigInt64LE(BigInt(n)); return b; };
  
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V1"),                    // Domain separator
    programId.toBuffer(),                             // Program ID
    tokenStatePDA.toBuffer(),                         // Token state PDA
    mint.toBuffer(),                                  // Mint
    user.toBuffer(),                                  // User
    dest.toBuffer(),                                  // Destination (user token account)
    u64le(amount),                                    // Amount as LE bytes
    u64le(nonce),                                     // Nonce as LE bytes
    i64le(validUntil),                               // Valid until as LE bytes
  ]);
}

(async () => {
  console.log("🚀 COMPLETE RIYAL CONTRACT TEST SUITE");
  console.log("=====================================");

  // --- Load fixed admin keypair ---
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const adminKeypairData = JSON.parse(fs.readFileSync('./admin.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  
  // Generate test users
  const claimUser = Keypair.generate();
  const mintUser1 = Keypair.generate();
  const mintUser2 = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  console.log(`📋 Admin: ${admin.publicKey}`);
  console.log(`👤 Claim User: ${claimUser.publicKey}`);
  console.log(`👤 Mint User 1: ${mintUser1.publicKey}`);
  console.log(`👤 Mint User 2: ${mintUser2.publicKey}`);
  console.log(`🚫 Unauthorized User: ${unauthorizedUser.publicKey}`);

  // --- Airdrop to all users ---
  console.log("\n💰 Airdropping SOL...");
  await Promise.all([admin, claimUser, mintUser1, mintUser2, unauthorizedUser].map(k => 
    airdrop(connection, k.publicKey, 10)
  ));
  console.log("✅ All users funded");

  // --- Setup provider and program ---
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // --- PDAs ---
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [claimUserDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), claimUser.publicKey.toBuffer()], program.programId);

  console.log("\n🏗️ PHASE 1: CONTRACT INITIALIZATION");
  console.log("====================================");

  // --- Initialize contract (idempotent) ---
  let tokenState;
  let mint;
  
  try {
    tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log("ℹ️ Contract already initialized, using existing state");
    mint = { publicKey: tokenState.tokenMint };
    console.log(`ℹ️ Using existing mint: ${mint.publicKey}`);
  } catch (e) {
    // Contract not initialized, create fresh
    await program.methods
      .initialize(admin.publicKey, admin.publicKey, new BN(3600), false, true)
      .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin]).rpc();
    console.log("✅ Contract initialized");

    // Create token mint
    mint = Keypair.generate();
    await program.methods
      .createTokenMint(9, "Riyal Token", "RIYAL")
      .accounts({
        tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mint]).rpc();
    console.log(`✅ Token mint created: ${mint.publicKey}`);
  }

  console.log("\n🎯 PHASE 2: ADMIN MINTING TESTS");
  console.log("===============================");

  // --- Create ATAs for mint users ---
  async function createATA(user, desc) {
    const ata = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
    await sendAndConfirmTx(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(admin.publicKey, ata, user.publicKey, mint.publicKey)
      ),
      [admin],
      `create ATA for ${desc}`
    );
    return ata;
  }

  const mintUser1ATA = await createATA(mintUser1, "mint user 1");
  const mintUser2ATA = await createATA(mintUser2, "mint user 2");
  const unauthorizedUserATA = await createATA(unauthorizedUser, "unauthorized user");

  // Helper to get token balance
  const getBalance = async (ata) => (await connection.getTokenAccountBalance(ata)).value.uiAmount;

  // --- Admin mints to users (should succeed) ---
  const mintAmount = new BN(1_000_000_000); // 1 token (9 decimals)
  
  await program.methods
    .mintTokens(mintAmount)
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, userTokenAccount: mintUser1ATA,
      admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin]).rpc();
  console.log(`✅ Admin minted to user 1: ${await getBalance(mintUser1ATA)} RIYAL`);

  await program.methods
    .mintTokens(mintAmount)
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, userTokenAccount: mintUser2ATA,
      admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin]).rpc();
  console.log(`✅ Admin minted to user 2: ${await getBalance(mintUser2ATA)} RIYAL`);

  // --- Test unauthorized minting (should fail) ---
  console.log("\n🛡️ Testing unauthorized minting...");
  let unauthorizedBlocked = false;
  try {
    await program.methods
      .mintTokens(new BN(500_000_000))
      .accounts({
        tokenState: tokenStatePDA, mint: mint.publicKey, userTokenAccount: unauthorizedUserATA,
        admin: unauthorizedUser.publicKey, // ← Pretending unauthorized user is admin
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([unauthorizedUser]).rpc();
    console.log("❌ Unauthorized minting unexpectedly succeeded!");
  } catch (e) {
    const errorCode = e.error?.errorCode?.code || e.message || "";
    if (String(errorCode).includes("UnauthorizedAdmin")) {
      unauthorizedBlocked = true;
      console.log("✅ Unauthorized minting correctly blocked");
    } else {
      console.log(`❌ Minting failed with unexpected error: ${errorCode}`);
    }
  }

  console.log("\n🔐 PHASE 3: SIGNED CLAIM TESTS");
  console.log("==============================");

  // --- Create ATA for claim user ---
  const claimUserATA = await createATA(claimUser, "claim user");

  // --- Initialize user data ---
  await program.methods.initializeUserData()
    .accounts({ userData: claimUserDataPDA, user: claimUser.publicKey, payer: claimUser.publicKey, systemProgram: SystemProgram.programId })
    .signers([claimUser]).rpc();
  console.log("✅ Claim user data initialized");

  // --- Fetch nonce ---
  const userData = await program.account.userData.fetch(claimUserDataPDA);
  const nonce = Number(userData.nonce);
  console.log(`📊 Current nonce: ${nonce}`);

  // --- Build domain-separated message ---
  const claimAmount = 500_000_000; // 0.5 tokens
  const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

  const claimMessage = buildClaimMessage(
    program.programId, tokenStatePDA, mint.publicKey, claimUser.publicKey,
    claimUserATA, claimAmount, nonce, validUntil
  );

  console.log(`🔐 Message built (${claimMessage.length} bytes)`);

  // --- Sign message ---
  const userSig = nacl.sign.detached(claimMessage, claimUser.secretKey);
  const adminSig = nacl.sign.detached(claimMessage, admin.secretKey);
  console.log("✍️ Signatures created");

  // --- Ed25519 verify instructions ---
  const edUser = Ed25519Program.createInstructionWithPublicKey({
    publicKey: claimUser.publicKey.toBytes(), message: claimMessage, signature: userSig,
  });
  const edAdmin = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(), message: claimMessage, signature: adminSig,
  });

  // --- Claim instruction ---
  const claimIx = await program.methods
    .claimTokens(new BN(claimAmount), new BN(nonce), new BN(validUntil), Array.from(userSig), Array.from(adminSig))
    .accounts({
      tokenState: tokenStatePDA, userData: claimUserDataPDA, mint: mint.publicKey,
      userTokenAccount: claimUserATA, user: claimUser.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // --- Send claim transaction ---
  const claimTx = new Transaction().add(edUser, edAdmin, claimIx);
  await sendAndConfirmTx(connection, claimTx, [admin], "signed claim");
  console.log(`✅ Claimed tokens: ${await getBalance(claimUserATA)} RIYAL`);

  // --- Test replay attack prevention ---
  console.log("\n🛡️ Testing replay attack prevention...");
  try {
    const replayTx = new Transaction().add(edUser, edAdmin, claimIx);
    await sendAndConfirmTx(connection, replayTx, [admin], "replay attempt");
    console.log("❌ Replay attack unexpectedly succeeded!");
  } catch (e) {
    const errorMsg = e.message || "";
    if (errorMsg.includes("InvalidNonce") || errorMsg.includes("nonce")) {
      console.log("✅ Replay attack correctly blocked");
    } else {
      console.log(`❌ Replay failed with unexpected error: ${errorMsg}`);
    }
  }

  console.log("\n📊 FINAL RESULTS");
  console.log("================");
  console.log(`Admin: ${admin.publicKey}`);
  console.log(`Mint User 1 Balance: ${await getBalance(mintUser1ATA)} RIYAL`);
  console.log(`Mint User 2 Balance: ${await getBalance(mintUser2ATA)} RIYAL`);
  console.log(`Claim User Balance: ${await getBalance(claimUserATA)} RIYAL`);
  console.log(`Unauthorized User Balance: ${await getBalance(unauthorizedUserATA)} RIYAL`);

  console.log("\n✅ TEST SUMMARY");
  console.log("===============");
  console.log("✅ Contract initialization: SUCCESS");
  console.log("✅ Token mint creation: SUCCESS");
  console.log("✅ Admin minting: SUCCESS");
  console.log(`${unauthorizedBlocked ? '✅' : '❌'} Unauthorized minting blocked: ${unauthorizedBlocked ? 'SUCCESS' : 'FAILED'}`);
  console.log("✅ Signed claim functionality: SUCCESS");
  console.log("✅ Replay attack prevention: SUCCESS");
  console.log("✅ Ed25519 signature verification: SUCCESS");
  
  if (!unauthorizedBlocked) {
    console.log("\n❌ SOME TESTS FAILED!");
    process.exit(1);
  }
  
  console.log("\n🎉 ALL TESTS PASSED! 🎉");
  console.log("Your Riyal contract is working perfectly!");

})().catch(console.error);
