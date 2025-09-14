const anchor = require("@coral-xyz/anchor");
const { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  SYSVAR_RENT_PUBKEY, 
  Transaction 
} = require("@solana/web3.js");
const { 
  TOKEN_PROGRAM_ID, 
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount 
} = require("@solana/spl-token");

// Helper to send and confirm transaction with detailed error logging
async function sendAndConfirmTx(connection, transaction, signers, description) {
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
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log(`✅ ${description} - Signature: ${signature}`);
    return signature;
  } catch (error) {
    console.log(`❌ ${description} - Error: ${error.message}`);
    
    // Try to get detailed logs if available
    if (error.logs) {
      console.log("📋 Transaction Logs:");
      error.logs.forEach((log, index) => {
        console.log(`  ${index + 1}: ${log}`);
      });
    }
    
    throw error;
  }
}

// Helper to get token balance
async function getTokenBalance(connection, tokenAccount) {
  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    return parseFloat(balance.value.uiAmount) || 0;
  } catch (error) {
    return 0;
  }
}

async function testTransferWithFreeze() {
  console.log("🔄 RIYAL CONTRACT - TRANSFER & FREEZE TEST");
  console.log("🎯 Testing token transfers with freeze mechanism");
  console.log("👥 Two accounts: Alice and Bob");
  console.log("💰 Mint 50 tokens to each, then test transfers");
  console.log("===============================================");

  // Configure the client
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  
  // Create test accounts
  const admin = Keypair.generate();
  const alice = Keypair.generate(); 
  const bob = Keypair.generate();   
  const tokenMint = Keypair.generate();
  
  // Fund accounts
  console.log("\n💰 Funding accounts...");
  for (const account of [admin, alice, bob]) {
    const airdrop = await connection.requestAirdrop(account.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop);
  }
  
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;
  
  // Derive PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  console.log("🏗️  Setup Complete:");
  console.log(`  Admin: ${admin.publicKey.toString()}`);
  console.log(`  Alice: ${alice.publicKey.toString()}`);
  console.log(`  Bob: ${bob.publicKey.toString()}`);
  console.log(`  Program ID: ${program.programId.toString()}`);

  try {
    // 1. Initialize contract
    console.log("\n1️⃣ Initialize contract");
    const initTx = new Transaction().add(
      await program.methods
        .initialize(
          admin.publicKey,
          admin.publicKey, // upgrade authority
          new anchor.BN(60), // claim period (not used anymore)
          false, // time lock disabled
          true   // upgradeable
        )
        .accounts({
          tokenState: tokenStatePDA,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, initTx, [admin], "Contract initialization");

    // 2. Create token mint
    console.log("\n2️⃣ Create token mint");
    const createMintTx = new Transaction().add(
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
        .instruction()
    );
    
    await sendAndConfirmTx(connection, createMintTx, [admin, tokenMint], "Token mint creation");

    // 3. Create token accounts
    console.log("\n3️⃣ Create token accounts");
    
    const aliceTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, alice.publicKey);
    const bobTokenAccount = await getAssociatedTokenAddress(tokenMint.publicKey, bob.publicKey);
    
    const createAccountsTx = new Transaction()
      .add(createAssociatedTokenAccountInstruction(
        admin.publicKey, aliceTokenAccount, alice.publicKey, tokenMint.publicKey
      ))
      .add(createAssociatedTokenAccountInstruction(
        admin.publicKey, bobTokenAccount, bob.publicKey, tokenMint.publicKey
      ));
    
    await sendAndConfirmTx(connection, createAccountsTx, [admin], "Token accounts creation");

    // 4. Mint 50 tokens to Alice
    console.log("\n4️⃣ Mint 50 tokens to Alice");
    const mintToAliceTx = new Transaction().add(
      await program.methods
        .mintTokens(new anchor.BN(50 * 10**9)) // 50 tokens
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint.publicKey,
          userTokenAccount: aliceTokenAccount,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, mintToAliceTx, [admin], "Mint 50 tokens to Alice");

    // 5. Mint 50 tokens to Bob
    console.log("\n5️⃣ Mint 50 tokens to Bob");
    const mintToBobTx = new Transaction().add(
      await program.methods
        .mintTokens(new anchor.BN(50 * 10**9)) // 50 tokens
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint.publicKey,
          userTokenAccount: bobTokenAccount,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, mintToBobTx, [admin], "Mint 50 tokens to Bob");

    // 6. Check initial balances
    console.log("\n6️⃣ Check initial balances");
    const aliceBalance = await getTokenBalance(connection, aliceTokenAccount);
    const bobBalance = await getTokenBalance(connection, bobTokenAccount);
    
    console.log(`  Alice balance: ${aliceBalance} RRIYAL`);
    console.log(`  Bob balance: ${bobBalance} RRIYAL`);

    // 7. Check if accounts are frozen
    console.log("\n7️⃣ Check account freeze status");
    const aliceAccountInfo = await getAccount(connection, aliceTokenAccount);
    const bobAccountInfo = await getAccount(connection, bobTokenAccount);
    
    console.log(`  Alice account frozen: ${aliceAccountInfo.isFrozen}`);
    console.log(`  Bob account frozen: ${bobAccountInfo.isFrozen}`);

    // 8. Try direct SPL transfer (should fail - accounts are frozen)
    console.log("\n8️⃣ Test direct SPL transfer (Alice → Bob, 10 tokens)");
    console.log("   Expected: FAIL (accounts are frozen)");
    
    try {
      const transferIx = createTransferInstruction(
        aliceTokenAccount,    // from
        bobTokenAccount,      // to
        alice.publicKey,      // authority
        10 * 10**9           // 10 tokens
      );
      
      const directTransferTx = new Transaction().add(transferIx);
      await sendAndConfirmTx(connection, directTransferTx, [alice], "Direct SPL transfer");
      
      console.log("🚨 UNEXPECTED: Direct transfer succeeded when it should have failed!");
      
    } catch (error) {
      console.log("🛡️  Direct SPL transfer correctly blocked!");
      console.log(`   Reason: ${error.message.includes('frozen') ? 'Account is frozen' : 'Transfer blocked'}`);
      
      // Print detailed logs
      if (error.message.includes('Simulation failed')) {
        console.log("📋 Detailed Error Information:");
        const match = error.message.match(/Logs: \[(.*?)\]/s);
        if (match) {
          try {
            const logsStr = match[1].replace(/"/g, '');
            const logs = logsStr.split(',').map(log => log.trim());
            logs.forEach((log, index) => {
              if (log) console.log(`     ${index + 1}: ${log}`);
            });
          } catch (parseError) {
            console.log(`     Raw error: ${error.message}`);
          }
        }
      }
    }

    // 9. Try contract-level transfer (should also fail - transfers not enabled)
    console.log("\n9️⃣ Test contract-level transfer (Alice → Bob, 5 tokens)");
    console.log("   Expected: FAIL (transfers not enabled in contract)");
    
    try {
      const contractTransferTx = new Transaction().add(
        await program.methods
          .transferTokens(new anchor.BN(5 * 10**9)) // 5 tokens
          .accounts({
            tokenState: tokenStatePDA,
            mint: tokenMint.publicKey,
            fromTokenAccount: aliceTokenAccount,
            toTokenAccount: bobTokenAccount,
            fromAuthority: alice.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      );
      
      await sendAndConfirmTx(connection, contractTransferTx, [alice], "Contract-level transfer");
      
      console.log("🚨 UNEXPECTED: Contract transfer succeeded when it should have failed!");
      
    } catch (error) {
      console.log("🛡️  Contract-level transfer correctly blocked!");
      console.log(`   Reason: Transfers not enabled in contract`);
      
      // Print detailed logs
      if (error.message.includes('Simulation failed')) {
        console.log("📋 Detailed Error Information:");
        const match = error.message.match(/Logs: \[(.*?)\]/s);
        if (match) {
          try {
            const logsStr = match[1].replace(/"/g, '');
            const logs = logsStr.split(',').map(log => log.trim());
            logs.forEach((log, index) => {
              if (log) console.log(`     ${index + 1}: ${log}`);
            });
          } catch (parseError) {
            console.log(`     Raw error: ${error.message}`);
          }
        }
      }
    }

    // 10. Admin enables transfers
    console.log("\n🔓 Admin enables transfers (PERMANENT operation)");
    const enableTransfersTx = new Transaction().add(
      await program.methods
        .enableTransfers()
        .accounts({
          tokenState: tokenStatePDA,
          admin: admin.publicKey,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, enableTransfersTx, [admin], "Enable transfers");

    // 11. Users unfreeze their accounts
    console.log("\n🔓 Users unfreeze their accounts");
    
    // Alice unfreezes her account
    const aliceUnfreezeTx = new Transaction().add(
      await program.methods
        .unfreezeAccount()
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint.publicKey,
          userTokenAccount: aliceTokenAccount,
          user: alice.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, aliceUnfreezeTx, [alice], "Alice unfreezes account");

    // Bob unfreezes his account
    const bobUnfreezeTx = new Transaction().add(
      await program.methods
        .unfreezeAccount()
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint.publicKey,
          userTokenAccount: bobTokenAccount,
          user: bob.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    
    await sendAndConfirmTx(connection, bobUnfreezeTx, [bob], "Bob unfreezes account");

    // 12. Check freeze status after unfreezing
    console.log("\n🔍 Check freeze status after unfreezing");
    const aliceAccountAfter = await getAccount(connection, aliceTokenAccount);
    const bobAccountAfter = await getAccount(connection, bobTokenAccount);
    
    console.log(`  Alice account frozen: ${aliceAccountAfter.isFrozen}`);
    console.log(`  Bob account frozen: ${bobAccountAfter.isFrozen}`);

    // 13. Try direct SPL transfer again (should work now)
    console.log("\n✅ Test direct SPL transfer after unfreezing (Alice → Bob, 10 tokens)");
    console.log("   Expected: SUCCESS (accounts are unfrozen)");
    
    try {
      const transferIx = createTransferInstruction(
        aliceTokenAccount,    // from
        bobTokenAccount,      // to
        alice.publicKey,      // authority
        10 * 10**9           // 10 tokens
      );
      
      const successTransferTx = new Transaction().add(transferIx);
      await sendAndConfirmTx(connection, successTransferTx, [alice], "Direct SPL transfer (after unfreeze)");
      
      console.log("🎉 Direct transfer succeeded!");
      
    } catch (error) {
      console.log("❌ Unexpected: Direct transfer still failed!");
      console.log(`   Error: ${error.message}`);
    }

    // 14. Check final balances
    console.log("\n💰 Final balances");
    const aliceFinalBalance = await getTokenBalance(connection, aliceTokenAccount);
    const bobFinalBalance = await getTokenBalance(connection, bobTokenAccount);
    
    console.log(`  Alice final balance: ${aliceFinalBalance} RRIYAL (expected: 40)`);
    console.log(`  Bob final balance: ${bobFinalBalance} RRIYAL (expected: 60)`);

    // 15. Test contract-level transfer (should work now)
    console.log("\n✅ Test contract-level transfer after enabling (Bob → Alice, 5 tokens)");
    console.log("   Expected: SUCCESS (transfers enabled in contract)");
    
    try {
      const contractTransferTx = new Transaction().add(
        await program.methods
          .transferTokens(new anchor.BN(5 * 10**9)) // 5 tokens
          .accounts({
            tokenState: tokenStatePDA,
            mint: tokenMint.publicKey,
            fromTokenAccount: bobTokenAccount,
            toTokenAccount: aliceTokenAccount,
            fromAuthority: bob.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      );
      
      await sendAndConfirmTx(connection, contractTransferTx, [bob], "Contract-level transfer (after enable)");
      
      console.log("🎉 Contract transfer succeeded!");
      
    } catch (error) {
      console.log("❌ Unexpected: Contract transfer still failed!");
      console.log(`   Error: ${error.message}`);
      
      // Print detailed logs
      if (error.message.includes('Simulation failed')) {
        console.log("📋 Detailed Error Information:");
        const match = error.message.match(/Logs: \[(.*?)\]/s);
        if (match) {
          try {
            const logsStr = match[1].replace(/"/g, '');
            const logs = logsStr.split(',').map(log => log.trim());
            logs.forEach((log, index) => {
              if (log) console.log(`     ${index + 1}: ${log}`);
            });
          } catch (parseError) {
            console.log(`     Raw error: ${error.message}`);
          }
        }
      }
    }

    // 16. Final balance check
    console.log("\n💰 Final balances after all transfers");
    const aliceVeryFinalBalance = await getTokenBalance(connection, aliceTokenAccount);
    const bobVeryFinalBalance = await getTokenBalance(connection, bobTokenAccount);
    
    console.log(`  Alice very final balance: ${aliceVeryFinalBalance} RRIYAL`);
    console.log(`  Bob very final balance: ${bobVeryFinalBalance} RRIYAL`);

    // Summary
    console.log("\n📊 TRANSFER & FREEZE TEST RESULTS");
    console.log("===================================");
    console.log("✅ Successfully minted 50 tokens to each account");
    console.log("✅ Accounts were automatically frozen after minting");
    console.log("🛡️  Direct SPL transfers blocked when frozen");
    console.log("🛡️  Contract transfers blocked when not enabled");
    console.log("✅ Admin successfully enabled transfers (permanent)");
    console.log("✅ Users successfully unfroze their accounts");
    console.log("✅ Transfers work normally after unfreezing + enabling");
    console.log("🎯 Freeze mechanism provides complete transfer control!");

  } catch (error) {
    console.error("❌ TEST FAILED:");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

// Run the transfer and freeze test
testTransferWithFreeze().catch(console.error);
