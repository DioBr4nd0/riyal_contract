# MERCLE TOKEN - DEPLOYMENT & TESTING GUIDE

## 🚀 Complete Deployment & Testing Script

The `deploy_and_test_complete.js` script handles everything you need:

### Features Tested
- ✅ **Contract Deployment** - Deploys to any network
- ✅ **Token Mint Creation** - Creates professional MERCLE token
- ✅ **Signature-Based Claims** - Tests admin-signed token claims
- ✅ **Replay Attack Prevention** - Verifies nonce-based security
- ✅ **Treasury Operations** - Tests minting and burning from treasury
- ✅ **Freeze/Unfreeze** - Tests account freezing controls
- ✅ **Token Transfers** - Tests user-to-user transfers
- ✅ **Private Key Logging** - Prints all test account keys for verification

### Security Verified
- 🔐 **Admin Signature Verification** - Ed25519 cryptographic verification
- 🛡️ **Nonce-Based Replay Protection** - Prevents duplicate claims
- 👤 **Account Ownership Validation** - Users can only claim to their own accounts
- ❄️ **Freeze Authority Control** - Admin can freeze, users can unfreeze after transfers enabled

## 📋 Usage

### Deploy to Devnet (Recommended for Testing)
```bash
node deploy_and_test_complete.js devnet
```

### Deploy to Local Validator
```bash
# Start local validator first
solana-test-validator

# Then deploy
node deploy_and_test_complete.js local
```

### Deploy to Mainnet (Production)
```bash
node deploy_and_test_complete.js mainnet-beta
```

## 🔧 Configuration

Edit the script to customize:

```javascript
// Test configuration
const TEST_ACCOUNTS_COUNT = 3;        // Number of test accounts
const CLAIM_AMOUNT_TOKENS = 1000;     // Tokens per claim
const TREASURY_MINT_AMOUNT = 1000000; // Initial treasury supply
const BURN_TEST_AMOUNT = 100;         // Amount to burn in test

// Admin key location
const ADMIN_KEY_SOURCE = "/Users/mercle/.config/solana/id.json";
```

## 📊 Expected Output

The script will:

1. **Load Admin** - From your Solana CLI keypair
2. **Deploy Contract** - Or use existing deployment
3. **Create Token Mint** - Professional "Mercle Token" (MERCLE)
4. **Generate Test Accounts** - With printed private keys
5. **Fund Accounts** - With SOL for transaction fees
6. **Test All Features** - Comprehensive functionality testing
7. **Print Results** - Success/failure status for each test

## 🔑 Private Keys

The script prints private keys for all generated test accounts:

```
🔑 Test Account 1:
  Public Key:  H8wxHGy8txR1qdcgK6PGkL2PriawdGka7oyixhB25UZB
  Private Key: [34,92,98,33,23,251,255,200,223,130,89,55,101,104,186,140,...]
```

Use these for manual verification:
```bash
# Check SOL balance
solana balance <public_key> --url devnet

# Check token balance
spl-token balance <token_mint> --owner <public_key> --url devnet

# Import to wallet (use private key array)
solana-keygen recover prompt:// --outfile test-account.json
```

## 🌐 Network URLs

- **Local**: `http://127.0.0.1:8899`
- **Devnet**: `https://api.devnet.solana.com`
- **Mainnet**: `https://api.mainnet-beta.solana.com`

## 📈 Success Metrics

A successful run shows:
- ✅ **100% Success Rate** for all tests
- ✅ **Replay Attack Prevention** working
- ✅ **Token Accounts Frozen** after claims
- ✅ **Treasury Operations** functioning
- ✅ **Transfers Working** after unfreeze

## 🚨 Troubleshooting

### Common Issues

1. **"Admin keypair not found"**
   - Ensure Solana CLI is configured: `solana config get`
   - Generate keypair: `solana-keygen new`

2. **"Insufficient SOL balance"**
   - Fund admin account: `solana airdrop 2 --url devnet`

3. **"Contract already initialized"**
   - Normal behavior - script handles existing deployments

4. **"Treasury already exists"**
   - Normal behavior - script continues with existing treasury

### Network Issues

- **Local validator not running**: Start with `solana-test-validator`
- **Devnet rate limits**: Wait and retry
- **Mainnet costs**: Ensure sufficient SOL for deployment

## 🎯 Production Deployment

For mainnet deployment:

1. **Fund Admin Account** with sufficient SOL
2. **Review Configuration** in the script
3. **Run Full Test** on devnet first
4. **Deploy to Mainnet**: `node deploy_and_test_complete.js mainnet-beta`
5. **Verify All Features** work as expected

## 📋 Contract Details

- **Program ID**: `DUALvp1DCViwVuWYPF66uPcdwiGXXLSW1pPXcAei3ihK`
- **Token Name**: "Mercle Token"
- **Token Symbol**: "MERCLE"
- **Decimals**: 9
- **Features**: Signature claims, freezing, treasury, transfers

## 🔗 Verification

After deployment, verify on Solana Explorer:
- **Devnet**: `https://explorer.solana.com/?cluster=devnet`
- **Mainnet**: `https://explorer.solana.com/`

Search for your program ID and token mint to verify deployment success.
