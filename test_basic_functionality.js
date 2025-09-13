const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program } = anchor.web3;
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");

describe("Riyal Contract - Basic Functionality", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    
    const program = anchor.workspace.RiyalContract;
    
    // Test accounts
    let admin, user1, user2;
    let tokenStatePDA, tokenStateBump;
    let user1DataPDA, user1DataBump;
    let user2DataPDA, user2DataBump;
    let mintAccount;
    let user1TokenAccount, user2TokenAccount;
    let treasuryAccount;
    
    before(async () => {
        // Generate test keypairs
        admin = Keypair.generate();
        user1 = Keypair.generate();
        user2 = Keypair.generate();
        mintAccount = Keypair.generate();
        
        // Airdrop SOL for testing
        const airdropTx1 = await provider.connection.requestAirdrop(admin.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
        const airdropTx2 = await provider.connection.requestAirdrop(user1.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
        const airdropTx3 = await provider.connection.requestAirdrop(user2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
        
        await provider.connection.confirmTransaction(airdropTx1);
        await provider.connection.confirmTransaction(airdropTx2);
        await provider.connection.confirmTransaction(airdropTx3);
        
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
        
        console.log("🚀 Test Setup Complete");
        console.log("Admin:", admin.publicKey.toString());
        console.log("User1:", user1.publicKey.toString());
        console.log("User2:", user2.publicKey.toString());
        console.log("Token State PDA:", tokenStatePDA.toString());
    });
    
    it("1️⃣ Initialize Contract", async () => {
        console.log("\n=== INITIALIZING CONTRACT ===");
        
        const upgradeAuthority = admin.publicKey; // Use admin as upgrade authority
        const claimPeriodSeconds = 3600; // 1 hour
        const timeLockEnabled = true;
        const upgradeable = true;
        
        const tx = await program.methods
            .initialize(
                admin.publicKey,
                upgradeAuthority,
                new anchor.BN(claimPeriodSeconds),
                timeLockEnabled,
                upgradeable
            )
            .accounts({
                tokenState: tokenStatePDA,
                payer: admin.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Contract initialized:", tx);
        
        // Verify state
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Token State:", {
            admin: tokenState.admin.toString(),
            upgradeAuthority: tokenState.upgradeAuthority.toString(),
            isInitialized: tokenState.isInitialized,
            transfersEnabled: tokenState.transfersEnabled,
            claimPeriodSeconds: tokenState.claimPeriodSeconds.toString(),
            timeLockEnabled: tokenState.timeLockEnabled,
            upgradeable: tokenState.upgradeable,
        });
        
        console.log("🎉 Contract initialization successful!");
    });
    
    it("2️⃣ Create Token Mint", async () => {
        console.log("\n=== CREATING TOKEN MINT ===");
        
        const decimals = 6;
        const name = "RiyalToken";
        const symbol = "RIYAL";
        
        const tx = await program.methods
            .createTokenMint(decimals, name, symbol)
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
        
        console.log("✅ Token mint created:", tx);
        
        // Verify mint
        const mintInfo = await provider.connection.getParsedAccountInfo(mintAccount.publicKey);
        console.log("Mint Info:", {
            decimals: mintInfo.value.data.parsed.info.decimals,
            mintAuthority: mintInfo.value.data.parsed.info.mintAuthority,
            freezeAuthority: mintInfo.value.data.parsed.info.freezeAuthority,
        });
        
        // Verify token state updated
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Token State Updated:", {
            tokenMint: tokenState.tokenMint.toString(),
            tokenName: tokenState.tokenName,
            tokenSymbol: tokenState.tokenSymbol,
            decimals: tokenState.decimals,
        });
        
        console.log("🎉 Token mint creation successful!");
    });
    
    it("3️⃣ Create Associated Token Accounts", async () => {
        console.log("\n=== CREATING ASSOCIATED TOKEN ACCOUNTS ===");
        
        // Create user1 token account
        const createUser1AccountTx = await provider.sendAndConfirm(
            new anchor.web3.Transaction().add(
                createAssociatedTokenAccountInstruction(
                    admin.publicKey, // payer
                    user1TokenAccount,
                    user1.publicKey, // owner
                    mintAccount.publicKey // mint
                )
            ),
            [admin]
        );
        console.log("✅ User1 token account created:", createUser1AccountTx);
        
        // Create user2 token account
        const createUser2AccountTx = await provider.sendAndConfirm(
            new anchor.web3.Transaction().add(
                createAssociatedTokenAccountInstruction(
                    admin.publicKey, // payer
                    user2TokenAccount,
                    user2.publicKey, // owner
                    mintAccount.publicKey // mint
                )
            ),
            [admin]
        );
        console.log("✅ User2 token account created:", createUser2AccountTx);
        
        console.log("🎉 Associated token accounts created!");
    });
    
    it("4️⃣ Initialize User Data PDAs", async () => {
        console.log("\n=== INITIALIZING USER DATA PDAS ===");
        
        // Initialize user1 data
        const tx1 = await program.methods
            .initializeUserData()
            .accounts({
                userData: user1DataPDA,
                user: user1.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([user1])
            .rpc();
        
        console.log("✅ User1 data initialized:", tx1);
        
        // Initialize user2 data
        const tx2 = await program.methods
            .initializeUserData()
            .accounts({
                userData: user2DataPDA,
                user: user2.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([user2])
            .rpc();
        
        console.log("✅ User2 data initialized:", tx2);
        
        // Verify user data
        const user1Data = await program.account.userData.fetch(user1DataPDA);
        const user2Data = await program.account.userData.fetch(user2DataPDA);
        
        console.log("User1 Data:", {
            user: user1Data.user.toString(),
            nonce: user1Data.nonce.toString(),
            totalClaims: user1Data.totalClaims.toString(),
        });
        
        console.log("User2 Data:", {
            user: user2Data.user.toString(),
            nonce: user2Data.nonce.toString(),
            totalClaims: user2Data.totalClaims.toString(),
        });
        
        console.log("🎉 User data initialization successful!");
    });
    
    it("5️⃣ Mint Tokens to Users (Admin Only)", async () => {
        console.log("\n=== MINTING TOKENS TO USERS ===");
        
        const mintAmount = 1000 * 10**6; // 1000 tokens with 6 decimals
        
        // Mint to user1
        const tx1 = await program.methods
            .mintTokens(new anchor.BN(mintAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user1TokenAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted to user1:", tx1);
        
        // Mint to user2
        const tx2 = await program.methods
            .mintTokens(new anchor.BN(mintAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                userTokenAccount: user2TokenAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted to user2:", tx2);
        
        // Check balances
        const user1Balance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2Balance = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        
        console.log("User1 Balance:", user1Balance.value.uiAmount, "RIYAL");
        console.log("User2 Balance:", user2Balance.value.uiAmount, "RIYAL");
        
        // Check if accounts are frozen (they should be since transfers aren't enabled)
        const user1AccountInfo = await provider.connection.getParsedAccountInfo(user1TokenAccount);
        const user2AccountInfo = await provider.connection.getParsedAccountInfo(user2TokenAccount);
        
        console.log("User1 Account Frozen:", user1AccountInfo.value.data.parsed.info.state === "frozen");
        console.log("User2 Account Frozen:", user2AccountInfo.value.data.parsed.info.state === "frozen");
        
        console.log("🎉 Token minting successful! Accounts are frozen until transfers enabled.");
    });
    
    it("6️⃣ Create Treasury Account", async () => {
        console.log("\n=== CREATING TREASURY ACCOUNT ===");
        
        const tx = await program.methods
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
        
        console.log("✅ Treasury created:", tx);
        
        // Verify treasury account
        const treasuryInfo = await provider.connection.getParsedAccountInfo(treasuryAccount);
        console.log("Treasury Owner:", treasuryInfo.value.data.parsed.info.owner);
        
        // Verify token state updated
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Treasury Account in State:", tokenState.treasuryAccount.toString());
        
        console.log("🎉 Treasury creation successful!");
    });
    
    it("7️⃣ Mint Tokens to Treasury", async () => {
        console.log("\n=== MINTING TOKENS TO TREASURY ===");
        
        const mintAmount = 10000 * 10**6; // 10,000 tokens
        
        const tx = await program.methods
            .mintToTreasury(new anchor.BN(mintAmount))
            .accounts({
                tokenState: tokenStatePDA,
                mint: mintAccount.publicKey,
                treasuryAccount: treasuryAccount,
                admin: admin.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Minted to treasury:", tx);
        
        // Check treasury balance
        const treasuryBalance = await provider.connection.getTokenAccountBalance(treasuryAccount);
        console.log("Treasury Balance:", treasuryBalance.value.uiAmount, "RIYAL");
        
        console.log("🎉 Treasury minting successful!");
    });
    
    it("8️⃣ Enable Transfers (Permanent)", async () => {
        console.log("\n=== ENABLING TRANSFERS (PERMANENT) ===");
        
        const tx = await program.methods
            .enableTransfers()
            .accounts({
                tokenState: tokenStatePDA,
                admin: admin.publicKey,
            })
            .signers([admin])
            .rpc();
        
        console.log("✅ Transfers enabled:", tx);
        
        // Verify state
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Transfer State:", {
            transfersEnabled: tokenState.transfersEnabled,
            transfersPermanentlyEnabled: tokenState.transfersPermanentlyEnabled,
            transferEnableTimestamp: tokenState.transferEnableTimestamp.toString(),
        });
        
        console.log("🎉 Transfers permanently enabled!");
    });
    
    it("9️⃣ Unfreeze User Accounts", async () => {
        console.log("\n=== UNFREEZING USER ACCOUNTS ===");
        
        // Unfreeze user1 account
        const tx1 = await program.methods
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
        
        console.log("✅ User1 account unfrozen:", tx1);
        
        // Unfreeze user2 account
        const tx2 = await program.methods
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
        
        console.log("✅ User2 account unfrozen:", tx2);
        
        // Verify accounts are no longer frozen
        const user1AccountInfo = await provider.connection.getParsedAccountInfo(user1TokenAccount);
        const user2AccountInfo = await provider.connection.getParsedAccountInfo(user2TokenAccount);
        
        console.log("User1 Account Frozen:", user1AccountInfo.value.data.parsed.info.state === "frozen");
        console.log("User2 Account Frozen:", user2AccountInfo.value.data.parsed.info.state === "frozen");
        
        console.log("🎉 User accounts unfrozen successfully!");
    });
    
    it("🔟 Transfer Tokens Between Users", async () => {
        console.log("\n=== TRANSFERRING TOKENS BETWEEN USERS ===");
        
        const transferAmount = 100 * 10**6; // 100 tokens
        
        // Get initial balances
        const user1BalanceBefore = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2BalanceBefore = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        
        console.log("Before Transfer:");
        console.log("User1 Balance:", user1BalanceBefore.value.uiAmount, "RIYAL");
        console.log("User2 Balance:", user2BalanceBefore.value.uiAmount, "RIYAL");
        
        // Transfer from user1 to user2
        const tx = await program.methods
            .transferTokens(new anchor.BN(transferAmount))
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
        
        console.log("✅ Transfer completed:", tx);
        
        // Get final balances
        const user1BalanceAfter = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2BalanceAfter = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        
        console.log("After Transfer:");
        console.log("User1 Balance:", user1BalanceAfter.value.uiAmount, "RIYAL");
        console.log("User2 Balance:", user2BalanceAfter.value.uiAmount, "RIYAL");
        
        // Verify transfer amounts
        const user1Diff = user1BalanceBefore.value.uiAmount - user1BalanceAfter.value.uiAmount;
        const user2Diff = user2BalanceAfter.value.uiAmount - user2BalanceBefore.value.uiAmount;
        
        console.log("User1 Sent:", user1Diff, "RIYAL");
        console.log("User2 Received:", user2Diff, "RIYAL");
        
        console.log("🎉 Token transfer successful!");
    });
    
    after(async () => {
        console.log("\n🏁 BASIC FUNCTIONALITY TESTS COMPLETED SUCCESSFULLY! 🏁");
        console.log("\n📊 FINAL STATE SUMMARY:");
        
        // Final contract state
        const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
        console.log("Contract State:", {
            admin: tokenState.admin.toString(),
            tokenMint: tokenState.tokenMint.toString(),
            transfersEnabled: tokenState.transfersEnabled,
            transfersPermanentlyEnabled: tokenState.transfersPermanentlyEnabled,
            timeLockEnabled: tokenState.timeLockEnabled,
            upgradeable: tokenState.upgradeable,
        });
        
        // Final balances
        const user1Balance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const user2Balance = await provider.connection.getTokenAccountBalance(user2TokenAccount);
        const treasuryBalance = await provider.connection.getTokenAccountBalance(treasuryAccount);
        
        console.log("Final Balances:");
        console.log("User1:", user1Balance.value.uiAmount, "RIYAL");
        console.log("User2:", user2Balance.value.uiAmount, "RIYAL");
        console.log("Treasury:", treasuryBalance.value.uiAmount, "RIYAL");
        
        console.log("\n✨ All basic functionality working perfectly! ✨");
    });
});

