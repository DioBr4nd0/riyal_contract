#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Riyal Contract Module 1 Deployment and Testing${NC}"
echo "=================================================="

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check dependencies
echo -e "${YELLOW}📋 Checking dependencies...${NC}"

if ! command_exists solana; then
    echo -e "${RED}❌ Solana CLI not found. Please install Solana CLI first.${NC}"
    exit 1
fi

if ! command_exists anchor; then
    echo -e "${RED}❌ Anchor CLI not found. Please install Anchor CLI first.${NC}"
    exit 1
fi

if ! command_exists yarn; then
    echo -e "${RED}❌ Yarn not found. Please install Yarn first.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ All dependencies found${NC}"

# Install node dependencies
echo -e "${YELLOW}📦 Installing node dependencies...${NC}"
yarn install

# Set Solana to localnet
echo -e "${YELLOW}🌐 Setting Solana to localnet...${NC}"
solana config set --url localhost

# Check if solana-test-validator is running
echo -e "${YELLOW}🔍 Checking if solana-test-validator is running...${NC}"
if ! solana cluster-version >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  solana-test-validator not running. Starting it...${NC}"
    echo -e "${BLUE}Please run the following command in a separate terminal:${NC}"
    echo -e "${GREEN}solana-test-validator${NC}"
    echo -e "${YELLOW}Then press Enter to continue...${NC}"
    read -r
fi

# Wait for validator to be ready
echo -e "${YELLOW}⏳ Waiting for validator to be ready...${NC}"
sleep 3

# Check validator is responding
if ! solana cluster-version >/dev/null 2>&1; then
    echo -e "${RED}❌ solana-test-validator is not responding. Please start it first.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Validator is running${NC}"

# Build the program
echo -e "${YELLOW}🔨 Building Anchor program...${NC}"
anchor build

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build successful${NC}"

# Deploy the program
echo -e "${YELLOW}🚀 Deploying program to localnet...${NC}"
anchor deploy

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Deployment failed${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Deployment successful${NC}"

# Generate TypeScript types
echo -e "${YELLOW}📝 Generating TypeScript types...${NC}"
anchor idl parse --file target/idl/riyal_contract.json --out target/types/

# Run tests
echo -e "${YELLOW}🧪 Running Module 1 tests...${NC}"
echo "=================================================="
anchor test --skip-local-validator --skip-deploy

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Tests failed${NC}"
    exit 1
fi

echo "=================================================="
echo -e "${GREEN}🎉 Module 1 deployment and testing completed successfully!${NC}"
echo ""
echo -e "${BLUE}📊 Summary:${NC}"
echo -e "  ✅ Contract initialized with admin authority"
echo -e "  ✅ SPL token mint created with proper authorities"
echo -e "  ✅ All security checks working correctly"
echo -e "  ✅ Ready for Module 2 implementation"
echo ""
echo -e "${YELLOW}💡 Next steps:${NC}"
echo -e "  1. Module 2: Implement token minting with admin control"
echo -e "  2. Module 3: Implement nonce management for users"
echo -e "  3. Module 4: Implement token claiming with signature verification"
echo ""
echo -e "${GREEN}🏁 Module 1 Complete!${NC}"
