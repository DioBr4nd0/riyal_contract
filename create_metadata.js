#!/usr/bin/env node

/**
 * CREATE TOKEN METADATA
 *
 * Calls the create_metadata function on the deployed Mercle Token contract
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const fs = require('fs');

const NETWORK = process.argv[2] || 'devnet';
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";

const NETWORK_CONFIGS = {
  'devnet': 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};

const RPC_URL = NETWORK_CONFIGS[NETWORK];
const METADATA_URI = "https://rose-electoral-cuckoo-545.mypinata.cloud/ipfs/bafkreicjiqv53ztui2jk3fstwu7vlxjy5uhut7h4gtvkiapll3bs5iy664";

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function loadAdminKeypair() {
  const data = JSON.parse(fs.readFileSync(ADMIN_KEY_SOURCE, 'utf8'));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(data));
}

function getMetadataPDA(mint, programId = TOKEN_METADATA_PROGRAM_ID) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      programId.toBuffer(),
      mint.toBuffer(),
    ],
    programId
  );
  return pda;
}

(async () => {
  console.log("🏷️  CREATING TOKEN METADATA");
  console.log("===========================");
  console.log("");

  try {
    const admin = loadAdminKeypair();
    console.log(`🔑 Admin: ${admin.publicKey.toString()}`);

    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
    anchor.setProvider(provider);

    console.log(`🌐 Network: ${NETWORK}`);
    console.log("");

    // Load the program
    const program = anchor.workspace.MercleToken;
    const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);

    console.log("🔍 Fetching token state...");
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const mintAddress = tokenState.tokenMint;

    console.log(`✅ Token Mint: ${mintAddress.toString()}`);

    const metadataPDA = getMetadataPDA(mintAddress);
    console.log(`📍 Metadata PDA: ${metadataPDA.toString()}`);
    console.log("");

    console.log("📝 Creating metadata...");
    console.log(`   Name: Mercle Token`);
    console.log(`   Symbol: MERCLE`);
    console.log(`   URI: ${METADATA_URI}`);
    console.log("");

    const tx = await program.methods
      .createMetadata("Mercle Token", "MERCLE", METADATA_URI)
      .accounts({
        tokenState: tokenStatePDA,
        mint: mintAddress,
        metadata: metadataPDA,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log("✅ Metadata created successfully!");
    console.log(`   Transaction: ${tx}`);
    console.log("");
    console.log("🎉 DONE! Your token now has metadata!");
    console.log("");
    console.log(`🔍 View on Solana Explorer:`);
    console.log(`   https://explorer.solana.com/address/${mintAddress.toString()}?cluster=${NETWORK}`);

  } catch (error) {
    console.error("");
    console.error("❌ FAILED:");
    console.error(error.message);

    if (error.logs) {
      console.error("");
      console.error("📋 Transaction Logs:");
      error.logs.forEach(log => console.error(log));
    }

    process.exit(1);
  }
})().catch(console.error);
