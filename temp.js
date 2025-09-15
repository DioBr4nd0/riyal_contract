// claim_with_json_message_fixed.js
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const BN = anchor.BN;

async function airdrop(connection, pk, sol = 10) {
  const sig = await connection.requestAirdrop(pk, sol * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function sendAndConfirmTx(connection, tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
  console.log(`✅ ${label}: ${sig}`);
  return sig;
}

(async () => {
  console.log("🧪 Claim with JSON message (fixed)");

  // --- provider / program ---
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user  = Keypair.generate();

  await Promise.all([admin, user].map(k => airdrop(connection, k.publicKey)));

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract; // make sure Anchor.toml name matches

  // --- PDAs ---
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA]   = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);

  // --- init (idempotent guard) ---
  const stateExists = await connection.getAccountInfo(tokenStatePDA);
  if (!stateExists) {
    await program.methods
      .initialize(admin.publicKey, admin.publicKey, new BN(3600), false, true)
      .accounts({
        tokenState: tokenStatePDA,          // 🔴 REQUIRED
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    console.log("✅ initialized");
  } else {
    console.log("ℹ️ token_state already exists — skipping initialize");
  }

  // --- create mint (idempotent-ish; if your program forbids second run, wrap in try/catch) ---
  const mint = Keypair.generate();
  try {
    await program.methods
      .createTokenMint(9, "Riyal Token", "RRIYAL")
      .accounts({
        tokenState: tokenStatePDA,          // 🔴 REQUIRED
        mint: mint.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mint])
      .rpc();
    console.log("✅ mint created");
  } catch (e) {
    // if already created earlier, you can load it instead; for simplicity we rethrow non-guard errors
    if (!`${e.message}`.includes("TokenMintAlreadyCreated")) throw e;
    console.log("ℹ️ mint already created — using existing");
  }

  // --- user ATA + user_data ---
  const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
  const ataInfo = await connection.getAccountInfo(userATA);
  if (!ataInfo) {
    await sendAndConfirmTx(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey, userATA, user.publicKey, mint.publicKey
        )
      ),
      [admin],
      "create user ATA"
    );
  } else {
    console.log("ℹ️ user ATA exists — skipping");
  }

  const userDataInfo = await connection.getAccountInfo(userDataPDA);
  if (!userDataInfo) {
    const initUdIx = await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await sendAndConfirmTx(connection, new Transaction().add(initUdIx), [admin, user], "init user_data PDA");
  } else {
    console.log("ℹ️ user_data exists — skipping");
  }

  // --- fetch nonce ---
  const userData = await program.account.userData.fetch(userDataPDA);
  const nonce = Number(userData.nonce);

  // --- build EXACT binary domain-separated message ---
  const amountUi = 0.5;                           // 0.5 tokens (9 dp)
  const amount = Math.floor(amountUi * 1e9);      // integer amount
  const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now
  
  // Helper functions for little-endian encoding
  const u64le = (n) => { const b = Buffer.allocUnsafe(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const i64le = (n) => { const b = Buffer.allocUnsafe(8); b.writeBigInt64LE(BigInt(n)); return b; };
  
  // Build domain-separated binary message exactly as contract expects:
  // "RIYAL_CLAIM_V1" | program_id | token_state_pda | mint | user | destination | amount | nonce | valid_until
  const msgBytes = Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V1"),                    // Domain separator
    program.programId.toBuffer(),                     // Program ID
    tokenStatePDA.toBuffer(),                         // Token state PDA
    mint.publicKey.toBuffer(),                        // Mint
    user.publicKey.toBuffer(),                        // User
    userATA.toBuffer(),                               // Destination (user token account)
    u64le(amount),                                    // Amount as LE bytes
    u64le(nonce),                                     // Nonce as LE bytes
    i64le(validUntil),                               // Valid until as LE bytes
  ]);

  // --- sign by user + admin ---
  const userSig  = nacl.sign.detached(msgBytes, user.secretKey);   // 64 bytes
  const adminSig = nacl.sign.detached(msgBytes, admin.secretKey);  // 64 bytes

  // --- Ed25519 pre-instructions ---
  const edU = Ed25519Program.createInstructionWithPublicKey({
    publicKey: user.publicKey.toBytes(),
    message: msgBytes,
    signature: userSig,
  });
  const edA = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(),
    message: msgBytes,
    signature: adminSig,
  });

  // --- claim instruction ---
  const claimIx = await program.methods
    .claimTokens(
      new BN(amount),              // amount (u64)
      new BN(nonce),               // nonce
      new BN(validUntil),          // valid_until (i64)
      Array.from(userSig),         // user_signature [u8;64]
      Array.from(adminSig)         // admin_signature [u8;64]
    )
    .accounts({
      tokenState: tokenStatePDA,               // 🔴 REQUIRED
      userData:   userDataPDA,
      mint:       mint.publicKey,
      userTokenAccount: userATA,
      user:       user.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, // 🔴 REQUIRED for introspection
      tokenProgram:  TOKEN_PROGRAM_ID,
    })
    .instruction();

  // --- send: [ed25519 user] + [ed25519 admin] + [claim] ---
  await sendAndConfirmTx(connection, new Transaction().add(edU, edA, claimIx), [admin], "claim tokens");

  // --- verify ---
  const userDataAfter = await program.account.userData.fetch(userDataPDA);
  const bal = await connection.getTokenAccountBalance(userATA);

  console.log("🎉 CLAIM SUCCESS");
  console.log("  JSON message:", jsonMessage);
  console.log("  New nonce:   ", userDataAfter.nonce.toString());
  console.log("  Total claims:", userDataAfter.totalClaims.toString());
  console.log("  User balance:", bal.value.uiAmount, "RRIYAL");
})().catch((e) => {
  console.error("❌ failed:", e);
  process.exit(1);
});
