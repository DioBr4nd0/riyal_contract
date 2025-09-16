#!/usr/bin/env node

/**
 * CLOSE PROGRAM AND RECLAIM SOL
 * 
 * This script closes your deployed program and reclaims the SOL.
 * WARNING: This is PERMANENT and cannot be undone!
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("⚠️  CLOSE PROGRAM AND RECLAIM SOL");
  console.log("=================================");
  console.log("WARNING: This will permanently destroy your deployed contract!");
  console.log("Current Program: DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK");
  console.log("SOL to reclaim: ~3.53 SOL");
  
  try {
    const admin = loadAdminKeypair();
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    
    const programId = new PublicKey("DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK");
    const programDataAddress = new PublicKey("7JABQmoVgSjHU3sKZVYdQPuj5LL8vmyBgjtd4n66XK71");
    
    console.log("\n📋 PROGRAM DETAILS:");
    console.log(`Program ID: ${programId.toString()}`);
    console.log(`Program Data: ${programDataAddress.toString()}`);
    console.log(`Authority: ${admin.publicKey.toString()}`);
    
    console.log("\n⚠️  TO CLOSE THE PROGRAM, RUN:");
    console.log(`solana program close ${programDataAddress.toString()} --url devnet`);
    console.log("\nThis will:");
    console.log("✅ Reclaim ~3.53 SOL to your account");
    console.log("❌ Permanently destroy the program");
    console.log("❌ Make all existing token accounts unusable");
    console.log("❌ Break any applications using this contract");
    
    console.log("\n💡 ALTERNATIVE: Keep the program and modify settings instead");
    console.log("Your current contract is well-configured and upgradeable!");
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
})().catch(console.error);
