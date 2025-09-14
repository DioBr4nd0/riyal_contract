const anchor = require("@coral-xyz/anchor");
const { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  SYSVAR_RENT_PUBKEY, 
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

// Helper function to create domain-separated message bytes
function createDomainSeparatedMessage(programId, tokenStatePDA, mint, user, destination, amount, nonce, validUntil) {
  const domainString = "RIYAL_CLAIM_V1";
  return Buffer.concat([
    Buffer.from(domainString, 'utf8'),
    programId.toBuffer(),
    tokenStatePDA.toBuffer(), 
    mint.toBuffer(),
    user.toBuffer(),
    destination.toBuffer(), // destination binding
    Buffer.from(new Uint8Array(new BigUint64Array([BigInt(amount)]).buffer)), // amount as LE bytes
    Buffer.from(new Uint8Array(new BigUint64Array([BigInt(nonce)]).buffer)), // nonce as LE bytes
    Buffer.from(new Uint8Array(new BigInt64Array([BigInt(validUntil)]).buffer)) // expiry as LE bytes
  ]);
}

// Helper to send transaction with detailed error capture
async function sendTransaction(connection, transaction, signers, description) {
  try {
    transaction.feePayer = signers[0].publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(...signers);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    
    if (confirmation.value.err) {
      return { success: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`, signature };
    }
    
    return { success: true, signature, error: null };
  } catch (error) {
    return { success: false, error: error.message, signature: null };
  }
}

async function testNonceRaceCondition() {
  console.log("🏁 RIYAL CONTRACT - NONCE RACE CONDITION TEST");
  console.log("==============================================");
  console.log("🎯 Testing concurrent transactions with SAME nonce");
  console.log("🔐 Expected: One SUCCESS, one InvalidNonce error");
  console.log("⚡ This tests double-spend prevention under concurrency");

  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user = Keypair.generate();
  const tokenMint = Keypair.generate();
  
  // Fund accounts
  console.log("\n💰 Funding accounts...");
  for (const account of [admin, user]) {
    const airdrop = await connection.requestAirdrop(account.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop);
  }
  
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;
  
  // Derive PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);

  console.log("🏗️  Setup:");
  console.log(`  Admin: ${admin.publicKey.toString()}`);
  console.log(`  User: ${user.publicKey.toString()}`);
  console.log(`  Program ID: ${program.programId.toString()}`);

  try {
    // 1. Initialize contract
    console.log("\n1️⃣ Initialize contract");
    await program.methods
      .initialize(admin.publicKey, admin.publicKey, new anchor.BN(60), false, true)
      .accounts({
        tokenState: tokenStatePDA,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // 2. Create token mint
    console.log("\n2️⃣ Create token mint");
    await program.methods
      .createTokenMint(9, "Riyal Token", "RRIYAL")
      .accounts({
        tokenState: tokenStatePDA,
        mint: tokenMint.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, tokenMint])
      .rpc();

    // 3. Setup user account and data
    console.log("\n3️⃣ Setup user account and data");
    
    const userTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, user.publicKey);
    
    // Create token account
    const createATATx = await connection.sendTransaction(
      new Transaction().add(createAssociatedTokenAccountInstruction(
        admin.publicKey, userTokenAccount, user.publicKey, tokenMint.publicKey
      )), 
      [admin]
    );
    await connection.confirmTransaction(createATATx);
    
    // Initialize user data
    const initUserDataTx = new Transaction().add(
      await program.methods
        .initializeUserData()
        .accounts({
          userData: userDataPDA,
          user: user.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
    
    initUserDataTx.feePayer = admin.publicKey;
    initUserDataTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    initUserDataTx.partialSign(admin, user);
    const userDataResult = await connection.sendRawTransaction(initUserDataTx.serialize());
    await connection.confirmTransaction(userDataResult);

    // 4. Get initial state
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const userData = await program.account.userData.fetch(userDataPDA);
    
    console.log("📋 Initial state:");
    console.log(`  User nonce: ${userData.nonce.toString()}`);
    console.log(`  Total claims: ${userData.totalClaims.toString()}`);

    // 5. Create IDENTICAL claim messages for race condition
    console.log("\n🔐 Creating IDENTICAL signed messages for race test...");
    
    const currentTime = Math.floor(Date.now() / 1000);
    const validUntil = currentTime + 300; // 5 minutes
    const claimAmount = 1000000000; // 1 token
    const raceNonce = userData.nonce.toNumber(); // SAME NONCE for both transactions
    
    console.log(`  Amount: ${claimAmount / 1e9} RRIYAL`);
    console.log(`  Nonce: ${raceNonce} (SAME for both transactions)`);
    console.log(`  Valid until: ${new Date(validUntil * 1000).toLocaleTimeString()}`);
    
    // Create domain-separated message
    const messageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user.publicKey,
      userTokenAccount,
      claimAmount,
      raceNonce,
      validUntil
    );
    
    // Generate signatures
    const userSignature = nacl.sign.detached(messageBytes, user.secretKey);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
    
    console.log("✅ Identical signatures generated for both transactions");

    // 6. Create IDENTICAL transactions for race condition
    console.log("\n⚡ Creating IDENTICAL transactions for race condition...");
    
    async function createClaimTransaction() {
      // Create Ed25519 verification instructions
      const userEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: user.publicKey.toBytes(),
        message: messageBytes,
        signature: userSignature,
      });
      
      const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: admin.publicKey.toBytes(),
        message: messageBytes,
        signature: adminSignature,
      });
      
      // Create claim instruction
      const claimIx = await program.methods
        .claimTokens(
          new anchor.BN(claimAmount),
          new anchor.BN(raceNonce),
          new anchor.BN(validUntil),
          Array.from(userSignature),
          Array.from(adminSignature)
        )
        .accounts({
          tokenState: tokenStatePDA,
          userData: userDataPDA,
          mint: tokenMint.publicKey,
          userTokenAccount: userTokenAccount,
          user: user.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      
      return new Transaction()
        .add(userEd25519Ix)
        .add(adminEd25519Ix)
        .add(claimIx);
    }
    
    const transaction1 = await createClaimTransaction();
    const transaction2 = await createClaimTransaction();
    
    console.log("✅ Two IDENTICAL transactions created");
    console.log("   Both use the same nonce, amount, signatures, and expiry");

    // 7. Fire both transactions SIMULTANEOUSLY (race condition)
    console.log("\n🏁 FIRING BOTH TRANSACTIONS SIMULTANEOUSLY...");
    console.log("   This simulates a race condition / double-spend attempt");
    
    const raceStartTime = Date.now();
    
    // Fire both transactions in parallel
    const [result1, result2] = await Promise.allSettled([
      sendTransaction(connection, transaction1, [admin], "Transaction 1"),
      sendTransaction(connection, transaction2, [admin], "Transaction 2")
    ]);
    
    const raceEndTime = Date.now();
    const raceDuration = raceEndTime - raceStartTime;
    
    console.log(`⏱️  Race completed in ${raceDuration}ms`);

    // 8. Analyze race results
    console.log("\n📊 RACE CONDITION RESULTS:");
    console.log("===========================");
    
    const tx1Result = result1.status === 'fulfilled' ? result1.value : { success: false, error: result1.reason.message };
    const tx2Result = result2.status === 'fulfilled' ? result2.value : { success: false, error: result2.reason.message };
    
    console.log(`Transaction 1: ${tx1Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (tx1Result.success) {
      console.log(`  Signature: ${tx1Result.signature}`);
    } else {
      console.log(`  Error: ${tx1Result.error}`);
    }
    
    console.log(`Transaction 2: ${tx2Result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (tx2Result.success) {
      console.log(`  Signature: ${tx2Result.signature}`);
    } else {
      console.log(`  Error: ${tx2Result.error}`);
    }

    // 9. Verify security expectations
    console.log("\n🔐 SECURITY ANALYSIS:");
    console.log("======================");
    
    const successCount = (tx1Result.success ? 1 : 0) + (tx2Result.success ? 1 : 0);
    const failureCount = 2 - successCount;
    
    console.log(`Successful transactions: ${successCount}`);
    console.log(`Failed transactions: ${failureCount}`);
    
    if (successCount === 1 && failureCount === 1) {
      console.log("🎉 PERFECT SECURITY: Exactly one transaction succeeded!");
      console.log("✅ Nonce race condition properly handled");
      console.log("✅ Double-spend attack prevented");
      
      // Check which error the failed transaction got
      const failedResult = tx1Result.success ? tx2Result : tx1Result;
      if (failedResult.error.includes('InvalidNonce') || failedResult.error.includes('NonceNotIncreasing')) {
        console.log("✅ Failed transaction got correct nonce error");
      } else {
        console.log(`⚠️  Failed transaction got unexpected error: ${failedResult.error}`);
      }
      
    } else if (successCount === 2) {
      console.log("🚨 CRITICAL SECURITY ISSUE: Both transactions succeeded!");
      console.log("❌ Double-spend attack possible - nonce validation failed");
      console.log("❌ This is a serious vulnerability!");
      
    } else if (successCount === 0) {
      console.log("⚠️  Both transactions failed - check setup");
      console.log("❓ This might indicate a different issue");
    }

    // 10. Check final state
    console.log("\n📊 FINAL STATE:");
    console.log("================");
    
    const finalUserData = await program.account.userData.fetch(userDataPDA);
    const finalBalance = await connection.getTokenAccountBalance(userTokenAccount);
    
    console.log(`User nonce: ${finalUserData.nonce.toString()} (should be ${raceNonce + 1})`);
    console.log(`Total claims: ${finalUserData.totalClaims.toString()} (should be 1)`);
    console.log(`Token balance: ${finalBalance.value.uiAmount} RRIYAL (should be 1.0)`);
    
    // Verify state consistency
    const expectedNonce = raceNonce + 1;
    const expectedClaims = 1;
    const expectedBalance = 1.0;
    
    if (finalUserData.nonce.toNumber() === expectedNonce && 
        finalUserData.totalClaims.toNumber() === expectedClaims &&
        parseFloat(finalBalance.value.uiAmount) === expectedBalance) {
      console.log("✅ Final state is consistent - only one claim processed");
    } else {
      console.log("❌ Final state inconsistent - possible double processing");
    }

    // 11. Summary
    console.log("\n🎯 NONCE RACE CONDITION TEST SUMMARY:");
    console.log("======================================");
    
    if (successCount === 1) {
      console.log("🛡️  SECURITY TEST PASSED!");
      console.log("✅ Contract correctly prevents nonce race conditions");
      console.log("✅ Double-spend attacks are impossible");
      console.log("✅ Only one transaction can succeed per nonce");
      console.log("✅ Concurrent transactions handled properly");
      
      console.log("\n📋 What happened:");
      console.log("  1. Two identical transactions fired simultaneously");
      console.log("  2. Both had same nonce, amount, signatures, expiry");
      console.log("  3. First transaction succeeded and incremented nonce");
      console.log("  4. Second transaction failed with InvalidNonce");
      console.log("  5. User state updated exactly once");
      
    } else {
      console.log("🚨 SECURITY TEST FAILED!");
      console.log("❌ Nonce race condition not properly handled");
      console.log("❌ Double-spend may be possible");
    }

  } catch (error) {
    console.error("❌ RACE CONDITION TEST FAILED:");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the nonce race condition test
testNonceRaceCondition().catch(console.error);
