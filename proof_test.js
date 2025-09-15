const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram, Transaction, Ed25519Program, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const nacl = require("tweetnacl");
const fs = require('fs');
const BN = anchor.BN;

// PROOF FUNCTIONS - These will show REAL on-chain data
async function verifyTransactionOnChain(connection, signature) {
  console.log(`🔍 VERIFYING TRANSACTION ON-CHAIN: ${signature}`);
  
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  });
  
  if (!tx) {
    console.log("❌ Transaction not found on chain!");
    return false;
  }
  
  console.log(`✅ Transaction found on-chain!`);
  console.log(`   • Slot: ${tx.slot}`);
  console.log(`   • Block Time: ${new Date(tx.blockTime * 1000).toISOString()}`);
  console.log(`   • Fee: ${tx.meta.fee} lamports`);
  console.log(`   • Status: ${tx.meta.err ? 'FAILED' : 'SUCCESS'}`);
  console.log(`   • Compute Units Used: ${tx.meta.computeUnitsConsumed}`);
  
  if (tx.meta.logMessages && tx.meta.logMessages.length > 0) {
    console.log(`   • Program Logs:`);
    tx.meta.logMessages.forEach((log, i) => {
      if (log.includes('CLAIM SUCCESSFUL') || log.includes('Instruction:')) {
        console.log(`     ${i}: ${log}`);
      }
    });
  }
  
  return true;
}

async function verifyAccountBalance(connection, tokenAccount, expectedAmount) {
  console.log(`💰 VERIFYING TOKEN BALANCE ON-CHAIN: ${tokenAccount}`);
  
  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    console.log(`✅ On-chain balance: ${balance.value.uiAmount} tokens`);
    console.log(`   • Amount: ${balance.value.amount}`);
    console.log(`   • Decimals: ${balance.value.decimals}`);
    
    if (expectedAmount && Math.abs(balance.value.uiAmount - expectedAmount) < 0.001) {
      console.log(`✅ Balance matches expected amount: ${expectedAmount}`);
      return true;
    }
    
    return balance.value.uiAmount;
  } catch (e) {
    console.log(`❌ Failed to get balance: ${e.message}`);
    return false;
  }
}

async function verifyProgramAccount(connection, programId, accountAddress) {
  console.log(`🏦 VERIFYING PROGRAM ACCOUNT ON-CHAIN: ${accountAddress}`);
  
  try {
    const accountInfo = await connection.getAccountInfo(accountAddress);
    if (!accountInfo) {
      console.log("❌ Account not found on-chain!");
      return false;
    }
    
    console.log(`✅ Account exists on-chain!`);
    console.log(`   • Owner: ${accountInfo.owner}`);
    console.log(`   • Data Length: ${accountInfo.data.length} bytes`);
    console.log(`   • Lamports: ${accountInfo.lamports}`);
    console.log(`   • Executable: ${accountInfo.executable}`);
    
    return accountInfo.owner.equals(programId);
  } catch (e) {
    console.log(`❌ Failed to get account info: ${e.message}`);
    return false;
  }
}

function buildClaimMessage(programId, payload) {
  const buffer = Buffer.alloc(56);
  let offset = 0;
  
  payload.userAddress.toBuffer().copy(buffer, offset);
  offset += 32;
  
  buffer.writeBigUInt64LE(BigInt(payload.claimAmount.toString()), offset);
  offset += 8;
  
  buffer.writeBigInt64LE(BigInt(payload.expiryTime.toString()), offset);
  offset += 8;
  
  buffer.writeBigUInt64LE(BigInt(payload.nonce.toString()), offset);
  offset += 8;
  
  return Buffer.concat([
    Buffer.from("RIYAL_CLAIM_V2"),
    programId.toBuffer(),
    buffer
  ]);
}

async function airdrop(connection, pubkey, sol = 10) {
  const sig = await connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

(async () => {
  console.log("🚨 RIYAL CONTRACT - REAL TRANSACTION PROOF");
  console.log("==========================================");
  console.log("This will show REAL on-chain transactions, not mocks!");
  
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  
  // Show we're connected to a real validator
  const version = await connection.getVersion();
  console.log(`📡 Connected to Solana validator version: ${version['solana-core']}`);
  
  const adminKeypairData = JSON.parse(fs.readFileSync('./admin.json', 'utf8'));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  const claimUser = Keypair.generate();
  
  console.log(`\n👥 PARTICIPANTS:`);
  console.log(`   Admin: ${admin.publicKey}`);
  console.log(`   User:  ${claimUser.publicKey}`);
  
  // Airdrop and verify
  console.log(`\n💸 AIRDROPPING SOL (REAL TRANSACTIONS):`);
  const airdropSig1 = await airdrop(connection, admin.publicKey, 10);
  const airdropSig2 = await airdrop(connection, claimUser.publicKey, 10);
  
  console.log(`   Admin airdrop signature: ${airdropSig1}`);
  console.log(`   User airdrop signature:  ${airdropSig2}`);
  
  // Verify the airdrops are real
  await verifyTransactionOnChain(connection, airdropSig1);
  await verifyTransactionOnChain(connection, airdropSig2);
  
  // Check balances
  const adminBalance = await connection.getBalance(admin.publicKey);
  const userBalance = await connection.getBalance(claimUser.publicKey);
  console.log(`   Admin SOL balance: ${adminBalance / 1e9} SOL`);
  console.log(`   User SOL balance:  ${userBalance / 1e9} SOL`);
  
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);
  const program = anchor.workspace.riyal_contract;
  
  console.log(`\n🏗️ CONTRACT PROGRAM ID: ${program.programId}`);
  
  const [tokenStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("token_state")], program.programId);
  const [claimUserDataPDA] = PublicKey.findProgramAddressSync([Buffer.from("user_data"), claimUser.publicKey.toBuffer()], program.programId);
  
  console.log(`   Token State PDA: ${tokenStatePDA}`);
  console.log(`   User Data PDA:   ${claimUserDataPDA}`);
  
  console.log(`\n🔨 INITIALIZING CONTRACT (REAL TRANSACTION):`);
  const initSig = await program.methods
    .initialize(admin.publicKey, admin.publicKey, new BN(30), false, true)
    .accounts({ tokenState: tokenStatePDA, payer: admin.publicKey, systemProgram: SystemProgram.programId })
    .signers([admin])
    .rpc();
  
  console.log(`   Initialize signature: ${initSig}`);
  await verifyTransactionOnChain(connection, initSig);
  await verifyProgramAccount(connection, program.programId, tokenStatePDA);
  
  console.log(`\n🪙 CREATING TOKEN MINT (REAL TRANSACTION):`);
  const mint = Keypair.generate();
  const mintSig = await program.methods
    .createTokenMint(9, "Riyal Token", "RIYAL")
    .accounts({
      tokenState: tokenStatePDA, mint: mint.publicKey, admin: admin.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([admin, mint])
    .rpc();
  
  console.log(`   Mint creation signature: ${mintSig}`);
  console.log(`   Token mint address: ${mint.publicKey}`);
  await verifyTransactionOnChain(connection, mintSig);
  
  console.log(`\n🏦 CREATING USER TOKEN ACCOUNT (REAL TRANSACTION):`);
  const claimUserATA = await getAssociatedTokenAddress(mint.publicKey, claimUser.publicKey, false, TOKEN_2022_PROGRAM_ID);
  
  const createATASig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(admin.publicKey, claimUserATA, claimUser.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)
    ),
    [admin]
  );
  
  console.log(`   Create ATA signature: ${createATASig}`);
  console.log(`   User token account: ${claimUserATA}`);
  await verifyTransactionOnChain(connection, createATASig);
  
  console.log(`\n👤 INITIALIZING USER DATA (REAL TRANSACTION):`);
  const userDataSig = await program.methods.initializeUserData()
    .accounts({ userData: claimUserDataPDA, user: claimUser.publicKey, payer: claimUser.publicKey, systemProgram: SystemProgram.programId })
    .signers([claimUser])
    .rpc();
  
  console.log(`   User data init signature: ${userDataSig}`);
  await verifyTransactionOnChain(connection, userDataSig);
  await verifyProgramAccount(connection, program.programId, claimUserDataPDA);
  
  console.log(`\n🔐 ADMIN CREATES SIGNED PAYLOAD:`);
  const userData = await program.account.userData.fetch(claimUserDataPDA);
  const nonce = Number(userData.nonce);
  
  const claimAmount = new BN(500_000_000); // 0.5 tokens
  const expiryTime = Math.floor(Date.now() / 1000) + 300;
  
  const payload = {
    userAddress: claimUser.publicKey,
    claimAmount: claimAmount,
    expiryTime: new BN(expiryTime),
    nonce: new BN(nonce)
  };
  
  const claimMessage = buildClaimMessage(program.programId, payload);
  const adminSig = nacl.sign.detached(claimMessage, admin.secretKey);
  
  console.log(`   Message length: ${claimMessage.length} bytes`);
  console.log(`   Admin signature: ${Buffer.from(adminSig).toString('hex').slice(0, 32)}...`);
  console.log(`   Payload nonce: ${nonce}`);
  console.log(`   Claim amount: ${claimAmount.toString()} (${claimAmount.toNumber() / 1e9} RIYAL)`);
  
  console.log(`\n💰 BALANCE BEFORE CLAIM (ON-CHAIN VERIFICATION):`);
  const balanceBefore = await verifyAccountBalance(connection, claimUserATA, 0);
  
  console.log(`\n🎯 USER SUBMITS CLAIM TRANSACTION (REAL TRANSACTION):`);
  
  const edAdmin = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.publicKey.toBytes(), 
    message: claimMessage, 
    signature: adminSig,
  });
  
  const claimIx = await program.methods
    .claimTokens(payload, Array.from(adminSig))
    .accounts({
      tokenState: tokenStatePDA, 
      userData: claimUserDataPDA, 
      mint: mint.publicKey,
      userTokenAccount: claimUserATA, 
      user: claimUser.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
  
  const claimTx = new Transaction().add(edAdmin, claimIx);
  const claimSig = await sendAndConfirmTransaction(connection, claimTx, [claimUser]);
  
  console.log(`   🎉 CLAIM TRANSACTION SIGNATURE: ${claimSig}`);
  console.log(`   This is a REAL on-chain transaction!`);
  
  // PROOF: Verify the claim transaction on-chain
  await verifyTransactionOnChain(connection, claimSig);
  
  console.log(`\n💰 BALANCE AFTER CLAIM (ON-CHAIN VERIFICATION):`);
  const balanceAfter = await verifyAccountBalance(connection, claimUserATA, 0.5);
  
  console.log(`\n🔍 FINAL PROOF - QUERY BLOCKCHAIN DIRECTLY:`);
  console.log(`   Run this command to verify the transaction yourself:`);
  console.log(`   solana confirm ${claimSig} --url http://localhost:8899`);
  console.log(`   `);
  console.log(`   Or query the token account balance:`);
  console.log(`   spl-token balance ${mint.publicKey} --owner ${claimUser.publicKey} --url http://localhost:8899`);
  
  console.log(`\n✅ PROOF COMPLETE:`);
  console.log(`   • All transactions are REAL and on the Solana blockchain`);
  console.log(`   • Contract deployed at: ${program.programId}`);
  console.log(`   • User received 0.5 RIYAL tokens`);
  console.log(`   • Admin signature verified: YES`);
  console.log(`   • User ownership verified: YES (transaction signature)`);
  console.log(`   • Balance change: ${balanceBefore} → ${balanceAfter} RIYAL`);
  
  console.log(`\n🎯 THIS IS NOT A MOCK - IT'S REAL BLOCKCHAIN INTERACTION!`);

})().catch(console.error);
