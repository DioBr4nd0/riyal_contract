const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection } = require("@solana/web3.js");
const fs = require("fs");

// ===============================
// CONFIGURATION
// ===============================
const NETWORK = "devnet"; // Change to "mainnet-beta" for mainnet
const PROGRAM_ID = "HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts";
const ADMIN_KEYPAIR_PATH = process.env.HOME + "/.config/solana/id.json";

// Settings to update
const NEW_SETTINGS = {
  claimDelay: 300,           // 5 minutes (300 seconds)
  timeLockEnabled: true,     // Enable timelock
};

// ===============================
// MAIN FUNCTION
// ===============================
async function updateContractSettings() {
  console.log("🔧 MERCLE TOKEN - CONTRACT SETTINGS UPDATE");
  console.log("============================================================\n");

  // Load admin keypair
  const adminKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf-8")))
  );
  console.log(`🔑 Admin: ${adminKeypair.publicKey.toString()}`);

  // Setup connection and provider
  const connection = new Connection(
    NETWORK === "mainnet-beta" 
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com",
    "confirmed"
  );
  
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load program using workspace (better compatibility)
  let program;
  const programId = new PublicKey(PROGRAM_ID);
  
  try {
    // Try loading from workspace first
    program = anchor.workspace.MercleToken;
  } catch (e) {
    // Fallback: load IDL manually
    const idl = JSON.parse(fs.readFileSync("./target/idl/mercle_token.json", "utf8"));
    program = new anchor.Program(idl, programId, provider);
  }

  // Derive token state PDA
  const [tokenStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    programId
  );

  console.log(`📋 Program ID: ${programId.toString()}`);
  console.log(`📋 Token State PDA: ${tokenStatePda.toString()}`);
  console.log(`🌐 Network: ${NETWORK}\n`);

  // ===============================
  // READ CURRENT SETTINGS
  // ===============================
  console.log("📖 READING CURRENT SETTINGS...\n");
  
  try {
    const tokenStateAccount = await program.account.tokenState.fetch(tokenStatePda);
    
    console.log("CURRENT SETTINGS:");
    console.log(`   Claim Delay: ${tokenStateAccount.claimDelay.toString()} seconds (${Math.floor(tokenStateAccount.claimDelay / 60)} minutes)`);
    console.log(`   Time Lock Enabled: ${tokenStateAccount.timeLockEnabled}`);
    console.log(`   Transfers Enabled: ${tokenStateAccount.transfersEnabled}`);
    console.log(`   Transfers Permanently Enabled: ${tokenStateAccount.transfersPermanentlyEnabled}`);
    console.log(`   Admin: ${tokenStateAccount.admin.toString()}`);
    console.log();

    // Verify admin matches
    if (tokenStateAccount.admin.toString() !== adminKeypair.publicKey.toString()) {
      console.error("❌ ERROR: You are not the admin of this contract!");
      console.error(`   Contract Admin: ${tokenStateAccount.admin.toString()}`);
      console.error(`   Your Pubkey: ${adminKeypair.publicKey.toString()}`);
      process.exit(1);
    }

  } catch (error) {
    console.error("❌ ERROR: Could not fetch contract state");
    console.error(error.message);
    process.exit(1);
  }

  // ===============================
  // UPDATE TIME LOCK SETTINGS
  // ===============================
  console.log("🔧 UPDATING TIME LOCK SETTINGS...\n");
  console.log("NEW SETTINGS:");
  console.log(`   Claim Delay: ${NEW_SETTINGS.claimDelay} seconds (${Math.floor(NEW_SETTINGS.claimDelay / 60)} minutes)`);
  console.log(`   Time Lock Enabled: ${NEW_SETTINGS.timeLockEnabled}`);
  console.log();

  try {
    const tx = await program.methods
      .updateTimeLock(
        new anchor.BN(NEW_SETTINGS.claimDelay),
        NEW_SETTINGS.timeLockEnabled
      )
      .accounts({
        tokenState: tokenStatePda,
        admin: adminKeypair.publicKey,
      })
      .rpc();

    console.log("✅ Time lock settings updated!");
    console.log(`   Transaction: ${tx}`);
    console.log();

  } catch (error) {
    console.error("❌ ERROR: Failed to update time lock settings");
    console.error(error);
    process.exit(1);
  }

  // ===============================
  // VERIFY NEW SETTINGS
  // ===============================
  console.log("📖 VERIFYING NEW SETTINGS...\n");
  
  try {
    const tokenStateAccount = await program.account.tokenState.fetch(tokenStatePda);
    
    console.log("UPDATED SETTINGS:");
    console.log(`   Claim Delay: ${tokenStateAccount.claimDelay.toString()} seconds (${Math.floor(tokenStateAccount.claimDelay / 60)} minutes)`);
    console.log(`   Time Lock Enabled: ${tokenStateAccount.timeLockEnabled}`);
    console.log(`   Transfers Enabled: ${tokenStateAccount.transfersEnabled}`);
    console.log(`   Transfers Permanently Enabled: ${tokenStateAccount.transfersPermanentlyEnabled}`);
    console.log();

    // Verify changes
    const claimDelayMatch = tokenStateAccount.claimDelay.toString() === NEW_SETTINGS.claimDelay.toString();
    const timeLockMatch = tokenStateAccount.timeLockEnabled === NEW_SETTINGS.timeLockEnabled;

    if (claimDelayMatch && timeLockMatch) {
      console.log("✅ ALL SETTINGS UPDATED SUCCESSFULLY!");
    } else {
      console.log("⚠️  WARNING: Some settings may not have updated correctly");
      if (!claimDelayMatch) console.log(`   - Claim Delay mismatch: expected ${NEW_SETTINGS.claimDelay}, got ${tokenStateAccount.claimDelay.toString()}`);
      if (!timeLockMatch) console.log(`   - Time Lock mismatch: expected ${NEW_SETTINGS.timeLockEnabled}, got ${tokenStateAccount.timeLockEnabled}`);
    }

  } catch (error) {
    console.error("❌ ERROR: Could not verify new settings");
    console.error(error.message);
    process.exit(1);
  }

  console.log("\n============================================================");
  console.log("🎉 CONTRACT SETTINGS UPDATE COMPLETE!");
  console.log("============================================================\n");

  console.log("📊 SUMMARY:");
  console.log(`   ⏱️  Users must wait ${NEW_SETTINGS.claimDelay / 60} minutes between claims`);
  console.log(`   🔒 Time lock is ${NEW_SETTINGS.timeLockEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`   🚫 Transfers are currently DISABLED`);
  console.log(`   ℹ️  To enable transfers, use: enable_transfers (WARNING: PERMANENT!)`);
  console.log();
}

// ===============================
// RUN
// ===============================
updateContractSettings()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

