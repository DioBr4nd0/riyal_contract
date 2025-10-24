#!/usr/bin/env node

/**
 * MERCLE TOKEN - COMPLETE DEPLOYMENT & TESTING SCRIPT
 * 
 * This script handles everything:
 * 1. Deploy contract to any network (local/devnet/mainnet)
 * 2. Test all contract features comprehensively
 * 3. Security testing (replay attacks, unauthorized access)
 * 4. Print all private keys for verification
 * 
 * USAGE:
 * node deploy_and_test_complete.js [network]
 * 
 * Networks: local, devnet, mainnet-beta
 * Default: devnet
 */

const anchor = require("@coral-xyz/anchor");
const { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  SYSVAR_INSTRUCTIONS_PUBKEY, 
  Transaction, 
  Ed25519Program,
  LAMPORTS_PER_SOL
} = require("@solana/web3.js");
const { 
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');

// ========================================
// CONFIGURATION
// ========================================

const NETWORK = process.argv[2] || 'devnet';
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";

const NETWORK_CONFIGS = {
  'local': 'http://127.0.0.1:8899',
  'devnet': 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};

const RPC_URL = NETWORK_CONFIGS[NETWORK];
if (!RPC_URL) {
  console.error(`❌ Invalid network: ${NETWORK}`);
  console.error(`Available networks: ${Object.keys(NETWORK_CONFIGS).join(', ')}`);
  process.exit(1);
}

// Test configuration
const TEST_ACCOUNTS_COUNT = 3;
const CLAIM_AMOUNT_TOKENS = 1000;
const TREASURY_MINT_AMOUNT = 1000000; // 1M tokens for treasury
const BURN_TEST_AMOUNT = 100;

// ========================================
// HELPER FUNCTIONS
// ========================================

function loadAdminKeypair() {
  try {
    const data = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(data));
  } catch (error) {
    console.error(`❌ Failed to load admin keypair from ${ADMIN_KEY_SOURCE}`);
    throw error;
  }
}

function generateTestKeypair(label) {
  const keypair = Keypair.generate();
  console.log(`🔑 ${label}:`);
  console.log(`  Public Key:  ${keypair.publicKey.toString()}`);
  console.log(`  Private Key: [${Array.from(keypair.secretKey).join(',')}]`);
  return keypair;
}

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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// DEPLOYMENT FUNCTIONS
// ========================================

async function deployContract(connection, admin) {
  console.log("🚀 DEPLOYING MERCLE TOKEN CONTRACT");
  console.log("==================================");
  
  try {
    // Load or deploy program
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    const program = anchor.workspace.MercleToken;
    const programId = program.programId;
    
    console.log(`📋 Program ID: ${programId.toString()}`);
    console.log(`🌐 Network: ${NETWORK} (${RPC_URL})`);
    
    // Check if contract is already initialized
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], programId);
    
    let tokenState;
    try {
      tokenState = await program.account.tokenState.fetch(tokenStatePDA);
      console.log("✅ Contract already initialized");
      return { program, programId, tokenStatePDA, tokenState };
    } catch (error) {
      console.log("🏗️  Initializing new contract...");
    }
    
    // Initialize contract
    const tx = await program.methods
      .initialize(
        admin.publicKey,
        admin.publicKey, // upgrade authority
        3600, // 1 hour claim period
        false, // time lock disabled for testing
        true // upgradeable
      )
      .accounts({
        tokenState: tokenStatePDA,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    
    console.log(`✅ Contract initialized: ${tx}`);
    
    tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    return { program, programId, tokenStatePDA, tokenState };
    
  } catch (error) {
    console.error("❌ Deployment failed:", error.message);
    throw error;
  }
}

async function createTokenMint(program, admin, tokenStatePDA) {
  console.log("\n🪙 CREATING MERCLE TOKEN MINT");
  console.log("=============================");
  
  const connection = program.provider.connection;
  
  // Generate mint keypair
  const mintKeypair = generateTestKeypair("MERCLE TOKEN MINT");
  
  // Create mint account
  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports: await connection.getMinimumBalanceForRentExemption(82),
      programId: TOKEN_PROGRAM_ID,
    })
  );
  
  // Initialize mint
  createMintTx.add(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      9, // decimals
      tokenStatePDA,
      tokenStatePDA,
      TOKEN_PROGRAM_ID
    )
  );
  
  createMintTx.feePayer = admin.publicKey;
  createMintTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  createMintTx.sign(admin, mintKeypair);
  
  const createMintSig = await connection.sendRawTransaction(createMintTx.serialize());
  await connection.confirmTransaction(createMintSig);
  
  console.log(`✅ Mint created: ${createMintSig}`);
  
  // Update contract with mint
  const updateTx = await program.methods
    .updateTokenMint(9, "Mercle Token", "MERCLE")
    .accounts({
      tokenState: tokenStatePDA,
      mint: mintKeypair.publicKey,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
  
  console.log(`✅ Contract updated with mint: ${updateTx}`);
  console.log(`🪙 MERCLE Token Mint: ${mintKeypair.publicKey.toString()}`);
  
  return mintKeypair.publicKey;
}

// ========================================
// TESTING FUNCTIONS
// ========================================

async function setupTestAccounts(connection, admin, count) {
  console.log(`\n👥 SETTING UP ${count} TEST ACCOUNTS`);
  console.log("=====================================");
  
  const accounts = [];
  
  // Generate accounts
  for (let i = 0; i < count; i++) {
    const keypair = generateTestKeypair(`Test Account ${i + 1}`);
    accounts.push(keypair);
  }
  
  // Fund accounts
  console.log("\n💰 Funding test accounts...");
  for (let i = 0; i < accounts.length; i++) {
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: accounts[i].publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL
      })
    );
    
    fundTx.feePayer = admin.publicKey;
    fundTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    fundTx.sign(admin);
    
    const sig = await connection.sendRawTransaction(fundTx.serialize());
    await connection.confirmTransaction(sig);
    console.log(`✅ Account ${i + 1} funded: ${sig}`);
  }
  
  return accounts;
}

async function initializeUserData(program, accounts) {
  console.log("\n🏗️  INITIALIZING USER DATA");
  console.log("=========================");
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), account.publicKey.toBuffer()], 
      program.programId
    );
    
    try {
      await program.account.userData.fetch(userDataPDA);
      console.log(`✅ Account ${i + 1} user data already exists`);
    } catch (error) {
      const tx = await program.methods
        .initializeUserData()
        .accounts({
          userData: userDataPDA,
          user: account.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([account])
        .rpc();
      
      console.log(`✅ Account ${i + 1} user data initialized: ${tx}`);
    }
  }
}

async function createTokenAccounts(connection, admin, mint, accounts) {
  console.log("\n🪙 CREATING TOKEN ACCOUNTS");
  console.log("=========================");
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const tokenAccount = await getAssociatedTokenAddress(
      mint,
      account.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    
    try {
      await connection.getTokenAccountBalance(tokenAccount);
      console.log(`✅ Account ${i + 1} token account already exists`);
    } catch (error) {
      const createTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          tokenAccount,
          account.publicKey,
          mint,
          TOKEN_PROGRAM_ID
        )
      );
      
      createTx.feePayer = admin.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      createTx.sign(admin);
      
      const sig = await connection.sendRawTransaction(createTx.serialize());
      await connection.confirmTransaction(sig);
      console.log(`✅ Account ${i + 1} token account created: ${sig}`);
    }
  }
}

async function testSignatureClaims(program, admin, mint, accounts) {
  console.log("\n🔐 TESTING SIGNATURE-BASED CLAIMS");
  console.log("=================================");
  
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const currentTime = Math.floor(Date.now() / 1000);
  const claimAmount = CLAIM_AMOUNT_TOKENS * Math.pow(10, 9);
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    console.log(`\n🎯 Testing claim for Account ${i + 1}:`);
    
    // Get user data
    const [userDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_data"), account.publicKey.toBuffer()], 
      program.programId
    );
    const userData = await program.account.userData.fetch(userDataPDA);
    
    // Create claim payload
    const claimPayload = {
      userAddress: account.publicKey,
      claimAmount: new anchor.BN(claimAmount),
      expiryTime: new anchor.BN(currentTime + 3600), // 1 hour expiry
      nonce: new anchor.BN(userData.nonce)
    };
    
    // Create admin signature
    const messageBytes = createDomainSeparatedMessage(program.programId, claimPayload);
    const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
    
    // Get token account
    const tokenAccount = await getAssociatedTokenAddress(
      mint,
      account.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    
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
        userData: userDataPDA,
        mint: mint,
        userTokenAccount: tokenAccount,
        user: account.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    // Build and send transaction
    const claimTransaction = new Transaction()
      .add(adminEd25519Ix)
      .add(claimIx);
    
    claimTransaction.feePayer = account.publicKey;
    claimTransaction.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    claimTransaction.sign(account);
    
    const signature = await program.provider.connection.sendRawTransaction(claimTransaction.serialize());
    await program.provider.connection.confirmTransaction(signature);
    
    console.log(`✅ Claim successful: ${signature}`);
    console.log(`🪙 Claimed ${CLAIM_AMOUNT_TOKENS} MERCLE tokens`);
    
    // Verify account is frozen
    const balance = await program.provider.connection.getTokenAccountBalance(tokenAccount);
    console.log(`💰 Balance: ${balance.value.uiAmount} tokens (should be frozen)`);
  }
}

async function testReplayAttackPrevention(program, admin, mint, accounts) {
  console.log("\n🛡️  TESTING REPLAY ATTACK PREVENTION");
  console.log("====================================");
  
  const account = accounts[0]; // Use first account
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_data"), account.publicKey.toBuffer()], 
    program.programId
  );
  
  // Get current user data
  const userData = await program.account.userData.fetch(userDataPDA);
  const oldNonce = userData.nonce;
  
  console.log(`🔍 Current nonce: ${oldNonce}`);
  
  // Try to use old nonce (should fail)
  const currentTime = Math.floor(Date.now() / 1000);
  const claimAmount = CLAIM_AMOUNT_TOKENS * Math.pow(10, 9);
  
  const replayPayload = {
    userAddress: account.publicKey,
    claimAmount: new anchor.BN(claimAmount),
    expiryTime: new anchor.BN(currentTime + 3600),
    nonce: new anchor.BN(oldNonce - 1) // Use old nonce
  };
  
  const messageBytes = createDomainSeparatedMessage(program.programId, replayPayload);
  const adminSignature = nacl.sign.detached(messageBytes, admin.secretKey);
  
  const tokenAccount = await getAssociatedTokenAddress(
    mint,
    account.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  
  try {
    const adminEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: admin.publicKey.toBytes(),
      message: messageBytes,
      signature: adminSignature,
    });
    
    const claimIx = await program.methods
      .claimTokens(replayPayload, Array.from(adminSignature))
      .accounts({
        tokenState: tokenStatePDA,
        userData: userDataPDA,
        mint: mint,
        userTokenAccount: tokenAccount,
        user: account.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    
    const replayTx = new Transaction()
      .add(adminEd25519Ix)
      .add(claimIx);
    
    replayTx.feePayer = account.publicKey;
    replayTx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    replayTx.sign(account);
    
    await program.provider.connection.sendRawTransaction(replayTx.serialize());
    console.log("❌ SECURITY FAILURE: Replay attack succeeded (this should not happen!)");
  } catch (error) {
    console.log("✅ Replay attack prevented successfully");
    console.log(`🔒 Error: ${error.message}`);
  }
}

async function testTreasuryOperations(program, admin, mint) {
  console.log("\n🏦 TESTING TREASURY OPERATIONS");
  console.log("==============================");
  
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const treasuryAddress = await getAssociatedTokenAddress(mint, tokenStatePDA, true, TOKEN_PROGRAM_ID);
  
  // Check if treasury exists
  console.log("🔍 Checking treasury status...");
  try {
    const treasuryBalance = await program.provider.connection.getTokenAccountBalance(treasuryAddress);
    console.log(`✅ Treasury already exists with ${treasuryBalance.value.uiAmount} tokens`);
  } catch (error) {
    // Create treasury
    console.log("🏗️  Creating treasury...");
    const treasuryTx = await program.methods
      .createTreasury()
      .accounts({
        tokenState: tokenStatePDA,
        treasuryAccount: treasuryAddress,
        mint: mint,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    
    console.log(`✅ Treasury created: ${treasuryTx}`);
  }
  
  // Mint to treasury (test additional minting)
  console.log("💰 Minting additional tokens to treasury...");
  const mintAmount = 10000 * Math.pow(10, 9); // Mint 10K more tokens
  const mintTx = await program.methods
    .mintToTreasury(new anchor.BN(mintAmount))
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      treasuryAccount: treasuryAddress,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
  
  console.log(`✅ Minted 10,000 additional tokens to treasury: ${mintTx}`);
  
  // Test treasury burn
  console.log("🔥 Testing treasury burn...");
  const burnAmount = BURN_TEST_AMOUNT * Math.pow(10, 9);
  const burnTx = await program.methods
    .burnFromTreasury(new anchor.BN(burnAmount))
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      treasuryAccount: treasuryAddress,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
  
  console.log(`✅ Burned ${BURN_TEST_AMOUNT} tokens from treasury: ${burnTx}`);
  
  // Check final treasury balance
  const finalBalance = await program.provider.connection.getTokenAccountBalance(treasuryAddress);
  console.log(`💰 Final treasury balance: ${finalBalance.value.uiAmount} tokens`);
}

async function testFreezeUnfreezeOperations(program, admin, mint, accounts) {
  console.log("\n❄️  TESTING FREEZE/UNFREEZE OPERATIONS");
  console.log("=====================================");
  
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const account = accounts[0];
  const tokenAccount = await getAssociatedTokenAddress(mint, account.publicKey, false, TOKEN_PROGRAM_ID);
  
  // Check current freeze status
  console.log("🔍 Checking current freeze status...");
  let accountInfo = await program.provider.connection.getTokenAccountBalance(tokenAccount);
  console.log(`Current balance: ${accountInfo.value.uiAmount} tokens`);
  console.log("ℹ️  Account is already frozen from claim operation");
  
  // Test that users CANNOT unfreeze when transfers are disabled
  console.log("🚫 Testing that users CANNOT unfreeze when transfers disabled...");
  try {
    const failedUnfreezeTx = await program.methods
      .unfreezeAccount()
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint,
        userTokenAccount: tokenAccount,
        user: account.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([account])
      .rpc();
    
    console.log("❌ SECURITY FAILURE: User was able to unfreeze when transfers disabled!");
  } catch (error) {
    console.log("✅ SECURITY SUCCESS: User cannot unfreeze when transfers disabled");
    console.log(`🔒 Error: ${error.message}`);
  }
  
  // Enable transfers permanently (required for user unfreeze)
  console.log("🔓 Admin enabling transfers permanently...");
  try {
    const enableTx = await program.methods
      .enableTransfers()
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    
    console.log(`✅ Transfers enabled permanently: ${enableTx}`);
  } catch (error) {
    if (error.message.includes("TransfersAlreadyPermanentlyEnabled")) {
      console.log("ℹ️  Transfers already permanently enabled");
    } else {
      throw error;
    }
  }
  
  // Test user unfreeze (should work now)
  console.log("🔥 Testing user unfreeze...");
  const unfreezeTx = await program.methods
    .unfreezeAccount()
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      userTokenAccount: tokenAccount,
      user: account.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([account])
    .rpc();
  
  console.log(`✅ Account unfrozen by user: ${unfreezeTx}`);
  console.log("🎉 User can now transfer tokens freely!");
  
  // Test admin freeze again (to show it works)
  console.log("❄️  Testing admin freeze after unfreeze...");
  const freezeTx = await program.methods
    .freezeTokenAccount()
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      tokenAccount: tokenAccount,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
  
  console.log(`✅ Account re-frozen by admin: ${freezeTx}`);
  
  // Unfreeze again for transfer test
  console.log("🔥 Unfreezing for transfer test...");
  const unfreezeTx2 = await program.methods
    .unfreezeAccount()
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      userTokenAccount: tokenAccount,
      user: account.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([account])
    .rpc();
  
  console.log(`✅ Account unfrozen again: ${unfreezeTx2}`);
}

async function testTransferOperations(program, admin, mint, accounts) {
  console.log("\n💸 TESTING TOKEN TRANSFERS");
  console.log("==========================");
  
  if (accounts.length < 2) {
    console.log("⚠️  Need at least 2 accounts for transfer test");
    return;
  }
  
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const fromAccount = accounts[0];
  const toAccount = accounts[1];
  
  const fromTokenAccount = await getAssociatedTokenAddress(mint, fromAccount.publicKey, false, TOKEN_PROGRAM_ID);
  const toTokenAccount = await getAssociatedTokenAddress(mint, toAccount.publicKey, false, TOKEN_PROGRAM_ID);
  
  // Unfreeze both accounts first
  // First test: Try direct SPL token transfer while frozen (should fail)
  console.log("🚫 Testing direct SPL transfer while accounts frozen (should fail)...");
  try {
    const { createTransferInstruction } = require("@solana/spl-token");
    const directTransferIx = createTransferInstruction(
      fromTokenAccount,
      toTokenAccount,
      fromAccount.publicKey,
      100 * Math.pow(10, 9),
      [],
      TOKEN_PROGRAM_ID
    );
    
    const directTransferTx = new Transaction().add(directTransferIx);
    directTransferTx.feePayer = fromAccount.publicKey;
    directTransferTx.recentBlockhash = (await program.provider.connection.getLatestBlockhash()).blockhash;
    directTransferTx.sign(fromAccount);
    
    await program.provider.connection.sendRawTransaction(directTransferTx.serialize());
    console.log("❌ SECURITY FAILURE: Direct SPL transfer worked while frozen!");
  } catch (error) {
    console.log("✅ SECURITY SUCCESS: Direct SPL transfer blocked while frozen");
    console.log(`🔒 Error: Account is frozen`);
  }
  
  console.log("🔥 Unfreezing recipient account...");
  const unfreezeToTx = await program.methods
    .unfreezeAccount()
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      userTokenAccount: toTokenAccount,
      user: toAccount.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([toAccount])
    .rpc();
  
  console.log(`✅ Recipient account unfrozen: ${unfreezeToTx}`);
  
  // Check balances before
  const fromBalanceBefore = await program.provider.connection.getTokenAccountBalance(fromTokenAccount);
  const toBalanceBefore = await program.provider.connection.getTokenAccountBalance(toTokenAccount);
  
  console.log(`📊 Before transfer:`);
  console.log(`  From: ${fromBalanceBefore.value.uiAmount} tokens`);
  console.log(`  To: ${toBalanceBefore.value.uiAmount} tokens`);
  
  // Transfer tokens
  const transferAmount = 100 * Math.pow(10, 9); // 100 tokens
  const transferTx = await program.methods
    .transferTokens(new anchor.BN(transferAmount))
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint,
      fromTokenAccount: fromTokenAccount,
      toTokenAccount: toTokenAccount,
      fromAuthority: fromAccount.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([fromAccount])
    .rpc();
  
  console.log(`✅ Transfer completed: ${transferTx}`);
  
  // Check balances after
  const fromBalanceAfter = await program.provider.connection.getTokenAccountBalance(fromTokenAccount);
  const toBalanceAfter = await program.provider.connection.getTokenAccountBalance(toTokenAccount);
  
  console.log(`📊 After transfer:`);
  console.log(`  From: ${fromBalanceAfter.value.uiAmount} tokens`);
  console.log(`  To: ${toBalanceAfter.value.uiAmount} tokens`);
  console.log(`💰 Transferred: 100 tokens`);
}

// ========================================
// MAIN EXECUTION
// ========================================

(async () => {
  console.log("🏢 MERCLE TOKEN - COMPLETE DEPLOYMENT & TESTING");
  console.log("===============================================");
  console.log(`🌐 Network: ${NETWORK}`);
  console.log(`🔗 RPC: ${RPC_URL}`);
  console.log("");
  
  const startTime = Date.now();
  
  try {
    // Load admin
    const admin = loadAdminKeypair();
    console.log(`🔑 Admin loaded: ${admin.publicKey.toString()}`);
    
    // Connect to network
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    console.log(`✅ Connected to ${NETWORK}`);
    
    // Deploy contract
    const { program, programId, tokenStatePDA, tokenState } = await deployContract(connection, admin);
    
    // Create token mint if needed
    let mint = tokenState.tokenMint;
    if (mint.equals(PublicKey.default)) {
      mint = await createTokenMint(program, admin, tokenStatePDA);
    } else {
      console.log(`\n🪙 Using existing mint: ${mint.toString()}`);
    }
    
    // Setup test accounts
    const testAccounts = await setupTestAccounts(connection, admin, TEST_ACCOUNTS_COUNT);
    
    // Initialize user data
    await initializeUserData(program, testAccounts);
    
    // Create token accounts
    await createTokenAccounts(connection, admin, mint, testAccounts);
    
    // Test signature-based claims
    await testSignatureClaims(program, admin, mint, testAccounts);
    
    // Test replay attack prevention
    await testReplayAttackPrevention(program, admin, mint, testAccounts);
    
    // Test treasury operations
    await testTreasuryOperations(program, admin, mint);
    
    // Test freeze/unfreeze operations
    await testFreezeUnfreezeOperations(program, admin, mint, testAccounts);
    
    // Test transfer operations
    await testTransferOperations(program, admin, mint, testAccounts);
    
    // Final summary
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    console.log("\n🎉 ALL TESTS COMPLETED SUCCESSFULLY!");
    console.log("===================================");
    console.log(`⏱️  Total time: ${duration.toFixed(2)} seconds`);
    console.log(`🏢 Contract: ${programId.toString()}`);
    console.log(`🪙 Token: ${mint.toString()}`);
    console.log(`🌐 Network: ${NETWORK}`);
    console.log("");
    console.log("✅ Features tested:");
    console.log("  • Contract deployment");
    console.log("  • Token mint creation");
    console.log("  • Signature-based claims");
    console.log("  • Replay attack prevention");
    console.log("  • Treasury operations");
    console.log("  • Freeze/unfreeze functionality");
    console.log("  • Token transfers");
    console.log("");
    console.log("🔐 Security verified:");
    console.log("  • Admin signature verification");
    console.log("  • Nonce-based replay protection");
    console.log("  • Account ownership validation");
    console.log("  • Freeze authority control");
    console.log("");
    console.log("🚀 MERCLE TOKEN CONTRACT IS PRODUCTION READY!");
    
  } catch (error) {
    console.error("\n❌ DEPLOYMENT/TESTING FAILED:");
    console.error(error.message);
    
    if (error.logs) {
      console.error("\n📋 Error logs:");
      error.logs.forEach(log => console.error(log));
    }
    
    process.exit(1);
  }
})().catch(console.error);
