#!/usr/bin/env node
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");
const fs = require("fs");

// ========================================
// CONFIGURATION - EDIT THESE VALUES
// ========================================
const CLUSTER = "mainnet-beta"; // MAINNET DEPLOYMENT

const TOKEN_CONFIG = {
  name: "MERCI POINTS",
  symbol: "MERCI",
  decimals: 9,
  uri: "https://ipfs.io/ipfs/bafkreic766ldkvoasmccfoxk65obzjz7z7ae26qaldtqvcjooac3n7vbty",
  claimDelay: 300,          // 5 minutes
  timeLockEnabled: true,    // Enabled for mainnet
  createTreasury: true
};

// ========================================
// RPC ENDPOINTS
// ========================================
const RPC_URLS = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com"
};

const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ========================================
// MAIN DEPLOYMENT SCRIPT
// ========================================
(async () => {
  console.log(`\n🚀 DEPLOYING MERCLE TOKEN TO ${CLUSTER.toUpperCase()}\n`);
  console.log("=" .repeat(60));

  // Setup connection
  const connection = new anchor.web3.Connection(RPC_URLS[CLUSTER], "confirmed");

  // Load wallet
  const walletPath = CLUSTER === "mainnet-beta" 
    ? "./mainnet_deployer.json" 
    : process.env.HOME + "/.config/solana/id.json";
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath))));

  console.log(`💼 Wallet: ${wallet.publicKey.toString()}`);

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💰 Balance: ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * anchor.web3.LAMPORTS_PER_SOL) {
    console.error("❌ Insufficient balance! Need at least 0.5 SOL for deployment");
    process.exit(1);
  }

  // Setup provider
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed"
  });
  anchor.setProvider(provider);

  // Load program using workspace (better compatibility)
  let program;
  const programId = new PublicKey("HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts");

  try {
    // Try loading from workspace first
    program = anchor.workspace.MercleToken;
  } catch (e) {
    // Fallback: load IDL manually
    const idl = JSON.parse(fs.readFileSync("./target/idl/mercle_token.json", "utf8"));
    program = new anchor.Program(idl, programId, provider);
  }

  // Derive PDAs
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );

  console.log(`\n📋 DEPLOYMENT INFO:`);
  console.log(`   Program ID: ${program.programId.toString()}`);
  console.log(`   Token State PDA: ${tokenStatePDA.toString()}`);
  console.log(`   Admin: ${wallet.publicKey.toString()}`);
  console.log("=" .repeat(60));

  // ========================================
  // STEP 1: INITIALIZE CONTRACT
  // ========================================
  console.log("\n🔧 STEP 1: Initializing contract...");

  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log("✅ Contract already initialized!");
    console.log(`   Admin: ${tokenState.admin.toString()}`);
  } catch (e) {
    // Not initialized, do it now
    const tx = await program.methods
      .initialize(
        wallet.publicKey,
        wallet.publicKey,
        new anchor.BN(TOKEN_CONFIG.claimDelay),
        TOKEN_CONFIG.timeLockEnabled,
        true
      )
      .accounts({
        tokenState: tokenStatePDA,
        deployer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`✅ Initialized! Tx: ${tx}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // ========================================
  // STEP 2: CREATE TOKEN MINT
  // ========================================
  console.log("\n🪙 STEP 2: Creating token mint...");

  const tokenState = await program.account.tokenState.fetch(tokenStatePDA);

  let tokenMint;
  if (tokenState.tokenMint.toString() !== PublicKey.default.toString()) {
    tokenMint = tokenState.tokenMint;
    console.log(`✅ Token mint already exists: ${tokenMint.toString()}`);
  } else {
    const mintKeypair = Keypair.generate();

    const tx = await program.methods
      .createTokenMint(TOKEN_CONFIG.decimals, TOKEN_CONFIG.name, TOKEN_CONFIG.symbol)
      .accounts({
        tokenState: tokenStatePDA,
        mint: mintKeypair.publicKey,
        admin: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc();

    tokenMint = mintKeypair.publicKey;
    console.log(`✅ Token mint created: ${tokenMint.toString()}`);
    console.log(`   Tx: ${tx}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // ========================================
  // STEP 3: TRANSFER MINT AUTHORITY TO PDA
  // ========================================
  console.log("\n🔐 STEP 3: Transferring mint authority to PDA...");

  const mintInfo = await connection.getParsedAccountInfo(tokenMint);
  const currentMintAuthority = mintInfo.value?.data?.parsed?.info?.mintAuthority;

  if (currentMintAuthority === tokenStatePDA.toString()) {
    console.log("✅ Mint authority already transferred to PDA");
  } else {
    const tx = await program.methods
      .transferMintAuthorityToPda()
      .accounts({
        tokenState: tokenStatePDA,
        mint: tokenMint,
        admin: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log(`✅ Mint authority transferred to PDA!`);
    console.log(`   Tx: ${tx}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // ========================================
  // STEP 4: CREATE METADATA
  // ========================================
  console.log("\n📝 STEP 4: Creating token metadata...");

  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_PROGRAM_ID.toBuffer(),
      tokenMint.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID
  );

  try {
    const metadataAccount = await connection.getAccountInfo(metadataPDA);
    if (metadataAccount) {
      console.log("✅ Metadata already exists");
      console.log(`   Metadata PDA: ${metadataPDA.toString()}`);
    } else {
      throw new Error("Metadata not found");
    }
  } catch (e) {
    try {
      const tx = await program.methods
        .createMetadata(TOKEN_CONFIG.name, TOKEN_CONFIG.symbol, TOKEN_CONFIG.uri)
        .accounts({
          tokenState: tokenStatePDA,
          mint: tokenMint,
          metadata: metadataPDA,
          admin: wallet.publicKey,
          tokenMetadataProgram: METAPLEX_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log(`✅ Metadata created!`);
      console.log(`   Metadata PDA: ${metadataPDA.toString()}`);
      console.log(`   Tx: ${tx}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (metaError) {
      console.log("⚠️  Metadata creation skipped (add manually with Metaplex SDK)");
    }
  }

  // ========================================
  // STEP 5: CREATE TREASURY (OPTIONAL)
  // ========================================
  if (TOKEN_CONFIG.createTreasury) {
    console.log("\n🏦 STEP 5: Creating treasury...");

    const treasuryATA = await getAssociatedTokenAddress(
      tokenMint,
      tokenStatePDA,
      true,
      TOKEN_PROGRAM_ID
    );

    try {
      await connection.getTokenAccountBalance(treasuryATA);
      console.log("✅ Treasury already exists");
      console.log(`   Treasury: ${treasuryATA.toString()}`);
    } catch (e) {
      const tx = await program.methods
        .createTreasury()
        .accounts({
          tokenState: tokenStatePDA,
          treasuryAccount: treasuryATA,
          mint: tokenMint,
          admin: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`✅ Treasury created!`);
      console.log(`   Treasury: ${treasuryATA.toString()}`);
      console.log(`   Tx: ${tx}`);
    }
  }

  // ========================================
  // DEPLOYMENT COMPLETE
  // ========================================
  console.log("\n" + "=".repeat(60));
  console.log("🎉 DEPLOYMENT COMPLETE!");
  console.log("=".repeat(60));

  console.log(`\n📊 CONTRACT DETAILS:`);
  console.log(`   Program ID: ${program.programId.toString()}`);
  console.log(`   Token Mint: ${tokenMint.toString()}`);
  console.log(`   Token Name: ${TOKEN_CONFIG.name}`);
  console.log(`   Token Symbol: ${TOKEN_CONFIG.symbol}`);
  console.log(`   Decimals: ${TOKEN_CONFIG.decimals}`);
  console.log(`   Metadata URI: ${TOKEN_CONFIG.uri}`);
  console.log(`   Admin: ${wallet.publicKey.toString()}`);
  console.log(`   Token State PDA: ${tokenStatePDA.toString()}`);
  console.log(`   Metadata PDA: ${metadataPDA.toString()}`);

  if (TOKEN_CONFIG.createTreasury) {
    const treasuryATA = await getAssociatedTokenAddress(tokenMint, tokenStatePDA, true, TOKEN_PROGRAM_ID);
    console.log(`   Treasury: ${treasuryATA.toString()}`);
  }

  console.log(`\n✅ Save these addresses - your contract is READY!`);

})().catch(err => {
  console.error("\n❌ Deployment Error:", err.message);
  if (err.logs) {
    console.error("\nProgram Logs:");
    err.logs.forEach(log => console.error("  ", log));
  }
  process.exit(1);
});
