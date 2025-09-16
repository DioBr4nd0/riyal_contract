#!/usr/bin/env node

/**
 * RIYAL TOKEN CLAIM SCRIPT
 * 
 * General-purpose script for claiming tokens with signature verification.
 * Configure the variables below and run to claim tokens for any user.
 * 
 * USAGE:
 * 1. Set the claimer's public/private key
 * 2. Set the admin's private key path or array
 * 3. Configure claim amount and other parameters
 * 4. Run: node claim-tokens.js
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
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');

// ========================================
// CONFIGURATION - MODIFY THESE VARIABLES
// ========================================

// Claimer's keypair (the user receiving tokens)
// const CLAIMER_PUBLIC_KEY = "PASTE_CLAIMER_PUBLIC_KEY_HERE";
const CLAIMER_PRIVATE_KEY = [110,67,129,81,146,208,14,255,148,122,11,99,153,236,59,6,230,18,81,60,74,204,141,225,255,217,5,128,202,131,23,255,177,246,100,202,146,216,58,133,198,66,182,227,93,211,230,195,31,81,219,194,159,123,82,2,245,2,117,169,200,115,61,34];

// Admin's private key (can be file path or array)
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json"; // or use array: [1,2,3,...]

// Claim parameters
const CLAIM_AMOUNT_TOKENS = 100; // Amount in tokens (will be converted to base units)
const CLAIM_EXPIRY_MINUTES = 5;  // How long the claim is valid for
const NONCE = 1; // Set the nonce (usually get from user data first)

// Network
const RPC_URL = "https://api.devnet.solana.com";

// Minimum SOL balance required for transactions
const MIN_BALANCE_SOL = 0.1;
const FUNDING_AMOUNT_SOL = 0.5;

// ========================================
// HELPER FUNCTIONS
// ========================================

// Load admin keypair from file path or array
function loadAdminKeypair() {
  if (typeof ADMIN_KEY_SOURCE === 'string') {
    try {
      const data = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
      return Keypair.fromSecretKey(new Uint8Array(data));
    } catch (error) {
      console.error(`Failed to load admin keypair from ${ADMIN_KEY_SOURCE}`);
      throw error;
    }
  } else if (Array.isArray(ADMIN_KEY_SOURCE)) {
    return Keypair.fromSecretKey(new Uint8Array(ADMIN_KEY_SOURCE));
  } else {
    throw new Error("ADMIN_KEY_SOURCE must be a file path string or private key array");
  }
}

// Load claimer keypair from configuration
function loadClaimerKeypair() {
  // if (!CLAIMER_PUBLIC_KEY || !CLAIMER_PRIVATE_KEY.length) {
  //   throw new Error("Please configure CLAIMER_PUBLIC_KEY and CLAIMER_PRIVATE_KEY");
  // }
  return Keypair.fromSecretKey(new Uint8Array(CLAIMER_PRIVATE_KEY));
}

// Serialize ClaimPayload according to the contract's Borsh format
function serializeClaimPayload(payload) {
  const buffer = Buffer.alloc(32 + 8 + 8 + 8); // user_address + claim_amount + expiry_time + nonce
  let offset = 0;
  
  // user_address: Pubkey (32 bytes)
  payload.userAddress.toBuffer().copy(buffer, offset);
  offset += 32;
  
  // claim_amount: u64 (8 bytes, little endian)
  buffer.writeBigUInt64LE(BigInt(payload.claimAmount.toString()), offset);
  offset += 8;
  
  // expiry_time: i64 (8 bytes, little endian)
  buffer.writeBigInt64LE(BigInt(payload.expiryTime.toString()), offset);
  offset += 8;
  
  // nonce: u64 (8 bytes, little endian)
  buffer.writeBigUInt64LE(BigInt(payload.nonce.toString()), offset);
  
  return buffer;
}

// Create domain-separated message as per contract specification
function createDomainSeparatedMessage(programId, payload) {
  const payloadBytes = serializeClaimPayload(payload);
  
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V2", 'utf8'), // Domain separator
    programId.toBuffer(),                   // Program ID
    payloadBytes                           // Serialized payload
  ]);
}

// Ensure claimer has enough SOL for transaction fees
async function ensureClaimerFunding(connection, claimer, admin) {
  const balance = await connection.getBalance(claimer.publicKey);
  const requiredBalance = MIN_BALANCE_SOL * anchor.web3.LAMPORTS_PER_SOL;
  
  console.log(`💰 Claimer balance: ${(balance / anchor.web3.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  
  if (balance < requiredBalance) {
    console.log(`🏦 Funding claimer with ${FUNDING_AMOUNT_SOL} SOL from admin...`);
    
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: claimer.publicKey,
        lamports: FUNDING_AMOUNT_SOL * anchor.web3.LAMPORTS_PER_SOL
      })
    );
    
    transferTx.feePayer = admin.publicKey;
    transferTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transferTx.sign(admin);
    
    const transferSig = await connection.sendRawTransaction(transferTx.serialize());
    await connection.confirmTransaction(transferSig);
    console.log("✅ Claimer funded successfully");
  } else {
    console.log("✅ Claimer has sufficient balance");
  }
}

// ========================================
// MAIN EXECUTION
// ========================================

(async () => {
  console.log("🎯 RIYAL TOKEN CLAIM EXECUTION");
  console.log("==============================");
  console.log("");
  
  try {
    // Load keypairs
    const admin = loadAdminKeypair();
    const claimer = loadClaimerKeypair();
    
    console.log("🔑 ACCOUNTS:");
    console.log(`Admin: ${admin.publicKey.toString()}`);
    console.log(`Claimer: ${claimer.publicKey.toString()}`);
    console.log("");
    
    // Connect to Solana
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    // Load the program
    const program = anchor.workspace.RiyalContract;
    const programId = program.programId;
    
    console.log(`📋 CONTRACT:`);
    console.log(`Program ID: ${programId.toString()}`);
    console.log(`Network: ${RPC_URL}`);
    console.log("");
    
    // Calculate PDAs
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], programId);
    const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), claimer.publicKey.toBuffer()], programId);
    
    // Ensure claimer has funding
    await ensureClaimerFunding(connection, claimer, admin);
    console.log("");
    
    // Get contract state
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log(`Token Mint: ${tokenState.tokenMint.toString()}`);
    
    // Verify admin matches (security check)
    if (!tokenState.admin.equals(admin.publicKey)) {
      throw new Error(`Admin mismatch! Contract admin: ${tokenState.admin.toString()}, Your admin: ${admin.publicKey.toString()}`);
    }
    
    // Initialize user data if needed
    let userData;
    try {
      userData = await program.account.userData.fetch(userDataPDA);
      console.log(`✅ Found user data, current nonce: ${userData.nonce.toString()}`);
    } catch (error) {
      console.log("🏗️  Initializing user data...");
      await program.methods
        .initializeUserData()
        .accounts({
          userData: userDataPDA,
          user: claimer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([claimer])
        .rpc();
      
      userData = await program.account.userData.fetch(userDataPDA);
      console.log("✅ User data initialized");
    }
    
    // Get/Create claimer's token account
    const claimerTokenAccount = await getAssociatedTokenAddress(
      tokenState.tokenMint, 
      claimer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    // Create token account if needed
    try {
      await connection.getTokenAccountBalance(claimerTokenAccount);
      console.log("✅ Token account exists");
    } catch (error) {
      console.log("🏗️  Creating token account...");
      const createATATx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          claimerTokenAccount,
          claimer.publicKey,
          tokenState.tokenMint,
          TOKEN_2022_PROGRAM_ID
        )
      );
      createATATx.feePayer = admin.publicKey;
      createATATx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      createATATx.sign(admin);
      const createSig = await connection.sendRawTransaction(createATATx.serialize());
      await connection.confirmTransaction(createSig);
      console.log("✅ Token account created");
    }
    
    // Create the claim payload
    const currentTime = Math.floor(Date.now() / 1000);
    const claimAmount = CLAIM_AMOUNT_TOKENS * Math.pow(10, 9); // Convert to base units (9 decimals)
    const expiryTime = currentTime + (CLAIM_EXPIRY_MINUTES * 60);
    const nonce = NONCE; // Use configured nonce
    
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(claimAmount),
      expiryTime: new anchor.BN(expiryTime),
      nonce: new anchor.BN(nonce)
    };
    
    console.log("");
    console.log("📝 CLAIM DETAILS:");
    console.log(`Amount: ${CLAIM_AMOUNT_TOKENS} tokens`);
    console.log(`Nonce: ${nonce}`);
    console.log(`Expires: ${new Date(expiryTime * 1000).toLocaleString()}`);
    console.log("");
    
    // Create domain-separated message and sign with admin key
    const messageBytes = createDomainSeparatedMessage(programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
    
    console.log("🔐 Admin signature created");
    
    // Get balance before claim
    const balanceBefore = await connection.getTokenAccountBalance(claimerTokenAccount);
    console.log("");
    console.log("📊 BEFORE CLAIM:");
    console.log(`Balance: ${balanceBefore.value.uiAmount || 0} tokens`);
    
    // Create Ed25519 verification instruction (CRITICAL for security)
    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });
    
    // Create claim instruction
    const claimIx = await program.methods
      .claimTokens(
        claimPayload,
        Array.from(adminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenState.tokenMint,
        userTokenAccount: claimerTokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    
    // Build transaction with signature verification FIRST
    const claimTransaction = new Transaction()
      .add(adminEd25519Ix)  // Admin signature verification MUST come first
      .add(claimIx);        // Then the claim instruction
    
    // Claimer submits and pays for transaction
    console.log("");
    console.log("🚀 SUBMITTING CLAIM TRANSACTION...");
    
    claimTransaction.feePayer = claimer.publicKey; // Claimer pays fees
    claimTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    claimTransaction.sign(claimer);
    
    const signature = await connection.sendRawTransaction(claimTransaction.serialize());
    console.log(`Transaction: ${signature}`);
    
    // Confirm transaction
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    // Check results
    const balanceAfter = await connection.getTokenAccountBalance(claimerTokenAccount);
    const userDataAfter = await program.account.userData.fetch(userDataPDA);
    
    console.log("");
    console.log("🎉 CLAIM SUCCESSFUL!");
    console.log("📊 RESULTS:");
    console.log(`Balance Before: ${balanceBefore.value.uiAmount || 0} tokens`);
    console.log(`Balance After: ${balanceAfter.value.uiAmount} tokens`);
    console.log(`Tokens Claimed: ${balanceAfter.value.uiAmount - (balanceBefore.value.uiAmount || 0)}`);
    console.log(`Nonce: ${nonce} → ${userDataAfter.nonce.toString()}`);
    console.log(`Total Claims: ${userDataAfter.totalClaims.toString()}`);
    
    console.log("");
    console.log("✅ CLAIM COMPLETED SUCCESSFULLY");
    
  } catch (error) {
    console.error("");
    console.error("❌ CLAIM FAILED:");
    console.error(error.message);
    
    if (error.logs) {
      console.error("");
      console.error("📋 Transaction Logs:");
      error.logs.forEach(log => console.error(log));
    }
    
    process.exit(1);
  }
})().catch(console.error);