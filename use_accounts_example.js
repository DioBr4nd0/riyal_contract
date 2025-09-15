const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair } = require("@solana/web3.js");
const fs = require('fs');

// Example script showing how to use the generated accounts
console.log("📖 HOW TO USE GENERATED ACCOUNTS");
console.log("================================");

// Load the accounts data
const accountsData = JSON.parse(fs.readFileSync('./generated_accounts.json', 'utf8'));

console.log("🔑 AVAILABLE METHODS TO LOAD KEYPAIRS:\n");

// Method 1: From secret key array
console.log("1️⃣ METHOD 1: From Secret Key Array");
const account1 = accountsData.accounts[0];
const keypair1 = Keypair.fromSecretKey(new Uint8Array(account1.secretKey));
console.log(`   const keypair = Keypair.fromSecretKey(new Uint8Array(${JSON.stringify(account1.secretKey.slice(0, 8))}...));`);
console.log(`   ✅ Loaded: ${keypair1.publicKey.toString()}`);

console.log("\n2️⃣ METHOD 2: From Base58 Secret Key");
const keypair2 = Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(account1.secretKeyBase58));
console.log(`   const keypair = Keypair.fromSecretKey(bs58.decode("${account1.secretKeyBase58}"));`);
console.log(`   ✅ Loaded: ${keypair2.publicKey.toString()}`);

console.log("\n3️⃣ METHOD 3: From JSON Keypair File");
console.log(`   const keypairData = JSON.parse(fs.readFileSync('./account_1_keypair.json', 'utf8'));`);
console.log(`   const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));`);
const keypairData = JSON.parse(fs.readFileSync('./account_1_keypair.json', 'utf8'));
const keypair3 = Keypair.fromSecretKey(new Uint8Array(keypairData));
console.log(`   ✅ Loaded: ${keypair3.publicKey.toString()}`);

console.log("\n📊 ALL GENERATED ACCOUNTS:");
console.log("==========================");

accountsData.accounts.forEach((account, index) => {
  console.log(`\n🆔 Account ${index + 1}:`);
  console.log(`   📍 Public Key: ${account.publicKey}`);
  console.log(`   🪙 Token Account (ATA): ${account.ata}`);
  console.log(`   🔐 Secret Key (Base58): ${account.secretKeyBase58}`);
  console.log(`   🌐 Explorer: https://explorer.solana.com/address/${account.publicKey}?cluster=devnet`);
  console.log(`   🪙 Token Explorer: https://explorer.solana.com/address/${account.ata}?cluster=devnet`);
});

console.log("\n💡 USAGE EXAMPLES:");
console.log("==================");

console.log("\n🔄 To use an account in your scripts:");
console.log(`
// Load account from generated_accounts.json
const accountsData = JSON.parse(fs.readFileSync('./generated_accounts.json', 'utf8'));
const account1Data = accountsData.accounts[0]; // First account

// Create keypair
const userKeypair = Keypair.fromSecretKey(new Uint8Array(account1Data.secretKey));

// Get public keys
const userPubkey = userKeypair.publicKey;
const userATA = new PublicKey(account1Data.ata);

console.log("User Address:", userPubkey.toString());
console.log("User Token Account:", userATA.toString());
console.log("Current RIYAL Balance: 50 tokens");
`);

console.log("\n🌐 SOLANA CLI USAGE:");
console.log("====================");
console.log("To use these accounts with Solana CLI:");
console.log("");
accountsData.accounts.forEach((account, index) => {
  console.log(`# Account ${index + 1}:`);
  console.log(`solana config set --keypair ./account_${index + 1}_keypair.json`);
  console.log(`solana balance ${account.publicKey} --url devnet`);
  console.log(`spl-token balance ${accountsData.token_mint} --owner ${account.publicKey} --url devnet`);
  console.log("");
});

console.log("📋 CONTRACT DETAILS:");
console.log("====================");
console.log(`🌐 Network: ${accountsData.network}`);
console.log(`📋 Program ID: ${accountsData.program_id}`);
console.log(`🪙 Token Mint: ${accountsData.token_mint}`);
console.log(`👤 Admin: ${accountsData.admin}`);
console.log(`⏰ Generated: ${accountsData.generated_at}`);

console.log("\n✅ All accounts are ready to use with 50 RIYAL tokens each!");
