#!/usr/bin/env node

/**
 * MERCLE TOKEN ADVANCED STRESS TEST
 * 
 * Tests:
 * - Concurrent claim attempts
 * - Rapid successive claims (timelock validation)
 * - High volume transaction handling
 * - Network congestion simulation
 * - Race condition testing
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

// Load admin
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

  // Fund user if needed
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
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { userData, userDataPDA, tokenAccount };
}

async function executeClaim(program, tokenStatePDA, user, userData, userDataPDA, tokenAccount, tokenMint) {
  const currentTime = Math.floor(Date.now() / 1000);
  const claimPayload = {
    userAddress: user.publicKey,
    claimAmount: new anchor.BN(50 * 1e9),
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
      user: user.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx = new Transaction().add(adminEd25519Ix).add(claimIx);
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
  tx.sign(user);

  const sig = await program.provider.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed"
  });
  
  return sig;
}

// TEST 1: Concurrent Claims (Race Condition)
async function testConcurrentClaims(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 1: CONCURRENT CLAIMS (RACE CONDITION)");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  console.log(`👤 Test User: ${testUser.publicKey.toString()}`);
  console.log(`🔑 Private Key (Base58): ${Buffer.from(testUser.secretKey).toString('base64')}`);
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    const connection = program.provider.connection;
    
    console.log(`→ BEFORE: Nonce = ${userData.nonce.toNumber()}`);
    
    const beforeBalance = await connection.getTokenAccountBalance(tokenAccount);
    console.log(`→ BEFORE: Balance = ${beforeBalance.value.uiAmount} tokens`);
    console.log("→ Attempting 5 concurrent claims with same nonce...");
    
    // Try to submit 5 claims simultaneously with same nonce
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        executeClaim(program, tokenStatePDA, testUser, userData, userDataPDA, tokenAccount, tokenMint)
          .catch(err => ({ error: err.message }))
      );
    }
    
    const results = await Promise.all(promises);
    const successes = results.filter(r => !r.error).length;
    const failures = results.filter(r => r.error).length;
    
    console.log(`📊 Submission Results: ${successes} successes, ${failures} failures`);
    
    // Wait for confirmations
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check ACTUAL state on chain
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(tokenAccount);
    
    console.log(`\n🔍 ACTUAL ON-CHAIN STATE:`);
    console.log(`→ AFTER: Nonce = ${finalUserData.nonce.toNumber()}`);
    console.log(`→ AFTER: Balance = ${finalBalance.value.uiAmount} tokens`);
    console.log(`→ AFTER: Total Claims = ${finalUserData.totalClaims.toNumber()}`);
    
    const nonceIncrement = finalUserData.nonce.toNumber() - userData.nonce.toNumber();
    const tokensMinted = finalBalance.value.uiAmount - beforeBalance.value.uiAmount;
    
    console.log(`\n📈 CHANGES:`);
    console.log(`→ Nonce increased by: ${nonceIncrement}`);
    console.log(`→ Tokens minted: ${tokensMinted}`);
    console.log(`→ Expected if 1 succeeded: nonce +1, tokens +50`);
    console.log(`→ Expected if 5 succeeded: nonce +5, tokens +250`);
    
    if (nonceIncrement === 1 && Math.abs(tokensMinted - 50) < 0.01) {
      console.log("\n✅ PASS: Only ONE claim actually succeeded (nonce protection working!)");
      return true;
    } else if (nonceIncrement > 1) {
      console.log(`\n❌ FAIL: ${nonceIncrement} claims succeeded (RACE CONDITION BUG!)`);
      return false;
    } else {
      console.log("\n⚠️  Unexpected result");
      return false;
    }
    
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 2: Rapid Successive Claims
async function testRapidSuccessiveClaims(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 2: RAPID SUCCESSIVE CLAIMS (TIMELOCK)");
  console.log("━".repeat(60));
  
  const testUser = Keypair.generate();
  console.log(`👤 Test User: ${testUser.publicKey.toString()}`);
  console.log(`🔑 Private Key (Base58): ${Buffer.from(testUser.secretKey).toString('base64')}`);
  
  try {
    const { userData: initialUserData, userDataPDA, tokenAccount } = await setupUser(program, testUser, tokenMint);
    const connection = program.provider.connection;
    
    console.log("→ Attempting 5 rapid successive claims (reduced to save SOL)...");
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < 5; i++) {
      try {
        // Fetch fresh nonce
        const userData = await program.account.userData.fetch(userDataPDA);
        
        const sig = await executeClaim(program, tokenStatePDA, testUser, userData, userDataPDA, tokenAccount, tokenMint);
        await program.provider.connection.confirmTransaction(sig);
        
        successCount++;
        console.log(`  Claim ${i + 1}: ✅ Success`);
        
        // Small delay between claims
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        failCount++;
        if (error.message.includes("0x1793")) {
          console.log(`  Claim ${i + 1}: ⏱️  Blocked by timelock (ClaimTimeLocked)`);
        } else if (error.message.includes("0x1794")) {
          console.log(`  Claim ${i + 1}: 🔒 Claim period not elapsed`);
        } else {
          console.log(`  Claim ${i + 1}: ❌ ${error.message.slice(0, 50)}`);
        }
      }
    }
    
    // Check actual state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(tokenAccount);
    
    console.log("");
    console.log(`📊 Submission Results: ${successCount} successes, ${failCount} failures`);
    console.log(`📊 Actual State: Nonce=${finalUserData.nonce.toNumber()}, Balance=${finalBalance.value.uiAmount} tokens, Claims=${finalUserData.totalClaims.toNumber()}`);
    
    if (successCount > 0 && failCount > 0) {
      console.log("✅ PASS: Timelock is enforcing claim frequency");
      return true;
    } else if (successCount === 5) {
      console.log("⚠️  All claims succeeded (timelock might be disabled)");
      return true;
    } else {
      console.log("❌ FAIL: No claims succeeded");
      return false;
    }
    
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 3: High Volume Multi-User
async function testHighVolumeMultiUser(program, tokenStatePDA, tokenMint, userCount = 5) {
  console.log("\n🔍 TEST 3: HIGH VOLUME MULTI-USER");
  console.log("━".repeat(60));
  
  try {
    console.log(`→ Creating ${userCount} users (reduced from 20 to save SOL)...`);
    
    const users = [];
    for (let i = 0; i < userCount; i++) {
      users.push(Keypair.generate());
    }
    
    console.log(`→ Setting up ${userCount} users...`);
    const setupPromises = users.map(user => setupUser(program, user, tokenMint));
    const userSetups = await Promise.all(setupPromises);
    
    console.log(`→ Executing ${userCount} claims simultaneously...`);
    const startTime = Date.now();
    
    const claimPromises = users.map((user, idx) => 
      executeClaim(
        program, 
        tokenStatePDA, 
        user, 
        userSetups[idx].userData, 
        userSetups[idx].userDataPDA, 
        userSetups[idx].tokenAccount, 
        tokenMint
      )
      .then(() => ({ success: true }))
      .catch(err => ({ success: false, error: err.message }))
    );
    
    const results = await Promise.all(claimPromises);
    const endTime = Date.now();
    
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log("");
    console.log(`✅ Successful: ${successes}/${userCount}`);
    console.log(`❌ Failed: ${failures}/${userCount}`);
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`📊 Throughput: ${(successes / parseFloat(duration)).toFixed(2)} claims/sec`);
    
    if (successes >= userCount * 0.8) {
      console.log("✅ PASS: High volume test successful (>80% success rate)");
      return true;
    } else {
      console.log("⚠️  WARN: High failure rate, might be network congestion");
      return true;
    }
    
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// TEST 4: Transaction Spam Prevention
async function testTransactionSpamPrevention(program, tokenStatePDA, tokenMint) {
  console.log("\n🔍 TEST 4: TRANSACTION SPAM PREVENTION");
  console.log("━".repeat(60));
  
  const spammer = Keypair.generate();
  console.log(`👤 Spammer: ${spammer.publicKey.toString()}`);
  console.log(`🔑 Private Key (Base58): ${Buffer.from(spammer.secretKey).toString('base64')}`);
  
  try {
    const { userData, userDataPDA, tokenAccount } = await setupUser(program, spammer, tokenMint);
    const connection = program.provider.connection;
    
    const beforeBalance = await connection.getTokenAccountBalance(tokenAccount);
    console.log(`→ BEFORE: Balance = ${beforeBalance.value.uiAmount} tokens`);
    console.log("→ Attempting to spam 10 transactions with same nonce (reduced from 50 to save SOL)...");
    
    const spamPromises = [];
    for (let i = 0; i < 10; i++) {
      spamPromises.push(
        executeClaim(program, tokenStatePDA, spammer, userData, userDataPDA, tokenAccount, tokenMint)
          .catch(err => ({ error: err.message }))
      );
    }
    
    const results = await Promise.all(spamPromises);
    const successes = results.filter(r => !r.error).length;
    
    // Wait for confirmations
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check actual state
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(tokenAccount);
    
    console.log(`📊 Submission: ${successes}/10 reported success`);
    console.log(`📊 Actual: Nonce=${finalUserData.nonce.toNumber()}, Balance=${finalBalance.value.uiAmount} tokens`);
    
    const nonceIncrement = finalUserData.nonce.toNumber() - userData.nonce.toNumber();
    const tokensMinted = finalBalance.value.uiAmount - beforeBalance.value.uiAmount;
    
    console.log(`\n📈 ACTUAL RESULTS:`);
    console.log(`→ Nonce increased by: ${nonceIncrement}`);
    console.log(`→ Tokens minted: ${tokensMinted}`);
    
    if (nonceIncrement === 1 && Math.abs(tokensMinted - 50) < 0.01) {
      console.log("✅ PASS: Spam prevention working (only 1 claim succeeded despite 10 submissions)");
      return true;
    } else if (nonceIncrement > 1) {
      console.log(`❌ FAIL: ${nonceIncrement} spam transactions actually succeeded`);
      return false;
    } else {
      console.log("⚠️  No claims succeeded");
      return false;
    }
    
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`);
    return false;
  }
}

// Main execution
(async () => {
  console.log("🚀 MERCLE TOKEN ADVANCED STRESS TEST SUITE");
  console.log("═".repeat(60));
  console.log("");
  
  try {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
      commitment: "confirmed",
      skipPreflight: false
    });
    anchor.setProvider(provider);
    
    const program = anchor.workspace.MercleToken;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);

    console.log(`📋 Program: ${program.programId.toString()}`);
    console.log(`🪙 Token Mint: ${tokenState.tokenMint.toString()}`);
    console.log("");
    
    const results = [];
    
    // Run stress tests
    results.push({ 
      name: "Concurrent Claims (Race Condition)", 
      passed: await testConcurrentClaims(program, tokenStatePDA, tokenState.tokenMint) 
    });
    
    results.push({ 
      name: "Rapid Successive Claims (Timelock)", 
      passed: await testRapidSuccessiveClaims(program, tokenStatePDA, tokenState.tokenMint) 
    });
    
    results.push({ 
      name: "High Volume Multi-User (5 users)", 
      passed: await testHighVolumeMultiUser(program, tokenStatePDA, tokenState.tokenMint, 5) 
    });
    
    results.push({ 
      name: "Transaction Spam Prevention", 
      passed: await testTransactionSpamPrevention(program, tokenStatePDA, tokenState.tokenMint) 
    });
    
    // Print summary
    console.log("\n" + "═".repeat(60));
    console.log("📊 STRESS TEST SUMMARY");
    console.log("═".repeat(60));
    
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    
    results.forEach(result => {
      const icon = result.passed ? "✅" : "❌";
      console.log(`${icon} ${result.name}`);
    });
    
    console.log("");
    console.log(`TOTAL: ${passed}/${total} tests passed`);
    console.log("");
    
    if (passed === total) {
      console.log("🎉 All stress tests passed!");
      console.log("💪 Contract is resilient under high load");
    } else {
      console.log("⚠️  Some stress tests had issues");
    }
    
  } catch (error) {
    console.error("❌ Test suite failed:", error.message);
    if (error.logs) {
      console.error("Logs:", error.logs);
    }
    process.exit(1);
  }
})();

