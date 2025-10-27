#!/usr/bin/env node

/**
 * MAINNET CLAIM - Admin claims to own account
 */

const anchor = require("@coral-xyz/anchor");
const { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  SYSVAR_INSTRUCTIONS_PUBKEY, 
  Transaction, 
  Ed25519Program 
} = require("@solana/web3.js");
const { 
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');

// ========================================
// MAINNET CONFIGURATION
// ========================================
const PROGRAM_ID = "HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts";
const TOKEN_MINT = "5HCsUuCDLY5VhVjZD6A3fJw3poJ4b6q7HESh8FWLCFFw";
const RPC_URL = "https://api.mainnet-beta.solana.com";
const CLAIM_AMOUNT_TOKENS = 10000; // 10,000 MERCI tokens
const CLAIM_EXPIRY_MINUTES = 10;

// ========================================
// HELPER FUNCTIONS
// ========================================

function serializeClaimPayload(payload) {
  const buffer = Buffer.alloc(32 + 8 + 8 + 8);
  let offset = 0;
  payload.userAddress.toBuffer().copy(buffer, offset);
  offset += 32;
  buffer.writeBigUInt64LE(BigInt(payload.claimAmount.toString()), offset);
  offset += 8;
  buffer.writeBigInt64LE(BigInt(payload.expiryTime.toString()), offset);
  offset += 8;
  buffer.writeBigUInt64LE(BigInt(payload.nonce.toString()), offset);
  return buffer;
}

function createDomainSeparatedMessage(programId, payload) {
  const payloadBytes = serializeClaimPayload(payload);
  return Buffer.concat([
    Buffer.from("MERCLE_CLAIM_V1", 'utf8'),
    programId.toBuffer(),
    payloadBytes
  ]);
}

// ========================================
// MAIN FUNCTION
// ========================================
(async () => {
  console.log("🎯 MERCLE TOKEN MAINNET CLAIM (Admin Self-Claim)");
  console.log("=" .repeat(60));
  console.log("");

  try {
    // Load admin keypair (same as claimer)
    const adminKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync("./mainnet_deployer.json", "utf-8")))
    );
    
    console.log("🔑 ACCOUNTS:");
    console.log(`Admin/Claimer: ${adminKeypair.publicKey.toString()}`);
    console.log("");
    
    // Setup connection
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const wallet = new anchor.Wallet(adminKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    // Load program
    const programId = new PublicKey(PROGRAM_ID);
    let program;
    try {
      program = anchor.workspace.MercleToken;
    } catch (e) {
      const idl = JSON.parse(fs.readFileSync("./target/idl/mercle_token.json", "utf8"));
      program = new anchor.Program(idl, programId, provider);
    }

    console.log("📋 CONTRACT:");
    console.log(`Program ID: ${PROGRAM_ID}`);
    console.log(`Token Mint: ${TOKEN_MINT}`);
    console.log(`Network: ${RPC_URL}`);
    console.log("");

    // Check balance
    const balance = await connection.getBalance(adminKeypair.publicKey);
    console.log(`💰 Admin balance: ${(balance / anchor.web3.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    
    if (balance < 0.01 * anchor.web3.LAMPORTS_PER_SOL) {
      console.error("❌ Insufficient balance! Need at least 0.01 SOL");
      process.exit(1);
    }
    console.log("✅ Balance sufficient");
    console.log("");

    // Derive PDAs
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), adminKeypair.publicKey.toBuffer()],
      programId
    );

    const tokenMint = new PublicKey(TOKEN_MINT);
    const userTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      adminKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Initialize user data if needed
    let userData;
    try {
      userData = await program.account.userData.fetch(userDataPDA);
      console.log(`✅ Found user data, current nonce: ${userData.nonce.toNumber()}`);
    } catch (error) {
      console.log("🏗️  Initializing user data...");
      await program.methods
        .initializeUserData()
        .accounts({
          userData: userDataPDA,
          user: adminKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("✅ User data initialized");
      userData = await program.account.userData.fetch(userDataPDA);
    }

    // Create token account if needed
    try {
      await connection.getTokenAccountBalance(userTokenAccount);
      console.log("✅ Token account exists");
    } catch (error) {
      console.log("🏗️  Creating token account...");
      const createATAIx = createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        userTokenAccount,
        adminKeypair.publicKey,
        tokenMint,
        TOKEN_PROGRAM_ID
      );
      const createATATx = new Transaction().add(createATAIx);
      await provider.sendAndConfirm(createATATx, [adminKeypair]);
      console.log("✅ Token account created");
    }
    console.log("");

    // Prepare claim payload
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: adminKeypair.publicKey,
      claimAmount: new anchor.BN(CLAIM_AMOUNT_TOKENS * 1e9),
      expiryTime: new anchor.BN(currentTime + CLAIM_EXPIRY_MINUTES * 60),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    console.log("📝 CLAIM DETAILS:");
    console.log(`Amount: ${CLAIM_AMOUNT_TOKENS.toLocaleString()} tokens`);
    console.log(`Nonce: ${userData.nonce.toNumber()}`);
    console.log(`Expires: ${new Date((currentTime + CLAIM_EXPIRY_MINUTES * 60) * 1000).toLocaleString()}`);
    console.log("");

    // Create admin signature
    const messageBytes = createDomainSeparatedMessage(programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, adminKeypair.secretKey);
    console.log("🔐 Admin signature created");
    console.log("");

    // Get balance before
    const beforeBalance = await connection.getTokenAccountBalance(userTokenAccount);
    console.log("📊 BEFORE CLAIM:");
    console.log(`Balance: ${beforeBalance.value.uiAmount} tokens`);
    console.log("");

    // Create Ed25519 instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: adminKeypair.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });

    // Create claim instruction
    const [tokenStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      programId
    );

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(adminSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenMint,
        userTokenAccount: userTokenAccount,
        user: adminKeypair.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Build and send transaction
    console.log("🚀 SUBMITTING CLAIM TRANSACTION...");
    const tx = new Transaction().add(ed25519Ix).add(claimIx);
    const signature = await provider.sendAndConfirm(tx, [adminKeypair]);
    console.log(`Transaction: ${signature}`);
    console.log("");

    // Wait a bit for confirmation
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get balance after
    const afterBalance = await connection.getTokenAccountBalance(userTokenAccount);
    const updatedUserData = await program.account.userData.fetch(userDataPDA);

    console.log("🎉 CLAIM SUCCESSFUL!");
    console.log("📊 RESULTS:");
    console.log(`Balance Before: ${beforeBalance.value.uiAmount} tokens`);
    console.log(`Balance After: ${afterBalance.value.uiAmount} tokens`);
    console.log(`Tokens Claimed: ${afterBalance.value.uiAmount - beforeBalance.value.uiAmount}`);
    console.log(`Nonce: ${userData.nonce.toNumber()} → ${updatedUserData.nonce.toNumber()}`);
    console.log(`Total Claims: ${updatedUserData.totalClaims.toNumber()}`);
    console.log("");
    console.log("✅ CLAIM COMPLETED SUCCESSFULLY");
    console.log("");

    // View on explorer
    console.log("🔗 View on Solscan:");
    console.log(`https://solscan.io/tx/${signature}`);
    console.log("");

  } catch (error) {
    console.log("\n❌ CLAIM FAILED:");
    console.log(error.message);
    
    if (error.logs) {
      console.log("\n📋 Transaction Logs:");
      error.logs.forEach(log => console.log(log));
    }
    
    process.exit(1);
  }
})();

