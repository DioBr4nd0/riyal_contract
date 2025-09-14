// FUCK THE COMPLEX SETUP - SIMPLE RACE TEST
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

async function sendAndConfirmTx(connection, tx, signers) {
  tx.feePayer = signers[0].publicKey;
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

(async () => {
  console.log("🏁 SIMPLE RACE TEST");
  
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user = Keypair.generate();
  
  for (const k of [admin, user]) {
    await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
  }
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);
  const mint = Keypair.generate();

  // Setup (using working pattern from your tests)
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new anchor.BN(3600), false, true)
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
  await sendAndConfirmTx(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, userATA, user.publicKey, mint.publicKey)
  ), [admin]);

  // User data init (the tricky part)
  const ix = await program.methods
    .initializeUserData()
    .accounts({ userData: userDataPDA, user: user.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  await sendAndConfirmTx(connection, new Transaction().add(ix), [admin, user]);

  console.log("✅ Setup done");

  // Get nonce
  const userData = await program.account.userData.fetch(userDataPDA);
  const nonce = Number(userData.nonce);
  console.log(`Current nonce: ${nonce}`);

  // Create race transactions
  async function buildClaimTx(amount, n, validUntil) {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const msg = buildClaimBytes(program.programId, tokenStatePDA, tokenState.tokenMint, user.publicKey, userATA, amount, n, validUntil);
    const sigUser = nacl.sign.detached(msg, user.secretKey);
    const sigAdmin = nacl.sign.detached(msg, admin.secretKey);
    const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(), message: msg, signature: sigUser });
    const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: msg, signature: sigAdmin });
    const claimIx = await program.methods
      .claimTokens(new anchor.BN(amount), new anchor.BN(n), new anchor.BN(validUntil), Array.from(sigUser), Array.from(sigAdmin))
      .accounts({
        tokenState: tokenStatePDA, userData: userDataPDA, mint: mint.publicKey,
        userTokenAccount: userATA, user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      }).instruction();
    return new Transaction().add(edU).add(edA).add(claimIx);
  }

  const amount = 500_000_000;
  const validUntil = Math.floor(Date.now()/1000) + 60;
  
  const tx1 = await buildClaimTx(amount, nonce, validUntil);
  const tx2 = await buildClaimTx(amount, nonce, validUntil); // SAME NONCE!

  console.log(`🏁 RACE: Both use nonce=${nonce}`);

  // Fire both
  const [r1, r2] = await Promise.allSettled([
    (async () => {
      tx1.feePayer = admin.publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx1.sign(admin);
      return connection.sendRawTransaction(tx1.serialize());
    })(),
    (async () => {
      tx2.feePayer = admin.publicKey;
      tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx2.sign(admin);
      return connection.sendRawTransaction(tx2.serialize());
    })()
  ]);

  const sig1 = r1.status === 'fulfilled' ? r1.value : null;
  const sig2 = r2.status === 'fulfilled' ? r2.value : null;

  console.log(`TX1: ${sig1 ? '✅' : '❌'}`);
  console.log(`TX2: ${sig2 ? '✅' : '❌'}`);

  // Confirm
  let c1 = false, c2 = false;
  if (sig1) {
    try { await connection.confirmTransaction(sig1); c1 = true; } catch (e) { console.log(`TX1 conf fail: ${e.message.substring(0,30)}`); }
  }
  if (sig2) {
    try { await connection.confirmTransaction(sig2); c2 = true; } catch (e) { console.log(`TX2 conf fail: ${e.message.substring(0,30)}`); }
  }

  const final = await program.account.userData.fetch(userDataPDA);
  const finalBal = await connection.getTokenAccountBalance(userATA);
  
  console.log(`\n📊 RESULT:`);
  console.log(`Confirmed: ${(c1?1:0) + (c2?1:0)}`);
  console.log(`Nonce: ${nonce} → ${Number(final.nonce)}`);
  console.log(`Balance: ${finalBal.value.uiAmount} RRIYAL`);

  if ((c1?1:0) + (c2?1:0) === 1) {
    console.log("🎉 SECURITY SUCCESS! Only one succeeded");
  } else {
    console.log("❌ Security issue or setup problem");
  }

})().catch(console.error);
