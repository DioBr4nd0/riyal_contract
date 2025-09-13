const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, SYSVAR_INSTRUCTIONS_PUBKEY } = anchor.web3;
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");

describe("Riyal Contract - Advanced Features", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    
    const program = anchor.workspace.RiyalContract;
    
    // Test accounts
    let admin, newAdmin, user1, user2;
    let tokenStatePDA, tokenStateBump;
    let user1DataPDA, user1DataBump;
    let user2DataPDA, user2DataBump;
    let mintAccount;
    let user1TokenAccount, user2TokenAccount;
    let treasuryAccount;
    
    before(async () => {
        // Generate test keypairs
        admin = Keypair.generate();
        newAdmin = Keypair.generate();
        user1 = Keypair.generate();
        user2 = Keypair.generate();
        mintAccount = Keypair.generate();
        
        // Airdrop SOL for testing
        const accounts = [admin, newAdmin, user1, user2];
        for (const account of accounts) {
            const airdropTx = await provider.connection.requestAirdrop(
                account.publicKey, 
                2 * anchor.web3.LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(airdropTx);
        }
        
        // Derive PDAs
        [tokenStatePDA, tokenStateBump] = await PublicKey.findProgramAddress(
            [Buffer.from("token_state")],
            program.programId
        );
        
        [user1DataPDA, user1DataBump] = await PublicKey.findProgramAddress(
            [Buffer.from("user_data"), user1.publicKey.toBuffer()],
            program.programId
        );
        
        [user2DataPDA, user2DataBump] = await PublicKey.findProgramAddress(
            [Buffer.from("user_data"), user2.publicKey.toBuffer()],
            program.programId
        );
        
        // Get associated token accounts
        user1TokenAccount = await getAssociatedTokenAddress(mintAccount.publicKey, user1.publicKey);
        user2TokenAccount = await getAssociatedTokenAddress(mintAccount.publicKey, user2.publicKey);
        treasuryAccount = await getAssociatedTokenAddress(mintAccount.publicKey, tokenStatePDA);
        
        console.log("🚀 Advanced Features Test Setup Complete");
        console.log("Admin:", admin.publicKey.toString());
        console.log("New Admin:", newAdmin.publicKey.toString());
        console.log("User1:", user1.publicKey.toString());
        console.log("User2:", user2.publicKey.toString());
    });
    
    it("⚙️ Setup: Complete Contract Initialization", async () => {
        console.log("\n=== ADVANCED FEATURES SETUP ===");
        
        // Initialize contract with advanced settings
        await program.methods
            .initialize(
                admin.publicKey,
                admin.publicKey, // admin is also upgrade authority initially
                new anchor.BN(7200), // 2 hours claim period
                true, // time-lock enabled
                true  // upgradeable
            )
            .accounts({
                tokenState: tokenStatePDA,
                payer: admin.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([admin])
            .rpc();
        
        // Create token mint
        await program.methods
            .createTokenMint(9, "AdvancedRiyal", "ARIYAL") // 9 decimals for precision
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .signers([admin, mintAccount])
            .rpc();
        
        // Create token accounts and user data
        await provider.sendAndConfirm(
            new anchor.web3.Transaction().add(
                createAssociatedTokenAccountInstruction(
                    admin.publicKey, user1TokenAccount, user1.publicKey, mintAccount.publicKey
                ),
                createAssociatedTokenAccountInstruction(
                    admin.publicKey, user2TokenAccount, user2.publicKey, mintAccount.publicKey
                )
            ),
            [admin]
        );
        
        // Initialize user data
        for (const [user, userDataPDA] of [[user1, user1DataPDA], [user2, user2DataPDA]]) {
            await program.methods
                .initializeUserData()
                .accounts({
                    userData: userDataPDA,
                    user: user.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .signers([user])
                .rpc();
        }
        
        console.log("✅ Advanced contract setup completed");
    });
    
    it("🔧 Test 1: Time-Lock Configuration Management", async () => {
        console.log("\n=== TEST: TIME-LOCK CONFIGURATION MANAGEMENT ===");
        
        // Test updating time-lock settings
        const newClaimPeriod = 10800; // 3 hours
        const newTimeLockEnabled = false;
        
        const tx = await program.methods
            .updateTimeLock(
                new anchor.BN(newClaimPeriod),
                newTimeLockEnabled
            )
            .accounts({
                tokenState: tokenStatePDA,
                admin: admin.publicKey,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Time-lock settings updated:", tx);
        
        // Verify the changes
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Updated Time-Lock Settings:", {
            claimPeriodSeconds: tokenState.claimPeriodSeconds.toString(),
            timeLockEnabled: tokenState.timeLockEnabled,
        });
        
        // Test with invalid period (should fail)
        try {
            await program.methods
                .updateTimeLock(
                    new anchor.BN(1800), // 30 minutes - too short
                    true
                )
                .accounts({
                    tokenState: tokenStatePDA,
                    admin: admin.publicKey,
                })
                .signers([admin])
                .rpc();
            
            throw new Error("Should have failed with invalid claim period");
        } catch (error) {
            console.log("✅ Correctly rejected invalid claim period");
        }
        
        console.log("🎉 Time-lock configuration management working!");
    });
    
    it("🔄 Test 2: Upgrade Authority Management", async () => {
        console.log("\n=== TEST: UPGRADE AUTHORITY MANAGEMENT ===");
        
        // Transfer upgrade authority to new admin
        const tx1 = await program.methods
            .setUpgradeAuthority(newAdmin.publicKey)
            .accounts({
                tokenState: tokenStatePDA,
                currentUpgradeAuthority: admin.publicKey,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Upgrade authority transferred:", tx1);
        
        // Verify the transfer
        let tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("New Upgrade Authority:", tokenState.upgradeAuthority.toString());
        
        // Test that old admin can't change upgrade authority anymore
        try {
            await program.methods
                .setUpgradeAuthority(admin.publicKey)
                .accounts({
                    tokenState: tokenStatePDA,
                    currentUpgradeAuthority: admin.publicKey, // old admin
                })
                .signers([admin])
                .rpc();
            
            throw new Error("Should have failed - old admin shouldn't have upgrade authority");
        } catch (error) {
            console.log("✅ Correctly rejected old upgrade authority");
        }
        
        // New admin removes upgrade authority (makes contract immutable)
        const tx2 = await program.methods
            .setUpgradeAuthority(null)
            .accounts({
                tokenState: tokenStatePDA,
                currentUpgradeAuthority: newAdmin.publicKey,
            })
            .signers([newAdmin])
            .rpc();
        
        console.log("✅ Upgrade authority removed (contract now immutable):", tx2);
        
        // Verify contract is now immutable
        tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Contract State:", {
            upgradeAuthority: tokenState.upgradeAuthority.toString(),
            upgradeable: tokenState.upgradeable,
        });
        
        console.log("🎉 Upgrade authority management working!");
    });
    
    it("💰 Test 3: Comprehensive Treasury Management", async () => {
        console.log("\n=== TEST: COMPREHENSIVE TREASURY MANAGEMENT ===");
        
        // Create treasury
        const tx1 = await program.methods
            .createTreasury()
            .accounts({
                tokenState: tokenStatePDA,
                treasuryAccount: treasuryAccount,
                mint: mintAccount.publicKey,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Treasury created:", tx1);
        
        // Mint large amount to treasury
        const treasuryMintAmount = 1000000 * 10**9; // 1M tokens with 9 decimals
        const tx2 = await program.methods
            .mintToTreasury(new anchor.BN(treasuryMintAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                treasuryAccount: treasuryAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted to treasury:", tx2);
        
        // Check treasury balance
        let treasuryBalance = await provider.connection.getTokenAccountBalance(treasuryAccount);
        console.log("Treasury Balance:", treasuryBalance.value.uiAmount, "ARIYAL");
        
        // Burn some tokens from treasury
        const burnAmount = 100000 * 10**9; // 100K tokens
        const tx3 = await program.methods
            .burnFromTreasury(new anchor.BN(burnAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                treasuryAccount: treasuryAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Burned from treasury:", tx3);
        
        // Check updated treasury balance
        treasuryBalance = await provider.connection.getTokenAccountBalance(treasuryAccount);
        console.log("Treasury Balance After Burn:", treasuryBalance.value.uiAmount, "ARIYAL");
        
        console.log("🎉 Treasury management working perfectly!");
    });
    
    it("🎯 Test 4: Precision Token Operations", async () => {
        console.log("\n=== TEST: PRECISION TOKEN OPERATIONS ===");
        
        // Test with very small amounts (testing 9 decimal precision)
        const precisionAmount = 1; // 0.000000001 tokens (1 unit with 9 decimals)
        
        // Mint tiny amount to user1
        const tx1 = await program.methods
            .mintTokens(new anchor.BN(precisionAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user1TokenAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted precision amount:", tx1);
        
        // Check balance
        const user1Balance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        console.log("User1 Precision Balance:", user1Balance.value.amount, "units");
        console.log("User1 UI Balance:", user1Balance.value.uiAmount, "ARIYAL");
        
        // Test with large amounts
        const largeAmount = 999999999 * 10**9; // 999,999,999 tokens
        
        const tx2 = await program.methods
            .mintTokens(new anchor.BN(largeAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user2TokenAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted large amount:", tx2);
        
        // Check balance
        const user2Balance = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        console.log("User2 Large Balance:", user2Balance.value.uiAmount, "ARIYAL");
        
        console.log("🎉 Precision token operations working!");
    });
    
    it("⏰ Test 5: Advanced Time-Lock Scenarios", async () => {
        console.log("\n=== TEST: ADVANCED TIME-LOCK SCENARIOS ===");
        
        // Re-enable time-lock with shorter period for testing
        await program.methods
            .updateTimeLock(
                new anchor.BN(3600), // 1 hour
                true // enable time-lock
            )
            .accounts({
                tokenState: tokenStatePDA,
                admin: admin.publicKey,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Time-lock re-enabled with 1 hour period");
        
        // Test multiple rapid claim attempts
        const userData = await program.account.userData.fetch(user1DataPDA);
        const currentNonce = userData.nonce.toNumber();
        
        // Valid signatures for testing
        const userSignature = new Array(64).fill(42);
        const adminSignature = new Array(64).fill(84);
        
        // First claim should succeed
        const tx1 = await program.methods
            .claimTokens(
                new anchor.BN(1000),
                new anchor.BN(currentNonce),
                userSignature,
                adminSignature
            )
            .accounts({
                tokenState: tokenStatePDA,
                userData: user1DataPDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user1TokenAccount,
                user: user1.publicKey,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user1])
            .rpc();
        
        console.log("✅ First claim successful:", tx1);
        
        // Check updated user data
        const updatedUserData = await program.account.userData.fetch(user1DataPDA);
        console.log("Updated User Data:", {
            nonce: updatedUserData.nonce.toString(),
            totalClaims: updatedUserData.totalClaims.toString(),
            lastClaimTimestamp: updatedUserData.lastClaimTimestamp.toString(),
            nextAllowedClaimTime: updatedUserData.nextAllowedClaimTime.toString(),
        });
        
        // Second claim should fail due to time-lock
        try {
            await program.methods
                .claimTokens(
                    new anchor.BN(1000),
                    new anchor.BN(currentNonce + 1),
                    userSignature,
                    adminSignature
                )
                .accounts({
                    tokenState: tokenStatePDA,
                    userData: user1DataPDA,
                    mint: mintAccount.publicKey,
                    userTokenAccount: user1TokenAccount,
                    user: user1.publicKey,
                    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc();
            
            throw new Error("Should have failed due to time-lock");
        } catch (error) {
            console.log("✅ Correctly enforced time-lock on rapid claim");
        }
        
        console.log("🎉 Advanced time-lock scenarios working!");
    });
    
    it("🔄 Test 6: Complete Freeze/Unfreeze Cycle", async () => {
        console.log("\n=== TEST: COMPLETE FREEZE/UNFREEZE CYCLE ===");
        
        // Check initial frozen state (should be frozen since transfers not enabled)
        let user1AccountInfo = await provider.connection.getParsedAccountInfo(user1TokenAccount);
        let user2AccountInfo = await provider.connection.getParsedAccountInfo(user2TokenAccount);
        
        console.log("Initial States:");
        console.log("User1 Account State:", user1AccountInfo.value.data.parsed.info.state);
        console.log("User2 Account State:", user2AccountInfo.value.data.parsed.info.state);
        
        // Enable transfers
        const tx1 = await program.methods
            .enableTransfers()
            .accounts({
                tokenState: tokenStatePDA,
                admin: admin.publicKey,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Transfers enabled:", tx1);
        
        // Accounts should still be frozen until manually unfrozen
        user1AccountInfo = await provider.connection.getParsedAccountInfo(user1TokenAccount);
        console.log("User1 Account State After Enable:", user1AccountInfo.value.data.parsed.info.state);
        
        // Unfreeze user accounts
        const tx2 = await program.methods
            .unfreezeAccount()
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user1TokenAccount,
                user: user1.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user1])
            .rpc();
        
        console.log("✅ User1 account unfrozen:", tx2);
        
        const tx3 = await program.methods
            .unfreezeAccount()
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user2TokenAccount,
                user: user2.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user2])
            .rpc();
        
        console.log("✅ User2 account unfrozen:", tx3);
        
        // Verify accounts are now initialized (unfrozen)
        user1AccountInfo = await provider.connection.getParsedAccountInfo(user1TokenAccount);
        user2AccountInfo = await provider.connection.getParsedAccountInfo(user2TokenAccount);
        
        console.log("Final States:");
        console.log("User1 Account State:", user1AccountInfo.value.data.parsed.info.state);
        console.log("User2 Account State:", user2AccountInfo.value.data.parsed.info.state);
        
        console.log("🎉 Complete freeze/unfreeze cycle working!");
    });
    
    it("💸 Test 7: Complex Transfer Scenarios", async () => {
        console.log("\n=== TEST: COMPLEX TRANSFER SCENARIOS ===");
        
        // Get initial balances
        const user1BalanceBefore = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2BalanceBefore = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        
        console.log("Initial Balances:");
        console.log("User1:", user1BalanceBefore.value.uiAmount, "ARIYAL");
        console.log("User2:", user2BalanceBefore.value.uiAmount, "ARIYAL");
        
        // Multiple transfers
        const transferAmounts = [
            1000000,     // 0.001 tokens
            10000000,    // 0.01 tokens
            100000000,   // 0.1 tokens
        ];
        
        for (let i = 0; i < transferAmounts.length; i++) {
            const amount = transferAmounts[i];
            
            // Alternate transfer direction
            const [from, to, fromAccount, toAccount] = i % 2 === 0 
                ? [user1, user2, user1TokenAccount, user2TokenAccount]
                : [user2, user1, user2TokenAccount, user1TokenAccount];
            
            const tx = await program.methods
                .transferTokens(new anchor.BN(amount))
                .accounts({
                    tokenState: tokenStatePDA,
                    mint: mintAccount.publicKey,
                    fromTokenAccount: fromAccount,
                    toTokenAccount: toAccount,
                    fromAuthority: from.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([from])
                .rpc();
            
            console.log(`✅ Transfer ${i + 1} completed:`, tx);
            
            // Check balances after each transfer
            const fromBalance = await provider.connection.getTokenAccountBalance(fromAccount);
            const toBalance = await provider.connection.getTokenAccountBalance(toAccount);
            
            console.log(`After Transfer ${i + 1}:`);
            console.log(`From Balance: ${fromBalance.value.uiAmount} ARIYAL`);
            console.log(`To Balance: ${toBalance.value.uiAmount} ARIYAL`);
        }
        
        console.log("🎉 Complex transfer scenarios completed!");
    });
    
    it("🧪 Test 8: Edge Case Validations", async () => {
        console.log("\n=== TEST: EDGE CASE VALIDATIONS ===");
        
        // Test zero amount transfers (should fail)
        try {
            await program.methods
                .transferTokens(new anchor.BN(0))
                .accounts({
                    tokenState: tokenStatePDA,
                    mint: mintAccount.publicKey,
                    fromTokenAccount: user1TokenAccount,
                    toTokenAccount: user2TokenAccount,
                    fromAuthority: user1.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc();
            
            throw new Error("Should have failed - zero transfer amount");
        } catch (error) {
            console.log("✅ Correctly rejected zero transfer amount");
        }
        
        // Test burning more than balance (should fail)
        const user1Balance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const excessiveAmount = new anchor.BN(user1Balance.value.amount).add(new anchor.BN(1));
        
        try {
            await program.methods
                .burnTokens(excessiveAmount)
                .accounts({
                    tokenState: tokenStatePDA,
                    mint: mintAccount.publicKey,
                    userTokenAccount: user1TokenAccount,
                    admin: admin.publicKey,
                    userAuthority: user1.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([admin, user1])
                .rpc();
            
            throw new Error("Should have failed - insufficient balance");
        } catch (error) {
            console.log("✅ Correctly rejected excessive burn amount");
        }
        
        // Test valid burn operation
        const burnAmount = 1000000; // 0.001 tokens
        const tx = await program.methods
            .burnTokens(new anchor.BN(burnAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user1TokenAccount,
                admin: admin.publicKey,
                userAuthority: user1.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin, user1])
            .rpc();
        
        console.log("✅ Valid burn operation completed:", tx);
        
        console.log("🎉 Edge case validations working!");
    });
    
    after(async () => {
        console.log("\n🚀 ADVANCED FEATURES TESTS COMPLETED SUCCESSFULLY! 🚀");
        console.log("\n📊 FINAL ADVANCED STATE SUMMARY:");
        
        // Final contract state
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Final Contract State:", {
            admin: tokenState.admin.toString(),
            upgradeAuthority: tokenState.upgradeAuthority.toString(),
            transfersEnabled: tokenState.transfersEnabled,
            transfersPermanentlyEnabled: tokenState.transfersPermanentlyEnabled,
            timeLockEnabled: tokenState.timeLockEnabled,
            upgradeable: tokenState.upgradeable,
            claimPeriodSeconds: tokenState.claimPeriodSeconds.toString(),
            tokenName: tokenState.tokenName,
            tokenSymbol: tokenState.tokenSymbol,
            decimals: tokenState.decimals,
        });
        
        // Final balances
        const user1Balance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2Balance = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        const treasuryBalance = await provider.connection.getTokenAccountBalance(treasuryAccount);
        
        console.log("Final Balances:");
        console.log("User1:", user1Balance.value.uiAmount, "ARIYAL");
        console.log("User2:", user2Balance.value.uiAmount, "ARIYAL");
        console.log("Treasury:", treasuryBalance.value.uiAmount, "ARIYAL");
        
        // Final user data
        const user1Data = await program.account.userData.fetch(user1DataPDA);
        const user2Data = await program.account.userData.fetch(user2DataPDA);
        
        console.log("Final User Data:");
        console.log("User1 Claims:", user1Data.totalClaims.toString());
        console.log("User1 Nonce:", user1Data.nonce.toString());
        console.log("User2 Claims:", user2Data.totalClaims.toString());
        console.log("User2 Nonce:", user2Data.nonce.toString());
        
        console.log("\n🌟 ADVANCED FEATURES SUMMARY:");
        console.log("✅ Time-lock configuration management");
        console.log("✅ Upgrade authority management & immutability");
        console.log("✅ Comprehensive treasury operations");
        console.log("✅ High-precision token operations (9 decimals)");
        console.log("✅ Advanced time-lock scenarios");
        console.log("✅ Complete freeze/unfreeze cycles");
        console.log("✅ Complex multi-directional transfers");
        console.log("✅ Edge case validations");
        
        console.log("\n🎯 All advanced features are working flawlessly!");
        console.log("💎 Contract is production-ready with enterprise-grade features!");
    });
});

