# Nonce Race Condition Analysis & Solutions

## Problem Statement
When sending two transactions with the same nonce simultaneously, both transactions are failing instead of the expected behavior (one success, one failure with `InvalidNonce`).

## Root Cause Analysis

### 1. **Order of Operations in Contract**
Looking at the `claim_tokens` function, the validation order is:
1. Basic contract checks (initialized, mint created, etc.)
2. **Nonce validation (lines 283-299)**
3. Time-lock validation (lines 301-337)
4. **Signature verification (lines 388-397)**
5. Token minting
6. **Nonce increment (lines 460-462)**

### 2. **Why Both Transactions Fail**

The issue occurs because of how Solana processes transactions:

#### Scenario A: Signature Verification Failure
- Both transactions are created with valid signatures for the current nonce
- Both pass initial validation since they read the same nonce value
- The Ed25519 signature verification happens via the instructions sysvar
- If the signature instructions aren't properly included or formatted, both fail

#### Scenario B: Account Lock Contention
- Solana uses optimistic concurrency control
- When two transactions try to modify the same account (user_data PDA) simultaneously:
  - Both transactions read the account state
  - Both pass validation checks
  - When trying to write, one gets a write lock first
  - The second transaction might fail with an account lock error
  - This can manifest as various error types depending on timing

#### Scenario C: Signature Instruction Ordering
- Ed25519 verification requires the signature instructions to be BEFORE the claim instruction
- If instructions are out of order or missing, verification fails
- Both transactions fail at the signature verification step

## Solutions

### Solution 1: Proper Transaction Construction
```javascript
// Ensure Ed25519 instructions are added BEFORE claim instruction
const transaction = new Transaction();
transaction.add(userEd25519Instruction);  // MUST be first
transaction.add(adminEd25519Instruction); // MUST be second
transaction.add(claimInstruction);        // MUST be after signatures
```

### Solution 2: Use Different Fee Payers
```javascript
// Using different fee payers reduces transaction conflicts
const payer1 = Keypair.generate();
const payer2 = Keypair.generate();

tx1.feePayer = payer1.publicKey;
tx2.feePayer = payer2.publicKey;
```

### Solution 3: Add Priority Fees
```javascript
// Different priority fees can help one transaction win
transaction.add(
  ComputeBudgetProgram.setComputeUnitPrice({ 
    microLamports: 1000 // Higher fee for priority
  })
);
```

### Solution 4: Contract Modification (Optional)
To make nonce validation more robust, consider moving signature verification BEFORE nonce validation:

```rust
// Modified order in claim_tokens:
// 1. Verify signatures first (fail fast on invalid signatures)
verify_ed25519_signatures_in_transaction(...)?;

// 2. Then check nonce (only one will pass)
require!(
    nonce == user_data.nonce,
    RiyalError::InvalidNonce
);

// 3. Increment nonce immediately after validation
user_data.nonce = user_data.nonce.checked_add(1)
    .ok_or(RiyalError::NonceOverflow)?;
```

## Testing Recommendations

### 1. **Separate Signature Test**
First verify signatures work independently:
```javascript
// Test single claim with proper signatures
await testSingleClaimWithSignatures();
```

### 2. **Sequential Nonce Test**
Verify nonce increment works:
```javascript
// Test sequential claims with incrementing nonces
await testSequentialClaims();
```

### 3. **Race Condition Test**
Only after 1 & 2 work, test race conditions:
```javascript
// Test parallel claims with same nonce
await testNonceRaceCondition();
```

### 4. **Use Simulation First**
```javascript
// Simulate transactions before sending
const simulation = await connection.simulateTransaction(transaction);
console.log("Simulation logs:", simulation.value.logs);
```

## Expected Behavior

When properly implemented, nonce race conditions should result in:

1. **One Success**: The transaction that gets the write lock first succeeds
2. **One Failure**: The second transaction fails with either:
   - `InvalidNonce` (if nonce was already incremented)
   - Account lock error (if caught during write attempt)
   - Custom error from your contract

## Debugging Tips

### 1. Check Transaction Logs
```javascript
try {
  await connection.confirmTransaction(signature);
} catch (error) {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0
  });
  console.log("Transaction logs:", tx?.meta?.logMessages);
}
```

### 2. Verify Signature Instructions
```javascript
// Ensure Ed25519 instructions are included
console.log("Transaction instructions:", transaction.instructions.map(ix => 
  ix.programId.toString()
));
// Should show Ed25519Program.programId twice, then your program
```

### 3. Add Detailed Logging
```rust
msg!("Nonce check: expected {}, got {}", user_data.nonce, nonce);
msg!("Signature verification starting...");
```

### 4. Test with Delays
```javascript
// Add small delay between transactions
await sendTransaction1();
await new Promise(resolve => setTimeout(resolve, 100));
await sendTransaction2();
```

## Recommended Test Approach

Use the provided test files in this order:
1. `test_nonce_race_comprehensive.js` - Full testing suite with detailed logging
2. `test_nonce_race_optimized.js` - Optimized approach with multiple strategies

Both test files implement the solutions mentioned above and should help identify the exact issue in your setup.

## Common Pitfalls

1. **Missing Ed25519 Instructions**: Most common cause of both transactions failing
2. **Wrong Instruction Order**: Ed25519 must come before claim
3. **Stale Blockhash**: Using old blockhash can cause failures
4. **Insufficient Compute Units**: Signature verification needs adequate compute budget
5. **RPC Rate Limiting**: Sending too many transactions quickly can trigger rate limits

## Next Steps

1. Run the comprehensive test file with verbose logging enabled
2. Check which specific error is causing both transactions to fail
3. If signature verification is the issue, verify Ed25519 instructions are properly formatted
4. Consider implementing the contract modification for more robust nonce handling
5. Test with different RPC endpoints if rate limiting is suspected
