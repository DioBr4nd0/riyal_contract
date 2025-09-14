#!/bin/bash

echo "🕒 Simple Time-Lock Test"
echo "========================"

# Kill existing validator and clean up
pkill -f solana-test-validator 2>/dev/null || true
sleep 2
rm -rf test-ledger 2>/dev/null || true

# Start validator
echo "🔄 Starting validator..."
solana-test-validator --reset --ledger test-ledger --quiet &
sleep 25

# Deploy and test
echo "🚀 Deploying and testing..."
anchor deploy && node test_simple_timelock.js

# Cleanup
pkill -f solana-test-validator 2>/dev/null || true
echo "✅ Complete"
