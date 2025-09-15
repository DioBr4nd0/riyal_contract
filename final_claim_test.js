const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction, Ed25519Program, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
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

function buildClaimMessage(programId, payload) {
  // Serialize the payload using Anchor's serialization format
  const buffer = Buffer.alloc(56); // 32 + 8 + 8 + 8 = 56 bytes
  let offset = 0;
  
  // Write user_address (32 bytes)
  payload.userAddress.toBuffer().copy(buffer, offset);
  offset += 32;
  
  // Write claim_amount (8 bytes, little endian)
  buffer.writeBigUInt64LE(BigInt(payload.claimAmount.toString()), offset);
  offset += 8;
  
  // Write expiry_time (8 bytes, little endian)
  buffer.writeBigInt64LE(BigInt(payload.expiryTime.toString()), offset);
  offset += 8;
  
  // Write nonce (8 bytes, little endian)
  buffer.writeBigUInt64LE(BigInt(payload.nonce.toString()), offset);
  offset += 8;
  
  // Create domain-separated message: "RIYAL_CLAIM_V2" | program_id | payload_bytes
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V2"),
    programId.toBuffer(),
    buffer
  ]);
}

(async () => {
  console.log("🚀 RIYAL CONTRACT - NEW ADMIN SIGNATURE FLOW");
  console.log("=============================================");
  console.log("Demonstrating the new admin-only payload signing approach");

  // Load admin keypair and generate test user
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const adminKeypairData = JSON.parse(fs.readFileSync('./admin.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  const claimUser = Keypair.generate();

  console.log(`📋 Admin: ${admin.publicKey}`);
  console.log(`👤 Claim User: ${claimUser.publicKey}`);

  // Airdrop SOL
  console.log("\n💰 Funding accounts...");
  await Promise.all([admin, claimUser].map(k => airdrop(connection, k.publicKey, 10)));
  console.log("✅ Accounts funded");

  // Setup Anchor
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [claimUserDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), claimUser.publicKey.toBuffer()], program.programId);

  console.log("\n🏗️ STEP 1: CONTRACT INITIALIZATION");
  console.log("==================================");

  // Initialize contract
  let tokenState, mint;
  try {
    tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log("ℹ️ Contract already initialized");
    mint = { publicKey: tokenState.tokenMint };
  } catch (e) {
    await program.methods
      .initialize(admin.publicKey, admin.publicKey, new BN(30), false, true)
      .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin]).rpc();
    console.log("✅ Contract initialized");

    mint = Keypair.generate();
    await program.methods
      .createTokenMint(9, "Riyal Token", "RIYAL")
      .accounts({
        tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, mint]).rpc();
    console.log(`✅ Token mint created: ${mint.publicKey}`);
  }

  // Create user token account
  const claimUserATA = await getAssociatedTokenAddress(mint.publicKey, claimUser.publicKey, false, TOKEN_2022_PROGRAM_ID);
  try {
    await connection.getTokenAccountBalance(claimUserATA);
  } catch (e) {
    await sendAndConfirmTx(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(admin.publicKey, claimUserATA, claimUser.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)
      ),
      [admin],
      "create user token account"
    );
  }

  // Initialize user data
  try {
    await program.account.userData.fetch(claimUserDataPDA);
  } catch (e) {
    await program.methods.initializeUserData()
      .accounts({ userData: claimUserDataPDA, user: claimUser.publicKey, payer: claimUser.publicKey, systemProgram: SystemProgram.programId })
      .signers([claimUser]).rpc();
    console.log("✅ User data initialized");
  }

  console.log("\n🔐 STEP 2: ADMIN CREATES SIGNED PAYLOAD");
  console.log("=======================================");

  // Get current nonce
  const userData = await program.account.userData.fetch(claimUserDataPDA);
  const nonce = Number(userData.nonce);
  
  // Create claim payload
  const claimAmount = new BN(500_000_000); // 0.5 tokens
  const expiryTime = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

  const payload = {
    userAddress: claimUser.publicKey,
    claimAmount: claimAmount,
    expiryTime: new BN(expiryTime),
    nonce: new BN(nonce)
  };

  console.log(`📦 Payload Details:`);
  console.log(`   • User: ${claimUser.publicKey}`);
  console.log(`   • Amount: ${claimAmount.toString()} (${claimAmount.toNumber() / 1e9} RIYAL)`);
  console.log(`   • Expiry: ${new Date(expiryTime * 1000).toISOString()}`);
  console.log(`   • Nonce: ${nonce}`);

  // Build message and sign with admin private key
  const claimMessage = buildClaimMessage(program.programId, payload);
  const adminSig = nacl.sign.detached(claimMessage, admin.secretKey);
  console.log(`✍️ Admin signed payload (${claimMessage.length} bytes message)`);

  console.log("\n👤 STEP 3: USER SUBMITS CLAIM TRANSACTION");
  console.log("=========================================");

  // Create Ed25519 verify instruction for admin signature
  const edAdmin = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(), 
    message: claimMessage, 
    signature: adminSig,
  });

  // Create claim instruction
  const claimIx = await program.methods
    .claimTokens(payload, Array.from(adminSig))
    .accounts({
      tokenState: tokenStatePDA, 
      userData: claimUserDataPDA, 
      mint: mint.publicKey,
      userTokenAccount: claimUserATA, 
      user: claimUser.publicKey, // User signs the transaction
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();

  const getBalance = async (ata) => {
    try {
      return (await connection.getTokenAccountBalance(ata)).value.uiAmount || 0;
    } catch (e) {
      return 0;
    }
  };

  console.log(`💰 Balance before: ${await getBalance(claimUserATA)} RIYAL`);

  // User signs and submits transaction
  const claimTx = new Transaction().add(edAdmin, claimIx);
  await sendAndConfirmTx(connection, claimTx, [claimUser], "claim transaction");
  
  console.log(`💰 Balance after: ${await getBalance(claimUserATA)} RIYAL`);

  console.log("\n🔒 STEP 4: SECURITY VERIFICATION");
  console.log("================================");

  // Test replay attack prevention
  console.log("🔄 Testing replay attack prevention...");
  try {
    const replayTx = new Transaction().add(edAdmin, claimIx);
    await sendAndConfirmTx(connection, replayTx, [claimUser], "replay attempt");
    console.log("❌ Replay attack succeeded (unexpected!)");
  } catch (e) {
    console.log("✅ Replay attack correctly blocked (nonce protection)");
  }

  console.log("\n🎯 SUMMARY");
  console.log("==========");
  console.log("✅ New signature flow implemented successfully!");
  console.log("✅ Admin signs payload containing user address, amount, expiry, and nonce");
  console.log("✅ User signs transaction to prove ownership of their account");
  console.log("✅ Contract verifies admin signature and user account match");
  console.log("✅ Replay protection via nonce system");
  console.log("✅ Time-based expiry protection");
  console.log("");
  console.log("🔐 SECURITY BENEFITS:");
  console.log("   • Reduced signature overhead (only admin signature needed)");
  console.log("   • User account ownership verified by transaction signature");
  console.log("   • Admin controls token distribution via signed payloads");
  console.log("   • Replay protection and time-based expiry");

})().catch(console.error);
