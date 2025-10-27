#!/usr/bin/env node

/**
 * MERCLE TOKEN CLAIM SCRIPT - Using acc.json
 * 
 * This version loads the claimer key from acc.json (base58 format)
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
// CONFIGURATION
// ========================================

// Load claimer from acc.json (base58 format)
const ACC_JSON_PATH = "./nu.json";

// Admin's private key
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";

// Claim parameters
const CLAIM_AMOUNT_TOKENS = 50; // Amount in tokens
const CLAIM_EXPIRY_MINUTES = 5;

// Network
const RPC_URL = "https://api.devnet.solana.com";

const MIN_BALANCE_SOL = 0.1;
const FUNDING_AMOUNT_SOL = 0.5;

// ========================================
// HELPER FUNCTIONS
// ========================================

// Base58 decode function (simple implementation)
function base58Decode(s) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP[ALPHABET[i]] = i;
  }
  
  let bytes = [];
  let carry, j;
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] in ALPHABET_MAP)) throw new Error('Invalid base58 character');
    carry = ALPHABET_MAP[s[i]];
    for (j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  
  // Add leading zeros
  for (let i = 0; i < s.length && s[i] === '1'; i++) {
    bytes.push(0);
  }
  
  return new Uint8Array(bytes.reverse());
}

// Load keypair from base58 string
function loadKeypairFromBase58(base58String) {
  try {
    const privateKeyBytes = base58Decode(base58String.trim());
    return Keypair.fromSecretKey(privateKeyBytes);
  } catch (error) {
    console.error("Failed to decode base58 private key:", error.message);
    throw error;
  }
}

// Load claimer from acc.json
function loadClaimerKeypair() {
  try {
    const base58Key = fs.readFileSync(ACC_JSON_PATH, 'utf8').trim();
    return loadKeypairFromBase58(base58Key);
  } catch (error) {
    console.error(`Failed to load claimer keypair from ${ACC_JSON_PATH}`);
    throw error;
  }
}

// Load admin keypair
function loadAdminKeypair() {
  try {
    const data = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(data));
  } catch (error) {
    console.error(`Failed to load admin keypair from ${ADMIN_KEY_SOURCE}`);
    throw error;
  }
}

// Serialize ClaimPayload
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

// Create domain-separated message
function createDomainSeparatedMessage(programId, payload) {
  const payloadBytes = serializeClaimPayload(payload);
  
  return Buffer.concat([
    Buffer.from("MERCLE_CLAIM_V1", 'utf8'),
    programId.toBuffer(),
    payloadBytes
  ]);
}

// Ensure claimer has funding
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
  console.log("🎯 MERCLE TOKEN CLAIM EXECUTION (acc.json)");
  console.log("==============================");
  console.log("");
  
  try {
    // Load keypairs
    console.log("Loading keypairs...");
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
    const program = anchor.workspace.MercleToken;
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
    
    // Verify admin matches
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
      TOKEN_PROGRAM_ID
    );
    
    // Create token account if needed
    try {
      await connection.getTokenAccountBalance(claimerTokenAccount);
      console.log("✅ Token account exists");
    } catch (error) {
      console.log("🏗️  Creating token account...");
      const createATATx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          claimer.publicKey, // Claimer pays for their own account
          claimerTokenAccount,
          claimer.publicKey,
          tokenState.tokenMint,
          TOKEN_PROGRAM_ID
        )
      );
      createATATx.feePayer = claimer.publicKey;
      createATATx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      createATATx.sign(claimer);
      const createSig = await connection.sendRawTransaction(createATATx.serialize());
      await connection.confirmTransaction(createSig);
      console.log("✅ Token account created");
    }
    
    // Create the claim payload
    const currentTime = Math.floor(Date.now() / 1000);
    const claimAmount = CLAIM_AMOUNT_TOKENS * Math.pow(10, 9);
    const expiryTime = currentTime + (CLAIM_EXPIRY_MINUTES * 60);
    const nonce = userData.nonce.toNumber();
    
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
    
    // Create Ed25519 verification instruction
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
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    // Build transaction
    const claimTransaction = new Transaction()
      .add(adminEd25519Ix)
      .add(claimIx);
    
    console.log("");
    console.log("🚀 SUBMITTING CLAIM TRANSACTION...");
    
    claimTransaction.feePayer = claimer.publicKey;
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

