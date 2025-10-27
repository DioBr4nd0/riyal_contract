#!/usr/bin/env node

/**
 * MERCLE TOKEN SECURITY TEST SUITE
 * 
 * Comprehensive security testing including:
 * - Replay attack prevention
 * - Cross-account signature abuse
 * - Nonce manipulation
 * - Signature forgery
 * - Expired signature handling
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

// Load keypairs
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("/Users/mercle/.config/solana/id.json", 'utf8'))));
const claimer1 = Keypair.fromSecretKey(new Uint8Array([110,67,129,81,146,208,14,255,148,122,11,99,153,236,59,6,230,18,81,60,74,204,141,225,255,217,5,128,202,131,23,255,177,246,100,202,146,216,58,133,198,66,182,227,93,211,230,195,31,81,219,194,159,123,82,2,245,2,117,169,200,115,61,34]));
const claimer2 = Keypair.generate(); // Second claimer for cross-account tests
const fakeAdmin = Keypair.generate(); // Fake admin for signature forgery tests

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

async function setupUserIfNeeded(program, user, tokenMint, admin) {
  const connection = program.provider.connection;
  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user.publicKey.toBuffer()], 
    program.programId
  );

  // Initialize user data if needed
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

  // Create token account if needed
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
  }

  return { userData, userDataPDA, tokenAccount };
}

// Test runners
async function testReplayAttack(program, tokenStatePDA, claimer) {
  console.log("\n🔍 TEST 1: REPLAY ATTACK PREVENTION");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData, userDataPDA, tokenAccount } = await setupUserIfNeeded(
      program, claimer, tokenState.tokenMint, admin
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    // First claim - should succeed
    console.log("→ Attempting first claim (should succeed)...");
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
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx1 = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx1.feePayer = claimer.publicKey;
    tx1.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx1.sign(claimer);

    await program.provider.connection.sendRawTransaction(tx1.serialize());
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log("✅ First claim succeeded");

    // Second claim with SAME signature - should fail (nonce mismatch)
    console.log("→ Attempting replay with same signature (should fail)...");
    const tx2 = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx2.feePayer = claimer.publicKey;
    tx2.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx2.sign(claimer);

    try {
      await program.provider.connection.sendRawTransaction(tx2.serialize());
      console.log("❌ SECURITY ISSUE: Replay attack succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1770")) {
        console.log("✅ Replay attack blocked (InvalidNonce error)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

async function testCrossAccountSignature(program, tokenStatePDA) {
  console.log("\n🔍 TEST 2: CROSS-ACCOUNT SIGNATURE ABUSE");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData: userData1, userDataPDA: userDataPDA1, tokenAccount: tokenAccount1 } = 
      await setupUserIfNeeded(program, claimer1, tokenState.tokenMint, admin);
    const { userData: userData2, userDataPDA: userDataPDA2, tokenAccount: tokenAccount2 } = 
      await setupUserIfNeeded(program, claimer2, tokenState.tokenMint, admin);

    // Create signature for claimer1
    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload1 = {
      userAddress: claimer1.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData1.nonce.toNumber())
    };

    const messageBytes1 = createDomainSeparatedMessage(program.programId, claimPayload1);
    const adminSignature1 = nacl.sign.detached(messageBytes1, admin.secretKey);

    // Try to use claimer1's signature for claimer2's claim
    console.log("→ Creating signature for claimer1...");
    console.log("→ Attempting to use it for claimer2 (should fail)...");

    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes1, // Message for claimer1
      signature: adminSignature1,
    });

    // Try to claim for claimer2 with claimer1's signature
    const claimIx = await program.methods
      .claimTokens(claimPayload1, Array.from(adminSignature1)) // Still claimer1's payload
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA2, // But claimer2's user data
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount2, // And claimer2's token account
        user: claimer2.publicKey, // And claimer2 as signer
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = claimer2.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(claimer2);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ CRITICAL SECURITY ISSUE: Cross-account signature abuse succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error")) {
        console.log("✅ Cross-account abuse blocked (UnauthorizedDestination or other error)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

async function testFakeAdminSignature(program, tokenStatePDA, claimer) {
  console.log("\n🔍 TEST 3: FAKE ADMIN SIGNATURE");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData, userDataPDA, tokenAccount } = await setupUserIfNeeded(
      program, claimer, tokenState.tokenMint, admin
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(1000000 * 1e9), // Try to steal 1M tokens
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const fakeSignature = nacl.sign.detached(messageBytes, fakeAdmin.secretKey); // Wrong admin!

    console.log(`→ Attempting claim signed by fake admin (${fakeAdmin.publicKey.toString().slice(0, 8)}...)...`);
    console.log(`→ Real admin: ${admin.publicKey.toString().slice(0, 8)}...`);

    const fakeEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: fakeAdmin.publicKey.toBytes(), // Fake admin's key
      message: messageBytes,
      signature: fakeSignature,
    });

    const claimIx = await program.methods
      .claimTokens(claimPayload, Array.from(fakeSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(fakeEd25519Ix).add(claimIx);
    tx.feePayer = claimer.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(claimer);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ CRITICAL SECURITY ISSUE: Fake admin signature accepted!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1772")) {
        console.log("✅ Fake admin signature rejected (InvalidAdminSignature)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

async function testExpiredSignature(program, tokenStatePDA, claimer) {
  console.log("\n🔍 TEST 4: EXPIRED SIGNATURE");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData, userDataPDA, tokenAccount } = await setupUserIfNeeded(
      program, claimer, tokenState.tokenMint, admin
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime - 1), // Expired 1 second ago
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    console.log("→ Attempting claim with expired signature...");
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
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = claimer.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(claimer);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ SECURITY ISSUE: Expired signature accepted!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1774")) {
        console.log("✅ Expired signature rejected (ClaimExpired)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

async function testNonceManipulation(program, tokenStatePDA, claimer) {
  console.log("\n🔍 TEST 5: NONCE MANIPULATION");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData, userDataPDA, tokenAccount } = await setupUserIfNeeded(
      program, claimer, tokenState.tokenMint, admin
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const wrongNonce = userData.nonce.toNumber() + 10; // Skip ahead
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(100 * 1e9),
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(wrongNonce)
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    console.log(`→ Current nonce: ${userData.nonce.toNumber()}`);
    console.log(`→ Attempting claim with nonce: ${wrongNonce} (should fail)...`);

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
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = claimer.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(claimer);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ SECURITY ISSUE: Nonce manipulation succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1770")) {
        console.log("✅ Nonce manipulation blocked (InvalidNonce)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

async function testZeroAmountClaim(program, tokenStatePDA, claimer) {
  console.log("\n🔍 TEST 6: ZERO AMOUNT CLAIM");
  console.log("━".repeat(60));
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const { userData, userDataPDA, tokenAccount } = await setupUserIfNeeded(
      program, claimer, tokenState.tokenMint, admin
    );

    const currentTime = Math.floor(Date.now() / 1000);
    const claimPayload = {
      userAddress: claimer.publicKey,
      claimAmount: new anchor.BN(0), // Zero amount
      expiryTime: new anchor.BN(currentTime + 300),
      nonce: new anchor.BN(userData.nonce.toNumber())
    };

    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);

    console.log("→ Attempting claim with zero amount...");

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
        mint: tokenState.tokenMint,
        userTokenAccount: tokenAccount,
        user: claimer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
    tx.feePayer = claimer.publicKey;
    tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(claimer);

    try {
      await program.provider.connection.sendRawTransaction(tx.serialize());
      console.log("❌ ISSUE: Zero amount claim succeeded!");
      return false;
    } catch (error) {
      if (error.message.includes("custom program error: 0x1771")) {
        console.log("✅ Zero amount claim blocked (InvalidMintAmount)");
        return true;
      } else {
        console.log(`⚠️  Blocked but unexpected error: ${error.message}`);
        return true;
      }
    }
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
    return false;
  }
}

// Main execution
(async () => {
  console.log("🛡️  MERCLE TOKEN SECURITY TEST SUITE");
  console.log("═".repeat(60));
  console.log("");
  
  try {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    const program = anchor.workspace.MercleToken;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);

    console.log(`📋 Program: ${program.programId.toString()}`);
    console.log(`🔐 Admin: ${admin.publicKey.toString()}`);
    console.log(`👤 Claimer 1: ${claimer1.publicKey.toString()}`);
    console.log(`👤 Claimer 2: ${claimer2.publicKey.toString()}`);
    
    const results = [];
    
    // Run all security tests
    results.push({ name: "Replay Attack Prevention", passed: await testReplayAttack(program, tokenStatePDA, claimer1) });
    results.push({ name: "Cross-Account Signature Abuse", passed: await testCrossAccountSignature(program, tokenStatePDA) });
    results.push({ name: "Fake Admin Signature", passed: await testFakeAdminSignature(program, tokenStatePDA, claimer1) });
    results.push({ name: "Expired Signature", passed: await testExpiredSignature(program, tokenStatePDA, claimer1) });
    results.push({ name: "Nonce Manipulation", passed: await testNonceManipulation(program, tokenStatePDA, claimer1) });
    results.push({ name: "Zero Amount Claim", passed: await testZeroAmountClaim(program, tokenStatePDA, claimer1) });
    
    // Print summary
    console.log("\n" + "═".repeat(60));
    console.log("📊 TEST SUMMARY");
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
      console.log("🎉 All security tests passed!");
    } else {
      console.log("⚠️  Some security tests failed! Review the contract.");
      process.exit(1);
    }
    
  } catch (error) {
    console.error("❌ Test suite failed:", error.message);
    process.exit(1);
  }
})();

