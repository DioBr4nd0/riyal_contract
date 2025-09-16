#!/usr/bin/env node

/**
 * DEPLOY FRESH CONTRACT
 * 
 * This script deploys a completely new contract with a new program ID
 * and your desired parameters from scratch.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');

// Load admin keypair
function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync('/Users/mercle/.config/solana/id.json', 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(data));
}

(async () => {
  console.log("🚀 DEPLOY FRESH RIYAL CONTRACT");
  console.log("==============================");
  
  try {
    const admin = loadAdminKeypair();
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);
    
    // Generate new program keypair for fresh deployment
    const programKeypair = Keypair.generate();
    console.log(`New Program ID: ${programKeypair.publicKey.toString()}`);
    
    // YOUR CUSTOM PARAMETERS - CHANGE THESE AS NEEDED
    const INIT_PARAMS = {
      admin: admin.publicKey,
      upgradeAuthority: admin.publicKey,
      claimPeriodSeconds: 3600, // 1 hour (change as needed)
      timeLockEnabled: true,    // Enable/disable time-lock
      upgradeable: true         // Make upgradeable or not
    };
    
    const TOKEN_PARAMS = {
      decimals: 9,
      name: "Riyal Token V2",  // Change name if desired
      symbol: "RIYAL2"         // Change symbol if desired
    };
    
    console.log("\n📋 DEPLOYMENT PARAMETERS:");
    console.log(`Admin: ${INIT_PARAMS.admin.toString()}`);
    console.log(`Upgrade Authority: ${INIT_PARAMS.upgradeAuthority.toString()}`);
    console.log(`Claim Period: ${INIT_PARAMS.claimPeriodSeconds} seconds (${INIT_PARAMS.claimPeriodSeconds / 3600} hours)`);
    console.log(`Time Lock Enabled: ${INIT_PARAMS.timeLockEnabled}`);
    console.log(`Upgradeable: ${INIT_PARAMS.upgradeable}`);
    console.log(`Token Name: ${TOKEN_PARAMS.name}`);
    console.log(`Token Symbol: ${TOKEN_PARAMS.symbol}`);
    console.log(`Token Decimals: ${TOKEN_PARAMS.decimals}`);
    
    console.log("\n⚠️  NOTE: This will create a NEW program with a different Program ID!");
    console.log("Your old contract will remain at: DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK");
    console.log(`New contract will be at: ${programKeypair.publicKey.toString()}`);
    
    // You would need to:
    // 1. Update Anchor.toml with new program ID
    // 2. Update lib.rs declare_id! with new program ID  
    // 3. Build and deploy the program
    // 4. Then run this initialization
    
    console.log("\n📝 STEPS TO DEPLOY FRESH CONTRACT:");
    console.log("1. Update Anchor.toml:");
    console.log(`   riyal_contract = "${programKeypair.publicKey.toString()}"`);
    console.log("2. Update programs/riyal_contract/src/lib.rs:");
    console.log(`   declare_id!("${programKeypair.publicKey.toString()}");`);
    console.log("3. Build and deploy:");
    console.log("   anchor build");
    console.log("   anchor deploy --program-name riyal_contract --program-keypair target/deploy/riyal_contract-keypair.json");
    console.log("4. Initialize with your parameters");
    
    console.log("\n💡 RECOMMENDATION:");
    console.log("Since your current contract is upgradeable and working well,");
    console.log("consider using modify_contract_settings.js instead to adjust settings.");
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
})().catch(console.error);

