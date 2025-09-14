#!/bin/bash

# run_nonce_race_tests.sh
# Script to run nonce race condition tests

echo "=========================================="
echo "NONCE RACE CONDITION TEST SUITE"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if local validator is running
if ! pgrep -x "solana-test-validator" > /dev/null; then
    echo -e "${YELLOW}Starting local Solana validator...${NC}"
    solana-test-validator --reset &
    sleep 5
    echo -e "${GREEN}Validator started${NC}"
else
    echo -e "${GREEN}Solana validator is already running${NC}"
fi

# Deploy the program
echo ""
echo -e "${YELLOW}Deploying program...${NC}"
anchor deploy
if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to deploy program${NC}"
    exit 1
fi
echo -e "${GREEN}Program deployed successfully${NC}"

# Function to run a test
run_test() {
    local test_file=$1
    local test_name=$2
    
    echo ""
    echo "=========================================="
    echo -e "${YELLOW}Running: $test_name${NC}"
    echo "=========================================="
    
    if [ -f "$test_file" ]; then
        node "$test_file"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ $test_name completed${NC}"
        else
            echo -e "${RED}❌ $test_name failed${NC}"
        fi
    else
        echo -e "${RED}Test file not found: $test_file${NC}"
    fi
}

# Menu for test selection
echo ""
echo "Select which test to run:"
echo "1) Debug Test (Recommended - most detailed logging)"
echo "2) Comprehensive Test (Full test suite)"
echo "3) Optimized Test (Multiple strategies)"
echo "4) Run all tests"
echo "5) Exit"
echo ""
read -p "Enter your choice (1-5): " choice

case $choice in
    1)
        run_test "test_nonce_race_debug.js" "Debug Test"
        ;;
    2)
        run_test "test_nonce_race_comprehensive.js" "Comprehensive Test"
        ;;
    3)
        run_test "test_nonce_race_optimized.js" "Optimized Test"
        ;;
    4)
        echo -e "${YELLOW}Running all tests...${NC}"
        run_test "test_nonce_race_debug.js" "Debug Test"
        run_test "test_nonce_race_comprehensive.js" "Comprehensive Test"
        run_test "test_nonce_race_optimized.js" "Optimized Test"
        ;;
    5)
        echo "Exiting..."
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo -e "${GREEN}All selected tests completed${NC}"
echo "=========================================="
echo ""
echo "📋 Summary:"
echo "- If both transactions fail: Check the NONCE_RACE_ANALYSIS.md file"
echo "- Expected behavior: One transaction succeeds, one fails"
echo "- Run the debug test first to identify specific issues"
echo ""
