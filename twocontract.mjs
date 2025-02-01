import dotenv from "dotenv";
import fetch from "node-fetch"; // Ensure you have node-fetch installed
import express from "express";
import axios from "axios";
import Web3 from "web3";
import { BigNumber } from "bignumber.js";
import retry from "async-retry";
import PQueue from "p-queue";
import Redis from "ioredis";
import { createClient } from "redis";
import { ethers, Wallet, JsonRpcProvider, Contract } from "ethers";
import cron from "node-cron";
import { promisify } from "util";
import pkg from "telegraf";
import { getRandomBytes32, HashLock, SDK, NetworkEnum } from "@1inch/cross-chain-sdk";
import POLYGON_ABI from "./abis/PolygonSmartContract.json";
import ARBITRUM_ABI from "./abis/ArbitrumSmartContract.json";

const sdk = new SDK({
  url: "https://api.1inch.dev/fusion-plus",
  authKey: process.env.ONEINCH_API_KEY,
});

dotenv.config();
const { Telegraf } = pkg;
const INFURA_URL = process.env.INFURA_URL;
const ERC20_ABI = [
    "function decimals() view returns (uint8)"
];
// Define contract addresses
const POLYGON_CONTRACT_ADDRESS = process.env.POLYGON_SMART_CONTRACT;
const ARBITRUM_CONTRACT_ADDRESS = process.env.ARBITRUM_SMART_CONTRACT;

// Define providers and wallets for both networks
const providerPolygon = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC);
const providerArbitrum = new ethers.providers.JsonRpcProvider(process.env.ARBITRUM_RPC);

const walletPolygon = new ethers.Wallet(process.env.PRIVATE_KEY, providerPolygon);
const walletArbitrum = new ethers.Wallet(process.env.PRIVATE_KEY, providerArbitrum);

// Load Smart Contracts for both networks
const polygonContract = new ethers.Contract(POLYGON_CONTRACT_ADDRESS, POLYGON_ABI, walletPolygon);
const arbitrumContract = new ethers.Contract(ARBITRUM_CONTRACT_ADDRESS, ARBITRUM_ABI, walletArbitrum);
const SMART_CONTRACT_ABI = [
  // Add your contract ABI here
];
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Permit2 contract address
// Initialize Redis cache
const permit2Abi = [
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          }
        ],
        "internalType": "struct ISignatureTransfer.TokenPermissions",
        "name": "permitted",
        "type": "tuple"
      },
      { "internalType": "uint256", "name": "nonce", "type": "uint256" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "internalType": "struct ISignatureTransfer.PermitTransferFrom",
    "name": "permit",
    "type": "tuple"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "owner", "type": "address" }
    ],
    "name": "nonces",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint256", "name": "nonce", "type": "uint256" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" },
      { "internalType": "bytes", "name": "signature", "type": "bytes" }
    ],
    "name": "permitTransferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "owner", "type": "address" },
      { "internalType": "address", "name": "spender", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];
const CHAIN_ID = 42161;
const web3 = new Web3(new Web3.providers.HttpProvider(INFURA_URL));
const PRIVATE_KEY = process.env.PRIVATE_KEY;
//const providerA = new JsonRpcProvider("https://arb-mainnet.g.alchemy.com/v2/TNqLsUr-1r20DnYhBhHqghjNlcZpQYNw");
const provider = new JsonRpcProvider(process.env.INFURA_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const REDIS_HOST = process.env.REDIS_HOST || 'redis-14324.c232.us-east-1-2.ec2.redns.redis-cloud.com';
const REDIS_PORT = process.env.REDIS_PORT || 14324;
const REDIS_USERNAME = process.env.REDIS_USERNAME || 'default';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'mKdimdMjHQbVCzRx58wWRklG59fdsd4I';
const REDIS_TTL = 60; // Cache data for 1 minute
const redisClient = createClient({
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
  },
});
const nonce = await permit2Contract.methods.nonces(wallet.address).call();
const API_BASE_URL = `https://api.1inch.dev/price/v1.1`;
const API_BASE_URL1 = "https://api.1inch.dev/swap/v6.0";
const API_KEY = process.env.ONEINCH_API_KEY; // Set 1inch API Key in .env
// Constants and Configuration
const GO_BACKEND_URL = process.env.GO_BACKEND_URL || "http://humble-mindfulness-production.up.railway.app"; // Go service endpoint
const MARKET_DATA_INTERVAL_MS = 1 * 60 * 1000; // Every 1 minutes
const RETRY_LIMIT = 3;
const RETRY_DELAY = 1000;
const CACHE_DURATION = 5 * 60; // 5 minutes in seconds
const MAX_HOPS = 3;
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Max consecutive failures allowed
const errorSummary = new Map();
const ERROR_SUMMARY_INTERVAL = 2 * 60 * 1000; // 10 minutes
const queue = new PQueue({ concurrency: 1 });
// Load Smart Contract
const contract = new ethers.Contract(process.env.SMART_CONTRACT_ADDRESS, ABI, wallet);
const NETWORKS = {
    POLYGON: 137,
    ARBITRUM: 42161
};

 const TOKENS = {
    POLYGON: {
        USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"
    },
    ARBITRUM: {
        USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        USDT: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
        DAI: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
        WETH: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        WBTC: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"
    }
};

const PROFIT_THRESHOLD = 300; // Minimum $500 profit per trade
const TRADE_SIZE_USDC = 100000; // $100,000 per trade

// Initialize Permit2 contract instance
const permit2Contract = new web3.eth.Contract(permit2Abi, PERMIT2_ADDRESS);
// Initialize Express app
const app = express();
app.use(express.json());

// State Variables
let consecutiveFailures = 0;
let lastRequestTimestamp = 0; // Track the timestamp of the last API request
const setAsync = redisClient.set.bind(redisClient);
const getAsync = redisClient.get.bind(redisClient);

function addErrorToSummary(error, context = '') {
  const errorKey = `${error.message} | Context: ${context}`;
  const currentCount = errorSummary.get(errorKey) || 0;
  errorSummary.set(errorKey, currentCount + 1);
}

function validateEnvVars(requiredVars) {
  requiredVars.forEach((varName) => {
    if (!process.env[varName]) {
      throw new Error(`Environment variable ${varName} is not set.`);
    }
  });
}

validateEnvVars([
  "INFURA_URL",
  "PRIVATE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "REDIS_URL",
  "ONEINCH_API_KEY",
  "WALLET_ADDRESS",
  "SMART_CONTRACT_ADDRESS",
  "POLYGON_RPC",
  "ARBITRUM_RPC",
]);


async function fetchAndCache(key, fetchFn, duration = CACHE_DURATION) {
  try {
    const cachedData = await redisClient.get(key);
    if (cachedData) {
      console.log(`Cache hit for ${key}`);
      return JSON.parse(cachedData);
    }

    const data = await fetchFn();
    await redisClient.set(key, JSON.stringify(data), "EX", duration);
    console.log(`Cached data for ${key} for ${duration} seconds.`);
    return data;
  } catch (error) {
    console.error(`Error fetching or caching data for ${key}:`, error.message);
    throw error;
  }
}

// Utility Functions
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Error connecting to Redis:', err);
    process.exit(1);
  }
})();

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

async function retryRequest(fn, retries = RETRY_LIMIT, delay = RETRY_DELAY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(); // Attempt the operation
    } catch (err) {
      // Check if the error is due to rate-limiting (429 Too Many Requests)
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers['retry-after'], 10) || delay / 1000;
        log(`Rate-limited by API. Waiting for ${retryAfter} seconds before retrying...`, 'warn');
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt === retries) {
        throw err; // Rethrow the error after max retries
      } else {
        // Exponential backoff for other errors
        const backoff = delay * Math.pow(2, attempt - 1); // Exponential increase in delay
        log(`Retrying (${attempt}/${retries}) after ${backoff}ms: ${err.message}`, 'warn');
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw new Error('Maximum retry attempts exceeded.');
}

// Function to cache and fetch data from Redis
async function cachedFetch(key, fetchFn) {
  const cachedData = await redis.get(key);
  if (cachedData) {
    return JSON.parse(cachedData);
  }
  const freshData = await fetchFn();
  await redis.setex(key, REDIS_TTL, JSON.stringify(freshData));
  return freshData;
}

// Helper function for validating Ethereum addresses
function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function validateAddresses(addresses) {
  const invalidAddresses = addresses.filter((addr) => !isValidAddress(addr));
  if (invalidAddresses.length > 0) {
    throw new Error(`Invalid token addresses detected: ${invalidAddresses.join(", ")}`);
  }
}

axios.interceptors.request.use((config) => {
  console.log("Axios Request Config:", JSON.stringify(config, null, 2));
  return config;
});

// Function to Fetch Fusion+ Quote
async function getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
    try {
        const quote = await sdk.getQuote({
            srcChainId: NetworkEnum[srcChain],
            dstChainId: NetworkEnum[dstChain],
            srcTokenAddress: srcToken,
            dstTokenAddress: dstToken,
            amount: amount.toString()
        });

        console.log(`✅ Fusion+ Quote: ${quote}`);
        return quote;
    } catch (error) {
        console.error(`❌ Error fetching Fusion+ quote:`, error);
        return null;
    }
}


// 🚀 Fetch Token Prices (API-DOCUMENTED FORMAT)
async function fetchTokenPrices(network, tokens) {
    const tokenList = tokens.join(",").toLowerCase();
    const url = `${API_BASE_URL}/${network}/${tokenList}`;

    const config = {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
        },
        params: { currency: "USD" },
    };

    try {
        const response = await axios.get(url, config);
        return Object.fromEntries(
            Object.entries(response.data).map(([token, price]) => [token.toLowerCase(), parseFloat(price)])
        );
    } catch (error) {
        console.error(`Error fetching prices for ${network}:`, error.response?.data || error.message);
        return null;
    }
}

async function executeFusionSwap(srcToken, dstToken, amount) {
    console.log(`🚀 Executing Fusion+ Swap: ${srcToken} → ${dstToken}, Amount: ${amount}`);

    const srcChain = "ARBITRUM";
    const dstChain = "POLYGON";

    const quote = await getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount);
    if (!quote) {
        console.error("❌ Failed to fetch Fusion+ quote.");
        return;
    }

    const secretsCount = quote.getPreset().secretsCount;
    const secrets = Array.from({ length: secretsCount }).map(() => getRandomBytes32());
    const secretHashes = secrets.map((x) => HashLock.hashSecret(x));

    const hashLock = secretsCount === 1
        ? HashLock.forSingleFill(secrets[0])
        : HashLock.forMultipleFills(secretHashes);

    try {
        const order = await sdk.placeOrder(quote, {
            walletAddress: process.env.WALLET_ADDRESS,
            hashLock,
            secretHashes,
        });

        console.log(`✅ Fusion+ Swap Executed: Order ID - ${order.id}`);

        await sendTelegramMessage(`✅ **Cross-Chain Swap Completed**  
        🔹 **From:** ${srcChain} (${srcToken})  
        🔹 **To:** ${dstChain} (${dstToken})  
        🔹 **Amount:** ${amount}`);
    } catch (error) {
        console.error(`❌ Error executing Fusion+ swap:`, error);
    }
}

// Listen for SwapExecuted Event
contract.on("SwapExecuted", async (srcToken, dstToken, amount, returnAmount, timestamp) => {
    console.log(`🔥 Swap Completed: ${srcToken} → ${dstToken}, Amount: ${amount}`);
    
    // Execute cross-chain transfer via Fusion+
    await executeFusionSwap(srcToken, dstToken, returnAmount);
});


// 🚀 Fetch Prices for Both Chains (Using fetchTokenPrices)
async function fetchPricesForBothChains() {
    try {
        const responses = await Promise.all(
            Object.entries(NETWORKS).map(async ([name, network]) => {
                return { name, data: await fetchTokenPrices(network, Object.values(TOKENS[name])) };
            })
        );

        return Object.fromEntries(responses.map(({ name, data }) => [name, data]));
    } catch (error) {
        console.error("Error fetching prices:", error);
        return null;
    }
}

// Helper function for delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ✅ Rate-Limited API Request Function
async function rateLimitedRequest(fn, retries = 3, delay = RETRY_DELAY) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const now = Date.now();
            const timeSinceLastRequest = now - lastRequestTimestamp;

            if (timeSinceLastRequest < delay) {
                const waitTime = delay - timeSinceLastRequest;
                console.log(`⏳ Throttling API requests: Waiting ${waitTime}ms...`);
                await new Promise((resolve) => setTimeout(resolve, waitTime));
            }

            lastRequestTimestamp = Date.now(); // Update timestamp
            return await fn(); // Execute API request
        } catch (err) {
            if (err.response?.status === 429) {
                const retryAfter = parseInt(err.response.headers["retry-after"], 10) || delay / 1000;
                console.warn(`🚨 Rate-limited! Retrying in ${retryAfter} seconds...`);
                await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            } else if (attempt === retries) {
                console.error(`❌ Request failed after ${retries} retries:`, err.message);
                return null; // Return `null` instead of throwing to prevent crashes
            } else {
                const backoff = delay * Math.pow(2, attempt - 1); // Exponential backoff
                console.warn(`🔄 Retrying (${attempt}/${retries}) after ${backoff}ms due to error: ${err.message}`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
    }

    return null; // Return `null` if all retry attempts fail
}

// 🚀 Telegram Notification
async function sendTelegramTradeAlert(details) {
//const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const botTokenz = process.env.TELEGRAM_BOT_TOKEN;
 const chatId1 = process.env.TELEGRAM_CHAT_ID;
const urlx = `https://api.telegram.org/bot${botTokenz}/sendMessage`;
    const message1 = `
🚀 **Arbitrage Trade Executed** 🚀
💰 **Buy Network:** ${details.buyOn}
💵 **Token:** ${details.token}
📉 **Buy Price:** $${details.buyPrice}

📈 **Sell Network:** ${details.sellOn}
💵 **Token:** ${details.token}
📉 **Sell Price:** $${details.sellPrice}

✅ **Profit:** $${details.profit}
💰 **Trade Size:** $${TRADE_SIZE_USDC} USDC
    `;
    //await bot.telegram.sendMessage(chatId1, message);
  try {
    const response = await axios.post(urlx, {
      chat_id: chatId1,
      text: message1,
    });
    console.log('Telegram message sent:', response.data);
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

// Error Handling and Notifications
async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
    });
    console.log('Telegram message sent:', response.data);
     console.log("✅ Telegram Message Sent!");
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

async function handleCriticalError(error, context = '') {
  log(`Critical Error: ${error.message} ${context}`, 'error');
  addErrorToSummary(error, context);
  // Send immediate Telegram notification for unique errors
  const errorKey = `${error.message} | Context: ${context}`;
  if (!errorSummary.has(errorKey)) {
    await sendTelegramMessage(`*Critical Error*:\n${error.message}\nContext: ${context}`, true);
  }
}

async function sendErrorSummary() {
  if (errorSummary.size === 0) {
    return; // No errors to summarize
  }

  let summaryMessage = '*Error Summary:*\n';
  errorSummary.forEach((count, error) => {
    summaryMessage += `- ${error}: ${count} occurrences\n`;
  });

  await sendTelegramMessage(summaryMessage, true);
  errorSummary.clear(); // Reset the summary map after sending
}

// Approving tokens using Permit2
async function generatePermitSignature(token, spender, amount, deadline) {
    const nonce = await permit2Contract.methods.nonces(wallet.address).call(); // ✅ Fetch nonce

    const domain = {
        name: "Permit2",
        version: "1",
        chainId: await wallet.getChainId(),
        verifyingContract: PERMIT2_ADDRESS
    };

    const permitData = {
        permitted: { token, amount },
        nonce,
        deadline
    };

    const types = {
        PermitTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" }
        ]
    };

    const signature = await wallet._signTypedData(domain, types, permitData);
    console.log("Signature:", signature);
    return { signature, permitData };
}


// Transferring tokens using Permit2
async function executePermitTransferFrom(token, recipient, amount, signature) {
    const tx = await permit2Contract.permitTransferFrom(
        {
            permitted: { token, amount },
            nonce: nonce, // Replace with actual nonce
            deadline: Math.floor(Date.now() / 1000) + 3600 // 1-hour validity
        },
        { to: recipient, requestedAmount: amount },
        wallet.address, // Owner's address
        signature
    );
    console.log("Transaction Hash:", tx.hash);
    await tx.wait();
    console.log("Transaction Confirmed!");
}

// Circuit-Breaker Logic
async function checkCircuitBreaker() {
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    log('Circuit breaker activated. Halting operations temporarily.', 'error');
    sendTelegramMessage('*Circuit Breaker Activated*: Too many consecutive failures.', true);

    // Wait 5 minutes before retrying
    await new Promise((resolve) => setTimeout(resolve, 300000));
    
    consecutiveFailures = 0; // Reset failure count
  }
}

// 🚀 Fetch Swap Quote (Using the Exact 1inch API Format)
// ✅ Fetch Swap Quote with Rate-Limiting & Null Handling
async function fetchSwapQuote(chain, fromToken, toToken, amount) {
    const url = `${API_BASE_URL1}/${chain}/quote`;
    const config = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: {
            src: fromToken,
            dst: toToken,
            amount,
            complexityLevel: 2,
            parts: 50,
            mainRouteParts: 10,
            includeTokensInfo: false,
            includeProtocols: true,
            includeGas: true,
        }
    };

    return await rateLimitedRequest(async () => {
        try {
            const response = await axios.get(url, config);
            if (!response.data || !response.data.dstAmount) {
                console.warn(`⚠️ Warning: Received invalid swap quote response for ${fromToken} -> ${toToken}`);
                return null;
            }
            return response.data.dstAmount;
        } catch (error) {
            console.error(`❌ Error fetching swap quote for ${fromToken} -> ${toToken}:`, error.message);
            return null;
        }
    });
}

// 🚀 Detect Arbitrage Opportunities
async function detectArbitrageOpportunities(arbitrumPrices, polygonPrices) {
    let opportunities = [];

    for (let token in TOKENS.POLYGON) {
        let arbPrice = arbitrumPrices[TOKENS.ARBITRUM[token]];
        let polyPrice = polygonPrices[TOKENS.POLYGON[token]];
        if (!arbPrice || !polyPrice) continue; // Skip if price data is missing

        // 🔹 Case 1: Buy on Polygon, Sell on Arbitrum
        if (arbPrice > polyPrice) {
            let profit = ((TRADE_SIZE_USDC / polyPrice) * arbPrice) - TRADE_SIZE_USDC;
            if (profit >= PROFIT_THRESHOLD) {
                try {
                    let buyAmount = await fetchSwapQuote(NETWORKS.POLYGON, TOKENS.POLYGON.USDC, TOKENS.POLYGON[token], TRADE_SIZE_USDC);
                    let sellAmount = await fetchSwapQuote(NETWORKS.ARBITRUM, TOKENS.ARBITRUM[token], TOKENS.ARBITRUM.USDC, buyAmount);
                    if (sellAmount > TRADE_SIZE_USDC) { // Ensure profitable after swap fees
                        const trade = {
                            token, 
                            buyOn: "Polygon", 
                            sellOn: "Arbitrum", 
                            profit, 
                            buyAmount, 
                            sellAmount 
                        };

                        opportunities.push(trade);
                        
                        // 🔹 Send Telegram Notification on Arbitrage Found
                        await sendTelegramTradeAlert({
                            title: "📢 Arbitrage Opportunity Found",
                            message: `💰 Buy on Polygon: $${polyPrice} | Sell on Arbitrum: $${arbPrice}
                            🏦 Expected Profit: $${profit}
                            🛒 Buy Amount: ${buyAmount} ${token} 
                            💵 Sell Amount: ${sellAmount} USDC`
                        });
                    }
                } catch (error) {
                    console.error(`❌ Error fetching swap quote for ${token} (Polygon -> Arbitrum):`, error);
                }
            }
        }

        // 🔹 Case 2: Buy on Arbitrum, Sell on Polygon
        if (polyPrice > arbPrice) {
            let profit = ((TRADE_SIZE_USDC / arbPrice) * polyPrice) - TRADE_SIZE_USDC;
            if (profit >= PROFIT_THRESHOLD) {
                try {
                    let buyAmount = await fetchSwapQuote(NETWORKS.ARBITRUM, TOKENS.ARBITRUM.USDC, TOKENS.ARBITRUM[token], TRADE_SIZE_USDC);
                    let sellAmount = await fetchSwapQuote(NETWORKS.POLYGON, TOKENS.POLYGON[token], TOKENS.POLYGON.USDC, buyAmount);
                    if (sellAmount > TRADE_SIZE_USDC) { // Ensure profitable after swap fees
                        const trade = {
                            token, 
                            buyOn: "Arbitrum", 
                            sellOn: "Polygon", 
                            profit, 
                            buyAmount, 
                            sellAmount 
                        };

                        opportunities.push(trade);

                        // 🔹 Send Telegram Notification on Arbitrage Found
                        await sendTelegramTradeAlert({
                            title: "📢 Arbitrage Opportunity Found",
                            message: `💰 Buy on Arbitrum: $${arbPrice} | Sell on Polygon: $${polyPrice}
                            🏦 Expected Profit: $${profit}
                            🛒 Buy Amount: ${buyAmount} ${token} 
                            💵 Sell Amount: ${sellAmount} USDC`
                        });
                    }
                } catch (error) {
                    console.error(`❌ Error fetching swap quote for ${token} (Arbitrum -> Polygon):`, error);
                }
            }
        }
    }

    return opportunities.sort((a, b) => b.profit - a.profit);
}

// 🔹 Execute Arbitrage Trade via Smart Contracts
async function executeSwap(trade) {
    const { token, buyOn, sellOn, buyAmount, sellAmount } = trade;

    console.log(`⚡ Executing Arbitrage Trade ⚡`);
    console.log(`BUY on ${buyOn}: ${buyAmount} of ${token}`);
    console.log(`SELL on ${sellOn}: ${sellAmount} of ${token}`);

    // 🔹 Send Telegram Notification before Execution
    await sendTelegramTradeAlert({
        title: "🚀 Executing Arbitrage Trade",
        message: `🔹 Buy on ${buyOn}: ${buyAmount} of ${token}
        🔹 Sell on ${sellOn}: ${sellAmount} of ${token}`
    });

    // 🔹 Dynamically Select the Correct Contract
    const buyContract = buyOn === "Polygon" ? polygonContract : arbitrumContract;
    const sellContract = sellOn === "Polygon" ? polygonContract : arbitrumContract;

    try {
        // 🔹 1️⃣ Execute Buy on First Chain (Flash Loan + Swap)
        console.log(`🔹 Requesting flash loan & executing buy on ${buyOn}...`);
        const buyTx = await buyContract.executeFlashLoanAndSwap(
            TOKENS[buyOn].USDC, 
            TOKENS[buyOn][token], 
            buyAmount
        );
        await buyTx.wait();
        console.log(`✅ Buy Transaction Confirmed on ${buyOn}`);

        // 🔹 2️⃣ Execute Sell on Second Chain (Swap + Repay Flash Loan)
        console.log(`🔹 Selling & repaying loan on ${sellOn}...`);
        const sellTx = await sellContract.executeSwapAndRepay(
            TOKENS[sellOn][token], 
            TOKENS[sellOn].USDC, 
            sellAmount
        );
        await sellTx.wait();
        console.log(`✅ Sell Transaction Confirmed on ${sellOn}`);

        // 🔹 3️⃣ Execute Fusion+ Swap for Loan Repayment
        try {
            console.log(`🚀 Executing Fusion+ Swap for Loan Repayment...`);
            await executeFusionSwap(TOKENS[sellOn].USDC, TOKENS[buyOn].USDC, sellAmount);
        } catch (error) {
            console.error("❌ Error executing Fusion+ swap for loan repayment:", error);
            await sendTelegramMessage(`🚨 **Warning:** Loan repayment swap failed. Manual intervention required.`);
        }

        // 🔹 Send Telegram Notification on Successful Trade
        await sendTelegramTradeAlert({
            title: "✅ Arbitrage Trade Completed!",
            message: `🏆 Successfully completed arbitrage trade!
            ✅ Bought ${buyAmount} of ${token} on ${buyOn}
            ✅ Sold ${sellAmount} of ${token} on ${sellOn}
            💰 Profit: $${trade.profit}`
        });

        console.log("🎉 Arbitrage Trade Completed Successfully!");

    } catch (error) {
        console.error(`❌ Error executing arbitrage trade:`, error);
        
        // 🔹 Send Telegram Notification on Failure
        await sendTelegramTradeAlert({
            title: "❌ Arbitrage Trade Failed!",
            message: `🚨 An error occurred during execution:
            ❌ ${error.message}`
        });
    }
}

async function notifyMonitoringSystem(message) {
  const monitoringServiceUrl = process.env.MONITORING_SERVICE_URL;

  // Validate the monitoring system URL
  if (!monitoringServiceUrl) {
    console.error("Monitoring system URL is not configured. Ensure MONITORING_SERVICE_URL is set in the environment.");
    throw new Error("Monitoring system URL is not configured.");
  }

  // Payload structure for the monitoring system
  const payload = {
    timestamp: new Date().toISOString(),
    severity: "error",
    message,
  };

  // Retry mechanism with exponential backoff
  const maxRetries = 3;
  let delay = 1000; // Initial retry delay in ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(monitoringServiceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      // Check if the response is successful
      if (response.ok) {
        console.log("Monitoring system notified successfully.");
        return; // Exit the function if successful
      }

      // Log error details from the response
      const responseBody = await response.text();
      console.error(`Monitoring system error: Status ${response.status}, Body: ${responseBody}`);

      throw new Error(`Monitoring system responded with status ${response.status}`);
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt === maxRetries) {
        console.error("All retry attempts to notify the monitoring system have failed.");
        throw error; // Rethrow after the final attempt
      }

      console.log(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

// 🚀 Execute Arbitrage Trade
async function executeArbitrage() {
    console.log("🔍 Fetching latest prices...");
    const prices = await fetchPricesForBothChains();
    if (!prices) {
        console.log("❌ Failed to fetch prices. Exiting...");
        return;
    }

    console.log("🔍 Detecting arbitrage opportunities...");
    const opportunities = await detectArbitrageOpportunities(prices.ARBITRUM, prices.POLYGON);
    if (opportunities.length === 0) {
        console.log("⚠️ No profitable arbitrage opportunities found.");
        return;
    }

    // Select the most profitable trade
    const bestTrade = opportunities[0];

    console.log(`🚀 Executing arbitrage trade: Buy on ${bestTrade.buyOn}, Sell on ${bestTrade.sellOn}`);
    await sendTelegramTradeAlert(bestTrade);

    try {
        // 🔹 Define provider & wallet for both networks
        const providerBuy = new ethers.providers.JsonRpcProvider(
            bestTrade.buyOn === "Polygon" ? process.env.POLYGON_RPC : process.env.ARBITRUM_RPC
        );
        const providerSell = new ethers.providers.JsonRpcProvider(
            bestTrade.sellOn === "Polygon" ? process.env.POLYGON_RPC : process.env.ARBITRUM_RPC
        );

        const walletBuy = new ethers.Wallet(process.env.PRIVATE_KEY, providerBuy);
        const walletSell = new ethers.Wallet(process.env.PRIVATE_KEY, providerSell);

        // 🔹 Execute Buy Transaction (Flash Loan + Swap)
        console.log(`🔹 Requesting flash loan & executing buy on ${bestTrade.buyOn}...`);
        await executeSwap(
            bestTrade.buyOn === "Polygon" ? NETWORKS.POLYGON : NETWORKS.ARBITRUM,
            TOKENS[bestTrade.buyOn].USDC,
            TOKENS[bestTrade.buyOn][bestTrade.token],
            bestTrade.buyAmount,
            walletBuy
        );
        console.log(`✅ Buy executed successfully on ${bestTrade.buyOn}`);

        // 🔹 Execute Sell Transaction (Swap & Repay Loan)
        console.log(`🔹 Selling & repaying loan on ${bestTrade.sellOn}...`);
        await executeSwap(
            bestTrade.sellOn === "Polygon" ? NETWORKS.POLYGON : NETWORKS.ARBITRUM,
            TOKENS[bestTrade.sellOn][bestTrade.token],
            TOKENS[bestTrade.sellOn].USDC,
            bestTrade.sellAmount,
            walletSell
        );
        console.log(`✅ Sell executed successfully on ${bestTrade.sellOn}`);

        console.log("🎉 Arbitrage trade completed successfully!");

        // 🔹 Execute Cross-Chain Swap for Flash Loan Repayment
        try {
            console.log(`🚀 Executing Fusion+ Swap for Loan Repayment...`);
            await executeFusionSwap(
                TOKENS[bestTrade.sellOn].USDC, 
                TOKENS[bestTrade.buyOn].USDC, 
                bestTrade.sellAmount
            );
            console.log(`✅ Fusion+ Swap for Loan Repayment executed successfully!`);
        } catch (error) {
            console.error("❌ Error executing Fusion+ swap for loan repayment:", error);
            await sendTelegramMessage(`🚨 **Warning:** Loan repayment swap failed. Manual intervention required.`);
        }

    } catch (error) {
        console.error("❌ Error executing arbitrage trade:", error);
    }
}

// 🚀 Start the Bot
executeArbitrage();
