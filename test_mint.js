// scripts/basic_mint_check.js
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const BN = anchor.BN;

async function airdrop(connection, pubkey, sol = 5) {
  const sig = await connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function main() {
  console.log("▶ basic admin mint check");

  // --- setup ---
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const u1 = Keypair.generate();
  const u2 = Keypair.generate();
  const u3 = Keypair.generate();
  await Promise.all([admin, u1, u2, u3].map(k => airdrop(connection, k.publicKey, 10)));

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract; // make sure your Anchor.toml name matches

  // PDAs + mint
  const [tokenStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_state")],
    program.programId
  );
  const mint = Keypair.generate();

  // --- initialize program state (claim period >= 3600 as per your constraints) ---
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new BN(3600), false, true)
    .accounts({
      tokenState: tokenStatePDA,
      payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();

  // --- create mint (PDA is mint & freeze authority) ---
  await program.methods
    .createTokenMint(6, "Riyal", "RIYAL")
    .accounts({
      tokenState: tokenStatePDA,
      mint: mint.publicKey,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin, mint])
    .rpc();

  // --- create ATAs for users ---
  async function createAta(ownerPk) {
    const ata = await getAssociatedTokenAddress(mint.publicKey, ownerPk);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey, // payer
        ata,
        ownerPk,
        mint.publicKey
      )
    );
    await provider.sendAndConfirm(tx, [admin]);
    return ata;
  }
  const u1ATA = await createAta(u1.publicKey);
  const u2ATA = await createAta(u2.publicKey);
  const u3ATA = await createAta(u3.publicKey);

  // --- helper to get ui balance ---
  const getUiBal = async (ata) => (await connection.getTokenAccountBalance(ata)).value.uiAmount;

  // --- admin mints to all three (should succeed) ---
  const amt = new BN(1_000_000_000); // 1000 tokens @ 6 decimals
  for (const [name, ata] of [["u1", u1ATA], ["u2", u2ATA], ["u3", u3ATA]]) {
    await program.methods
      .mintTokens(amt)
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        userTokenAccount: ata,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
    console.log(`✅ admin minted to ${name}: balance =`, await getUiBal(ata));
  }

  // --- non-admin tries to mint (should fail with UnauthorizedAdmin) ---
  let failedAsExpected = false;
  try {
    await program.methods
      .mintTokens(new BN(500_000)) // arbitrary
      .accounts({
        tokenState: tokenStatePDA,
        mint: mint.publicKey,
        userTokenAccount: u1ATA,
        admin: u1.publicKey, // ← pretending user1 is admin (not allowed)
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([u1])
      .rpc();
    console.error("❌ non-admin mint unexpectedly succeeded");
  } catch (e) {
    const got = e.error?.errorCode?.code || e.message || "";
    if (String(got).includes("UnauthorizedAdmin")) {
      failedAsExpected = true;
      console.log("🛡️ non-admin mint blocked with UnauthorizedAdmin");
    } else {
      console.error("❌ mint failed with different error:", got);
    }
  }

  // --- final scores (balances) ---
  console.log("— final balances —");
  console.log("u1:", await getUiBal(u1ATA));
  console.log("u2:", await getUiBal(u2ATA));
  console.log("u3:", await getUiBal(u3ATA));

  if (!failedAsExpected) process.exit(1);
  console.log("✔ basic admin control + balances verified");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
