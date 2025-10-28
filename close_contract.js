#!/usr/bin/env node

/**
 * CLOSE MAINNET CONTRACT - With Phantom Approval
 * 
 * This script:
 * 1. Calculates the SOL refund from closing the program
 * 2. Creates a web interface for Phantom approval
 * 3. Executes the close after user confirmation
 */

const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// ========================================
// CONFIGURATION
// ========================================
const PROGRAM_ID = "HWuotjdXtQePUmX5WCzPxQkZ3LiiXQ6i8AYSudgJxEts";
// Alternative free RPCs (change if rate limited):
const RPC_URL = "https://solana-mainnet.g.alchemy.com/v2/demo"; // Alchemy demo endpoint
// const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=public"; // Helius public
// const RPC_URL = "https://rpc.ankr.com/solana"; // Ankr public
const PORT = 3456;

// ========================================
// MAIN FUNCTION
// ========================================
(async () => {
  console.log("🔍 MERCLE TOKEN - CONTRACT CLOSURE CALCULATOR");
  console.log("=" .repeat(60));
  console.log("");

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const programId = new PublicKey(PROGRAM_ID);

    // Get program account info
    console.log("📋 Program ID:", PROGRAM_ID);
    console.log("🌐 Network: Mainnet Beta");
    console.log("");

    const accountInfo = await connection.getAccountInfo(programId);
    
    if (!accountInfo) {
      console.error("❌ Program account not found!");
      process.exit(1);
    }

    // Get program data account (where the real SOL is!)
    const programDataAddress = PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
    )[0];

    console.log("📋 Program Data Address:", programDataAddress.toString());
    console.log("");

    const programDataInfo = await connection.getAccountInfo(programDataAddress);
    
    if (!programDataInfo) {
      console.error("❌ Program data account not found!");
      process.exit(1);
    }

    // The refund comes from the program data account!
    const refundLamports = programDataInfo.lamports;
    const refundSOL = refundLamports / 1e9;

    console.log("💰 REFUND CALCULATION:");
    console.log("━".repeat(60));
    console.log(`Program Data Balance:   ${refundSOL.toFixed(9)} SOL`);
    console.log(`Refund Amount:          ${refundSOL.toFixed(9)} SOL`);
    console.log(`USD Value (est):        $${(refundSOL * 200).toFixed(2)} (at $200/SOL)`);
    console.log("");
    console.log("✅ Ready to close! (Transaction will fail if you're not the upgrade authority)");
    console.log("");

    // Create HTML interface
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Close Mercle Contract</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .info-box {
      background: #f8f9fa;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border-left: 4px solid #667eea;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 14px;
    }
    .info-row:last-child {
      margin-bottom: 0;
    }
    .label {
      color: #666;
      font-weight: 500;
    }
    .value {
      color: #333;
      font-weight: 600;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }
    .refund {
      font-size: 32px !important;
      color: #667eea;
    }
    .warning {
      background: #fff3cd;
      border-left-color: #ffc107;
      border: 1px solid #ffc107;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #856404;
    }
    .warning strong {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
    }
    button {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 10px;
    }
    .btn-connect {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .btn-connect:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    .btn-close {
      background: #dc3545;
      color: white;
      display: none;
    }
    .btn-close:hover {
      background: #c82333;
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(220, 53, 69, 0.4);
    }
    .btn-close:disabled {
      background: #ccc;
      cursor: not-allowed;
      transform: none;
    }
    .status {
      text-align: center;
      padding: 12px;
      border-radius: 8px;
      margin-top: 20px;
      font-size: 14px;
      display: none;
    }
    .status.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .status.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    .status.info {
      background: #d1ecf1;
      color: #0c5460;
      border: 1px solid #bee5eb;
    }
    .connected {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      background: #d4edda;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .connected .dot {
      width: 8px;
      height: 8px;
      background: #28a745;
      border-radius: 50%;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔴 Close Mercle Contract</h1>
    <div class="subtitle">Mainnet Beta • Solana</div>
    
    <div class="info-box">
      <div class="info-row">
        <span class="label">Program ID:</span>
        <span class="value">${PROGRAM_ID.slice(0, 8)}...${PROGRAM_ID.slice(-8)}</span>
      </div>
      <div class="info-row">
        <span class="label">Refund Amount:</span>
        <span class="value refund">${refundSOL.toFixed(4)} SOL</span>
      </div>
      <div class="info-row">
        <span class="label">Est. USD Value:</span>
        <span class="value">~$${(refundSOL * 200).toFixed(2)}</span>
      </div>
    </div>

    <div class="warning">
      <strong>⚠️ WARNING: This action is PERMANENT!</strong>
      • The contract will be completely removed<br>
      • All contract functions will stop working<br>
      • Token mint and user accounts will remain<br>
      • You will receive ${refundSOL.toFixed(4)} SOL refund
    </div>

    <div class="connected" id="walletConnected">
      <span class="dot"></span>
      <span>Wallet Connected: <span id="walletAddress"></span></span>
    </div>

    <button class="btn-connect" id="connectBtn" onclick="connectWallet()">
      Connect Phantom Wallet
    </button>

    <button class="btn-close" id="closeBtn" onclick="closeProgram()" disabled>
      Close Contract & Claim ${refundSOL.toFixed(4)} SOL
    </button>

    <div class="status" id="status"></div>
  </div>

  <script>
    const PROGRAM_ID = "${PROGRAM_ID}";
    const REFUND_SOL = ${refundSOL};
    let wallet = null;

    async function connectWallet() {
      const btn = document.getElementById('connectBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Connecting...';

      try {
        if (!window.solana || !window.solana.isPhantom) {
          showStatus('error', '❌ Phantom wallet not found! Please install Phantom browser extension.');
          btn.disabled = false;
          btn.innerHTML = 'Connect Phantom Wallet';
          return;
        }

        const resp = await window.solana.connect();
        wallet = window.solana;
        
        document.getElementById('walletConnected').style.display = 'flex';
        document.getElementById('walletAddress').textContent = 
          resp.publicKey.toString().slice(0, 4) + '...' + resp.publicKey.toString().slice(-4);
        
        document.getElementById('connectBtn').style.display = 'none';
        document.getElementById('closeBtn').style.display = 'block';
        document.getElementById('closeBtn').disabled = false;
        
        showStatus('success', '✅ Wallet connected successfully!');
      } catch (err) {
        showStatus('error', '❌ Connection failed: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = 'Connect Phantom Wallet';
      }
    }

    async function closeProgram() {
      if (!wallet) {
        showStatus('error', '❌ Please connect your wallet first');
        return;
      }

      const btn = document.getElementById('closeBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Closing Contract...';

      showStatus('info', '⏳ Creating transaction... Please approve in Phantom.');

      try {
        // Import Solana web3
        const solanaWeb3 = window.solanaWeb3;
        if (!solanaWeb3) {
          throw new Error('Solana web3.js not loaded');
        }

        const connection = new solanaWeb3.Connection('${RPC_URL}', 'confirmed');
        const programId = new solanaWeb3.PublicKey(PROGRAM_ID);
        
        // Create close instruction (requires BPF Loader Upgradeable)
        const BPF_LOADER_UPGRADEABLE = new solanaWeb3.PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
        
        // Find program data address
        const [programDataAddress] = await solanaWeb3.PublicKey.findProgramAddress(
          [programId.toBuffer()],
          BPF_LOADER_UPGRADEABLE
        );

        // Create close instruction
        // Instruction format: [5, 0, 0, 0] (4-byte little-endian for discriminator)
        const closeData = new Uint8Array(4);
        closeData[0] = 5; // Close discriminator
        closeData[1] = 0;
        closeData[2] = 0;
        closeData[3] = 0;

        const instruction = new solanaWeb3.TransactionInstruction({
          keys: [
            { pubkey: programDataAddress, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: true },
          ],
          programId: BPF_LOADER_UPGRADEABLE,
          data: closeData
        });

        const transaction = new solanaWeb3.Transaction().add(instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        // Send transaction
        const signed = await wallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize());
        
        showStatus('info', '⏳ Transaction sent! Confirming... (Signature: ' + signature.slice(0, 8) + '...)');
        
        await connection.confirmTransaction(signature);
        
        showStatus('success', 
          \`✅ Contract closed successfully!<br>
          💰 Refund: \${REFUND_SOL.toFixed(4)} SOL<br>
          🔗 <a href="https://solscan.io/tx/\${signature}" target="_blank" style="color: #155724; text-decoration: underline;">View Transaction</a>\`
        );
        
        btn.style.display = 'none';
      } catch (err) {
        console.error(err);
        showStatus('error', '❌ Failed: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = 'Retry Close Contract';
      }
    }

    function showStatus(type, message) {
      const status = document.getElementById('status');
      status.className = 'status ' + type;
      status.innerHTML = message;
      status.style.display = 'block';
    }

    // Check if Phantom is available on load
    window.addEventListener('load', () => {
      if (!window.solana || !window.solana.isPhantom) {
        showStatus('error', '❌ Phantom wallet not detected! Please install: <a href="https://phantom.app/" target="_blank" style="color: #721c24; text-decoration: underline;">phantom.app</a>');
      }
    });
  </script>
  
  <!-- Load Solana web3.js from CDN -->
  <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js"></script>
</body>
</html>`;

    // Start HTTP server
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (req.url === '/close') {
        console.log("\n✅ Close server shutting down...");
        res.writeHead(200);
        res.end('OK');
        server.close();
        process.exit(0);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(PORT, () => {
      console.log("🌐 OPENING WEB INTERFACE:");
      console.log("━".repeat(60));
      console.log(`Local URL: http://localhost:${PORT}`);
      console.log("");
      console.log("✅ Browser should open automatically...");
      console.log("📱 Connect your Phantom wallet to proceed");
      console.log("");
      console.log("Press Ctrl+C to cancel");
      console.log("");

      // Open browser
      const url = `http://localhost:${PORT}`;
      const openCommand = process.platform === 'darwin' ? 'open' : 
                          process.platform === 'win32' ? 'start' : 'xdg-open';
      
      exec(`${openCommand} ${url}`, (error) => {
        if (error) {
          console.log("⚠️  Could not open browser automatically");
          console.log(`   Please open: ${url}`);
        }
      });
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log("\n\n❌ Cancelled by user");
      server.close();
      process.exit(0);
    });

  } catch (error) {
    console.error("\n❌ ERROR:", error.message);
    process.exit(1);
  }
})();

