#!/bin/bash

echo "🚀 Starting Riyal Contract Test Suite"
echo "===================================="

# Kill any existing validator
echo "🧹 Cleaning up existing validator..."
pkill -f solana-test-validator
sleep 2

# Force remove all ledger data
echo "🗑️  Force removing all ledger data..."
rm -rf test-ledger
rm -rf ~/.config/solana/test-validator-*
rm -rf /tmp/test-validator-*

# Wait longer for complete cleanup
sleep 5

# Start fresh validator with explicit reset
echo "🔄 Starting completely fresh test validator..."
solana-test-validator --reset --ledger test-ledger --quiet &
VALIDATOR_PID=$!

# Wait longer for validator to be completely ready
echo "⏳ Waiting for validator to be completely ready..."
sleep 20

# Verify validator is actually running
echo "🔍 Checking validator status..."
solana cluster-version --url http://127.0.0.1:8899

# Deploy the contract
echo "🚀 Deploying contract..."
anchor deploy

if [ $? -eq 0 ]; then
    echo "✅ Contract deployed successfully"
    
    # Run the REAL comprehensive test
echo "🧪 Running REAL comprehensive test (NO MOCKS)..."
node test_complete_real_no_mocks.js
    
    if [ $? -eq 0 ]; then
        echo "🎉 ALL TESTS PASSED!"
    else
        echo "❌ Tests failed"
    fi
else
    echo "❌ Contract deployment failed"
fi

# Clean up
echo "🧹 Cleaning up..."
kill $VALIDATOR_PID 2>/dev/null
pkill -f solana-test-validator 2>/dev/null

echo "✅ Test run complete"
