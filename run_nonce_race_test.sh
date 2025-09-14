#!/bin/bash

echo "🏁 RIYAL CONTRACT - NONCE RACE CONDITION TEST"
echo "=============================================="
echo "This script will:"
echo "1. Reset validator and deploy fresh contract"
echo "2. Setup accounts and do one successful claim"
echo "3. Fire TWO identical transactions with SAME nonce"
echo "4. Verify only ONE succeeds (double-spend prevention)"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Step 1: Resetting validator and rebuilding...${NC}"
pkill solana-test-validator
sleep 3
solana-test-validator --reset --quiet &
sleep 8

anchor build
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed!${NC}"
    exit 1
fi

anchor deploy
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Deploy failed!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Contract deployed fresh${NC}"

echo -e "${BLUE}Step 2: Running nonce race condition test...${NC}"
echo -e "${YELLOW}⚠️  This will test concurrent double-spend prevention${NC}"

# Create the race test inline
cat > temp_race_test.js << 'EOF'
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, Ed25519Program
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");

const u64le = (x) => { const b=new ArrayBuffer(8); new DataView(b).setBigUint64(0, BigInt(x), true); return Buffer.from(b); };
const i64le = (x) => { const b=new ArrayBuffer(8); new DataView(b).setBigInt64(0, BigInt(x), true);  return Buffer.from(b); };

function buildClaimBytes(programId, tokenStatePDA, mint, user, dest, amount, nonce, validUntil) {
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V1"),
    programId.toBuffer(),
    tokenStatePDA.toBuffer(),
    mint.toBuffer(),
    user.toBuffer(),
    dest.toBuffer(),
    u64le(amount),
    u64le(nonce),
    i64le(validUntil),
  ]);
}

(async () => {
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const admin = Keypair.generate();
  const user = Keypair.generate();
  
  // Fund
  for (const k of [admin, user]) {
    await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
  }
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [userDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), user.publicKey.toBuffer()], program.programId);
  const mint = Keypair.generate();

  // Quick setup
  await program.methods
    .initialize(admin.publicKey, admin.publicKey, new anchor.BN(3600), false, true)
    .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
    .signers([admin]).rpc();

  await program.methods
    .createTokenMint(9, "Riyal", "RIYAL")
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin, mint]).rpc();

  const userATA = await getAssociatedTokenAddress(mint.publicKey, user.publicKey);
  await connection.sendTransaction(
    new Transaction().add(createAssociatedTokenAccountInstruction(admin.publicKey, userATA, user.publicKey, mint.publicKey)),
    [admin]
  );

  const initTx = new Transaction().add(
    await program.methods
      .initializeUserData()
      .accounts({ userData: userDataPDA, user: user.publicKey, systemProgram: SystemProgram.programId })
      .instruction()
  );
  initTx.feePayer = admin.publicKey;
  initTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  initTx.partialSign(admin, user);
  const initSig = await connection.sendRawTransaction(initTx.serialize());
  await connection.confirmTransaction(initSig);

  console.log("✅ Setup complete");

  // Get current nonce
  const userData = await program.account.userData.fetch(userDataPDA);
  const currentNonce = Number(userData.nonce);
  console.log(`📊 Current nonce: ${currentNonce}`);

  // Create IDENTICAL race transactions
  const claimAmount = 1_000_000_000;
  const validUntil = Math.floor(Date.now()/1000) + 60;

  async function buildRaceTx() {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    const msg = buildClaimBytes(program.programId, tokenStatePDA, tokenState.tokenMint, user.publicKey, userATA, claimAmount, currentNonce, validUntil);
    const sigUser = nacl.sign.detached(msg, user.secretKey);
    const sigAdmin = nacl.sign.detached(msg, admin.secretKey);
    const edU = Ed25519Program.createInstructionWithPublicKey({ publicKey: user.publicKey.toBytes(), message: msg, signature: sigUser });
    const edA = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.publicKey.toBytes(), message: msg, signature: sigAdmin });
    const claimIx = await program.methods
      .claimTokens(new anchor.BN(claimAmount), new anchor.BN(currentNonce), new anchor.BN(validUntil), Array.from(sigUser), Array.from(sigAdmin))
      .accounts({
        tokenState: tokenStatePDA, userData: userDataPDA, mint: mint.publicKey,
        userTokenAccount: userATA, user: user.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      }).instruction();
    return new Transaction().add(edU).add(edA).add(claimIx);
  }

  const tx1 = await buildRaceTx();
  const tx2 = await buildRaceTx();

  console.log(`🏁 FIRING RACE: Two transactions with SAME nonce=${currentNonce}`);

  // Fire both simultaneously
  const startTime = Date.now();
  const [result1, result2] = await Promise.allSettled([
    (async () => {
      tx1.feePayer = admin.publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx1.sign(admin);
      return connection.sendRawTransaction(tx1.serialize(), { skipPreflight: false });
    })(),
    (async () => {
      tx2.feePayer = admin.publicKey;
      tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx2.sign(admin);
      return connection.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
    })()
  ]);

  console.log(`⏱️  Race completed in ${Date.now() - startTime}ms`);

  // Check send results
  const sig1 = result1.status === 'fulfilled' ? result1.value : null;
  const sig2 = result2.status === 'fulfilled' ? result2.value : null;
  const err1 = result1.status === 'rejected' ? result1.reason.message : null;
  const err2 = result2.status === 'rejected' ? result2.reason.message : null;

  console.log(`TX1 sent: ${sig1 ? '✅' : '❌'} ${err1 ? err1.substring(0,50) : ''}`);
  console.log(`TX2 sent: ${sig2 ? '✅' : '❌'} ${err2 ? err2.substring(0,50) : ''}`);

  // Confirm both
  let confirmed1 = false, confirmed2 = false;
  
  if (sig1) {
    try {
      await connection.confirmTransaction(sig1);
      confirmed1 = true;
    } catch (e) {
      console.log(`TX1 confirmation failed: ${e.message.substring(0,50)}`);
    }
  }
  
  if (sig2) {
    try {
      await connection.confirmTransaction(sig2);
      confirmed2 = true;
    } catch (e) {
      console.log(`TX2 confirmation failed: ${e.message.substring(0,50)}`);
    }
  }

  // Final state
  const finalData = await program.account.userData.fetch(userDataPDA);
  const finalBalance = await connection.getTokenAccountBalance(userATA);
  
  console.log("\n📊 RACE RESULTS:");
  console.log("=================");
  console.log(`Confirmed transactions: ${(confirmed1?1:0) + (confirmed2?1:0)}`);
  console.log(`Final nonce: ${currentNonce} → ${Number(finalData.nonce)}`);
  console.log(`Final balance: ${finalBalance.value.uiAmount} RRIYAL`);

  const successCount = (confirmed1 ? 1 : 0) + (confirmed2 ? 1 : 0);
  
  if (successCount === 1) {
    console.log("\n🎉 SECURITY SUCCESS!");
    console.log("✅ Exactly ONE transaction confirmed");
    console.log("✅ Nonce race condition properly handled");
    console.log("✅ Double-spend attack PREVENTED");
  } else if (successCount === 2) {
    console.log("\n🚨 SECURITY FAILURE!");
    console.log("❌ BOTH transactions confirmed");
    console.log("❌ Double-spend attack POSSIBLE");
  } else {
    console.log("\n⚠️  Both failed - check logs");
  }

})().catch(console.error);
EOF

node temp_race_test.js

# Cleanup
rm temp_race_test.js

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎯 NONCE RACE CONDITION TEST COMPLETED!${NC}"
else
    echo ""
    echo -e "${RED}❌ Nonce race test failed${NC}"
    exit 1
fi
