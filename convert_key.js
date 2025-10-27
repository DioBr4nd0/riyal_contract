const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const fs = require('fs');

const base58Key = process.argv[2];

try {
  const decoded = bs58.decode(base58Key);
  const keypairArray = Array.from(decoded);
  
  fs.writeFileSync('mainnet_deployer.json', JSON.stringify(keypairArray));
  
  console.log('✅ Keypair saved to mainnet_deployer.json');
  console.log(`Public Key: ${require('@solana/web3.js').Keypair.fromSecretKey(decoded).publicKey.toString()}`);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

