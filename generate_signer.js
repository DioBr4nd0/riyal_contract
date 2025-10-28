#!/usr/bin/env node

/**
 * GENERATE NEW CLAIM SIGNER KEYPAIR
 * 
 * Generates a new keypair for use as claim_signer
 * Saves in both JSON array and Base58 formats
 */

const { Keypair } = require("@solana/web3.js");
const fs = require('fs');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

console.log("\n" + "=".repeat(80));
console.log("🔑 GENERATE NEW CLAIM SIGNER KEYPAIR");
console.log("=".repeat(80) + "\n");

// Generate new keypair
const keypair = Keypair.generate();

// Prepare file names
const timestamp = Date.now();
const jsonFile = `claim_signer_${timestamp}.json`;
const base58File = `claim_signer_${timestamp}_base58.txt`;

console.log("✅ New keypair generated!\n");
console.log("📋 KEYPAIR DETAILS:");
console.log(`   Public Key:  ${keypair.publicKey.toString()}`);
console.log(`   Private Key (Base58): ${bs58.encode(keypair.secretKey)}`);
console.log("");

// Save JSON format (standard Solana keypair format)
fs.writeFileSync(jsonFile, JSON.stringify(Array.from(keypair.secretKey)));
console.log(`💾 Saved JSON format:   ./${jsonFile}`);

// Save Base58 format
fs.writeFileSync(base58File, bs58.encode(keypair.secretKey));
console.log(`💾 Saved Base58 format: ./${base58File}`);

console.log("");
console.log("=".repeat(80));
console.log("✅ KEYPAIR GENERATED SUCCESSFULLY!");
console.log("=".repeat(80));
console.log("");
console.log("📝 NEXT STEPS:");
console.log("");
console.log("1. Update the claim signer:");
console.log(`   node update_signer.js ${jsonFile}`);
console.log("");
console.log("2. Store the private key securely in your backend");
console.log("");
console.log("3. Delete the keypair files after securely storing:");
console.log(`   rm ${jsonFile} ${base58File}`);
console.log("");
console.log("⚠️  WARNING: Keep these files secure! Anyone with the private key");
console.log("   can sign claims on your contract!");
console.log("");

