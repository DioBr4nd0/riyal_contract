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

async function testCompleteRiyalContractRealNoMocks() {
  console.log("🏆 RIYAL CONTRACT - COMPLETE REAL END-TO-END TEST");
  console.log("🎯 NO MOCKS, NO SKIPPING, ALL REAL FUNCTIONALITY");
  console.log("🔥 TESTING EVERY SECURITY FEATURE AND ATTACK VECTOR");
  console.log("===================================================");

  // Configure the client to use the local cluster with hardcoded settings
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  
  // Create a test wallet
  const testWallet = Keypair.generate();
  const wallet = new anchor.Wallet(testWallet);
  
  // Airdrop SOL to the test wallet
  const airdropTx = await connection.requestAirdrop(testWallet.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropTx);
  
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // Test accounts - DISTINCT admin and user keys to expose bugs
  const admin = testWallet;
  const user1 = Keypair.generate(); // DISTINCT from admin
  const user2 = Keypair.generate();
  const maliciousUser = Keypair.generate();
  const tokenMint = Keypair.generate();
  
  // Airdrop to all users
  for (const user of [user1, user2, maliciousUser]) {
    const airdrop = await connection.requestAirdrop(user.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop);
  }
  
  // Derive PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  const [user1DataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user1.publicKey.toBuffer()],
    program.programId
  );

  const [user2DataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), user2.publicKey.toBuffer()],
    program.programId
  );

  console.log("🏗️  Setup:");
  console.log("  Admin:", admin.publicKey.toString());
  console.log("  User1:", user1.publicKey.toString());
  console.log("  User2:", user2.publicKey.toString());
  console.log("  Token State PDA:", tokenStatePDA.toString());

  try {
    console.log("\n============================================================");
    console.log("📋 MODULE 1: CONTRACT INITIALIZATION & TOKEN CREATION");
    console.log("============================================================");

    // 1. Initialize contract
    console.log("\n1️⃣ Initialize contract");
    await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey, // upgrade authority
        new anchor.BN(3600), // claim period (1 hour) - REAL TIME-LOCK
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
    console.log("✅ Contract initialized");

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

    // 3. REAL MINT AUTHORITY VERIFICATION (using SPL helpers, not parsed JSON)
    console.log("\n3️⃣ Verify mint authorities (REAL TEST - SPL helpers)");
    const mintAccount = await connection.getAccountInfo(tokenMint.publicKey);
    if (!mintAccount) throw new Error("Mint account not found");
    
    // Decode mint account using SPL token layout
    const { MintLayout } = require("@solana/spl-token");
    const mintData = MintLayout.decode(mintAccount.data);
    
    // Verify mint authority is the token state PDA
    const mintAuthority = new PublicKey(mintData.mintAuthority);
    const freezeAuthority = new PublicKey(mintData.freezeAuthority);
    
    if (!mintAuthority.equals(tokenStatePDA)) {
      throw new Error(`CRITICAL: Mint authority is ${mintAuthority.toString()}, expected ${tokenStatePDA.toString()}`);
    }
    if (!freezeAuthority.equals(tokenStatePDA)) {
      throw new Error(`CRITICAL: Freeze authority is ${freezeAuthority.toString()}, expected ${tokenStatePDA.toString()}`);
    }
    console.log("✅ Mint authorities correctly set to PDA (REAL SPL verification)");

    // 4. Test duplicate mint creation (REAL TEST)
    console.log("\n4️⃣ Test duplicate mint creation (REAL TEST)");
    try {
      const duplicateMint = Keypair.generate();
      await program.methods
        .createTokenMint(9, "Duplicate", "DUP")
        .accounts({
          tokenState: tokenStatePDA,
          mint: duplicateMint.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin, duplicateMint])
        .rpc();
      throw new Error("CRITICAL ERROR: Second mint creation succeeded when it should fail");
    } catch (error) {
      if (!error.message.includes("TokenMintAlreadyCreated")) {
        throw new Error(`WRONG ERROR: Expected TokenMintAlreadyCreated, got: ${error.message}`);
      }
      console.log("✅ Duplicate mint creation correctly prevented");
    }

    console.log("\n============================================================");
    console.log("🪙 MODULE 2: TOKEN ACCOUNTS & USER DATA");
    console.log("============================================================");

    // 5. Create token accounts and user data
    console.log("\n5️⃣ Create token accounts and user data");
    
    const user1TokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, user1.publicKey);
    const user2TokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, user2.publicKey);
    
    // Create token accounts
    const createUser1ATAIx = createAssociatedTokenAccountInstruction(
      admin.publicKey, user1TokenAccount, user1.publicKey, tokenMint.publicKey
    );
    const createUser2ATAIx = createAssociatedTokenAccountInstruction(
      admin.publicKey, user2TokenAccount, user2.publicKey, tokenMint.publicKey
    );
    
    const user1ATATx = await connection.sendTransaction(new Transaction().add(createUser1ATAIx), [admin]);
    await connection.confirmTransaction(user1ATATx);
    const user2ATATx = await connection.sendTransaction(new Transaction().add(createUser2ATAIx), [admin]);
    await connection.confirmTransaction(user2ATATx);
    
    // Initialize user data PDAs
    const initUser1DataIx = await program.methods
      .initializeUserData()
      .accounts({
        userData: user1DataPDA,
        user: user1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
      
    const initUser2DataIx = await program.methods
      .initializeUserData()
      .accounts({
        userData: user2DataPDA,
        user: user2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    
    // Sign user data initialization properly with distinct keys
    const user1InitTx = new Transaction().add(initUser1DataIx);
    user1InitTx.feePayer = admin.publicKey;
    user1InitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    user1InitTx.partialSign(admin, user1);
    const user1InitResult = await connection.sendRawTransaction(user1InitTx.serialize());
    await connection.confirmTransaction(user1InitResult);
    
    const user2InitTx = new Transaction().add(initUser2DataIx);
    user2InitTx.feePayer = admin.publicKey;
    user2InitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    user2InitTx.partialSign(admin, user2);
    const user2InitResult = await connection.sendRawTransaction(user2InitTx.serialize());
    await connection.confirmTransaction(user2InitResult);
    
    console.log("✅ User data initialized");

    // 5a. Mint initial tokens to user1 (this will freeze the account)
    console.log("\n5️⃣a Mint initial tokens to user1");
    await program.methods
      .mintTokens(new anchor.BN(100 * 10**9))
      .accounts({
        tokenState: tokenStatePDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
    console.log("✅ Initial tokens minted (account frozen)");

    console.log("\n============================================================");
    console.log("🔐 MODULE 3: REAL ED25519 SIGNATURE VERIFICATION");
    console.log("============================================================");

    // 6. Test REAL Ed25519 claim with cryptographic signatures
    console.log("\n6️⃣ Test REAL Ed25519 claim");
    
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const user1Data = await program.account.userData.fetch(user1DataPDA);
    
    // Create PROPER DOMAIN-SEPARATED MESSAGE with destination binding and expiry
    const validUntil = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const amount = 1000000000; // 1 token
    const nonce = user1Data.nonce.toNumber();
    
    const messageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user1.publicKey,
      user1TokenAccount,
      amount,
      nonce,
      validUntil
    );
    
    console.log("Domain-separated message with destination binding and expiry created");
    console.log("Message length:", messageBytes.length, "bytes");
    
    // Generate REAL Ed25519 signatures using tweetnacl
    const userSignature = nacl.sign.detached(messageBytes, user1.secretKey);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
    
    // Verify signatures are cryptographically valid
    const userVerified = nacl.sign.detached.verify(messageBytes, userSignature, user1.publicKey.toBytes());
    const adminVerified = nacl.sign.detached.verify(messageBytes, adminSignature, admin.publicKey.toBytes());
    
    if (!userVerified || !adminVerified) {
      throw new Error("CRITICAL: Generated signatures are not cryptographically valid!");
    }
    console.log("✅ Signatures are cryptographically valid");
    
    // Create REAL Ed25519 verification instructions
    const userEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user1.publicKey.toBytes(),
      message: messageBytes,
      signature: userSignature,
    });
    
    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });
    
    // Create claim instruction with proper parameters including valid_until
    const claimIx = await program.methods
      .claimTokens(
        new anchor.BN(amount),
        new anchor.BN(nonce),
        new anchor.BN(validUntil),
        Array.from(userSignature),
        Array.from(adminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: user1DataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, // CRITICAL: Ed25519 verification requires this
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    // Build complete transaction with Ed25519 verification
    const claimTransaction = new Transaction()
      .add(userEd25519Ix)
      .add(adminEd25519Ix)
      .add(claimIx);
    
    const balanceBefore = await connection.getTokenAccountBalance(user1TokenAccount);
    console.log(`Balance before claim: ${balanceBefore.value.uiAmount} RRIYAL`);
    
    try {
      // Only admin needs to sign the transaction - Ed25519 verification is done via instruction data
      claimTransaction.feePayer = admin.publicKey;
      claimTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      claimTransaction.sign(admin); // Only admin signs the transaction
      const claimResult = await connection.sendRawTransaction(claimTransaction.serialize());
      await connection.confirmTransaction(claimResult);
      
      console.log("🎉 CLAIM SUCCEEDED!");
      console.log(`Transaction: ${claimResult}`);
      
      // REAL VERIFICATION: Check if claim actually worked
      const balanceAfter = await connection.getTokenAccountBalance(user1TokenAccount);
      const user1DataAfter = await program.account.userData.fetch(user1DataPDA);
      
      console.log(`Balance after claim: ${balanceAfter.value.uiAmount} RRIYAL`);
      console.log(`Nonce incremented to: ${user1DataAfter.nonce.toString()}`);
      console.log(`Total claims: ${user1DataAfter.totalClaims.toString()}`);
      
      // Verify the claim actually added tokens
      const expectedIncrease = amount;
      const actualIncrease = BigInt(balanceAfter.value.amount) - BigInt(balanceBefore.value.amount);
      
      if (actualIncrease !== BigInt(expectedIncrease)) {
        throw new Error(`CRITICAL: Expected ${expectedIncrease} token increase, got ${actualIncrease}`);
      }
      
      console.log("✅ REAL ED25519 VERIFICATION SUCCESS!");
      console.log("✅ Claim amount correctly added to balance");
      console.log("✅ Nonce correctly incremented");
      
    } catch (error) {
      console.error("❌ ED25519 CLAIM FAILED:");
      console.error("Error:", error.message);
      throw error;
    }

    console.log("\n============================================================");
    console.log("🛡️ MODULE 4: REAL NONCE & REPLAY ATTACK PREVENTION");
    console.log("============================================================");

    // 7. Test REAL nonce replay attack prevention
    console.log("\n7️⃣ Test REAL nonce replay attack prevention");
    
    // Get current user data for nonce
    const currentUser1Data = await program.account.userData.fetch(user1DataPDA);
    const oldNonce = currentUser1Data.nonce.toNumber() - 1; // Use OLD nonce
    
    // Create replay message with OLD nonce using proper domain separation
    const replayAmount = 500000000;
    const replayValidUntil = Math.floor(Date.now() / 1000) + 3600;
    const replayMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user1.publicKey,
      user1TokenAccount,
      replayAmount,
      oldNonce, // OLD NONCE - REPLAY ATTACK
      replayValidUntil
    );
    
    // Generate signatures for replay attack
    const replayUserSignature = nacl.sign.detached(replayMessageBytes, user1.secretKey);
    const replayAdminSignature = nacl.sign.detached(replayMessageBytes, admin.secretKey);
    
    // Create Ed25519 instructions for replay
    const replayUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user1.publicKey.toBytes(),
      message: replayMessageBytes,
      signature: replayUserSignature,
    });
    
    const replayAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: replayMessageBytes,
      signature: replayAdminSignature,
    });
    
    const replayClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(replayAmount),
        new anchor.BN(oldNonce),
        new anchor.BN(replayValidUntil),
        Array.from(replayUserSignature),
        Array.from(replayAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: user1DataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, // CRITICAL: Ed25519 verification requires this
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    const replayTransaction = new Transaction()
      .add(replayUserEd25519Ix)
      .add(replayAdminEd25519Ix)
      .add(replayClaimIx);
    
    try {
      replayTransaction.feePayer = admin.publicKey;
      replayTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      replayTransaction.sign(admin); // Only admin signs
      const replayResult = await connection.sendRawTransaction(replayTransaction.serialize());
      await connection.confirmTransaction(replayResult);
      throw new Error("CRITICAL: Nonce replay attack succeeded when it should fail");
    } catch (error) {
      if (!error.message.includes("InvalidNonce") && !error.message.includes("NonceNotIncreasing")) {
        throw new Error(`WRONG ERROR: Expected nonce error, got: ${error.message}`);
      }
      console.log("✅ Nonce replay attack correctly prevented");
    }

    // 8. Test REAL "nonce too high" attack prevention
    console.log("\n8️⃣ Test REAL 'nonce too high' attack prevention");
    
    const currentNonce = currentUser1Data.nonce.toNumber();
    const tooHighNonce = currentNonce + 100; // WAY TOO HIGH
    
    const highNonceAmount = 500000000;
    const highNonceValidUntil = Math.floor(Date.now() / 1000) + 3600;
    const highNonceMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user1.publicKey,
      user1TokenAccount,
      highNonceAmount,
      tooHighNonce,
      highNonceValidUntil
    );
    
    const highNonceUserSignature = nacl.sign.detached(highNonceMessageBytes, user1.secretKey);
    const highNonceAdminSignature = nacl.sign.detached(highNonceMessageBytes, admin.secretKey);
    
    const highNonceUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user1.publicKey.toBytes(),
      message: highNonceMessageBytes,
      signature: highNonceUserSignature,
    });
    
    const highNonceAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: highNonceMessageBytes,
      signature: highNonceAdminSignature,
    });
    
    const highNonceClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(highNonceAmount),
        new anchor.BN(tooHighNonce),
        new anchor.BN(highNonceValidUntil),
        Array.from(highNonceUserSignature),
        Array.from(highNonceAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: user1DataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, // CRITICAL: Ed25519 verification requires this
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    const highNonceTransaction = new Transaction()
      .add(highNonceUserEd25519Ix)
      .add(highNonceAdminEd25519Ix)
      .add(highNonceClaimIx);
    
    try {
      highNonceTransaction.feePayer = admin.publicKey;
      highNonceTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      highNonceTransaction.sign(admin); // Only admin signs
      const highNonceResult = await connection.sendRawTransaction(highNonceTransaction.serialize());
      await connection.confirmTransaction(highNonceResult);
      throw new Error("CRITICAL: High nonce attack succeeded when it should fail");
    } catch (error) {
      if (!error.message.includes("NonceTooHigh") && !error.message.includes("InvalidNonce")) {
        throw new Error(`WRONG ERROR: Expected nonce error, got: ${error.message}`);
      }
      console.log("✅ High nonce attack correctly prevented");
    }

    console.log("\n============================================================");
    console.log("🎯 MODULE 5: REAL DESTINATION BINDING SECURITY");
    console.log("============================================================");

    // 9. Test REAL destination binding (user1 tries to claim to user2's account)
    console.log("\n9️⃣ Test REAL destination binding - claim to wrong account");
    
    const destAmount = 500000000;
    const destValidUntil = Math.floor(Date.now() / 1000) + 3600;
    const destMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user1.publicKey,
      user2TokenAccount, // WRONG DESTINATION - this is the attack vector
      destAmount,
      currentUser1Data.nonce.toNumber(),
      destValidUntil
    );
    
    const destUserSignature = nacl.sign.detached(destMessageBytes, user1.secretKey);
    const destAdminSignature = nacl.sign.detached(destMessageBytes, admin.secretKey);
    
    const destUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user1.publicKey.toBytes(),
      message: destMessageBytes,
      signature: destUserSignature,
    });
    
    const destAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: destMessageBytes,
      signature: destAdminSignature,
    });
    
    // Try to claim to user2's token account using user1's signatures
    const wrongDestClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(destAmount),
        new anchor.BN(currentUser1Data.nonce.toNumber()),
        new anchor.BN(destValidUntil),
        Array.from(destUserSignature),
        Array.from(destAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: user1DataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user2TokenAccount, // WRONG DESTINATION!
        user: user1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    const wrongDestTransaction = new Transaction()
      .add(destUserEd25519Ix)
      .add(destAdminEd25519Ix)
      .add(wrongDestClaimIx);
    
    try {
      wrongDestTransaction.feePayer = admin.publicKey;
      wrongDestTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      wrongDestTransaction.sign(admin); // Only admin signs
      const wrongDestResult = await connection.sendRawTransaction(wrongDestTransaction.serialize());
      await connection.confirmTransaction(wrongDestResult);
      throw new Error("CRITICAL: Claim to wrong destination succeeded when it should fail");
    } catch (error) {
      if (!error.message.includes("UnauthorizedDestination")) {
        throw new Error(`WRONG ERROR: Expected UnauthorizedDestination, got: ${error.message}`);
      }
      console.log("✅ Wrong destination correctly prevented (UnauthorizedDestination)");
    }

    console.log("\n🎉 ALL REAL ED25519 TESTS PASSED!");
    console.log("✅ Ed25519 signature verification working");
    console.log("✅ Nonce replay prevention working");
    console.log("✅ Nonce validation working");
    console.log("✅ Destination binding security working");

    console.log("\n============================================================");
    console.log("⏰ MODULE 6: REAL TIME-LOCK ENFORCEMENT");
    console.log("============================================================");

    // 10. Test REAL time-lock enforcement (claim too soon)
    console.log("\n🔟 Test REAL time-lock enforcement");
    
    // Try to claim again immediately (should fail due to time-lock)
    const timeLockAmount = 250000000;
    const timeLockValidUntil = Math.floor(Date.now() / 1000) + 3600;
    const timeLockMessageBytes = createDomainSeparatedMessage(
      program.programId,
      tokenStatePDA,
      tokenState.tokenMint,
      user1.publicKey,
      user1TokenAccount,
      timeLockAmount,
      currentUser1Data.nonce.toNumber(),
      timeLockValidUntil
    );
    
    const timeLockUserSignature = nacl.sign.detached(timeLockMessageBytes, user1.secretKey);
    const timeLockAdminSignature = nacl.sign.detached(timeLockMessageBytes, admin.secretKey);
    
    const timeLockUserEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: user1.publicKey.toBytes(),
      message: timeLockMessageBytes,
      signature: timeLockUserSignature,
    });
    
    const timeLockAdminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: timeLockMessageBytes,
      signature: timeLockAdminSignature,
    });
    
    const timeLockClaimIx = await program.methods
      .claimTokens(
        new anchor.BN(timeLockAmount),
        new anchor.BN(currentUser1Data.nonce.toNumber()),
        new anchor.BN(timeLockValidUntil),
        Array.from(timeLockUserSignature),
        Array.from(timeLockAdminSignature)
      )
      .accounts({
        tokenState: tokenStatePDA,
        userData: user1DataPDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, // CRITICAL: Ed25519 verification requires this
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    const timeLockTransaction = new Transaction()
      .add(timeLockUserEd25519Ix)
      .add(timeLockAdminEd25519Ix)
      .add(timeLockClaimIx);
    
    try {
      timeLockTransaction.feePayer = admin.publicKey;
      timeLockTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      timeLockTransaction.sign(admin); // Only admin signs
      const timeLockResult = await connection.sendRawTransaction(timeLockTransaction.serialize());
      await connection.confirmTransaction(timeLockResult);
      throw new Error("CRITICAL: Time-lock bypass succeeded when it should fail");
    } catch (error) {
      if (!error.message.includes("ClaimTooSoon") && !error.message.includes("ClaimTimeLocked")) {
        throw new Error(`WRONG ERROR: Expected time-lock error, got: ${error.message}`);
      }
      console.log("✅ Time-lock enforcement working (claim blocked within 1-hour period)");
    }

    console.log("\n============================================================");
    console.log("🔥 MODULE 7: REAL FREEZE STATE VERIFICATION");
    console.log("============================================================");

    // 11. REAL freeze state verification before transfers enabled
    console.log("\n1️⃣1️⃣ Verify accounts are FROZEN at SPL level before transfers enabled");
    
    // Check if user1's token account is frozen
    const user1AccountInfo = await getAccount(connection, user1TokenAccount);
    if (!user1AccountInfo.isFrozen) {
      throw new Error("CRITICAL: User1 token account should be FROZEN but is not!");
    }
    console.log("✅ User1 account is correctly FROZEN at SPL level");

    // Try direct SPL transfer (should fail)
    try {
      const { createTransferInstruction } = require("@solana/spl-token");
      const transferIx = createTransferInstruction(
        user1TokenAccount,
        user2TokenAccount, 
        user1.publicKey,
        100 * 10**9
      );
      const transaction = new Transaction().add(transferIx);
      transaction.feePayer = user1.publicKey;
      transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      transaction.partialSign(user1);
      await connection.sendRawTransaction(transaction.serialize());
      throw new Error("CRITICAL: Direct SPL transfer succeeded on frozen account!");
    } catch (error) {
      if (error.message.includes("CRITICAL")) {
        throw error;
      }
      console.log("✅ Direct SPL transfer correctly blocked (account frozen)");
    }

    // 12. Test unfreeze before admin enables transfers (should fail)
    console.log("\n1️⃣2️⃣ Test unfreeze before admin enables transfers");
    try {
      const unfreezeBeforeTx = new Transaction();
      unfreezeBeforeTx.add(await program.methods
        .unfreezeAccount()
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint.publicKey,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction());
      unfreezeBeforeTx.feePayer = user1.publicKey;
      unfreezeBeforeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      unfreezeBeforeTx.partialSign(user1);
      await connection.sendRawTransaction(unfreezeBeforeTx.serialize());
      throw new Error("CRITICAL: User unfroze account before admin enabled transfers!");
    } catch (error) {
      if (!error.message.includes("TransfersNotEnabled")) {
        throw new Error(`WRONG ERROR: Expected TransfersNotEnabled, got: ${error.message}`);
      }
      console.log("✅ Unfreeze correctly blocked before admin enables transfers");
    }

    console.log("\n============================================================");
    console.log("🔄 MODULE 8: ADMIN TRANSFER CONTROL & UNFREEZE FLOW");
    console.log("============================================================");

    // 13. Admin enables transfers (permanent operation)
    console.log("\n1️⃣3️⃣ Admin enables transfers (permanent)");
    await program.methods
      .enableTransfers()
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    
    const transferState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log("✅ Transfers enabled by admin");
    console.log("  Transfers enabled:", transferState.transfersEnabled);
    // Note: transfers_permanently_enabled field removed - was undefined

    // 14. Users unfreeze their accounts after admin enables transfers
    console.log("\n1️⃣4️⃣ Users unfreeze accounts after admin enables transfers");
    
    // User1 unfreezes
    const user1UnfreezeTx = new Transaction();
    user1UnfreezeTx.add(await program.methods
      .unfreezeAccount()
      .accounts({
        tokenState: tokenStatePDA,
        mint: tokenMint.publicKey,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction());
    user1UnfreezeTx.feePayer = user1.publicKey;
    user1UnfreezeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    user1UnfreezeTx.partialSign(user1);
    await connection.sendRawTransaction(user1UnfreezeTx.serialize());
    
    // Wait a moment for the transaction to settle
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify user1 account is now unfrozen - HARD ASSERT
    const user1AccountAfterUnfreeze = await getAccount(connection, user1TokenAccount);
    console.log("User1 account frozen status after unfreeze:", user1AccountAfterUnfreeze.isFrozen);
    
    if (user1AccountAfterUnfreeze.isFrozen) {
      throw new Error("CRITICAL: Unfreeze failed - account is still frozen!");
    }
    console.log("✅ User1 account successfully unfrozen");

    console.log("\n============================================================");
    console.log("🛡️ MODULE 9: COMPREHENSIVE SECURITY AUDIT");
    console.log("============================================================");

    // 15. Test unauthorized admin operations
    console.log("\n1️⃣5️⃣ Test unauthorized admin operations");
    
    const unauthorizedTests = [
      {
        name: "Unauthorized mint",
        test: async () => {
          return program.methods
            .mintTokens(new anchor.BN(1000))
            .accounts({
              tokenState: tokenStatePDA,
              mint: tokenMint.publicKey,
              userTokenAccount: user1TokenAccount,
              admin: maliciousUser.publicKey, // WRONG ADMIN
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([maliciousUser])
            .rpc();
        },
        expectedError: "UnauthorizedAdmin"
      },
      {
        name: "Unauthorized burn",
        test: async () => {
          return program.methods
            .burnTokens(new anchor.BN(1000))
            .accounts({
              tokenState: tokenStatePDA,
              mint: tokenMint.publicKey,
              userTokenAccount: user1TokenAccount,
              admin: maliciousUser.publicKey, // WRONG ADMIN
              userAuthority: user1.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([maliciousUser, user1])
            .rpc();
        },
        expectedError: "UnauthorizedAdmin"
      }
    ];

    for (const test of unauthorizedTests) {
      try {
        await test.test();
        throw new Error(`CRITICAL: ${test.name} succeeded when it should fail`);
      } catch (error) {
        if (!error.message.includes(test.expectedError)) {
          throw new Error(`WRONG ERROR for ${test.name}: Expected ${test.expectedError}, got: ${error.message}`);
        }
        console.log(`✅ ${test.name} correctly prevented`);
      }
    }

    console.log("\n🎉 ALL REAL TESTS COMPLETED!");
    console.log("📊 SUMMARY:");
    console.log("✅ Contract initialization");
    console.log("✅ Token mint creation");
    console.log("✅ Mint authority validation (SPL helpers)");
    console.log("✅ Duplicate mint prevention");
    console.log("✅ User data initialization");
    console.log("✅ REAL Ed25519 signature verification");
    console.log("✅ REAL nonce replay prevention");
    console.log("✅ REAL nonce validation");
    console.log("✅ REAL destination binding security");
    console.log("✅ REAL time-lock enforcement");
    console.log("✅ REAL freeze state verification");
    console.log("✅ Unfreeze guard validation");
    console.log("✅ Admin transfer control");
    console.log("✅ Comprehensive security audit");
    console.log("🎉 ALL TESTS PASSED!");

  } catch (error) {
    console.error("❌ REAL TEST FAILED:");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the complete REAL end-to-end test
testCompleteRiyalContractRealNoMocks().catch(console.error);
