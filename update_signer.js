#!/usr/bin/env node

/**
 * UPDATE CLAIM SIGNER SCRIPT
 * 
 * Updates the claim_signer on the contract to a new keypair
 * Usage: node update_signer.js <path_to_new_signer_keypair.json>
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair } = require("@solana/web3.js");
const fs = require('fs');

// Configuration
const CLUSTER = "devnet"; // Change to "mainnet-beta" for mainnet
const PROGRAM_ID = new PublicKey("3SkrCb3S7ocBxLZFrSYpNqTcNvdkvFpocXtpf3dZZyCo"); // Update for mainnet

// Load admin keypair (the one that has authority to update)
function loadAdminKeypair() {
  const walletPath = process.env.HOME + "/.config/solana/id.json";
  const keypairData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

// Load new signer keypair from provided path
function loadSignerKeypair(path) {
  try {
    const data = fs.readFileSync(path, 'utf8');
    
    // Try parsing as JSON array (standard Solana keypair format)
    try {
      const keypairData = JSON.parse(data);
      if (Array.isArray(keypairData)) {
        return Keypair.fromSecretKey(new Uint8Array(keypairData));
      }
    } catch (e) {
      // Not JSON array, might be base58
    }
    
    // Try as base58 string
    const bs58Module = require('bs58');
    const bs58 = bs58Module.default || bs58Module;
    const privateKeyBytes = bs58.decode(data.trim());
    return Keypair.fromSecretKey(privateKeyBytes);
  } catch (error) {
    console.error(`❌ Failed to load signer keypair from ${path}`);
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }
}

// Main function
async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("🔄 UPDATE CLAIM SIGNER");
  console.log("=".repeat(80) + "\n");

  // Check arguments
  if (process.argv.length < 3) {
    console.log("❌ Usage: node update_signer.js <path_to_new_signer_keypair.json>");
    console.log("\nExample:");
    console.log("  node update_signer.js ./new_signer.json");
    console.log("  node update_signer.js ./signer_base58.txt");
    process.exit(1);
  }

  const signerPath = process.argv[2];

  // Load keypairs
  console.log("📂 Loading keypairs...");
  const admin = loadAdminKeypair();
  const newSigner = loadSignerKeypair(signerPath);

  console.log(`✅ Admin loaded: ${admin.publicKey.toString()}`);
  console.log(`✅ New signer loaded: ${newSigner.publicKey.toString()}`);
  console.log("");

  // Connect to Solana
  const connection = new anchor.web3.Connection(
    CLUSTER === "mainnet-beta" 
      ? "https://api.mainnet-beta.solana.com"
      : anchor.web3.clusterApiUrl(CLUSTER),
    "confirmed"
  );

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  console.log(`🌐 Connected to ${CLUSTER}`);
  console.log(`🏦 Program ID: ${PROGRAM_ID.toString()}`);
  console.log("");

  // Load program
  const program = anchor.workspace.MercleToken;

  // Get token state PDA
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  // Fetch current state
  console.log("📊 Fetching current contract state...");
  const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
  
  console.log(`   Current claim signer: ${tokenState.claimSigner.toString()}`);
  console.log(`   Contract admin: ${tokenState.admin.toString()}`);
  console.log("");

  // Verify admin matches
  if (!tokenState.admin.equals(admin.publicKey)) {
    console.log("❌ ERROR: You are not the contract admin!");
    console.log(`   Your key: ${admin.publicKey.toString()}`);
    console.log(`   Admin key: ${tokenState.admin.toString()}`);
    process.exit(1);
  }

  // Check if new signer is same as current
  if (tokenState.claimSigner.equals(newSigner.publicKey)) {
    console.log("⚠️  WARNING: New signer is the same as current signer!");
    console.log("   No update needed.");
    process.exit(0);
  }

  // Confirm with user
  console.log("🔄 READY TO UPDATE CLAIM SIGNER");
  console.log(`   FROM: ${tokenState.claimSigner.toString()}`);
  console.log(`   TO:   ${newSigner.publicKey.toString()}`);
  console.log("");

  // Check balance
  const balance = await connection.getBalance(admin.publicKey);
  console.log(`💰 Admin balance: ${(balance / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  
  if (balance < 0.01 * anchor.web3.LAMPORTS_PER_SOL) {
    console.log("❌ ERROR: Insufficient balance for transaction (need at least 0.01 SOL)");
    process.exit(1);
  }
  console.log("");

  // Update the claim signer
  console.log("🚀 Sending transaction...");
  try {
    const tx = await program.methods
      .updateClaimSigner(newSigner.publicKey)
      .accounts({
        tokenState: tokenStatePDA,
        admin: admin.publicKey,
      })
      .rpc();

    console.log("✅ CLAIM SIGNER UPDATED SUCCESSFULLY!");
    console.log(`   Transaction: ${tx}`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${CLUSTER}`);
    console.log("");

    // Verify the update
    console.log("🔍 Verifying update...");
    const updatedState = await program.account.tokenState.fetch(tokenStatePDA);
    
    if (updatedState.claimSigner.equals(newSigner.publicKey)) {
      console.log("✅ VERIFIED: Claim signer updated on-chain");
      console.log(`   New signer: ${updatedState.claimSigner.toString()}`);
    } else {
      console.log("⚠️  WARNING: On-chain signer doesn't match expected value");
      console.log(`   Expected: ${newSigner.publicKey.toString()}`);
      console.log(`   Got: ${updatedState.claimSigner.toString()}`);
    }

    console.log("");
    console.log("=".repeat(80));
    console.log("🎉 UPDATE COMPLETE!");
    console.log("=".repeat(80));
    console.log("");
    console.log("⚠️  IMPORTANT: Update your backend to use the new signing key!");
    console.log(`   New Signer Public Key: ${newSigner.publicKey.toString()}`);
    
    // Print private key if requested
    const bs58Module = require('bs58');
    const bs58 = bs58Module.default || bs58Module;
    console.log(`   New Signer Private Key (Base58): ${bs58.encode(newSigner.secretKey)}`);
    console.log("");
    console.log("⚠️  OLD SIGNATURES WILL NO LONGER BE VALID!");
    console.log("   All claims must now be signed with the new key.");
    console.log("");

  } catch (error) {
    console.log("❌ TRANSACTION FAILED!");
    console.log(`   Error: ${error.message}`);
    
    if (error.logs) {
      console.log("\n📋 Transaction Logs:");
      error.logs.forEach(log => console.log(`   ${log}`));
    }
    
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error("\n❌ UNEXPECTED ERROR:");
  console.error(error);
  process.exit(1);
});