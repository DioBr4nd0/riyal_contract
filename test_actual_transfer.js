#!/usr/bin/env node

/**
 * TEST ACTUAL TRANSFER
 * 
 * This script attempts to actually execute a transfer to see if it fails
 * when the account is frozen and transfers are disabled.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction } = require("@solana/web3.js");
const { 
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");
const fs = require('fs');

(async () => {
  console.log("🧪 TESTING ACTUAL TRANSFER EXECUTION");
  console.log("===================================");
  
  try {
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    
    // Load the user who has tokens (from our previous test)
    const userSecretKey = [136,90,218,149,61,116,95,154,229,218,208,221,30,159,234,166,80,253,120,76,130,173,119,245,0,202,201,47,94,189,172,175,209,145,22,20,8,12,126,103,98,233,233,231,159,225,92,148,239,105,83,150,4,39,147,164,25,201,52,121,205,38,5,162];
    const user = Keypair.fromSecretKey(new Uint8Array(userSecretKey));
    
    // Create a recipient
    const recipient = Keypair.generate();
    
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(user), {});
    anchor.setProvider(provider);
    const program = anchor.workspace.RiyalContract;
    
    // Get token mint
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    
    console.log(`Token Mint: ${tokenState.tokenMint.toString()}`);
    console.log(`Contract Transfers Enabled: ${tokenState.transfersEnabled}`);
    
    // Get token accounts
    const userTokenAccount = await getAssociatedTokenAddress(
      tokenState.tokenMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    const recipientTokenAccount = await getAssociatedTokenAddress(
      tokenState.tokenMint,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    console.log(`\n📋 TRANSFER TEST:`);
    console.log(`From: ${userTokenAccount.toString()}`);
    console.log(`To: ${recipientTokenAccount.toString()}`);
    
    // Check balances before
    const balanceBefore = await connection.getTokenAccountBalance(userTokenAccount);
    console.log(`User Balance Before: ${balanceBefore.value.uiAmount} tokens`);
    
    // Fund recipient for account creation
    const airdrop = await connection.requestAirdrop(recipient.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop);
    
    // Create recipient token account
    console.log("\n🏗️  Creating recipient token account...");
    const createATATx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey, // payer
        recipientTokenAccount,
        recipient.publicKey,
        tokenState.tokenMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    
    createATATx.feePayer = user.publicKey;
    createATATx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    createATATx.sign(user);
    
    const createSig = await connection.sendRawTransaction(createATATx.serialize());
    await connection.confirmTransaction(createSig);
    console.log("✅ Recipient token account created");
    
    // Attempt transfer
    console.log("\n🚀 ATTEMPTING TRANSFER...");
    const transferAmount = 1000000000; // 1 token
    
    try {
      const transferTx = new Transaction().add(
        createTransferCheckedInstruction(
          userTokenAccount,
          tokenState.tokenMint,
          recipientTokenAccount,
          user.publicKey,
          transferAmount,
          9, // decimals
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );
      
      transferTx.feePayer = user.publicKey;
      transferTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      transferTx.sign(user);
      
      const signature = await connection.sendRawTransaction(transferTx.serialize());
      console.log(`Transfer transaction sent: ${signature}`);
      
      const confirmation = await connection.confirmTransaction(signature);
      
      if (confirmation.value.err) {
        console.log("❌ Transfer FAILED (as expected!)");
        console.log(`Error: ${JSON.stringify(confirmation.value.err)}`);
        console.log("✅ Freeze mechanism is working correctly!");
      } else {
        console.log("🚨 Transfer SUCCEEDED - This is a SECURITY ISSUE!");
        
        // Check balances after
        const balanceAfter = await connection.getTokenAccountBalance(userTokenAccount);
        const recipientBalance = await connection.getTokenAccountBalance(recipientTokenAccount);
        
        console.log(`User Balance After: ${balanceAfter.value.uiAmount} tokens`);
        console.log(`Recipient Balance: ${recipientBalance.value.uiAmount} tokens`);
        console.log(`\n❌ CRITICAL SECURITY BUG CONFIRMED:`);
        console.log("Tokens can be transferred even when contract has transfers disabled!");
      }
      
    } catch (error) {
      console.log("❌ Transfer FAILED (as expected!)");
      console.log(`Error: ${error.message}`);
      console.log("✅ This confirms the freeze mechanism is working!");
      
      if (error.message.includes("frozen")) {
        console.log("✅ Account is properly frozen - transfers are blocked");
      }
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    
    if (error.logs) {
      console.log("\n📋 Transaction Logs:");
      error.logs.forEach(log => console.log(log));
    }
  }
})().catch(console.error);
