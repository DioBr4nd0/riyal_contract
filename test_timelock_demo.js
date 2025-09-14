const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, Ed25519Program } = require("@solana/web3.js");
const { 
  TOKEN_PROGRAM_ID, 
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount 
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

// Helper function to get token balance
async function getTokenBalance(connection, tokenAccount) {
  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    return parseFloat(balance.value.uiAmount) || 0;
  } catch (error) {
    return 0;
  }
}

// Helper function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testTimeLockDemo() {
  console.log("🕒 RIYAL CONTRACT - TIME-LOCK DEMONSTRATION");
  console.log("⏰ Testing 45-second claim period enforcement");
  console.log("👥 Two users with different claim timing");
  console.log("===============================================");

  // Configure the client
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  
  // Create a test wallet (admin)
  const testWallet = Keypair.generate();
  const wallet = new anchor.Wallet(testWallet);
  
  // Airdrop SOL to the test wallet
  const airdropTx = await connection.requestAirdrop(testWallet.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropTx);
  
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // Test accounts
  const admin = testWallet;
  const alice = Keypair.generate(); // Will claim immediately
  const bob = Keypair.generate();   // Will wait 50 seconds
  const tokenMint = Keypair.generate();
  
  // Airdrop to users
  for (const user of [alice, bob]) {
    const airdrop = await connection.requestAirdrop(user.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop);
  }
  
  // Derive PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  const [aliceDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), alice.publicKey.toBuffer()],
    program.programId
  );

  const [bobDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), bob.publicKey.toBuffer()],
    program.programId
  );

  console.log("🏗️  Setup:");
  console.log("  Admin:", admin.publicKey.toString());
  console.log("  Alice (immediate claim):", alice.publicKey.toString());
  console.log("  Bob (delayed claim):", bob.publicKey.toString());
  console.log("  Token State PDA:", tokenStatePDA.toString());

  try {
    // 1. Initialize contract with 45-second claim period
    console.log("\n1️⃣ Initialize contract with 45-second claim period");
    await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey, // upgrade authority
        new anchor.BN(45), // 45 SECOND claim period
        true, // time lock enabled
        true  // upgradeable
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    console.log("✅ Contract initialized with 45-second time-lock");

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
    console.log("✅ Token mint created");

    // 3. Setup token accounts and user data
    console.log("\n3️⃣ Setup token accounts and user data");
    
    const aliceTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, alice.publicKey);
    const bobTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, bob.publicKey);
    
    // Create token accounts
    const createAliceATAIx = createAssociatedTokenAccountInstruction(
      admin.publicKey, aliceTokenAccount, alice.publicKey, tokenMint.publicKey
    );
    const createBobATAIx = createAssociatedTokenAccountInstruction(
      admin.publicKey, bobTokenAccount, bob.publicKey, tokenMint.publicKey
    );
    
    const aliceATATx = await connection.sendTransaction(new Transaction().add(createAliceATAIx), [admin]);
    await connection.confirmTransaction(aliceATATx);
    const bobATATx = await connection.sendTransaction(new Transaction().add(createBobATAIx), [admin]);
    await connection.confirmTransaction(bobATATx);
    
    // Initialize user data PDAs
    const initAliceDataIx = await program.methods
      .initializeUserData()
      .accounts({
        userData: aliceDataPDA,
        user: alice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
      
    const initBobDataIx = await program.methods
      .initializeUserData()
      .accounts({
        userData: bobDataPDA,
        user: bob.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    
    // Sign user data initialization
    const aliceInitTx = new Transaction().add(initAliceDataIx);
    aliceInitTx.feePayer = admin.publicKey;
    aliceInitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    aliceInitTx.partialSign(admin, alice);
    const aliceInitResult = await connection.sendRawTransaction(aliceInitTx.serialize());
    await connection.confirmTransaction(aliceInitResult);
    
    const bobInitTx = new Transaction().add(initBobDataIx);
    bobInitTx.feePayer = admin.publicKey;
    bobInitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    bobInitTx.partialSign(admin, bob);
    const bobInitResult = await connection.sendRawTransaction(bobInitTx.serialize());
    await connection.confirmTransaction(bobInitResult);
    
    console.log("✅ Token accounts and user data setup complete");

    // 4. Get initial balances
    console.log("\n4️⃣ Initial token balances");
    const aliceBalanceBefore = await getTokenBalance(connection, aliceTokenAccount);
    const bobBalanceBefore = await getTokenBalance(connection, bobTokenAccount);
    
    console.log(`  Alice initial balance: ${aliceBalanceBefore} RRIYAL`);
    console.log(`  Bob initial balance: ${bobBalanceBefore} RRIYAL`);

    // 5. Get token state for mint info
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    
    // 6. ALICE'S IMMEDIATE CLAIM
    console.log("\n🚀 ALICE'S IMMEDIATE CLAIM TEST");
    console.log("===============================");
    
    const aliceData = await program.account.userData.fetch(aliceDataPDA);
    const aliceClaimAmount = 500000000; // 0.5 tokens
    const aliceValidUntil = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const aliceNonce = aliceData.nonce.toNumber();
    
    // Create Alice's domain-separated message
    const aliceMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      alice.publicKey,
      aliceTokenAccount,
      aliceClaimAmount,
      aliceNonce,
      aliceValidUntil
    );
    
    console.log("📝 Alice's claim details:");
    console.log(`  Amount: ${aliceClaimAmount / 1e9} RRIYAL`);
    console.log(`  Nonce: ${aliceNonce}`);
    console.log(`  Valid until: ${new Date(aliceValidUntil * 1000).toLocaleTimeString()}`);
    
    // Generate Alice's signatures
    const aliceUserSignature = nacl.sign.detached(aliceMessageBytes, alice.secretKey);
    const aliceAdminSignature = nacl.sign.detached(aliceMessageBytes, admin.secretKey);
    
    // Create Alice's Ed25519 verification instructions
    const aliceUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: alice.publicKey.toBytes(),
      message: aliceMessageBytes,
      signature: aliceUserSignature,
    });
    
    const aliceAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: aliceMessageBytes,
      signature: aliceAdminSignature,
    });
    
    // Create Alice's claim instruction
    const aliceClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(aliceClaimAmount),
        new anchor.BN(aliceNonce),
        new anchor.BN(aliceValidUntil),
        Array.from(aliceUserSignature),
        Array.from(aliceAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: aliceDataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: aliceTokenAccount,
        user: alice.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    // Execute Alice's claim immediately
    const aliceClaimTransaction = new Transaction()
      .add(aliceUserEd25519Ix)
      .add(aliceAdminEd25519Ix)
      .add(aliceClaimIx);
    
    console.log("⏰ Executing Alice's claim immediately...");
    const aliceClaimStartTime = Date.now();
    
    try {
      aliceClaimTransaction.feePayer = admin.publicKey;
      aliceClaimTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      aliceClaimTransaction.sign(admin);
      const aliceClaimResult = await connection.sendRawTransaction(aliceClaimTransaction.serialize());
      await connection.confirmTransaction(aliceClaimResult);
      
      console.log("🎉 ALICE'S CLAIM SUCCEEDED!");
      console.log(`  Transaction: ${aliceClaimResult}`);
      console.log(`  Claim executed at: ${new Date(aliceClaimStartTime).toLocaleTimeString()}`);
      
    } catch (error) {
      console.error("❌ Alice's claim failed:", error.message);
    }

    // 7. BOB'S DELAYED CLAIM
    console.log("\n⏳ BOB'S DELAYED CLAIM TEST");
    console.log("============================");
    
    const bobData = await program.account.userData.fetch(bobDataPDA);
    const bobClaimAmount = 750000000; // 0.75 tokens
    const bobValidUntil = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const bobNonce = bobData.nonce.toNumber();
    
    // Create Bob's domain-separated message
    const bobMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      bob.publicKey,
      bobTokenAccount,
      bobClaimAmount,
      bobNonce,
      bobValidUntil
    );
    
    console.log("📝 Bob's claim details:");
    console.log(`  Amount: ${bobClaimAmount / 1e9} RRIYAL`);
    console.log(`  Nonce: ${bobNonce}`);
    console.log(`  Valid until: ${new Date(bobValidUntil * 1000).toLocaleTimeString()}`);
    
    // Generate Bob's signatures
    const bobUserSignature = nacl.sign.detached(bobMessageBytes, bob.secretKey);
    const bobAdminSignature = nacl.sign.detached(bobMessageBytes, admin.secretKey);
    
    // Create Bob's Ed25519 verification instructions
    const bobUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: bob.publicKey.toBytes(),
      message: bobMessageBytes,
      signature: bobUserSignature,
    });
    
    const bobAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: bobMessageBytes,
      signature: bobAdminSignature,
    });
    
    // Create Bob's claim instruction
    const bobClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(bobClaimAmount),
        new anchor.BN(bobNonce),
        new anchor.BN(bobValidUntil),
        Array.from(bobUserSignature),
        Array.from(bobAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: bobDataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: bobTokenAccount,
        user: bob.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    // Wait 50 seconds before Bob's claim (exceeds 45-second limit)
    console.log("⏳ Waiting 50 seconds before Bob's claim (exceeds 45-second limit)...");
    console.log("   (This simulates Bob trying to claim after Alice's 45-second window)");
    
    // Show countdown
    for (let i = 50; i > 0; i--) {
      process.stdout.write(`\r   Countdown: ${i} seconds remaining...`);
      await sleep(1000);
    }
    console.log("\r   ⏰ 50 seconds elapsed - attempting Bob's claim now...");
    
    const bobClaimTransaction = new Transaction()
      .add(bobUserEd25519Ix)
      .add(bobAdminEd25519Ix)
      .add(bobClaimIx);
    
    const bobClaimStartTime = Date.now();
    
    try {
      bobClaimTransaction.feePayer = admin.publicKey;
      bobClaimTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      bobClaimTransaction.sign(admin);
      const bobClaimResult = await connection.sendRawTransaction(bobClaimTransaction.serialize());
      await connection.confirmTransaction(bobClaimResult);
      
      console.log("🚨 UNEXPECTED: Bob's claim succeeded when it should have failed!");
      
    } catch (error) {
      if (error.message.includes("ClaimTooSoon") || error.message.includes("ClaimTimeLocked")) {
        console.log("🛡️  BOB'S CLAIM CORRECTLY BLOCKED BY TIME-LOCK!");
        console.log(`   Error: Time-lock enforcement working`);
        console.log(`   Claim attempted at: ${new Date(bobClaimStartTime).toLocaleTimeString()}`);
        console.log(`   Time since Alice's claim: ${Math.round((bobClaimStartTime - aliceClaimStartTime) / 1000)} seconds`);
      } else {
        console.log("❌ Bob's claim failed with unexpected error:", error.message);
      }
    }

    // 8. Final balance check
    console.log("\n💰 FINAL TOKEN BALANCES");
    console.log("========================");
    
    const aliceBalanceAfter = await getTokenBalance(connection, aliceTokenAccount);
    const bobBalanceAfter = await getTokenBalance(connection, bobTokenAccount);
    
    console.log(`  Alice final balance: ${aliceBalanceAfter} RRIYAL (gained: ${aliceBalanceAfter - aliceBalanceBefore})`);
    console.log(`  Bob final balance: ${bobBalanceAfter} RRIYAL (gained: ${bobBalanceAfter - bobBalanceBefore})`);
    
    // 9. Test summary
    console.log("\n📊 TIME-LOCK DEMONSTRATION RESULTS");
    console.log("===================================");
    
    if (aliceBalanceAfter > aliceBalanceBefore && bobBalanceAfter === bobBalanceBefore) {
      console.log("🎉 SUCCESS: Time-lock enforcement working perfectly!");
      console.log("✅ Alice claimed immediately → SUCCESS");
      console.log("🛡️  Bob waited 50 seconds → BLOCKED (45-second limit)");
      console.log("⏰ 45-second claim period properly enforced");
    } else if (aliceBalanceAfter === aliceBalanceBefore && bobBalanceAfter === bobBalanceBefore) {
      console.log("⚠️  Both claims were blocked - check time-lock settings");
    } else if (aliceBalanceAfter > aliceBalanceBefore && bobBalanceAfter > bobBalanceBefore) {
      console.log("🚨 SECURITY ISSUE: Both claims succeeded - time-lock not working!");
    } else {
      console.log("❓ Unexpected result - check test logic");
    }
    
    console.log("\n🏁 TIME-LOCK DEMONSTRATION COMPLETE");

  } catch (error) {
    console.error("❌ TIME-LOCK TEST FAILED:");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the time-lock demonstration
testTimeLockDemo().catch(console.error);

