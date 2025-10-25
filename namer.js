#!/usr/bin/env node

/**
 * TOKEN METADATA UPDATER
 *
 * Updates metadata for the Mercle Token deployed on Solana.
 * Creates metadata for a token where the mint authority is a PDA.
 *
 * USAGE:
 * node namer.js [network]
 *
 * Networks: devnet (default), mainnet-beta
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, Transaction, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const fs = require('fs');

// Import Metaplex for metadata
const { Metaplex, keypairIdentity } = require("@metaplex-foundation/js");

// ========================================
// CONFIGURATION
// ========================================

const NETWORK = process.argv[2] || 'devnet';
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";

const NETWORK_CONFIGS = {
  'devnet': 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};

const RPC_URL = NETWORK_CONFIGS[NETWORK];
if (!RPC_URL) {
  console.error(`❌ Invalid network: ${NETWORK}`);
  console.error(`Available networks: ${Object.keys(NETWORK_CONFIGS).join(', ')}`);
  process.exit(1);
}

// Token metadata - loaded from metadata.json
const METADATA_FILE = "./metadata.json";

// Metadata URI (should point to the JSON file hosted on IPFS/Pinata)
const METADATA_URI = "https://rose-electoral-cuckoo-545.mypinata.cloud/ipfs/bafkreicjiqv53ztui2jk3fstwu7vlxjy5uhut7h4gtvkiapll3bs5iy664";

// Token Metadata Program ID
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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

function loadMetadata() {
  try {
    const data = fs.readFileSync(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`❌ Failed to load metadata from ${METADATA_FILE}`);
    throw error;
  }
}

// Get metadata PDA
function getMetadataPDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

// Create metadata instruction manually (without requiring mint authority to sign)
function createMetadataInstruction(
  metadata,
  mint,
  mintAuthority,
  payer,
  updateAuthority,
  name,
  symbol,
  uri
) {
  const keys = [
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: mintAuthority, isSigner: false, isWritable: false }, // Mint authority doesn't need to sign
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: updateAuthority, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false },
  ];

  // Build the data for CreateMetadataAccountV3
  const nameBytes = Buffer.from(name);
  const symbolBytes = Buffer.from(symbol);
  const uriBytes = Buffer.from(uri);

  const data = Buffer.alloc(1 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 2 + 1 + 1 + 1 + 1);
  let offset = 0;

  // Instruction discriminator for CreateMetadataAccountV3
  data.writeUInt8(33, offset);
  offset += 1;

  // Name
  data.writeUInt32LE(nameBytes.length, offset);
  offset += 4;
  nameBytes.copy(data, offset);
  offset += nameBytes.length;

  // Symbol
  data.writeUInt32LE(symbolBytes.length, offset);
  offset += 4;
  symbolBytes.copy(data, offset);
  offset += symbolBytes.length;

  // URI
  data.writeUInt32LE(uriBytes.length, offset);
  offset += 4;
  uriBytes.copy(data, offset);
  offset += uriBytes.length;

  // Seller fee basis points
  data.writeUInt16LE(0, offset);
  offset += 2;

  // Creators (None = 0)
  data.writeUInt8(0, offset);
  offset += 1;

  // Collection (None = 0)
  data.writeUInt8(0, offset);
  offset += 1;

  // Uses (None = 0)
  data.writeUInt8(0, offset);
  offset += 1;

  // Is mutable
  data.writeUInt8(1, offset);

  return new anchor.web3.TransactionInstruction({
    keys,
    programId: TOKEN_METADATA_PROGRAM_ID,
    data,
  });
}

// ========================================
// MAIN EXECUTION
// ========================================

(async () => {
  console.log("🏷️  TOKEN METADATA UPDATER");
  console.log("============================");
  console.log("");

  try {
    // Load admin keypair
    const admin = loadAdminKeypair();
    console.log(`🔑 Admin: ${admin.publicKey.toString()}`);
    console.log("");

    // Connect to Solana
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(admin),
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);

    console.log(`🌐 Network: ${NETWORK}`);
    console.log(`📡 RPC: ${RPC_URL}`);
    console.log("");

    // Load the program
    const program = anchor.workspace.MercleToken;
    const programId = program.programId;

    console.log(`📋 Program ID: ${programId.toString()}`);
    console.log("");

    // Get token state to retrieve mint address
    const [tokenStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state")],
      programId
    );

    console.log("🔍 Fetching token state...");
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const mintAddress = tokenState.tokenMint;

    console.log(`✅ Token Mint: ${mintAddress.toString()}`);
    console.log(`   Token State PDA (Mint Authority): ${tokenStatePDA.toString()}`);
    console.log("");

    // Verify admin authority
    if (!tokenState.admin.equals(admin.publicKey)) {
      throw new Error(
        `❌ Admin mismatch!\n` +
        `   Contract admin: ${tokenState.admin.toString()}\n` +
        `   Your admin: ${admin.publicKey.toString()}`
      );
    }
    console.log("✅ Admin authority verified");
    console.log("");

    // Load metadata from file
    const metadataJson = loadMetadata();
    console.log("📄 Loaded metadata:");
    console.log(`   Name: ${metadataJson.name}`);
    console.log(`   Symbol: ${metadataJson.symbol}`);
    console.log(`   Metadata URI: ${METADATA_URI}`);
    console.log(`   Image URL: ${metadataJson.image}`);
    console.log("");

    // Get metadata PDA
    const metadataPDA = getMetadataPDA(mintAddress);
    console.log(`📍 Metadata PDA: ${metadataPDA.toString()}`);
    console.log("");

    // Check if metadata already exists
    const metadataAccountInfo = await connection.getAccountInfo(metadataPDA);

    if (metadataAccountInfo !== null) {
      // Metadata exists, use Metaplex to update it
      console.log("⚠️  Metadata already exists. Updating...");

      const metaplex = Metaplex.make(connection).use(keypairIdentity(admin));
      const existingMetadata = await metaplex.nfts().findByMint({ mintAddress });

      const { response } = await metaplex.nfts().update({
        nftOrSft: existingMetadata,
        name: metadataJson.name,
        symbol: metadataJson.symbol,
        uri: METADATA_URI,
      });

      console.log("✅ Metadata updated successfully!");
      console.log(`   Transaction: ${response.signature}`);
    } else {
      // Create new metadata
      console.log("📝 Creating token metadata...");

      // The mint authority is the tokenStatePDA (a PDA), so we pass it but don't need it to sign
      const createMetadataIx = createMetadataInstruction(
        metadataPDA,
        mintAddress,
        tokenStatePDA, // Mint authority (PDA - doesn't sign)
        admin.publicKey, // Payer
        admin.publicKey, // Update authority
        metadataJson.name,
        metadataJson.symbol,
        METADATA_URI
      );

      const tx = new Transaction().add(createMetadataIx);
      tx.feePayer = admin.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.sign(admin);

      const signature = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(signature, "confirmed");

      console.log("✅ Metadata created successfully!");
      console.log(`   Transaction: ${signature}`);
    }

    console.log("");
    console.log("🎉 METADATA UPDATE COMPLETE!");
    console.log("");
    console.log("📋 Summary:");
    console.log(`   Token Mint: ${mintAddress.toString()}`);
    console.log(`   Metadata PDA: ${metadataPDA.toString()}`);
    console.log(`   Name: ${metadataJson.name}`);
    console.log(`   Symbol: ${metadataJson.symbol}`);
    console.log(`   Metadata URI: ${METADATA_URI}`);
    console.log(`   Image: ${metadataJson.image}`);
    console.log("");
    console.log("✅ Token metadata is now live on Solana!");
    console.log("");
    console.log(`🔍 View on Solana Explorer:`);
    console.log(`   https://explorer.solana.com/address/${mintAddress.toString()}?cluster=${NETWORK}`);

  } catch (error) {
    console.error("");
    console.error("❌ METADATA UPDATE FAILED:");
    console.error(error.message);

    if (error.logs) {
      console.error("");
      console.error("📋 Transaction Logs:");
      error.logs.forEach(log => console.error(log));
    }

    if (error.stack && !error.logs) {
      console.error("");
      console.error("🔍 Stack trace:");
      console.error(error.stack);
    }

    process.exit(1);
  }
})().catch(console.error);
