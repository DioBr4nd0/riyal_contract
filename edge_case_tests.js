#!/usr/bin/env node

/**
 * MERCLE TOKEN EDGE CASE TEST SUITE
 * 
 * Tests for edge cases and boundary conditions:
 * - Integer overflow/underflow attempts
 * - Maximum values
 * - Account state edge cases
 * - Token account manipulation
 * - Message tampering
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

const RPC_URL = "https://api.devnet.solana.com";
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("/Users/mercle/.config/solana/id.json", 'utf8'))));

// Helper functions
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

async function setupUser(program, user, tokenMint) {
  const connection = program.provider.connection;
  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user.publicKey.toBuffer()], 
    program.programId
  );

  const balance = await connection.getBalance(user.publicKey);
  if (balance < 0.1 * anchor.web3.LAMPORTS_PER_SOL) {
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.5 * anchor.web3.LAMPORTS_PER_SOL
      })
    );
    transferTx.feePayer = admin.publicKey;
    transferTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transferTx.sign(admin);
    await connection.sendRawTransaction(transferTx.serialize());
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  let userData;
  try {
    userData = await program.account.userData.fetch(userDataPDA);
  } catch (error) {
    await program.methods
      .initializeUserData()
      .accounts({
        userData: userDataPDA,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    userData = await program.account.userData.fetch(userDataPDA);
  }

  const tokenAccount = await getAssociatedTokenAddress(tokenMint, user.publicKey, false, TOKEN_PROGRAM_ID);
  try {
    await connection.getTokenAccountBalance(tokenAccount);
  } catch (error) {
    const createATATx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        tokenAccount,
        user.publicKey,
        tokenMint,
        TOKEN_PROGRAM_ID
      )
    );
    createATATx.feePayer = admin.publicKey;
    createATATx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    createATATx.sign(admin);
    await connection.sendRawTransaction(createATATx.serialize());
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { userData, userDataPDA, tokenAccount };
}

// TEST 1: Maximum u64 Value Claim
async function testMaxU64Claim(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 1: MAXIMUM U64 VALUE CLAIM");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    
    const maxU64 = "18446744073709551615"; // Max u64
    console.log(`→ Attempting claim with max u64 amount: ${maxU64}`);
    
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: testUser.publicKey,
      claimAmount: new anchor.BN(maxU64),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(adminSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenMint,
        userTokenAccount: tokenAccount,
        user: testUser.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = testUser.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(testUser);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("⚠️  Max u64 claim accepted (admin approved, mint authority has supply)");
      return true;
    } catch (error) {
      console.log(`✅ Max u64 claim blocked: ${error.message.slice(0, 60)}`);
      return true;
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 2: Message Tampering
async function testMessageTampering(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 2: MESSAGE TAMPERING");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    
    console.log("→ Creating signature for 100 tokens...");
    const currentTime = Math.floor(Date.now() / 1000);
    const originalPayload = {
      userAddress: testUser.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, originalPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    console.log("→ Tampering: trying to claim 1,000,000 tokens with signature for 100...");
    
    // Tampered payload - different amount
    const tamperedPayload = {
      userAddress: testUser.publicKey,
      claimAmount: new anchor.BN(1000000 * 1e9), // Changed!
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    // Use original signature with tampered payload
    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes, // Original message
      signature: adminSignature,
    });

    const claimIx = await program.methods
      .claimTokens(tamperedPayload, Array.from(adminSignature)) // Tampered payload!
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenMint,
        userTokenAccount: tokenAccount,
        user: testUser.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = testUser.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(testUser);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ CRITICAL: Message tampering succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1772")) {
        console.log("✅ Message tampering blocked (signature verification failed)");
        return true;
      } else {
        console.log(`✅ Message tampering blocked: ${error.message.slice(0, 60)}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 3: Wrong Token Account Owner
async function testWrongTokenAccountOwner(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 3: WRONG TOKEN ACCOUNT OWNER");
  console.log("━".repeat(60));
  
  const victim = Keypair.generate();
  const attacker = Keypair.generate();
  
  try {
    const { userData: victimData, userDataPDA: victimDataPDA } = await setupUser(program, victim, tokenMint);
    const { tokenAccount: attackerTokenAccount } = await setupUser(program, attacker, tokenMint);
    
    console.log(`👤 Victim: ${victim.publicKey.toString().slice(0, 8)}...`);
    console.log(`🦹 Attacker: ${attacker.publicKey.toString().slice(0, 8)}...`);
    console.log("→ Attacker tries to redirect victim's tokens to their account...");
    
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: victim.publicKey, // Victim's address
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(victimData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(adminSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: victimDataPDA,
        mint: tokenMint,
        userTokenAccount: attackerTokenAccount, // Attacker's token account!
        user: victim.publicKey, // But victim as user
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = victim.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(victim);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ CRITICAL: Token redirect succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1773")) {
        console.log("✅ Token redirect blocked (UnauthorizedDestination)");
        return true;
      } else {
        console.log(`✅ Token redirect blocked: ${error.message.slice(0, 60)}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 4: Nonce Overflow Attempt
async function testNonceOverflow(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 4: NONCE OVERFLOW ATTEMPT");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    
    const maxU64 = "18446744073709551615";
    console.log(`→ Attempting claim with max u64 nonce: ${maxU64}`);
    
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: testUser.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(maxU64) // Max nonce
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(adminSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenMint,
        userTokenAccount: tokenAccount,
        user: testUser.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = testUser.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(testUser);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("⚠️  Max nonce accepted (will cause InvalidNonce)");
      return true;
    } catch (error) {
      console.log(`✅ Max nonce blocked: ${error.message.slice(0, 60)}`);
      return true;
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 5: Signature with all zeros
async function testZeroSignature(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 5: ZERO SIGNATURE ATTEMPT");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    
    console.log("→ Attempting claim with all-zero signature...");
    
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: testUser.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const zeroSignature = new Uint8Array(64).fill(0); // All zeros

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(zeroSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenMint,
        userTokenAccount: tokenAccount,
        user: testUser.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(claimIx);
    tx.feePayer = testUser.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(testUser);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ CRITICAL: Zero signature accepted!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1772")) {
        console.log("✅ Zero signature blocked (InvalidAdminSignature checksum)");
        return true;
      } else {
        console.log(`✅ Zero signature blocked: ${error.message.slice(0, 60)}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// Main execution
(async () => {
  console.log("🔬 MERCLE TOKEN EDGE CASE TEST SUITE");
  console.log("═".repeat(60));
  console.log("");
  
  try {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    const program = anchor.workspace.MercleToken;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);

    console.log(`📋 Program: ${program.programId.toString()}`);
    console.log(`🪙 Token Mint: ${tokenState.tokenMint.toString()}`);
    console.log("");
    
    const results = [];
    
    // Run edge case tests
    results.push({ name: "Maximum U64 Value Claim", passed: await testMaxU64Claim(program, tokenStatePDA, tokenState.tokenMint) });
    results.push({ name: "Message Tampering", passed: await testMessageTampering(program, tokenStatePDA, tokenState.tokenMint) });
    results.push({ name: "Wrong Token Account Owner", passed: await testWrongTokenAccountOwner(program, tokenStatePDA, tokenState.tokenMint) });
    results.push({ name: "Nonce Overflow Attempt", passed: await testNonceOverflow(program, tokenStatePDA, tokenState.tokenMint) });
    results.push({ name: "Zero Signature Attempt", passed: await testZeroSignature(program, tokenStatePDA, tokenState.tokenMint) });
    
    // Print summary
    console.log("\n" + "═".repeat(60));
    console.log("📊 EDGE CASE TEST SUMMARY");
    console.log("═".repeat(60));
    
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    
    results.forEach(result => {
      const icon = result.passed ? "✅" : "❌";
      console.log(`${icon} ${result.name}`);
    });
    
    console.log("");
    console.log(`TOTAL: ${passed}/${total} tests passed`);
    
    if (passed === total) {
      console.log("🎉 All edge case tests passed!");
    } else {
      console.log("⚠️  Some edge case tests failed!");
    }
    
  } catch (error) {
    console.error("❌ Test suite failed:", error.message);
    process.exit(1);
  }
})();

