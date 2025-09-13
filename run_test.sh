#!/bin/bash

echo "🚀 Starting Riyal Contract Test Suite"
echo "===================================="

# Kill any existing validator
echo "🧹 Cleaning up existing validator..."
pkill -f solana-test-validator
rm -rf test-ledger

# Wait a moment
sleep 3

# Start fresh validator
echo "🔄 Starting fresh test validator..."
solana-test-validator --reset --quiet &
VALIDATOR_PID=$!

# Wait for validator to be ready
echo "⏳ Waiting for validator to be ready..."
sleep 15

# Deploy the contract
echo "🚀 Deploying contract..."
anchor deploy

if [ $? -eq 0 ]; then
    echo "✅ Contract deployed successfully"
    
    # Run the working functionality test
    echo "🧪 Running comprehensive test..."
    node test_working_functionality.js
    
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
