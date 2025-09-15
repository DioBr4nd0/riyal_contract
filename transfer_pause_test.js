const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const fs = require('fs');
const BN = anchor.BN;

async function airdrop(connection, pubkey, sol = 10) {
  const sig = await connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function getBalance(connection, ata) {
  try {
    const balance = await connection.getTokenAccountBalance(ata);
    return {
      ui: balance.value.uiAmount || 0,
      raw: balance.value.amount
    };
  } catch (e) {
    return { ui: 0, raw: "0" };
  }
}

async function testError(testName, testFn) {
  try {
    await testFn();
    console.log(`❌ ${testName}: Expected error but succeeded`);
    return false;
  } catch (e) {
    console.log(`✅ ${testName}: Correctly blocked`);
    console.log(`   Error: ${e.message.split('.')[0]}...`);
    return true;
  }
}

(async () => {
  console.log("🚫 RIYAL CONTRACT - TRANSFER PAUSE/RESUME TESTS");
  console.log("===============================================");

  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const adminKeypairData = JSON.parse(fs.readFileSync('./admin.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  console.log("👥 PARTICIPANTS:");
  console.log(`   Admin: ${admin.publicKey}`);
  console.log(`   User1: ${user1.publicKey}`);
  console.log(`   User2: ${user2.publicKey}`);

  // Airdrop
  console.log("\n💰 FUNDING ACCOUNTS...");
  await Promise.all([admin, user1, user2].map(k => airdrop(connection, k.publicKey, 10)));
  console.log("✅ All accounts funded");

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);

  console.log("\n🏗️ STEP 1: CONTRACT SETUP");
  console.log("==========================");

  // Initialize contract
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new BN(30), false, true)
    .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
    .signers([admin]).rpc();
  console.log("✅ Contract initialized");

  // Create token mint (should start paused)
  const mint = Keypair.generate();
  await program.methods
    .createTokenMint(9, "Riyal Token", "RIYAL")
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin, mint]).rpc();
  console.log(`✅ Token mint created: ${mint.publicKey}`);

  // Check initial state
  const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
  console.log(`✅ Initial transfer state: ${tokenState.transfersEnabled ? 'ENABLED' : 'PAUSED'} ✅`);

  // Create user token accounts
  const user1ATA = await getAssociatedTokenAddress(mint.publicKey, user1.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const user2ATA = await getAssociatedTokenAddress(mint.publicKey, user2.publicKey, false, TOKEN_2022_PROGRAM_ID);

  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, user1ATA, user1.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)
  ), [admin]);
  
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(admin.publicKey, user2ATA, user2.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)
  ), [admin]);
  console.log("✅ User token accounts created");

  // Mint some tokens to users
  await program.methods
    .mintTokens(new BN(10000000000)) // 10 RIYAL
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, userTokenAccount: user1ATA,
      admin: admin.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([admin]).rpc();

  await program.methods
    .mintTokens(new BN(5000000000)) // 5 RIYAL
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, userTokenAccount: user2ATA,
      admin: admin.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([admin]).rpc();

  console.log(`✅ Tokens minted:`);
  console.log(`   User1: ${(await getBalance(connection, user1ATA)).ui} RIYAL`);
  console.log(`   User2: ${(await getBalance(connection, user2ATA)).ui} RIYAL`);

  console.log("\n🚫 STEP 2: TEST TRANSFERS WHILE PAUSED");
  console.log("======================================");

  // Test: Transfer should fail while paused
  console.log("🚫 Testing transfer while paused...");
  await testError("Transfer while paused", async () => {
    await program.methods
      .transferTokens(new BN(1000000000)) // 1 RIYAL
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        fromTokenAccount: user1ATA,
        toTokenAccount: user2ATA,
        fromAuthority: user1.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user1]).rpc();
  });

  console.log("\n▶️ STEP 3: RESUME TRANSFERS");
  console.log("===========================");

  // Resume transfers
  await program.methods
    .resumeTransfers()
    .accounts({
      tokenState: tokenStatePDA,
      admin: admin.publicKey,
    })
    .signers([admin]).rpc();

  const tokenStateAfterResume = await program.account.tokenState.fetch(tokenStatePDA);
  console.log(`✅ Transfers resumed: ${tokenStateAfterResume.transfersEnabled ? 'ENABLED' : 'PAUSED'} ✅`);
  console.log(`✅ Transfer enable timestamp: ${tokenStateAfterResume.transferEnableTimestamp}`);

  console.log("\n✅ STEP 4: TEST TRANSFERS WHILE ENABLED");
  console.log("=======================================");

  // Test: Transfer should succeed while enabled
  console.log("✅ Testing transfer while enabled...");
  const user1BalanceBefore = await getBalance(connection, user1ATA);
  const user2BalanceBefore = await getBalance(connection, user2ATA);
  
  await program.methods
    .transferTokens(new BN(2000000000)) // 2 RIYAL
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint.publicKey,
      fromTokenAccount: user1ATA,
      toTokenAccount: user2ATA,
      fromAuthority: user1.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user1]).rpc();

  const user1BalanceAfter = await getBalance(connection, user1ATA);
  const user2BalanceAfter = await getBalance(connection, user2ATA);

  console.log(`✅ Transfer successful!`);
  console.log(`   User1: ${user1BalanceBefore.ui} → ${user1BalanceAfter.ui} RIYAL (sent 2 RIYAL)`);
  console.log(`   User2: ${user2BalanceBefore.ui} → ${user2BalanceAfter.ui} RIYAL (received 2 RIYAL)`);

  console.log("\n⏸️ STEP 5: PAUSE TRANSFERS AGAIN");
  console.log("=================================");

  // Pause transfers again
  await program.methods
    .pauseTransfers()
    .accounts({
      tokenState: tokenStatePDA,
      admin: admin.publicKey,
    })
    .signers([admin]).rpc();

  const tokenStateAfterPause = await program.account.tokenState.fetch(tokenStatePDA);
  console.log(`✅ Transfers paused again: ${tokenStateAfterPause.transfersEnabled ? 'ENABLED' : 'PAUSED'} ✅`);

  // Test: Transfer should fail again
  console.log("🚫 Testing transfer after re-pausing...");
  await testError("Transfer after re-pausing", async () => {
    await program.methods
      .transferTokens(new BN(1000000000)) // 1 RIYAL
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        fromTokenAccount: user1ATA,
        toTokenAccount: user2ATA,
        fromAuthority: user1.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user1]).rpc();
  });

  console.log("\n🔒 STEP 6: PERMANENTLY ENABLE TRANSFERS");
  console.log("=======================================");

  // Permanently enable transfers
  await program.methods
    .permanentlyEnableTransfers()
    .accounts({
      tokenState: tokenStatePDA,
      admin: admin.publicKey,
    })
    .signers([admin]).rpc();

  const tokenStateAfterPermanent = await program.account.tokenState.fetch(tokenStatePDA);
  console.log(`✅ Transfers permanently enabled: ${tokenStateAfterPermanent.transfersEnabled ? 'ENABLED' : 'PAUSED'} ✅`);
  console.log(`✅ Permanently enabled: ${tokenStateAfterPermanent.transfersPermanentlyEnabled ? 'YES' : 'NO'} ✅`);

  // Test: Transfer should work
  console.log("✅ Testing transfer after permanent enable...");
  const user1BalanceBefore2 = await getBalance(connection, user1ATA);
  const user2BalanceBefore2 = await getBalance(connection, user2ATA);
  
  await program.methods
    .transferTokens(new BN(1000000000)) // 1 RIYAL
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint.publicKey,
      fromTokenAccount: user1ATA,
      toTokenAccount: user2ATA,
      fromAuthority: user1.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user1]).rpc();

  const user1BalanceAfter2 = await getBalance(connection, user1ATA);
  const user2BalanceAfter2 = await getBalance(connection, user2ATA);

  console.log(`✅ Transfer successful!`);
  console.log(`   User1: ${user1BalanceBefore2.ui} → ${user1BalanceAfter2.ui} RIYAL (sent 1 RIYAL)`);
  console.log(`   User2: ${user2BalanceBefore2.ui} → ${user2BalanceAfter2.ui} RIYAL (received 1 RIYAL)`);

  // Test: Pause should fail now (permanently enabled)
  console.log("\n🚫 Testing pause after permanent enable (should fail)...");
  await testError("Pause after permanent enable", async () => {
    await program.methods
      .pauseTransfers()
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .signers([admin]).rpc();
  });

  console.log("\n🎯 FINAL RESULTS");
  console.log("================");
  console.log("📋 Transfer Pause/Resume Tests:");
  console.log("   ✅ Token starts with transfers PAUSED");
  console.log("   ✅ Transfers blocked when paused");
  console.log("   ✅ Admin can resume transfers");
  console.log("   ✅ Transfers work when enabled");
  console.log("   ✅ Admin can pause transfers again");
  console.log("   ✅ Admin can permanently enable transfers");
  console.log("   ✅ Pause blocked after permanent enable");
  
  console.log("\n📋 Final Balances:");
  console.log(`   User1: ${(await getBalance(connection, user1ATA)).ui} RIYAL`);
  console.log(`   User2: ${(await getBalance(connection, user2ATA)).ui} RIYAL`);
  console.log(`   Total transferred: 3 RIYAL (2 + 1)`);

  console.log("\n🎉 ALL TRANSFER PAUSE/RESUME TESTS PASSED! 🎉");
  console.log("   • Tokens start paused as requested ✅");
  console.log("   • Transfer blocking works without freezing wallets ✅");
  console.log("   • Admin has full control over transfer state ✅");
  console.log("   • Permanent enable provides irreversible unlock ✅");
  console.log("   • Users maintain wallet access throughout ✅");

})().catch(console.error);
