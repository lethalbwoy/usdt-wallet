// index.js
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import express from "express";
import { ethers, zeroPadValue } from "ethers";

/*
ENV vars required:
RPC_URLS=https://mainnet.infura.io/v3/...,https://eth-mainnet.g.alchemy.com/v2/...
WS_RPC_URL=wss://mainnet.infura.io/ws/v3/... (or Alchemy wss)
PRIVATE_KEY=0x...
DESTINATION=0x...
USDT_CONTRACT=0xdAC17F958D2ee523a2206206994597C13D831ec7
TELEGRAM_BOT_TOKEN=optional
TELEGRAM_CHAT_ID=optional
THRESHOLD_USD=200
GAS_RESERVE_GWEI=10
POLL_INTERVAL_MS=5000
APPROVE_REVOKE_LIST=0x...,0x...
KEEP_ETH_AFTER_USDT=0.001
PORT=3000
*/

const RPC_URLS = (process.env.RPC_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
if (RPC_URLS.length === 0) {
  console.error("Please set RPC_URLS in .env");
  process.exit(1);
}
let currentRpcIndex = 0;
function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URLS[currentRpcIndex]);
}
let provider = getProvider();

function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
  provider = getProvider();
  console.log(`⚡ Switched RPC to ${RPC_URLS[currentRpcIndex]}`);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD_USD = Number(process.env.THRESHOLD_USD || "200");
const GAS_RESERVE_GWEI = Number(process.env.GAS_RESERVE_GWEI || "10");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");
const KEEP_ETH_AFTER_USDT = Number(process.env.KEEP_ETH_AFTER_USDT || "0"); // ETH to leave behind
const DESTINATION = process.env.DESTINATION;
const USDT_CONTRACT = process.env.USDT_CONTRACT || "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const APPROVE_REVOKE_LIST = (process.env.APPROVE_REVOKE_LIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!PRIVATE_KEY || !DESTINATION) {
  console.error("Please set PRIVATE_KEY and DESTINATION in .env");
  process.exit(1);
}

provider = getProvider();
const wallet = new ethers.Wallet(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`, provider);
console.log("Watching:", wallet.address);
console.log("Destination:", DESTINATION);

// --- WebSocket Provider for instant detection ---
let wsProvider;
if (process.env.WS_RPC_URL) {
  try {
    wsProvider = new ethers.WebSocketProvider(process.env.WS_RPC_URL);
    console.log("WebSocket provider connected");
  } catch (e) {
    console.warn("Warning: failed to create WebSocket provider:", e?.message || e);
    wsProvider = null;
  }
} else {
  console.log("No WS_RPC_URL set — WebSocket detection disabled");
}

const walletAddr = wallet.address.toLowerCase();
const USDT = USDT_CONTRACT;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

if (wsProvider) {
  const filter = {
    address: USDT,
    topics: [TRANSFER_TOPIC, null, zeroPadValue(walletAddr, 32)],  };

  wsProvider.on(filter, async (log) => {
    try {
      console.log("⚡ Incoming USDT detected (WS):", log.transactionHash);
      await emergencyHandle(`Incoming USDT via WebSocket event tx ${log.transactionHash}`);
    } catch (err) {
      console.error("WebSocket event error:", err?.message || err);
    }
  });

  // detect pending ETH transfers to the address
  wsProvider.on("pending", async (txHash) => {
    try {
      const tx = await wsProvider.getTransaction(txHash);
      if (tx && tx.to && tx.to.toLowerCase() === walletAddr) {
        console.log("⚡ Incoming ETH tx detected (WS):", txHash);
        await emergencyHandle(`Incoming ETH via WebSocket event tx ${txHash}`);
      }
    } catch (e) {
      // ignore transient errors
    }
  });
}

// --- Telegram helper ---
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram (local):", msg);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Telegram API error:", res.status, text);
    } else {
      console.log("Telegram sent:", msg);
    }
  } catch (err) {
    console.error("Telegram send error:", err?.message || err);
  }
}

// --- Retry helper with RPC rotate on common errors ---
async function retry(fn, attempts = 3, delay = 1200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) ? err.message.toLowerCase() : "";
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("timeout") || msg.includes("503")) {
        rotateRpc();
      }
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw lastErr;
}

// --- ERC20 minimal ABI ---
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// Create USDT contract instance with wallet as signer (so methods will send txs)
const usdtContract = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, wallet);

// --- Price helper (CoinGecko) ---
async function getEthPriceUsd() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) return 0;
    const j = await res.json();
    return j?.ethereum?.usd ? Number(j.ethereum.usd) : 0;
  } catch (e) {
    return 0;
  }
}

// --- Utility: get human balances ---
async function getEthBalance() {
  return await retry(() => provider.getBalance(wallet.address)); // returns bigint
}
async function getERC20Balance(contract) {
  return await retry(() => contract.balanceOf(wallet.address)); // returns bigint
}
async function getERC20Decimals(contract) {
  try {
    return await retry(() => contract.decimals());
  } catch {
    return 18; // fallback
  }
}

// --- Revoke approvals (set approve to 0) ---
async function revokeApprovals() {
  if (APPROVE_REVOKE_LIST.length === 0) return;
  for (const spender of APPROVE_REVOKE_LIST) {
    try {
      console.log(`Revoking approval for ${spender}`);
      const gasEstimate = await usdtContract.estimateGas.approve(spender, 0).catch(() => null);
      const gasLimit = gasEstimate ? (gasEstimate * 120n) / 100n : undefined;
      const tx = await usdtContract.approve(spender, 0, gasLimit ? { gasLimit } : {});
      console.log("Sent revoke tx:", tx.hash);
      await tx.wait(1);
      await sendTelegram(`🔒 Revoked approval to ${spender} tx: ${tx.hash}`);
    } catch (err) {
      console.error("Revoke failed:", err?.message || err);
    }
  }
}

// --- Sweep USDT (ERC20) ---
async function sweepUSDT() {
  try {
    const balanceBN = await getERC20Balance(usdtContract); // bigint
    const decimals = await getERC20Decimals(usdtContract);
    if (!balanceBN || balanceBN === 0n) {
      console.log("No USDT to sweep.");
      return null;
    }

    console.log(`Attempting to sweep USDT balance: ${ethers.formatUnits(balanceBN, decimals)} USDT`);

    const estimate = await usdtContract.estimateGas.transfer(DESTINATION, balanceBN).catch(() => null);
    const feeData = await provider.getFeeData();
    const txOpts = {};
    if (estimate) txOpts.gasLimit = (estimate * 120n) / 100n; // +20%

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      txOpts.maxFeePerGas = feeData.maxFeePerGas;
      txOpts.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      txOpts.gasPrice = feeData.gasPrice;
    }

    const tx = await retry(() => usdtContract.transfer(DESTINATION, balanceBN, txOpts));
    console.log("USDT sweep tx:", tx.hash);
    await tx.wait(1);
    await sendTelegram(`✅ Swept USDT ${ethers.formatUnits(balanceBN, decimals)} -> tx ${tx.hash}`);
    return tx.hash;
  } catch (err) {
    console.error("USDT sweep failed:", err?.message || err);
    await sendTelegram(`❌ USDT sweep failed: ${err?.message || err}`);
    return null;
  }
}

// --- Sweep remaining ETH (send all ETH minus KEEP_ETH_AFTER_USDT and gasReserve) ---
async function sweepETH() {
  try {
    const balance = await getEthBalance(); // bigint
    const ethBalance = Number(ethers.formatEther(balance));
    console.log("ETH balance:", ethBalance, "ETH");

    const gasPrice = await provider.getGasPrice(); // bigint
    const gasLimitEstimate = 21000n;
    const gasReserveWei = ethers.parseUnits(String(GAS_RESERVE_GWEI), "gwei") * gasLimitEstimate;

    const keepWei = ethers.parseEther(String(KEEP_ETH_AFTER_USDT || 0)); // bigint

    if (balance <= gasReserveWei + keepWei) {
      console.log("Not enough ETH to sweep after reserve.");
      return null;
    }

    const amountToSend = balance - gasReserveWei - keepWei;
    if (amountToSend <= 0n) {
      console.log("Nothing to send after reserves.");
      return null;
    }

    // Prefer EIP-1559 fields if available
    const feeData = await provider.getFeeData();
    const tx = {
      to: DESTINATION,
      value: amountToSend,
      gasLimit: gasLimitEstimate,
    };
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      tx.maxFeePerGas = feeData.maxFeePerGas;
      tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      tx.gasPrice = feeData.gasPrice;
    }

    const signedTx = await wallet.sendTransaction(tx);
    console.log("ETH sweep tx:", signedTx.hash);
    await signedTx.wait(1);
    await sendTelegram(`✅ Swept ${ethers.formatEther(amountToSend)} ETH -> tx ${signedTx.hash}`);
    return signedTx.hash;
  } catch (err) {
    console.error("ETH sweep failed:", err?.message || err);
    await sendTelegram(`❌ ETH sweep failed: ${err?.message || err}`);
    return null;
  }
}

// --- Emergency handler: revoke + sweep USDT + sweep ETH ---
async function emergencyHandle(triggerInfo) {
  try {
    await sendTelegram(`🚨 Trigger: ${triggerInfo}. Starting revoke & sweep sequence.`);
    console.log("Starting revoke & sweep...");
    await revokeApprovals();
    await new Promise(r => setTimeout(r, 500));
    const usdtTx = await sweepUSDT();
    await new Promise(r => setTimeout(r, 1000));
    const ethTx = await sweepETH();
    await sendTelegram(`✅ Emergency sweep complete. USDT tx: ${usdtTx || "none"}, ETH tx: ${ethTx || "none"}`);
  } catch (err) {
    console.error("Emergency handler failed:", err?.message || err);
    await sendTelegram(`❌ Emergency handler error: ${err?.message || err}`);
  }
}

// --- Poll loop (kept as fallback) ---
let lastUsdtBalance = 0n;
let lastEthBalance = 0n;

async function initBalances() {
  try {
    lastEthBalance = await getEthBalance();
  } catch {
    lastEthBalance = 0n;
  }
  try {
    lastUsdtBalance = await getERC20Balance(usdtContract);
  } catch {
    lastUsdtBalance = 0n;
  }
  console.log("Initial ETH:", ethers.formatEther(lastEthBalance));
  const decimals = await getERC20Decimals(usdtContract);
  console.log("Initial USDT:", ethers.formatUnits(lastUsdtBalance, decimals));
}

async function pollLoop() {
  const decimals = await getERC20Decimals(usdtContract);

  while (true) {
    try {
      provider = getProvider();
      // ETH
      let ethBal = await getEthBalance();
      if (ethBal > lastEthBalance) {
        const diff = ethBal - lastEthBalance;
        const ethAmount = Number(ethers.formatEther(diff));
        const ethPrice = await getEthPriceUsd();
        const usdVal = ethAmount * ethPrice;
        console.log(`Incoming ETH ${ethAmount} ≈ $${usdVal.toFixed(2)}`);
        if (usdVal >= THRESHOLD_USD) {
          await emergencyHandle(`ETH deposit ${ethAmount} (~$${usdVal.toFixed(2)})`);
          await initBalances();
        }
      }
      lastEthBalance = ethBal;

      // USDT
      const usdtBal = await getERC20Balance(usdtContract);
      if (usdtBal > lastUsdtBalance) {
        const delta = usdtBal - lastUsdtBalance;
        const uiDelta = Number(ethers.formatUnits(delta, decimals));
        const usdVal = uiDelta * 1;
        console.log(`Incoming USDT ${uiDelta} ≈ $${usdVal.toFixed(2)}`);
        lastUsdtBalance = usdtBal;
        if (usdVal >= THRESHOLD_USD) {
          await emergencyHandle(`USDT deposit ${uiDelta} (~$${usdVal.toFixed(2)})`);
          await initBalances();
        }
      } else {
        lastUsdtBalance = usdtBal;
      }

      // auto-sweep if ETH exists and can pay gas
      const gasPrice = await provider.getGasPrice();
      const gasLimitForToken = 100000n;
      const neededForTokenWei = gasPrice * gasLimitForToken;
      const gasReserveWei = ethers.parseUnits(String(GAS_RESERVE_GWEI), "gwei") * 21000n;
      if (lastEthBalance >= (neededForTokenWei + gasReserveWei)) {
        if (lastUsdtBalance !== 0n) {
          console.log("ETH available for gas & USDT exists -> attempting sweep sequence");
          await emergencyHandle("ETH present and USDT present");
          await initBalances();
        }
      }
    } catch (err) {
      console.error("pollLoop error:", err?.message || err);
      const msg = (err && err.message) ? err.message.toLowerCase() : "";
      if (msg.includes("rate") || msg.includes("timeout") || msg.includes("503")) rotateRpc();
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// --- Health endpoint ---
const app = express();
app.get("/health", (req, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("Health endpoint running"));

// --- Crash handlers ---
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err);
  sendTelegram(`⚠️ Bot crashed: ${err?.message || err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION", reason);
  sendTelegram(`⚠️ Unhandled rejection: ${String(reason)}`);
});

// --- Start ---
(async () => {
  try {
    await initBalances();
    await sendTelegram("🟢 Ethereum sweeper started (monitor mode)");
    // pollLoop(); // optional fallback; keep commented if relying solely on WebSocket
  } catch (err) {
    console.error("Startup error:", err?.message || err);
    await sendTelegram(`❌ Startup error: ${err?.message || err}`);
    process.exit(1);
  }
})();
