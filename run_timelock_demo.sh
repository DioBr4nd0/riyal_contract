#!/bin/bash

echo "🕒 Starting Time-Lock Demonstration"
echo "===================================="

# Kill any existing validator
echo "🧹 Cleaning up existing validator..."
pkill -f solana-test-validator 2>/dev/null || true
sleep 2

# Remove any existing ledger data
echo "🗑️  Removing old ledger data..."
rm -rf test-ledger 2>/dev/null || true
rm -rf ~/.config/solana/test-validator-* 2>/dev/null || true
rm -rf /tmp/test-validator-* 2>/dev/null || true

# Start fresh validator
echo "🔄 Starting fresh test validator..."
solana-test-validator --reset --ledger test-ledger --quiet &

# Wait for validator to be ready
echo "⏳ Waiting for validator to be ready..."
sleep 25

# Check validator status
echo "🔍 Checking validator status..."
solana --version

# Build and deploy the contract
echo "🚀 Building and deploying contract..."
anchor build

if [ $? -eq 0 ]; then
    echo "✅ Contract built successfully"
    
    # Deploy the contract
    anchor deploy
    
    if [ $? -eq 0 ]; then
        echo "✅ Contract deployed successfully"
        
        # Run the time-lock demonstration
        echo "🕒 Running time-lock demonstration..."
        node test_timelock_demo.js
        
        if [ $? -eq 0 ]; then
            echo "🎉 TIME-LOCK DEMO COMPLETED!"
        else
            echo "❌ Time-lock demo failed"
        fi
    else
        echo "❌ Contract deployment failed"
    fi
else
    echo "❌ Contract build failed"
fi

# Cleanup
echo "🧹 Cleaning up..."
pkill -f solana-test-validator 2>/dev/null || true

echo "✅ Time-lock demo run complete"

