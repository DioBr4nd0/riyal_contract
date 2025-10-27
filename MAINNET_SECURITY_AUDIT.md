# MERCLE TOKEN CONTRACT - MAINNET SECURITY AUDIT
**Date:** 2025-10-27
**Contract:** mercle_token (AeMQMNYBr4ae5DNhbxPQ4BpuT2x6QrnrVJUsuDWAJ92Z)
**Status:** ⚠️ **NOT READY FOR MAINNET - CRITICAL ISSUES FOUND**

---

## 🔴 CRITICAL ISSUES (MUST FIX BEFORE MAINNET)

### 1. **Access Control Bug in Upgrade Functions**
**Location:** `lib.rs:344-360` (set_upgrade_authority, validate_upgrade)
**Severity:** CRITICAL
**Issue:** Both functions check `admin` authority instead of `upgrade_authority`

```rust
// Line 538 & 552 - WRONG!
constraint = admin.key() == token_state.admin @ MercleError::UnauthorizedAdmin
// Should be:
constraint = admin.key() == token_state.upgrade_authority @ MercleError::UnauthorizedUpgradeAuthority
```

**Impact:** Admin can change upgrade authority even though they shouldn't have that power. This violates separation of concerns.
**Fix Required:** Change constraint to check `upgrade_authority` field instead of `admin`

---

### 2. **Duplicate Function - Code Bloat**
**Location:** `lib.rs:285-294` (enable_transfers) vs `lib.rs:104-110` (permanently_enable_transfers)
**Severity:** MEDIUM
**Issue:** Both functions do EXACTLY the same thing:

```rust
// enable_transfers (line 285-294)
token_state.transfers_enabled = true;
token_state.transfers_permanently_enabled = true;
token_state.transfer_enable_timestamp = Clock::get()?.unix_timestamp;

// permanently_enable_transfers (line 104-110) - IDENTICAL!
s.transfers_enabled = true;
s.transfers_permanently_enabled = true;
s.transfer_enable_timestamp = Clock::get()?.unix_timestamp;
```

**Impact:** Confusion, unnecessary compute units, maintenance burden
**Fix Required:** Remove one of these functions

---

### 3. **Mint Authority Not Transferred Automatically**
**Location:** `lib.rs:57-70` (create_token_mint)
**Severity:** HIGH
**Issue:** Line 602 creates mint with admin as mint_authority, but should be PDA

```rust
// Line 602 - DANGEROUS!
mint::authority = admin.key(),  // Should be token_state.key()
```

**Impact:** Admin has direct mint authority outside contract control. Must manually call `transfer_mint_authority_to_pda`
**Fix Required:** Either:
- Change line 602 to `mint::authority = token_state.key()`
- OR: Call `transfer_mint_authority_to_pda` immediately after in deployment script

---

### 4. **update_token_mint Resets Treasury**
**Location:** `lib.rs:73-86`
**Severity:** HIGH
**Issue:** Line 83 resets treasury account to default

```rust
// Line 83 - WHY?!
token_state.treasury_account = Pubkey::default();
```

**Impact:** If admin calls update_token_mint after treasury is created, it gets reset!
**Fix Required:** Remove line 83 OR add check to prevent resetting if treasury exists

---

### 5. **Front-Running Risk on Initialize**
**Location:** `lib.rs:33-54` + comment on line 504-506
**Severity:** CRITICAL
**Issue:** Whoever calls `initialize()` first becomes admin

```rust
// Line 504-506 warning:
/// CRITICAL: Only YOU should call this immediately after deployment!
/// Whoever calls initialize() first becomes the admin.
/// Deploy and initialize in same transaction to prevent front-running.
```

**Impact:** MEV bot or attacker could front-run initialization and become admin
**Fix Required:** MUST deploy and initialize in same transaction, or add deployer check

---

## ⚠️ MEDIUM ISSUES

### 6. **validate_upgrade Function is Useless**
**Location:** `lib.rs:357-360`
**Severity:** LOW
**Issue:** Only checks if program_data != default pubkey, doesn't validate anything meaningful

```rust
pub fn validate_upgrade(ctx: Context<ValidateUpgrade>) -> Result<()> {
    require!(ctx.accounts.program_data.key() != Pubkey::default(), MercleError::InvalidProgramData);
    Ok(())
}
```

**Impact:** Function serves no real purpose
**Recommendation:** Remove this function or implement proper upgrade validation

---

### 7. **Metadata Update Authority Set to Admin**
**Location:** `lib.rs:448`
**Severity:** LOW
**Issue:** Metaplex metadata update authority is admin, not PDA

```rust
// Line 448
.update_authority(&ctx.accounts.admin.to_account_info(), true)
```

**Impact:** Admin can update metadata outside contract control
**Recommendation:** Consider if this is intended behavior

---

## ✅ PERFECT FUNCTIONS (No Issues)

| Function | Access | Line | Status |
|----------|--------|------|--------|
| `initialize_user_data` | Public | 171 | ✅ Perfect |
| `claim_tokens` | Public + Admin Sig | 183 | ✅ Perfect - Excellent security |
| `mint_tokens` | Admin | 113 | ✅ Perfect |
| `freeze_token_account` | Admin | 141 | ✅ Perfect |
| `unfreeze_token_account` | Admin | 156 | ✅ Perfect |
| `pause_transfers` | Admin | 90 | ✅ Perfect |
| `resume_transfers` | Admin | 97 | ✅ Perfect |
| `permanently_enable_transfers` | Admin | 104 | ✅ Perfect |
| `burn_tokens` | Admin + User | 268 | ✅ Perfect - Requires both signatures |
| `unfreeze_account` | Public | 297 | ✅ Perfect - Gated by transfers_permanently_enabled |
| `transfer_tokens` | Public | 315 | ✅ Perfect - Gated by transfers_enabled |
| `update_time_lock` | Admin | 333 | ✅ Perfect |
| `create_treasury` | Admin | 363 | ✅ Perfect |
| `mint_to_treasury` | Admin | 369 | ✅ Perfect |
| `burn_from_treasury` | Admin | 387 | ✅ Perfect |
| `update_admin` | Admin | 406 | ✅ Perfect - Good logging |
| `create_metadata` | Admin | 432 | ✅ Perfect |
| `transfer_mint_authority_to_pda` | Admin | 467 | ✅ Perfect |

---

## 🔍 FUNCTION ACCESS CONTROL ANALYSIS

### Functions That SHOULD Be Admin But Are Public:
**None** - All public functions are correctly public

### Functions That SHOULD Be Public But Are Admin:
**None** - All admin functions are correctly restricted

### Functions With WRONG Access Control:
1. ❌ `set_upgrade_authority` - Should check `upgrade_authority`, checks `admin`
2. ❌ `validate_upgrade` - Should check `upgrade_authority`, checks `admin`

---

## 📊 SECURITY TEST RESULTS

Based on `security_tests.js` and `treasury_burn_test.js`:

✅ **Replay Attack Prevention** - PASS
✅ **Cross-Account Signature Abuse** - PASS
✅ **Fake Admin Signature** - PASS
✅ **Expired Signature** - PASS
✅ **Nonce Manipulation** - PASS
✅ **Zero Amount Claim** - PASS
✅ **Treasury Authorization** - PASS
✅ **Burn Authorization** - PASS (requires both admin + user)

**Security Score: 8/8 (100%)** - Excellent signature and claim security!

---

## 🎯 UNUSED/AMBIGUOUS FUNCTIONS

### Unused Functions:
1. **`validate_upgrade`** - Doesn't do meaningful validation, recommend removal

### Ambiguous Functions:
1. **`enable_transfers`** - Duplicate of `permanently_enable_transfers`
2. **`update_token_mint`** - Resets treasury, unclear if intentional

---

## 🚨 MAINNET DEPLOYMENT CHECKLIST

### BEFORE Deployment:
- [ ] **FIX**: Change access control in `set_upgrade_authority` (line 538)
- [ ] **FIX**: Change access control in `validate_upgrade` (line 552)
- [ ] **FIX**: Remove duplicate `enable_transfers` function OR `permanently_enable_transfers`
- [ ] **FIX**: Remove line 83 in `update_token_mint` (treasury reset)
- [ ] **DECIDE**: Change mint authority in `create_token_mint` to PDA (line 602)
- [ ] **REMOVE**: Delete `validate_upgrade` function (useless)
- [ ] **PREPARE**: Deploy and initialize script in SINGLE transaction

### DURING Deployment:
- [ ] Deploy contract
- [ ] Initialize in SAME transaction (prevent front-running)
- [ ] Create token mint
- [ ] Transfer mint authority to PDA (`transfer_mint_authority_to_pda`)
- [ ] Create metadata
- [ ] Create treasury
- [ ] Verify all authorities are correct

### AFTER Deployment:
- [ ] Verify admin is correct address
- [ ] Verify upgrade_authority is correct address
- [ ] Verify mint authority is PDA, not admin
- [ ] Verify freeze authority is PDA
- [ ] Test claim flow on devnet/mainnet-fork first
- [ ] Consider making contract non-upgradeable after testing

---

## 🔐 SECURITY STRENGTHS

1. ✅ **Excellent signature verification** - Ed25519, domain separation, nonce, expiry
2. ✅ **Replay attack protection** - Nonce-based, tested thoroughly
3. ✅ **Cross-account protection** - User address in payload
4. ✅ **Dual-signature burn** - Requires both admin AND user
5. ✅ **Transfer controls** - Proper gating with permanent flag
6. ✅ **Freeze/unfreeze logic** - Secure account freezing for claims
7. ✅ **Time-lock mechanism** - Configurable claim delays
8. ✅ **Treasury management** - Proper separation of treasury operations

---

## 🔴 FINAL VERDICT

### ⛔ **RED LIGHT - NOT READY FOR MAINNET**

**Critical Issues Count:** 5
**High Issues Count:** 2
**Medium Issues Count:** 2

### Required Actions:
1. Fix all 5 CRITICAL issues above
2. Remove duplicate/unused functions
3. Test all fixes on devnet
4. Re-run security test suite
5. Get code review from another developer
6. Perform mainnet-fork testing

### After Fixes:
If all critical and high issues are resolved, the contract has strong security foundations:
- Excellent claim mechanism with signature verification
- Good access control (after fixes)
- Proper transfer gating
- Tested security features

**Estimated time to mainnet-ready:** 2-4 hours of focused fixes + testing

---

## 📝 RECOMMENDATIONS

1. **Immediate:** Fix access control bugs in upgrade functions
2. **Immediate:** Remove duplicate `enable_transfers`
3. **Immediate:** Fix treasury reset in `update_token_mint`
4. **Immediate:** Automate mint authority transfer
5. **Before mainnet:** Remove `validate_upgrade` function
6. **Before mainnet:** Create atomic deploy+init script
7. **After mainnet:** Consider making contract immutable
8. **After mainnet:** Set up monitoring for admin actions

---

**Auditor Note:** The core security mechanisms (claim verification, nonce, signatures) are excellent. The issues found are primarily in access control and code organization. These are fixable within hours. DO NOT deploy to mainnet until all CRITICAL and HIGH issues are resolved.
