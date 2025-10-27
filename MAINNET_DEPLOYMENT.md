# 🎉 MERCLE TOKEN - MAINNET DEPLOYMENT SUCCESS

**Deployment Date:** October 27, 2025  
**Network:** Solana Mainnet Beta

---

## 📊 CONTRACT ADDRESSES

### Core Addresses
- **Program ID:** `HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts`
- **Token Mint:** `5HCsUuCDLY5VhVjZD6A3fJw3poJ4b6q7HESh8FWLCFFw`
- **Admin:** `9YGqfnrTuaSdN6rts4H9AKwZKp4xfNwJyUGBCfKniiqw`

### PDAs (Program Derived Addresses)
- **Token State PDA:** `GG5DPRRBz8GiZ5C7Y4MF7q9842GfQFSLsS5aMDaY2uVV`
- **Metadata PDA:** `Axs7927HmxRyUE8dmhe7JZQgNohogZnsfenM5pN4DGgc`
- **Treasury:** `E3Cz5VngTYuRSgYfGyEaJweiKU4uytxKwDthUcRguBiw`

---

## 🪙 TOKEN DETAILS

- **Name:** MERCI POINTS
- **Symbol:** MERCI
- **Decimals:** 9
- **Metadata URI:** https://ipfs.io/ipfs/bafkreic766ldkvoasmccfoxk65obzjz7z7ae26qaldtqvcjooac3n7vbty
- **Image URI:** https://ipfs.io/ipfs/bafkreibnylqsvmn4fssrbkcaz5lkqo3y4srfc7nxmskslj4xohqydxh6ju

---

## ⚙️ CONTRACT CONFIGURATION

- **Claim Delay:** 300 seconds (5 minutes)
- **Timelock Enabled:** ✅ Yes
- **Transfers Enabled:** ❌ No (must be enabled by admin)
- **Upgradeable:** ✅ Yes
- **Upgrade Authority:** `9YGqfnrTuaSdN6rts4H9AKwZKp4xfNwJyUGBCfKniiqw`

---

## 💰 DEPLOYMENT COSTS

- **Starting Balance:** 4.707 SOL
- **Final Balance:** 1.143 SOL
- **Total Cost:** ~3.564 SOL
  - Program Deployment: ~3.543 SOL
  - Contract Initialization: ~0.002 SOL
  - Token Mint Creation: ~0.002 SOL
  - Mint Authority Transfer: ~0.0001 SOL
  - Metadata Creation: ~0.01 SOL
  - Treasury Creation: ~0.007 SOL

---

## 📋 DEPLOYMENT TRANSACTIONS

| Step | Transaction Signature |
|------|----------------------|
| Program Deploy | `4cTxj8qmK2umyt4Me1zzsidp1DWmX6Hd3Q62a2QQchqUfhykDQqfqR6CGVpszzsKTzTkhdv4DCwAGpU5c3dDKQb9` |
| Initialize | `4a7b1S8Lxs7PjoMhk8VHV2PVWZuh8UN8UfxwM1xGkFuyKBpGtz6gY3MW3PVeHX6gXJcDj1GkjhK27hQtbSSuqFVM` |
| Create Mint | `3AfaRdXPUU6rDMorThKAHaTwzuUp2EPUszzw4pZLfNk4TMtN1DmtBDWo8LJYA3ToRF9SLPiYG43ZnmkhB5GJY1fX` |
| Transfer Authority | `2AYjhHuUJLQyQT5JYvKKmuTWNB6VSrxB9r52UAzrdbTxfN2XKSz8NwSS2qDG8yizQYhAvZ1Ai9u4k2a4oqB7ptuM` |
| Create Metadata | `vxPCNVgd1C9rWf1hP1kk1n4BgSZWr8FRgQureFjN5Jrynm3ko84Y1etLXH38XZk2sma2qb6frEismVfPVZjUjnH` |
| Create Treasury | `4BxYQDfUzD27cFpjBiTdWUkm6cWTxWvLECzdSz7jCpKo75kFrJmf1RBPm5tBrDw61R9SRVCtnqnPXhkrpvQgfa9G` |

---

## 🔗 EXPLORER LINKS

### Solscan (Mainnet)
- **Program:** https://solscan.io/account/HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts
- **Token Mint:** https://solscan.io/token/5HCsUuCDLY5VhVjZD6A3fJw3poJ4b6q7HESh8FWLCFFw
- **Admin:** https://solscan.io/account/9YGqfnrTuaSdN6rts4H9AKwZKp4xfNwJyUGBCfKniiqw

### Solana Explorer
- **Program:** https://explorer.solana.com/address/HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts
- **Token Mint:** https://explorer.solana.com/address/5HCsUuCDLY5VhVjZD6A3fJw3poJ4b6q7HESh8FWLCFFw
- **Admin:** https://explorer.solana.com/address/9YGqfnrTuaSdN6rts4H9AKwZKp4xfNwJyUGBCfKniiqw

---

## 🔐 SECURITY FEATURES

✅ **Anti-Replay Protection** - Nonce-based claim system  
✅ **Admin Authorization** - Ed25519 signature verification  
✅ **Rate Limiting** - 5-minute timelock between claims  
✅ **Transfer Lock** - Accounts frozen by default  
✅ **Overflow Protection** - Checked math everywhere  
✅ **Domain Separation** - Signatures include program ID + version  
✅ **Access Control** - Admin-only functions properly protected  
✅ **String Validation** - Name ≤32 chars, Symbol ≤16 chars  

---

## ✅ TESTING RESULTS

### Stress Tests (4/4 Passed)
- ✅ Concurrent Claims (Race Condition Protection)
- ✅ Rapid Successive Claims (Timelock Enforcement)
- ✅ High Volume Multi-User (5 users)
- ✅ Transaction Spam Prevention

### Edge Case Tests (5/5 Passed)
- ✅ Maximum U64 Value Claim
- ✅ Message Tampering
- ✅ Wrong Token Account Owner
- ✅ Nonce Overflow Attempt
- ✅ Zero Signature Attempt

---

## 🚀 NEXT STEPS

1. **Verify Token on Explorers**
   - Check that logo appears correctly
   - Verify metadata is displayed

2. **Test Claiming Flow**
   - Create test signatures
   - Verify 5-minute timelock
   - Confirm accounts are frozen after claims

3. **Monitor Contract**
   - Watch for any unexpected behavior
   - Track claim activity

4. **When Ready to Enable Transfers**
   - Call `enable_transfers()` function
   - **WARNING:** This is PERMANENT and cannot be reversed!

---

## 📞 ADMIN FUNCTIONS

| Function | Access | Purpose |
|----------|--------|---------|
| `initialize` | Deployer Only | One-time setup |
| `create_token_mint` | Admin Only | Create token mint |
| `update_token_mint` | Admin Only | Update token details |
| `transfer_mint_authority_to_pda` | Admin Only | Transfer mint control |
| `create_metadata` | Admin Only | Create Metaplex metadata |
| `create_treasury` | Admin Only | Create treasury account |
| `update_time_lock` | Admin Only | Change claim delay settings |
| `enable_transfers` | Admin Only | Enable transfers (PERMANENT) |
| `set_upgrade_authority` | Admin Only | Change upgrade authority |
| `validate_upgrade` | Admin Only | Validate upgrade operations |
| `update_admin` | Admin Only | Transfer admin role |

---

## 🎯 CONTRACT READY FOR PRODUCTION! 

**Total Development & Testing Time:** Comprehensive  
**Total Bugs Fixed:** All resolved  
**Security Audit Status:** Self-audited, all tests passed  
**Deployment Status:** ✅ LIVE ON MAINNET

---

*Deployed by Mercle Team*  
*Contract Version: 1.0*  
*Network: Solana Mainnet Beta*

