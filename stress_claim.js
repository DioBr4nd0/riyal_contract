#!/usr/bin/env node

/**
 * RIYAL TOKEN STRESS TEST SCRIPT
 * 
 * Generates multiple random accounts and sends concurrent claim requests
 * to test the contract's performance under load.
 * 
 * USAGE:
 * 1. Set NUMBER_OF_ACCOUNTS to desired stress test size
 * 2. Configure admin key and other parameters
 * 3. Run: node stress-test-claims.js
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
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');

// ========================================
// STRESS TEST CONFIGURATION
// ========================================

// Number of accounts to generate and test concurrently
const NUMBER_OF_ACCOUNTS = 3; // CHANGE THIS NUMBER FOR STRESS TEST SIZE

// Admin's private key (can be file path or array)
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json"; // or use array: [1,2,3,...]

// Claim parameters (applied to all accounts)
const CLAIM_AMOUNT_TOKENS = 1000; // Amount in tokens per account
const CLAIM_EXPIRY_MINUTES = 10;  // How long claims are valid for

// Network
const RPC_URL = "https://api.devnet.solana.com";

// Funding parameters
const FUNDING_AMOUNT_SOL = 0.2; // SOL to fund each test account

// Concurrency settings
const MAX_CONCURRENT_REQUESTS = 10; // Limit concurrent requests to avoid rate limits
const DELAY_BETWEEN_BATCHES_MS = 1000; // Delay between batches of requests

// ========================================
// HELPER FUNCTIONS
// ========================================

// Load admin keypair from file path or array
function loadAdminKeypair() {
  if (typeof ADMIN_KEY_SOURCE === 'string') {
    try {
      const data = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
      return Keypair.fromSecretKey(new Uint8Array(data));
    } catch (error) {
      console.error(`Failed to load admin keypair from ${ADMIN_KEY_SOURCE}`);
      throw error;
    }
  } else if (Array.isArray(ADMIN_KEY_SOURCE)) {
    return Keypair.fromSecretKey(new Uint8Array(ADMIN_KEY_SOURCE));
  } else {
    throw new Error("ADMIN_KEY_SOURCE must be a file path string or private key array");
  }
}

// Serialize ClaimPayload according to the contract's Borsh format
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

// Create domain-separated message
function createDomainSeparatedMessage(programId, payload) {
  const payloadBytes = serializeClaimPayload(payload);
  
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V2", 'utf8'),
    programId.toBuffer(),
    payloadBytes
  ]);
}

// Generate test accounts and fund them
async function generateAndFundAccounts(connection, admin, count) {
  console.log(`🏭 Generating ${count} test accounts...`);
  
  const accounts = [];
  const fundingTxs = [];
  
  // Generate all accounts first
  for (let i = 0; i < count; i++) {
    const account = Keypair.generate();
    accounts.push({
      keypair: account,
      id: i + 1,
      publicKey: account.publicKey.toString(),
      privateKey: Array.from(account.secretKey)
    });
  }
  
  console.log("✅ Generated all accounts");
  console.log("");
  console.log("🔑 GENERATED KEYPAIRS (for verification):");
  console.log("==========================================");
  accounts.forEach(account => {
    console.log(`Account ${account.id}:`);
    console.log(`  Public Key:  ${account.publicKey}`);
    console.log(`  Private Key: [${account.privateKey.join(',')}]`);
    console.log("");
  });
  console.log("💡 You can check balances using: solana balance <public_key> --url devnet");
  console.log("");
  console.log("💰 Funding accounts in batches...");
  
  // Fund accounts in batches to avoid transaction size limits
  const BATCH_SIZE = 10;
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    
    const batchTx = new Transaction();
    batch.forEach(account => {
      batchTx.add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: account.keypair.publicKey,
          lamports: FUNDING_AMOUNT_SOL * anchor.web3.LAMPORTS_PER_SOL
        })
      );
    });
    
    batchTx.feePayer = admin.publicKey;
    batchTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    batchTx.sign(admin);
    
    const sig = await connection.sendRawTransaction(batchTx.serialize());
    fundingTxs.push(sig);
    
    console.log(`📦 Batch ${Math.floor(i / BATCH_SIZE) + 1} funded (${batch.length} accounts)`);
  }
  
  // Wait for all funding transactions to confirm
  console.log("⏳ Confirming funding transactions...");
  await Promise.all(fundingTxs.map(sig => connection.confirmTransaction(sig)));
  console.log("✅ All accounts funded successfully");
  
  return accounts;
}

// Initialize user data for all accounts
async function initializeAllUserData(program, accounts) {
  console.log("🏗️  Initializing user data for all accounts...");
  
  const initPromises = accounts.map(async (account, index) => {
    try {
      const [userDataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_data"), account.keypair.publicKey.toBuffer()], 
        program.programId
      );
      
      // Check if already exists
      try {
        await program.account.userData.fetch(userDataPDA);
        return { account, userDataPDA, existed: true };
      } catch (error) {
        // Need to initialize
        await program.methods
          .initializeUserData()
          .accounts({
            userData: userDataPDA,
            user: account.keypair.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([account.keypair])
          .rpc();
        
        return { account, userDataPDA, existed: false };
      }
    } catch (error) {
      console.error(`❌ Failed to initialize user data for account ${index + 1}:`, error.message);
      return { account, userDataPDA: null, error };
    }
  });
  
  const results = await Promise.all(initPromises);
  const successful = results.filter(r => r.userDataPDA && !r.error);
  const failed = results.filter(r => r.error);
  
  console.log(`✅ User data: ${successful.length} ready, ${failed.length} failed`);
  return successful;
}

// Create token accounts for all users
async function createAllTokenAccounts(connection, admin, tokenMint, accounts) {
  console.log("🪙 Creating token accounts...");
  
  const createPromises = accounts.map(async (accountData) => {
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        accountData.account.keypair.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      
      // Check if exists
      try {
        await connection.getTokenAccountBalance(tokenAccount);
        return { ...accountData, tokenAccount, existed: true };
      } catch (error) {
        // Create it
        const createTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,
            tokenAccount,
            accountData.account.keypair.publicKey,
            tokenMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        
        createTx.feePayer = admin.publicKey;
        createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        createTx.sign(admin);
        
        const sig = await connection.sendRawTransaction(createTx.serialize());
        await connection.confirmTransaction(sig);
        
        return { ...accountData, tokenAccount, existed: false };
      }
    } catch (error) {
      console.error(`❌ Failed to create token account for account ${accountData.account.id}:`, error.message);
      return { ...accountData, tokenAccount: null, error };
    }
  });
  
  const results = await Promise.all(createPromises);
  const successful = results.filter(r => r.tokenAccount && !r.error);
  const failed = results.filter(r => r.error);
  
  console.log(`✅ Token accounts: ${successful.length} ready, ${failed.length} failed`);
  return successful;
}

// Process claims in controlled batches to avoid overwhelming the network
async function processClaimsInBatches(claimPromises, batchSize, delayMs) {
  const results = [];
  
  for (let i = 0; i < claimPromises.length; i += batchSize) {
    const batch = claimPromises.slice(i, i + batchSize);
    console.log(`🚀 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(claimPromises.length / batchSize)} (${batch.length} claims)...`);
    
    const startTime = Date.now();
    const batchResults = await Promise.allSettled(batch);
    const endTime = Date.now();
    
    const successful = batchResults.filter(r => r.status === 'fulfilled').length;
    const failed = batchResults.filter(r => r.status === 'rejected').length;
    
    console.log(`📊 Batch completed in ${endTime - startTime}ms: ${successful} success, ${failed} failed`);
    
    results.push(...batchResults);
    
    // Delay between batches to avoid rate limits
    if (i + batchSize < claimPromises.length && delayMs > 0) {
      console.log(`⏳ Waiting ${delayMs}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

// ========================================
// MAIN STRESS TEST EXECUTION
// ========================================

(async () => {
  console.log("🎯 RIYAL TOKEN STRESS TEST");
  console.log("==========================");
  console.log(`📊 Testing with ${NUMBER_OF_ACCOUNTS} concurrent accounts`);
  console.log(`⚡ Max concurrent requests: ${MAX_CONCURRENT_REQUESTS}`);
  console.log("");
  
  const overallStartTime = Date.now();
  
  try {
    // Load admin
    const admin = loadAdminKeypair();
    console.log(`🔑 Admin: ${admin.publicKey.toString()}`);
    console.log("");
    
    // Connect to Solana
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    // Load program
    const program = anchor.workspace.RiyalContract;
    const programId = program.programId;
    
    console.log(`📋 Contract: ${programId.toString()}`);
    
    // Get contract state
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], programId);
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    
    console.log(`🪙 Token Mint: ${tokenState.tokenMint.toString()}`);
    console.log("");
    
    // Verify admin
    if (!tokenState.admin.equals(admin.publicKey)) {
      throw new Error(`Admin mismatch! Contract: ${tokenState.admin.toString()}, Yours: ${admin.publicKey.toString()}`);
    }
    
    // PHASE 1: Generate and fund accounts
    const accounts = await generateAndFundAccounts(connection, admin, NUMBER_OF_ACCOUNTS);
    console.log("");
    
    // PHASE 2: Initialize user data
    const accountsWithUserData = await initializeAllUserData(program, accounts);
    console.log("");
    
    // PHASE 3: Create token accounts
    const readyAccounts = await createAllTokenAccounts(connection, admin, tokenState.tokenMint, accountsWithUserData);
    console.log("");
    
    if (readyAccounts.length === 0) {
      throw new Error("No accounts are ready for testing!");
    }
    
    console.log(`✅ ${readyAccounts.length} accounts ready for stress test`);
    console.log("");
    
    // PHASE 4: Prepare all claim transactions
    console.log("📝 Preparing claim transactions...");
    
    const currentTime = Math.floor(Date.now() / 1000);
    const claimAmount = CLAIM_AMOUNT_TOKENS * Math.pow(10, 9);
    const expiryTime = currentTime + (CLAIM_EXPIRY_MINUTES * 60);
    
    const claimPromises = readyAccounts.map(async (accountData, index) => {
      try {
        // Create claim payload
        const claimPayload = {
          userAddress: accountData.account.keypair.publicKey,
          claimAmount: new anchor.BN(claimAmount),
          expiryTime: new anchor.BN(expiryTime),
          nonce: new anchor.BN(0) // Assuming first claim for all
        };
        
        // Create signature
        const messageBytes = createDomainSeparatedMessage(programId, claimPayload);
        const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
        
        // Create Ed25519 verification instruction
        const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
          publicKey: admin.publicKey.toBytes(),
          message: messageBytes,
          signature: adminSignature,
        });
        
        // Create claim instruction
        const claimIx = await program.methods
          .claimTokens(claimPayload, Array.from(adminSignature))
          .accounts({
            tokenState: tokenStatePDA,
            userData: accountData.userDataPDA,
            mint: tokenState.tokenMint,
            userTokenAccount: accountData.tokenAccount,
            user: accountData.account.keypair.publicKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();
        
        // Build and send transaction
        const claimTransaction = new Transaction()
          .add(adminEd25519Ix)
          .add(claimIx);
        
        claimTransaction.feePayer = accountData.account.keypair.publicKey;
        claimTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        claimTransaction.sign(accountData.account.keypair);
        
        const startTime = Date.now();
        const signature = await connection.sendRawTransaction(claimTransaction.serialize());
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        const endTime = Date.now();
        
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        return {
          accountId: accountData.account.id,
          publicKey: accountData.account.publicKey,
          signature,
          success: true,
          processingTime: endTime - startTime,
          timestamp: Date.now()
        };
        
      } catch (error) {
        return {
          accountId: accountData.account.id,
          publicKey: accountData.account.publicKey,
          success: false,
          error: error.message,
          timestamp: Date.now()
        };
      }
    });
    
    // PHASE 5: Execute stress test
    console.log("🚀 STARTING STRESS TEST...");
    console.log(`⏱️  Start time: ${new Date().toLocaleString()}`);
    console.log("");
    
    const testStartTime = Date.now();
    const results = await processClaimsInBatches(claimPromises, MAX_CONCURRENT_REQUESTS, DELAY_BETWEEN_BATCHES_MS);
    const testEndTime = Date.now();
    
    // PHASE 6: Analyze results
    console.log("");
    console.log("📊 STRESS TEST RESULTS");
    console.log("======================");
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success);
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));
    
    const totalTime = testEndTime - testStartTime;
    const overallTime = Date.now() - overallStartTime;
    const throughput = (successful.length / (totalTime / 1000)).toFixed(2);
    
    console.log(`✅ Successful claims: ${successful.length}/${results.length}`);
    console.log(`❌ Failed claims: ${failed.length}/${results.length}`);
    console.log(`⚡ Success rate: ${((successful.length / results.length) * 100).toFixed(1)}%`);
    console.log(`⏱️  Total execution time: ${totalTime}ms`);
    console.log(`🚀 Throughput: ${throughput} claims/second`);
    console.log(`⏲️  Overall runtime: ${overallTime}ms`);
    
    if (successful.length > 0) {
      const processingTimes = successful
        .map(r => r.value.processingTime)
        .filter(t => t !== undefined);
      
      if (processingTimes.length > 0) {
        const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        const minTime = Math.min(...processingTimes);
        const maxTime = Math.max(...processingTimes);
        
        console.log(`📈 Avg processing time: ${avgProcessingTime.toFixed(0)}ms`);
        console.log(`⏩ Fastest claim: ${minTime}ms`);
        console.log(`⏳ Slowest claim: ${maxTime}ms`);
      }
    }
    
    // Show all successful transactions
    if (successful.length > 0) {
      console.log("");
      console.log("🔗 Successful transactions (verify on Solana Explorer):");
      successful.forEach(result => {
        console.log(`  Account ${result.value.accountId}: https://explorer.solana.com/tx/${result.value.signature}?cluster=devnet`);
      });
    }
    
    // Show sample errors if any
    if (failed.length > 0) {
      console.log("");
      console.log("❌ Sample errors:");
      const errorMessages = failed.slice(0, 3).map(result => {
        const error = result.status === 'rejected' ? result.reason : result.value.error;
        return `  Account ${result.value?.accountId || 'unknown'}: ${error}`;
      });
      errorMessages.forEach(msg => console.log(msg));
    }
    
    console.log("");
    console.log(`🎯 STRESS TEST COMPLETED - ${successful.length}/${NUMBER_OF_ACCOUNTS} accounts succeeded`);
    
    // Final account summary with balances
    console.log("");
    console.log("💰 FINAL ACCOUNT SUMMARY:");
    console.log("=========================");
    
    for (const accountData of readyAccounts) {
      try {
        const solBalance = await connection.getBalance(accountData.account.keypair.publicKey);
        let tokenBalance = "0";
        
        try {
          const tokenBalanceResult = await connection.getTokenAccountBalance(accountData.tokenAccount);
          tokenBalance = tokenBalanceResult.value.uiAmount || "0";
        } catch (e) {
          tokenBalance = "Error reading token balance";
        }
        
        console.log(`Account ${accountData.account.id}:`);
        console.log(`  Public:  ${accountData.account.publicKey}`);
        console.log(`  SOL:     ${(solBalance / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)}`);
        console.log(`  Tokens:  ${tokenBalance}`);
        console.log("");
      } catch (error) {
        console.log(`Account ${accountData.account.id}: Error reading balance - ${error.message}`);
      }
    }
    
    console.log("🔍 Verification commands:");
    console.log(`solana balance <public_key> --url devnet`);
    console.log(`spl-token balance <token_mint> --owner <public_key> --url devnet`);
    console.log("");
    
  } catch (error) {
    console.error("");
    console.error("❌ STRESS TEST FAILED:");
    console.error(error.message);
    
    if (error.logs) {
      console.error("");
      console.error("📋 Error logs:");
      error.logs.forEach(log => console.error(log));
    }
    
    process.exit(1);
  }
})().catch(console.error);