const { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const fs = require('fs');

// Base58 decode
function base58Decode(s) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP[ALPHABET[i]] = i;
  }
  let bytes = [];
  let carry, j;
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] in ALPHABET_MAP)) throw new Error('Invalid base58 character');
    carry = ALPHABET_MAP[s[i]];
    for (j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

(async () => {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const base58Key = fs.readFileSync("./acc.json", 'utf8').trim();
  const from = Keypair.fromSecretKey(base58Decode(base58Key));
  const to = new PublicKey("E3SNDSxHdXqjZ3GwDh3BLV4TfncX2n6qqdXPrQM1HeeP");
  
  console.log(`Transferring 2 SOL from ${from.publicKey.toString()} to ${to.toString()}`);
  
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: 2 * LAMPORTS_PER_SOL
    })
  );
  
  tx.feePayer = from.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(from);
  
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig);
  
  console.log(`✅ Transfer complete: ${sig}`);
})();

