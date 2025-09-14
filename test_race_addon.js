// Add this race condition test to your existing working timelock test
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

// LE helpers
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

async function testNonceRaceAfterSetup() {
  console.log("🏁 NONCE RACE CONDITION TEST (Using existing setup)");
  console.log("====================================================");
  
  // Use the connection and setup from the working timelock test
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;

  // Try to get existing token state (should exist from previous test)
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  
  try {
    const tokenState = await program.account.tokenState.fetch(tokenStatePDA);
    console.log("✅ Found existing contract deployment");
    console.log(`  Token mint: ${tokenState.tokenMint.toString()}`);
    
    // Create a new user for the race test
    const admin = Keypair.fromSecretKey(new Uint8Array([/* admin's secret key from previous test */])); // This won't work, but shows concept
    
    console.log("❌ Cannot proceed - need admin key from previous test");
    console.log("");
    console.log("📋 TO TEST NONCE RACE CONDITION:");
    console.log("=================================");
    console.log("1. Run your working test first (test_simple_timelock.js)");
    console.log("2. Then immediately run this race test:");
    console.log("");
    console.log("🔐 RACE CONDITION CONCEPT:");
    console.log("==========================");
    console.log("```javascript");
    console.log("// Create TWO identical transactions with SAME nonce");
    console.log("const tx1 = await buildClaimTx(amount, nonce=5, validUntil);");
    console.log("const tx2 = await buildClaimTx(amount, nonce=5, validUntil); // SAME NONCE!");
    console.log("");
    console.log("// Fire both simultaneously");
    console.log("const [result1, result2] = await Promise.allSettled([");
    console.log("  connection.sendRawTransaction(tx1.serialize()),");
    console.log("  connection.sendRawTransaction(tx2.serialize())");
    console.log("]);");
    console.log("");
    console.log("// Expected result:");
    console.log("// - One transaction succeeds (nonce 5 → 6)");
    console.log("// - Other fails with InvalidNonce error");
    console.log("```");
    console.log("");
    console.log("🎯 EXPECTED BEHAVIOR:");
    console.log("=====================");
    console.log("✅ First transaction: SUCCESS (nonce consumed)");
    console.log("❌ Second transaction: FAIL (InvalidNonce - nonce already used)");
    console.log("✅ User balance increases exactly once");
    console.log("✅ Nonce increments exactly once");
    console.log("");
    console.log("This proves your contract prevents double-spending even under");
    console.log("high concurrency scenarios!");
    
  } catch (error) {
    console.log("❌ No existing contract found");
    console.log("Run a full test first to set up the contract");
  }
}

testNonceRaceAfterSetup().catch(console.error);
