const dotenv = require("dotenv");
require("dotenv").config();

//dotenv.config(); // ✅ Load environment variables early
//const fetch = require("node-fetch"); // Ensure you have node-fetch installed
const express = require("express");
const axios = require("axios");
const Web3 = require("web3");
const BigNumber = require("bignumber.js");
const retry = require("async-retry");
//const PQueue = require("p-queue");
const Redis = require("ioredis");
const { createClient } = require("redis");
const { ethers, Wallet, JsonRpcProvider, Contract } = require("ethers");
const cron = require("node-cron");
const { promisify } = require("util");
const pkg = require("telegraf");
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const redis = require("redis"); // Ensure Redis client is properly initialized
// 🔥 Trade Map to Track Executed Swaps
const tradeMap = new Map();
// ✅ Fix 1inch SDK Import for CommonJS
const { 
   SDK, 
   HashLock,  
   NetworkEnum,  
   OrderStatus,  
   PresetEnum,  
   PrivateKeyProviderConnector,
   QuoteParams
} = require("@1inch/cross-chain-sdk");

// const { HashLock, NetworkEnum, OrderStatus, PresetEnum, PrivateKeyProviderConnector, SDK } = require("@1inch/cross-chain-sdk");

const privateKey = process.env.PRIVATE_KEY;
// ✅ Ensure __dirname is defined in CommonJS
//const __dirname = path.resolve();
const polygonAbiPath = path.join(__dirname, "PolygonSmartContract.json");
const arbitrumAbiPath = path.join(__dirname, "ArbitrumSmartContract.json");


// ✅ Safely Read and Parse JSON Files
function safeLoadJson(filePath) {
    try {
        const fileContent = fs.readFileSync(filePath, "utf8");
        if (!fileContent.trim()) throw new Error("File is empty");
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`❌ Error parsing ${filePath}: ${error.message}`);
        return null;
    }
}

// ✅ Load Smart Contract ABIs
const POLYGON_ABI = safeLoadJson(polygonAbiPath);
const ARBITRUM_ABI = safeLoadJson(arbitrumAbiPath);
if (!POLYGON_ABI || !ARBITRUM_ABI) {
    console.error("🚨 Missing or invalid ABI files. Please check your JSON files.");
    process.exit(1); // Stop execution to prevent errors later
}

// ✅ Initialize SDK
const sdk = new SDK({
    url: "https://api.1inch.dev/fusion-plus",
    authKey: process.env.ONEINCH_API_KEY,  // ✅ Correctly assigned
    blockchainProvider: new PrivateKeyProviderConnector(privateKey, new Web3(process.env.INFURA_URL)), // ✅ Ensures `web3` is defined
});

dotenv.config();
const { Telegraf } = pkg;
const INFURA_URL = process.env.INFURA_URL;
const ERC20_ABI = [
    "function decimals() view returns (uint8)"
];

// Define contract addresses POLYGON_CONTRACT_ADDRESS ARBITRUM_CONTRACT_ADDRESS
const POLYGON_CONTRACT_ADDRESS = process.env.POLYGON_SMART_CONTRACT;
const ARBITRUM_CONTRACT_ADDRESS = process.env.ARBITRUM_SMART_CONTRACT;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS_MAIN;
// Define providers and wallets for both networks;
// const providerPolygon = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
// const providerArbitrum = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC);

const providerPolygon = new ethers.WebSocketProvider(process.env.POLYGON_WS);
const providerArbitrum = new ethers.WebSocketProvider(process.env.ARBITRUM_WS);


const walletPolygon = new ethers.Wallet(process.env.PRIVATE_KEY, providerPolygon);
const walletArbitrum = new ethers.Wallet(process.env.PRIVATE_KEY, providerArbitrum);

// Load Smart Contracts for both networks polygonContract arbitrumContract
const DEBUG_MODE = process.env.DEBUG === "true";
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

//const nonce = await permit2Contract.nonces(wallet.address);

const API_BASE_URL = `https://api.1inch.dev/price/v1.1`;
const API_BASE_URL1 = `https://api.1inch.dev/swap/v6.0`;
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
// Load Smart Contract
//const contract = new ethers.Contract(process.env.POLYGON_CONTRACT_ADDRESS, ABI, wallet);
//const contract1 = new ethers.Contract(process.env.ARBITRUM_SMART_CONTRACT, ABI, wallet);
const NETWORKS = {
    POLYGON: 137,
    ARBITRUM: 42161
};

const TOKENS = {
    POLYGON: [
        { name: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
        { name: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
        { name: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" }
    ],
    ARBITRUM: [
        { name: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
        { name: "WETH", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
        { name: "WBTC", address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f" }
    ]
};

// Token decimals mapping (Polygon, Arbitrum)
// ✅ Polygon Tokens // ✅ Arbitrum Tokens
const TOKEN_DECIMALS = {
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": 6,  // USDC (Polygon)
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": 18, // WETH (Polygon)
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": 8,  // WBTC (Polygon)
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": 6,  // USDC (Arbitrum)
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH (Arbitrum)
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": 8   // WBTC (Arbitrum)
};

const PROFIT_THRESHOLD = 200; // Minimum $500 profit per trade
const TRADE_SIZE_USDC = 110000; // $110,000 per trade

// Initialize Permit2 contract instance
const permit2Contract = new web3.eth.Contract(permit2Abi, PERMIT2_ADDRESS);
// Initialize Express app
const app = express();
app.use(express.json());

let fetch;
(async () => {
  fetch = (await import("node-fetch")).default;
})();



// State Variables
let consecutiveFailures = 0;
let lastRequestTimestamp = 0; // Track the timestamp of the last API request
const setAsync = redisClient.set.bind(redisClient);
const getAsync = redisClient.get.bind(redisClient);
//const queue = new PQueue({ concurrency: 1 });

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
  "POLYGON_SMART_CONTRACT",
  "ARBITRUM_SMART_CONTRACT",
  "POLYGON_RPC",
  "ARBITRUM_RPC",
]);

// ✅ Use dynamic import() for node-fetch in CommonJS
async function getFetchModule() {
  const fetchModule = await import("node-fetch"); // ✅ Use dynamic import
  return fetchModule.default;
}

async function initialize() {
    try {
        // Dynamically import p-queue
  const { default: PQueue } = await import('p-queue');

  // Now you can use PQueue as usual
  const queue = new PQueue({ concurrency: 1 });

        const nonce = await permit2Contract.nonces(wallet.address); // ✅ Fix: Wrapped in async function
        console.log(`Nonce: ${nonce}`);
    } catch (error) {
        console.error("Error initializing script:", error);
    }
}

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

async function retryRequest(fn, retries = 5, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn(); // ✅ Attempt request
        } catch (err) {
            if (err.response?.status === 429) {
                // ✅ Handle rate limiting (Retry-After Header)
                const retryAfter = parseInt(err.response.headers['retry-after'], 10) || delay / 1000;
                console.warn(`[WARN] Rate-limited by API. Waiting for ${retryAfter} seconds before retrying...`);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            } else if (attempt === retries) {
                console.error("❌ Max retries reached. Request failed.");
                throw err;
            } else {
                // ✅ Exponential Backoff for Other Errors
                const backoff = delay * Math.pow(2, attempt - 1);
                console.warn(`[WARN] Retrying (${attempt}/${retries}) after ${backoff}ms: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    }
}

// ✅ Corrected cachedFetch function
async function cachedFetch(key, fetchFn) {
    try {
        const cachedData = await redisClient.get(key);
        if (cachedData) {
            try {
                const parsedData = JSON.parse(cachedData);
                return parsedData;
            } catch (jsonError) {
                console.error(`❌ Error parsing cached data for ${key}:`, jsonError.message);
                await redisClient.del(key); // ✅ Delete corrupted cache entry
            }
        }

        console.log(`❌ Cache miss for ${key}. Fetching fresh data...`);

        // ✅ Ensure `fetch` is loaded dynamically
        if (!fetch) {
            fetch = (await import("node-fetch")).default;
        }

        const freshData = await fetchFn(fetch);
        if (!freshData) {
            throw new Error(`❌ Fetch function returned empty data for ${key}`);
        }

        await redisClient.setex(key, 60, JSON.stringify(freshData));
        return freshData;
    } catch (error) {
        console.error(`❌ Error in cachedFetch(${key}):`, error.message);
        throw error;
    }
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
    if (DEBUG_MODE) {
        // ✅ Mask Sensitive Data
        const sanitizedConfig = { ...config };
        if (sanitizedConfig.headers && sanitizedConfig.headers.Authorization) {
            sanitizedConfig.headers.Authorization = `Bearer ${process.env.ONEINCH_API_KEY}`; // Hide API Key
        }

        console.log("📡 Axios Request Config:", JSON.stringify(sanitizedConfig, null, 2));
    }

    return config;
});

/**
 * 📡 Fetch a Fusion+ Quote for Cross-Chain Swaps
 * @param {string} srcChain - Name of the source chain ("Polygon" or "Arbitrum")
 * @param {string} dstChain - Name of the destination chain ("Polygon" or "Arbitrum")
 * @param {string} srcToken - Source token address
 * @param {string} dstToken - Destination token address
 * @param {string} amount - Trade amount (already formatted in smallest unit)
 * @returns {Promise<{ receivedAmount: string, quoteData: object } | null>}
 */
async function fetchFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
    console.log(`📡 Fetching Fusion+ Quote: ${srcChain} → ${dstChain}, Amount: ${amount}`);

    const srcChainID = srcChain;
    const dstChainID = dstChain;

    if (!srcChain || !dstChain) {
        console.error(`❌ Invalid Chain Names! Source: ${srcChain}, Destination: ${dstChain}`);
        return null;
    }

    console.log(`🔹 Extracted Chain IDs → Source: ${srcChainID}, Destination: ${dstChainID}`);

    // ✅ Respect 1inch 1RPS limit
    await delay(1000);

    // ✅ Fetch the Fusion+ Quote using extracted Chain IDs
    const fusionQuote = await getFusionQuote(srcChainID, dstChainID, srcToken, dstToken, amount);
    if (!fusionQuote) {
        console.error("❌ Failed to fetch Fusion+ quote");
        return null;
    }

    // ✅ Extract expected received amount
    let expectedDstAmount = parseFloat(fusionQuote.dstTokenAmount);

    console.log(`✅ Fusion+ Quote Received: ${expectedDstAmount} ${dstToken}`);

    return {
        receivedAmount: expectedDstAmount, // ✅ Full amount received
        quoteData: fusionQuote
    };
}

/**
 * 📡 Get Fusion+ Quote from 1inch API
 * @param {number} srcChainID - Source chain ID
 * @param {number} dstChainID - Destination chain ID
 * @param {string} srcToken - Source token address
 * @param {string} dstToken - Destination token address
 * @param {string} amount - Trade amount (already in smallest unit format)
 * @returns {Promise<object | null>} - Quote response from API
 */
// 🚀 Fusion+ Quote Function (Dynamic)

// ✅ Store Last API Call Time to Enforce Rate Limiting
let lastFusionQuoteTimestamp = 0;

async function getFusionQuote(srcChainID, dstChainID, srcToken, dstToken, amountInWei) {
    const url = "https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/build";

    // ✅ Ensure API Key and Wallet Address
    const API_KEY = process.env.ONEINCH_API_KEY?.trim();
    const walletAddress = process.env.WALLET_ADDRESS_MAIN?.trim();

    if (!API_KEY || !walletAddress) {
        console.error("❌ Missing API Key or Wallet Address. Cannot proceed.");
        return null;
    }

    console.log(`📡 Requesting Fusion+ Quote: ${srcChainID} → ${dstChainID}, Amount (Wei): ${amountInWei}`);

    // ✅ Convert Amount from Wei to Decimal Format
    const srcTokenDecimals = TOKEN_DECIMALS[srcToken] || 18;
    const amountInTokenUnits = parseFloat(amountInWei) / 10 ** srcTokenDecimals;
    const finalAmountInWei = Math.floor(amountInTokenUnits * 10 ** srcTokenDecimals).toString();

    console.log(`🔹 Final Amount in Wei to Send to API: ${finalAmountInWei}`);

    // ✅ Fusion+ API Request Payload (following 1inch Docs)
    const payload = {
        quote: {
            quoteId: "custom_quote_id",
            srcTokenAmount: finalAmountInWei,
            dstTokenAmount: "", // API will fill this based on the best quote
            walletAddress: walletAddress,
            srcTokenAddress: srcToken,
            dstTokenAddress: dstToken,
            srcChain: srcChainID,
            dstChain: dstChainID,
            presets: {
                fair: {
                    auctionDuration: 360, // 6-minute auction
                    initialRateBump: 1000,
                    auctionStartAmount: finalAmountInWei,
                    startAmount: finalAmountInWei,
                    auctionEndAmount: finalAmountInWei,
                    allowPartialFills: true,
                    allowMultipleFills: true
                }
            },
            timeLocks: {
                srcWithdrawal: 180,
                dstWithdrawal: 180
            },
            recommendedPreset: "fair"
        },
        secretsHashList: [
            "0x315b47a8c3780434b153667588db4ca628526e20000000000000000000000000"
        ]
    };

    // ✅ API Request Headers
    const headers = {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
    };

    try {
        const response = await axios.post(url, payload, { headers });
        console.log(`✅ Fusion+ Quote Received:`, response.data);

        if (!response.data.presets) {
            console.error(`❌ Fusion+ Quote Failed: No preset data returned.`);
            return null;
        }

        // ✅ Extract `auctionEndAmount` correctly for final swap estimation
        const dstAmount = response.data.presets?.fair?.auctionEndAmount;

        if (!dstAmount) {
            console.warn(`⚠️ Warning: Could not retrieve auctionEndAmount.`);
            return null;
        }

        console.log(`🔹 Estimated Received Amount on ${dstChainID}: ${dstAmount}`);
        return response.data;
    } catch (error) {
        console.error(`❌ Fusion+ API Error:`, error.response?.data || error.message);
        return null;
    }
}



// 🚀 Fetch Token Prices (API-DOCUMENTED FORMAT)
async function fetchTokenPrices(networkId, tokenAddresses) {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
        console.error(`❌ No valid token addresses for network ${networkId}. Skipping request.`);
        return { networkId, prices: {} };
    }

    // ✅ Ensure addresses are properly formatted in URL
    const tokenList = tokenAddresses.filter(Boolean).map(addr => addr.toLowerCase()).join(",");
    const url = `${API_BASE_URL}/${networkId}/${tokenList}`;

    const config = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: { currency: "USD" },
    };

    let retries = 5;
    let delay = 1000; // Start with a 1-second delay
    while (retries > 0) {
        try {
            console.log(`📡 Fetching prices for network ${networkId}...`);

            const response = await axios.get(url, config);
            const responseData = response.data;

            console.log(`✅ Raw API Response:`, responseData);

            // ✅ Extract token addresses and corresponding prices directly from responseData
            const prices = {};
            for (const [tokenAddress, price] of Object.entries(responseData)) {
                if (price && !isNaN(price)) {
                    prices[tokenAddress.toLowerCase()] = parseFloat(price);
                }
            }

            if (Object.keys(prices).length === 0) {
                console.warn(`⚠️ No valid price data received for network ${networkId}. Retrying...`);
                retries--;
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
                continue;
            }

            console.log(`✅ Successfully fetched prices for network ${networkId}`);
            return { networkId, prices };
        } catch (error) {
            if (error.response?.status === 429) {
                console.warn(`🚨 Rate-limited by API. Waiting before retrying...`);
                await new Promise(resolve => setTimeout(resolve, delay * 1.5)); // Slightly increase wait time
            } else {
                console.error(`❌ Error fetching prices for ${networkId}: ${error.message}`);
            }

            retries--;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }

    console.error(`❌ Failed to fetch valid price data for network ${networkId} after multiple retries.`);
    return { networkId, prices: {} };
}


/**
 * 🔥 **Fusion+ Cross-Chain Swap Execution**
 */

// 🔥 Listen for Swap Events on Both Contracts
arbitrumContract.on("SwapExecuted", (srcToken, dstToken, amount, returnAmount, timestamp) =>
    handleSwapExecuted(srcToken, dstToken, amount, returnAmount, timestamp, "Arbitrum")
);

polygonContract.on("SwapExecuted", (srcToken, dstToken, amount, returnAmount, timestamp) =>
    handleSwapExecuted(srcToken, dstToken, amount, returnAmount, timestamp, "Polygon")
);

// 🚀 Fetch Prices for Both Chains (Using fetchTokenPrices)

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
async function sendTelegramTradeAlert(tradeDetails) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    if (!tradeDetails || typeof tradeDetails !== "object") {
        console.error("❌ Invalid trade details. Cannot send Telegram alert.");
        return;
    }

    // ✅ Extract trade details safely
    const {
        token = "N/A",
        buyOn = "N/A",
        sellOn = "N/A",
        buyAmount = "0",
        sellAmount = "0",
        profit = "0",
    } = tradeDetails;

    // ✅ Ensure numeric values are correctly formatted
    const formattedBuyAmount = parseFloat(buyAmount).toFixed(2);
    const formattedSellAmount = parseFloat(sellAmount).toFixed(2);
    const formattedProfit = parseFloat(profit).toFixed(2);

    // ✅ Construct message correctly
    const message = `
title: "✅ Arbitrage Trade Completed!",
                    message: `🏆 Successfully completed arbitrage trade!
                    ✅ Bought ${bestTrade.buyAmount} USDC of ${bestTrade.token} on ${bestTrade.buyOn}
                    ✅ Sold ${bestTrade.sellAmount} of ${bestTrade.token} on ${bestTrade.sellOn}
                    💰 Profit: $${bestTrade.profit}`
    `;

    if (!botToken || !chatId) {
        console.error("❌ Telegram bot token or chat ID is missing. Cannot send trade alert.");
        return;
    }

    try {
        const response = await axios.post(url, {
            chat_id: chatId,
            text: message.trim(), // ✅ Ensure proper formatting
        });

        console.log("✅ Telegram trade alert sent successfully:", response.data);
    } catch (error) {
        console.error("❌ Failed to send Telegram trade alert:", error.message);
    }
}


// Error Handling and Notifications
async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  if (!botToken || !chatId) {
    console.error("❌ Telegram bot token or chat ID is missing. Cannot send message.");
    return;
  }
  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
    });
    console.log("✅ Telegram message sent:", response.data);
  } catch (error) {
    console.error("❌ Failed to send Telegram message:", error.message);
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
    //const nonce = await permit2Contract.methods.nonces(wallet.address).call(); // ✅ Fetch nonce
   const nonce = await permit2Contract.nonces(wallet.address);

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
async function fetchSwapQuote(networkId, fromToken, toToken, amount, protocolToInclude) {
    console.log(`📡 Fetching swap quote on ${networkId} for ${amount} ${fromToken} → ${toToken} via ${protocolToInclude}...`);

    // ✅ Ensure token decimal mapping exists
    if (!TOKEN_DECIMALS[fromToken] || !TOKEN_DECIMALS[toToken]) {
        console.error(`❌ Missing token decimal mapping for ${fromToken} or ${toToken}`);
        return null;
    }

    // ✅ Convert amount to Wei if necessary
    let amountInWei = BigInt(amount * 10 ** TOKEN_DECIMALS[fromToken]).toString();
    console.log(`🔹 Amount in Wei: ${amountInWei}`);

    // ✅ Full List of Available Protocols from Your Data
    const AVAILABLE_PROTOCOLS = [
        "ARBITRUM_BALANCER_V2", "ARBITRUM_SUSHISWAP", "ARBITRUM_UNISWAP_V3", "ARBITRUM_CURVE",
        "ARBITRUM_CURVE_V2", "ARBITRUM_ONE_INCH_LIMIT_ORDER", "ARBITRUM_ONE_INCH_LIMIT_ORDER_V2",
        "ARBITRUM_ONE_INCH_LIMIT_ORDER_V3", "ARBITRUM_ONE_INCH_LIMIT_ORDER_V4", "ARBITRUM_DODO",
        "ARBITRUM_DODO_V2", "ARBITRUM_DXSWAP", "ARBITRUM_GMX", "ARBITRUM_SYNAPSE", "ARBITRUM_SADDLE",
        "ARBITRUM_KYBERSWAP_ELASTIC", "ARBITRUM_KYBER_DMM_STATIC", "ARBITRUM_AAVE_V3", "ARBITRUM_ELK",
        "ARBITRUM_WOOFI_V2", "ARBITRUM_CAMELOT", "ARBITRUM_TRADERJOE", "ARBITRUM_TRADERJOE_V2",
        "ARBITRUM_TRADERJOE_V2_2", "ARBITRUM_SWAPFISH", "ARBITRUM_ZYBER", "ARBITRUM_ZYBER_STABLE",
        "ARBITRUM_SOLIDLIZARD", "ARBITRUM_ZYBER_V3", "ARBITRUM_MYCELIUM", "ARBITRUM_TRIDENT",
        "ARBITRUM_SHELL_OCEAN", "ARBITRUM_RAMSES", "ARBITRUM_TRADERJOE_V2_1", "ARBITRUM_NOMISWAPEPCS",
        "ARBITRUM_CAMELOT_V3", "ARBITRUM_WOMBATSWAP", "ARBITRUM_CHRONOS", "ARBITRUM_LIGHTER",
        "ARBITRUM_ARBIDEX", "ARBITRUM_ARBIDEX_V3", "ARBSWAP", "ARBSWAP_STABLE", "ARBITRUM_SUSHISWAP_V3",
        "ARBITRUM_RAMSES_V2", "ARBITRUM_LEVEL_FINANCE", "ARBITRUM_CHRONOS_V3", "ARBITRUM_PANCAKESWAP_V3",
        "ARBITRUM_PMM11", "ARBITRUM_DODO_V3", "ARBITRUM_SMARDEX", "ARBITRUM_INTEGRAL",
        "ARBITRUM_DFX_FINANCE_V3", "ARBITRUM_CURVE_STABLE_NG", "ARBITRUM_VIRTUSWAP",
        "ARBITRUM_CURVE_V2_TRICRYPTO_NG", "ARBITRUM_CURVE_V2_TWOCRYPTO_NG", "ARBITRUM_BGD_AAVE_STATIC",
        "ARBITRUM_SOLIDLY_V3", "ARBITRUM_ANGLE", "ARBITRUM_MAVERICK_V2", "ARBITRUM_UNISWAP_V4",
        "ARBITRUM_FLUID_DEX_T1"
    ];

    // ✅ Exclude all protocols except the selected one
    const EXCLUDED_PROTOCOLS = AVAILABLE_PROTOCOLS.filter(protocol => protocol !== protocolToInclude).join(',');

    const url = `${API_BASE_URL1}/${networkId}/quote`;
    const config = {
        headers: { "Authorization": "Bearer DAqqEXsx5pIazLLOf1QcjJu3KmQhB8pr" },
        params: {
            src: fromToken,
            dst: toToken,
            amount: amountInWei,
            complexityLevel: 3,
            parts: 100,
            mainRouteParts: 50,
            includeTokensInfo: false,
            includeProtocols: true,
            includeGas: true,
            excludedProtocols: EXCLUDED_PROTOCOLS
        }
    };

    // ✅ Attempt fetching price with retries
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, config);
            if (response.data?.dstAmount) {
                const price = parseFloat(response.data.dstAmount) / 1e6; // Convert from USDC Wei
                console.log(`✅ ${protocolToInclude} Swap Quote: ${price.toFixed(2)} USDC`);
                return price;
            }
        } catch (error) {
            console.warn(`⚠️ Attempt ${attempt} failed: ${error.response?.data?.error || error.message}. Retrying...`);
            await delay(2000 * attempt);
        }
    }

    console.error(`❌ Failed to fetch swap quote after 3 attempts.`);
    return null;
}


// async function fetchSwapQuote(networkId, fromToken, toToken, amount) {
//     console.log(`📡 Fetching swap quote on network ${networkId} for ${amount} ${fromToken} → ${toToken}...`);

//     // ✅ Ensure token decimal mapping exists
//     if (!TOKEN_DECIMALS[fromToken]) {
//         console.error(`❌ Token decimal mapping missing for ${fromToken}`);
//         return null;
//     }

//     if (!TOKEN_DECIMALS[toToken]) {
//         console.error(`❌ Token decimal mapping missing for ${toToken}`);
//         return null;
//     }

//     // ✅ Determine if amount is already in Wei (i.e., large number)
//     let amountInWei;
//     if (BigInt(amount) < BigInt(10 ** TOKEN_DECIMALS[fromToken])) {
//         // Convert only if it's not already in Wei
//         amountInWei = BigInt(Math.floor(amount * 10 ** TOKEN_DECIMALS[fromToken])).toString();
//         console.log(`🔹 Converted Amount to Wei: ${amountInWei} (smallest unit)`);
//     } else {
//         // Assume amount is already in Wei
//         amountInWei = amount.toString();
//         console.log(`🔹 Amount is already in Wei: ${amountInWei}`);
//     }

//     const url = `${API_BASE_URL1}/${networkId}/quote`;

//     const config = {
//         headers: { "Authorization": "Bearer DAqqEXsx5pIazLLOf1QcjJu3KmQhB8pr" },
//         params: {
//             src: fromToken,
//             dst: toToken,
//             amount: amountInWei, // ✅ Correct field name and format
//             complexityLevel: 3,
//             parts: 100,
//             mainRouteParts: 50,
//             includeTokensInfo: false,
//             includeProtocols: true,
//             includeGas: true
//         }
//     };

//     for (let attempt = 1; attempt <= 3; attempt++) {
//         try {
//             const response = await axios.get(url, config);
//             if (response.data?.dstAmount) {
//                 console.log(`✅ Swap Quote: Expected ${response.data.dstAmount} ${toToken}`);
//                 return response.data.dstAmount;
//             }
//         } catch (error) {
//             console.warn(`⚠️ Swap quote fetch attempt ${attempt} failed: ${error.response?.data?.error || error.message}. Retrying...`);
//             await delay(2000 * attempt); // Exponential backoff
//         }
//     }

//     console.error(`❌ Failed to fetch swap quote after 3 attempts.`);
//     return null;
// }

function convertToWei(amount, token) {
    const tokenDecimals = TOKEN_DECIMALS[token.toLowerCase()];
    if (!tokenDecimals) {
        throw new Error(`❌ Missing token decimal for ${token}`);
    }

    // ✅ Multiply by decimals & floor to ensure it's an integer
    return BigInt(Math.floor(amount * 10 ** tokenDecimals));
}

// 🚀 Detect Arbitrage Opportunities


async function detectArbitrageOpportunities() {
    console.log("🔍 Detecting arbitrage opportunities on Uniswap, Sushiswap, Curve, and Balancer...");

    const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
    const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // USDC on Arbitrum
    const NETWORK_ID = 42161; // Arbitrum
    const CAPITAL_USDC = 150000; // Fixed trading capital

    const dexProtocols = {
        uniswap: "ARBITRUM_UNISWAP_V3",
        sushiswap: "ARBITRUM_SUSHISWAP",
        curve: "ARBITRUM_CURVE",
        balancer: "ARBITRUM_BALANCER_V2",
    };

    // ✅ Fetch Prices from All 4 DEXs
    const prices = await Promise.all([
        fetchSwapQuote(NETWORK_ID, WBTC, USDC, 1, dexProtocols.uniswap),
        fetchSwapQuote(NETWORK_ID, WBTC, USDC, 1, dexProtocols.sushiswap),
        fetchSwapQuote(NETWORK_ID, WBTC, USDC, 1, dexProtocols.curve),
        fetchSwapQuote(NETWORK_ID, WBTC, USDC, 1, dexProtocols.balancer),
    ]);

    const priceData = {
        uniswap: prices[0],
        sushiswap: prices[1],
        curve: prices[2],
        balancer: prices[3],
    };

    if (Object.values(priceData).some(price => price === null)) {
        console.error("❌ Missing price data from one or more DEXs. Skipping arbitrage detection.");
        return [];
    }

    console.log("✅ Fetched Prices:", priceData);

    let bestTrade = null;
    let maxProfit = 0;

    // ✅ Find the Best Buy and Sell DEX Combination
    for (let [buyDex, buyPrice] of Object.entries(priceData)) {
        for (let [sellDex, sellPrice] of Object.entries(priceData)) {
            if (buyDex === sellDex) continue; // Skip same DEX trades

            const tokensBought = CAPITAL_USDC / buyPrice;
            const sellAmount = tokensBought * sellPrice;
            const profit = sellAmount - CAPITAL_USDC;
            const profitMargin = (profit / CAPITAL_USDC) * 100;

            console.log(`🔄 ${buyDex} → ${sellDex} | Buy: $${buyPrice.toFixed(2)} | Sell: $${sellPrice.toFixed(2)} | Profit: $${profit.toFixed(2)} (${profitMargin.toFixed(2)}%)`);

            if (profit > 150) { // ✅ Minimum profit threshold (adjustable)
                if (profit > maxProfit) {
                    maxProfit = profit;
                    bestTrade = {
                        token: "WBTC",
                        buyOn: buyDex,
                        sellOn: sellDex,
                        buyAmount: CAPITAL_USDC.toFixed(2),
                        sellAmount: sellAmount.toFixed(2),
                        profit: profit.toFixed(2),
                        profitMargin: profitMargin.toFixed(2),
                    };
                }
            }
        }
    }

    if (bestTrade) {
        console.log(`🚀 Best Arbitrage Found! Buy on ${bestTrade.buyOn} at $${bestTrade.buyAmount}, Sell on ${bestTrade.sellOn} at $${bestTrade.sellAmount}. Profit: $${bestTrade.profit}`);
        return [bestTrade];
    } else {
        console.log("⚠️ No profitable arbitrage opportunity at the moment.");
        return [];
    }
}


// async function detectArbitrageOpportunities(pricesByNetwork) {
//     let opportunities = [];

//     if (!pricesByNetwork?.POLYGON || !pricesByNetwork?.ARBITRUM) {
//         console.error("❌ No valid price data. Skipping arbitrage detection...");
//         return opportunities;
//     }

//     const polygonPrices = pricesByNetwork.POLYGON?.prices ?? {};
//     const arbitrumPrices = pricesByNetwork.ARBITRUM?.prices ?? {};

//     if (Object.keys(polygonPrices).length === 0 || Object.keys(arbitrumPrices).length === 0) {
//         console.warn("⚠️ One or both networks have empty price data. Skipping arbitrage detection...");
//         return opportunities;
//     }

//     console.log("✅ Checking for arbitrage opportunities...");

//     if (!TOKENS?.POLYGON || !TOKENS?.ARBITRUM) {
//         console.error("❌ Token list is missing for one or both networks.");
//         return opportunities;
//     }

//     const usdcPolygon = TOKENS.POLYGON.find(t => t.name === "USDC");
//     const usdcArbitrum = TOKENS.ARBITRUM.find(t => t.name === "USDC");

//     if (!usdcPolygon || !usdcArbitrum) {
//         console.error("❌ USDC token missing on one or both networks.");
//         return opportunities;
//     }

//     const usdcPolygonPrice = polygonPrices[usdcPolygon.address.toLowerCase()];
//     const usdcArbitrumPrice = arbitrumPrices[usdcArbitrum.address.toLowerCase()];

//     if (!usdcPolygonPrice || !usdcArbitrumPrice) {
//         console.error("❌ USDC price missing on one or both networks.");
//         return opportunities;
//     }

//     console.log(`🔹 USDC Prices → Polygon: $${usdcPolygonPrice}, Arbitrum: $${usdcArbitrumPrice}`);

//     for (let token of TOKENS.POLYGON) {
//         const polygonToken = token;
//         const arbitrumToken = TOKENS.ARBITRUM.find(t => t.name === polygonToken.name);

//         if (!polygonToken || !arbitrumToken) {
//             console.warn(`⚠️ Skipping ${token.name}: No matching address on both networks`);
//             continue;
//         }

//         const polygonTokenPrice = polygonPrices[polygonToken.address.toLowerCase()];
//         const arbitrumTokenPrice = arbitrumPrices[arbitrumToken.address.toLowerCase()];

//         if (!polygonTokenPrice || !arbitrumTokenPrice) {
//             console.warn(`⚠️ Missing price data for ${token.name}`);
//             continue;
//         }

//         console.log(`🔹 ${token.name} Prices → Polygon: $${polygonTokenPrice}, Arbitrum: $${arbitrumTokenPrice}`);

//         // ✅ Case 1: Buy on Polygon, Sell on Arbitrum
//         const buyAmountPoly = 110000 / usdcPolygonPrice;
//         const tokensBoughtPoly = buyAmountPoly / polygonTokenPrice;
//         const sellAmountArb = tokensBoughtPoly * arbitrumTokenPrice;
//         const finalUSDCArb = sellAmountArb / usdcArbitrumPrice;
//         const estimatedProfitPolyToArb = finalUSDCArb - buyAmountPoly;

//         // ✅ Validate all values before pushing trade
//         if (
//             isNaN(buyAmountPoly) || isNaN(tokensBoughtPoly) || isNaN(sellAmountArb) ||
//             isNaN(finalUSDCArb) || isNaN(estimatedProfitPolyToArb) ||
//             buyAmountPoly <= 0 || tokensBoughtPoly <= 0 || finalUSDCArb <= 0
//         ) {
//             console.warn(`⚠️ Skipping trade due to invalid values: ${token.name}`);
//             continue;
//         }

//         console.log(`🔄 [DEBUG] Buy on Polygon → Sell on Arbitrum`);
//         console.log(`💰 Buy Amount: ${buyAmountPoly.toFixed(2)} USDC`);
//         console.log(`🛒 Tokens Bought: ${tokensBoughtPoly.toFixed(6)} ${token.name}`);
//         console.log(`💵 Sell Amount: ${sellAmountArb.toFixed(2)} USDC`);
//         console.log(`💵 Final USDC Output: ${finalUSDCArb.toFixed(2)} USDC`);
//         console.log(`💰 Estimated Profit: ${estimatedProfitPolyToArb.toFixed(2)} USDC (Threshold: $100)`);

//         if (estimatedProfitPolyToArb >= 100) {
//             opportunities.push({
//                 token: token.name,
//                 buyOn: "Polygon",
//                 sellOn: "Arbitrum",
//                 buyAmount: buyAmountPoly.toFixed(2),
//                 sellAmount: finalUSDCArb.toFixed(2),
//                 profit: estimatedProfitPolyToArb.toFixed(2),
//             });
//         }

//         // ✅ Case 2: Buy on Arbitrum, Sell on Polygon
//         const buyAmountArb = 110000 / usdcArbitrumPrice;
//         const tokensBoughtArb = buyAmountArb / arbitrumTokenPrice;
//         const sellAmountPoly = tokensBoughtArb * polygonTokenPrice;
//         const finalUSDCPly = sellAmountPoly / usdcPolygonPrice;
//         const estimatedProfitArbToPoly = finalUSDCPly - buyAmountArb;

//         // ✅ Validate all values before pushing trade
//         if (
//             isNaN(buyAmountArb) || isNaN(tokensBoughtArb) || isNaN(sellAmountPoly) ||
//             isNaN(finalUSDCPly) || isNaN(estimatedProfitArbToPoly) ||
//             buyAmountArb <= 0 || tokensBoughtArb <= 0 || finalUSDCPly <= 0
//         ) {
//             console.warn(`⚠️ Skipping trade due to invalid values: ${token.name}`);
//             continue;
//         }

//         console.log(`🔄 [DEBUG] Buy on Arbitrum → Sell on Polygon`);
//         console.log(`💰 Buy Amount: ${buyAmountArb.toFixed(2)} USDC`);
//         console.log(`🛒 Tokens Bought: ${tokensBoughtArb.toFixed(6)} ${token.name}`);
//         console.log(`💵 Sell Amount: ${sellAmountPoly.toFixed(2)} USDC`);
//         console.log(`💵 Final USDC Output: ${finalUSDCPly.toFixed(2)} USDC`);
//         console.log(`💰 Estimated Profit: ${estimatedProfitArbToPoly.toFixed(2)} USDC (Threshold: $100)`);

//         if (estimatedProfitArbToPoly >= 100) {
//             opportunities.push({
//                 token: token.name,
//                 buyOn: "Arbitrum",
//                 sellOn: "Polygon",
//                 buyAmount: buyAmountArb.toFixed(2),
//                 sellAmount: finalUSDCPly.toFixed(2),
//                 profit: estimatedProfitArbToPoly.toFixed(2),
//             });
//         }
//     }

//     console.log("✅ Detected Arbitrage Opportunities:", opportunities);
//     return opportunities.sort((a, b) => b.profit - a.profit);
// }


function convertFromWei(amountWei, token) {
    if (typeof token !== "string") {
        throw new Error(`❌ Invalid token address type. Expected string, received ${typeof token}`);
    }

    // ✅ Normalize token address by matching against stored keys
    const normalizedToken = Object.keys(TOKEN_DECIMALS).find(
        (key) => key.toLowerCase() === token.toLowerCase()
    );

    if (!normalizedToken) {
        throw new Error(`❌ Missing token decimal for ${token}`);
    }

    const tokenDecimals = TOKEN_DECIMALS[normalizedToken]; // Get decimals using matched key

    return Number(amountWei) / 10 ** tokenDecimals;
}


// 🔹 Execute Arbitrage Trade via Smart Contracts

/**
 * 🔥 **Arbitrage Execution Function**
 */

async function executeSwap(trade) {
    const { token, buyOn, sellOn, buyAmount, sellAmount } = trade;

    console.log(`⚡ Preparing Arbitrage Execution ⚡`);
    console.log(`BUY on ${buyOn}: ${buyAmount} USDC → ${token}`);
    console.log(`SELL on ${sellOn}: ${sellAmount} ${token} → USDC`);

    // ✅ Convert DEX names to protocol IDs
    const dexProtocols = {
        UNISWAP: "ARBITRUM_UNISWAP_V3",
        SUSHISWAP: "ARBITRUM_SUSHISWAP",
        CURVE: "ARBITRUM_CURVE_V2",
        BALANCER: "ARBITRUM_BALANCER_V2",
    };

    if (!dexProtocols[buyOn] || !dexProtocols[sellOn]) {
        console.error(`❌ Unsupported DEX: Buy on ${buyOn}, Sell on ${sellOn}.`);
        return;
    }

    // ✅ Get USDC & WBTC token addresses
    const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
    const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
    const NETWORK_ID = 42161; // Arbitrum

    // ✅ Generate calldata for buy & sell swaps
    const buyCalldata = await executeFlashLoanAndSwap(buyOn, USDC, WBTC, buyAmount, dexProtocols[buyOn]);
    const sellCalldata = await executeFlashLoanAndSwap(sellOn, WBTC, USDC, sellAmount, dexProtocols[sellOn]);

    if (!buyCalldata || !sellCalldata) {
        console.error("❌ Failed to generate calldata for swaps. Aborting trade.");
        return;
    }

    console.log("✅ Successfully generated calldata for buy & sell swaps.");

    // ✅ Convert buy amount to Wei (assuming 6 decimals for USDC)
    const buyAmountInWei = ethers.utils.parseUnits(buyAmount.toString(), 6).toString();

    // ✅ Execute smart contract flash loan & swaps
    try {
        console.log("🚀 Requesting Flash Loan & Executing Trades...");
        const tx = await smartContract.fn_RequestFlashLoan(
            USDC,            // Token to loan (USDC)
            buyAmountInWei,  // Amount in Wei
            buyCalldata,     // Buy swap calldata
            sellCalldata     // Sell swap calldata
        );

        await tx.wait();
        console.log("✅ Smart Contract Execution Confirmed!");

        // ✅ Notify Telegram after successful execution
        await sendTelegramTradeAlert({
            title: "✅ Arbitrage Trade Executed!",
            message: `🏆 Arbitrage trade executed successfully!
            ✅ Bought ${buyAmount} USDC of ${token} on ${buyOn}
            ✅ Sold ${sellAmount} ${token} on ${sellOn}
            💰 Profit: $${(sellAmount - buyAmount).toFixed(2)}`
        });

    } catch (error) {
        console.error("❌ Error executing smart contract trade:", error);
        await sendTelegramMessage("🚨 **Critical Error:** Trade execution failed. Manual intervention required.");
    }
}


// async function executeSwap(trade) {
//     const { token, buyOn, sellOn, buyAmount, sellAmount, netLoanRequest, tokenAddress } = trade;
//     console.log(`⚡ Executing Arbitrage Trade ⚡`);
//     console.log(`BUY on ${buyOn}: ${buyAmount} USDC to purchase ${token}`);
//     console.log(`SELL on ${sellOn}: ${sellAmount} of ${token}`);
//     await sendTelegramTradeAlert({
//         title: "🚀 Executing Arbitrage Trade",
//         message: `🔹 Buy on ${buyOn}: ${buyAmount} USDC to purchase ${token}
//         🔹 Sell on ${sellOn}: ${sellAmount} of ${token}`
//     });

//     // ✅ Validate Required Data
//     if (!token || !buyOn || !sellOn || !buyAmount || !sellAmount || !netLoanRequest || !tokenAddress) {
//         console.error(`❌ Invalid trade data received in executeSwap:`, trade);
//         return;
//     }

//     // ✅ Convert Amounts from Wei to Token Units if Necessary
//     const buyAmountConverted = convertFromWei(buyAmount, tokenAddress);
//     const sellAmountConverted = convertFromWei(sellAmount, tokenAddress);
//     console.log(`🔹 Converted Buy Amount: ${buyAmountConverted} ${token}`);
//     console.log(`🔹 Converted Sell Amount: ${sellAmountConverted} ${token}`);

//     // ✅ Get Network Chain IDs
//     const buyChainID = NETWORKS[buyOn.toUpperCase()];
//     const sellChainID = NETWORKS[sellOn.toUpperCase()];

//     if (!buyChainID || !sellChainID) {
//         console.error(`❌ Invalid chain IDs! Buy: ${buyChainID}, Sell: ${sellChainID}`);
//         return;
//     }

//     // ✅ Select the Correct Smart Contract for Execution
//     const buyContract = buyOn === "Polygon" ? polygonContract : arbitrumContract;
//     const sellContract = sellOn === "Polygon" ? polygonContract : arbitrumContract;

//     try {
//         // ✅ Execute Flash Loan & Swaps in Parallel
//         console.log(`🔹 Requesting Flash Loans & Executing Swaps...`);
//         const [buyTx, sellTx] = await Promise.all([
//             executeFlashLoanAndSwap(buyOn, token, buyAmountConverted, buyContract),
//             executeFlashLoanAndSwap(sellOn, token, sellAmountConverted, sellContract)
//         ]);

//         if (!buyTx || !sellTx) {
//             console.error("❌ Flash loan or swap execution failed. Retrying...");
//             return;
//         }

//         console.log(`✅ Both Buy & Sell Transactions Confirmed!`);

//         // ✅ Execute Cross-Chain Fusion+ Swap for Loan Repayment
//         try {
//             console.log(`🚀 Executing Fusion+ Swap for Loan Repayment...`);
//             await executeFusionSwap(
//                 trade,
//                 TOKENS[sellOn].find(t => t.name === "USDC").address, 
//                 TOKENS[buyOn].find(t => t.name === "USDC").address,
//                 sellAmount
//             );
//         } catch (error) {
//             console.error("❌ Error executing Fusion+ swap for loan repayment:", error);
//             await sendTelegramMessage(`🚨 **Warning:** Loan repayment swap failed. Manual intervention required.`);
//         }

//         // ✅ Notify on Successful Trade
//         await sendTelegramTradeAlert({
//             title: "✅ Arbitrage Trade Completed!",
//             message: `🏆 Successfully completed arbitrage trade!
//             ✅ Bought ${buyAmount} USDC of ${token} on ${buyOn}
//             ✅ Sold ${sellAmount} of ${token} on ${sellOn}
//             💰 Profit: $${trade.profit}`
//         });

//         console.log("🎉 Arbitrage Trade Completed Successfully!");

//     } catch (error) {
//         console.error(`❌ Error executing arbitrage trade:`, error);
//         await sendTelegramMessage({
//             title: "❌ Arbitrage Trade Failed!",
//             message: `🚨 An error occurred during execution:
//             ❌ ${error.message}`
//         });
//     }
// }

/**
 * 🔥 **Flash Loan Execution Function**
 */

async function executeFlashLoanAndSwap(dex, fromToken, toToken, amount, protocolID) {
    console.log(`🚀 Generating calldata for ${dex} swap: ${amount} ${fromToken} → ${toToken} via ${protocolID}`);

    // ✅ List of all possible protocols on Arbitrum
    const ALL_PROTOCOLS = [
        "ARBITRUM_BALANCER_V2", "ARBITRUM_SUSHISWAP", "ARBITRUM_UNISWAP_V3", "ARBITRUM_CURVE",
        "ARBITRUM_CURVE_V2", "ARBITRUM_ONE_INCH_LIMIT_ORDER", "ARBITRUM_ONE_INCH_LIMIT_ORDER_V2",
        "ARBITRUM_ONE_INCH_LIMIT_ORDER_V3", "ARBITRUM_ONE_INCH_LIMIT_ORDER_V4", "ARBITRUM_DODO",
        "ARBITRUM_DODO_V2", "ARBITRUM_DXSWAP", "ARBITRUM_GMX", "ARBITRUM_SYNAPSE", "ARBITRUM_SADDLE",
        "ARBITRUM_KYBERSWAP_ELASTIC", "ARBITRUM_KYBER_DMM_STATIC", "ARBITRUM_AAVE_V3", "ARBITRUM_ELK",
        "ARBITRUM_WOOFI_V2", "ARBITRUM_CAMELOT", "ARBITRUM_TRADERJOE", "ARBITRUM_TRADERJOE_V2",
        "ARBITRUM_TRADERJOE_V2_2", "ARBITRUM_SWAPFISH", "ARBITRUM_ZYBER", "ARBITRUM_ZYBER_STABLE",
        "ARBITRUM_SOLIDLIZARD", "ARBITRUM_ZYBER_V3", "ARBITRUM_MYCELIUM", "ARBITRUM_TRIDENT",
        "ARBITRUM_SHELL_OCEAN", "ARBITRUM_RAMSES", "ARBITRUM_TRADERJOE_V2_1", "ARBITRUM_NOMISWAPEPCS",
        "ARBITRUM_CAMELOT_V3", "ARBITRUM_WOMBATSWAP", "ARBITRUM_CHRONOS", "ARBITRUM_LIGHTER",
        "ARBITRUM_ARBIDEX", "ARBITRUM_ARBIDEX_V3", "ARBSWAP", "ARBSWAP_STABLE", "ARBITRUM_SUSHISWAP_V3",
        "ARBITRUM_RAMSES_V2", "ARBITRUM_LEVEL_FINANCE", "ARBITRUM_CHRONOS_V3", "ARBITRUM_PANCAKESWAP_V3",
        "ARBITRUM_PMM11", "ARBITRUM_DODO_V3", "ARBITRUM_SMARDEX", "ARBITRUM_INTEGRAL",
        "ARBITRUM_DFX_FINANCE_V3", "ARBITRUM_CURVE_STABLE_NG", "ARBITRUM_VIRTUSWAP",
        "ARBITRUM_CURVE_V2_TRICRYPTO_NG", "ARBITRUM_CURVE_V2_TWOCRYPTO_NG", "ARBITRUM_BGD_AAVE_STATIC",
        "ARBITRUM_SOLIDLY_V3", "ARBITRUM_ANGLE", "ARBITRUM_MAVERICK_V2", "ARBITRUM_UNISWAP_V4",
        "ARBITRUM_FLUID_DEX_T1"
    ];

    // ✅ Dynamically exclude all protocols **except** the selected one
    const excludedProtocols = ALL_PROTOCOLS.filter(p => p !== protocolID).join(',');

    try {
        // ✅ Convert amount to correct decimal format
        const decimals = TOKEN_DECIMALS[fromToken] || 18; // Default to 18 decimals if missing
        const amountInWei = ethers.utils.parseUnits(amount.toString(), decimals).toString();

        console.log(`🔹 Converted Amount to Wei: ${amountInWei}`);

        // ✅ Fetch calldata from 1inch Swap API
        const response = await axios.get(`https://api.1inch.dev/swap/v6.0/42161/swap`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
            params: {
                src: fromToken,
                dst: toToken,
                amount: amountInWei,
                excludedProtocols: excludedProtocols, // ✅ Exclude all except selected protocol
                includeGas: true,
                slippage: 1
            }
        });

        console.log(`✅ Successfully generated calldata for ${dex}:`, response.data.tx.data);
        return response.data.tx.data; // ✅ Return calldata for smart contract execution

    } catch (error) {
        console.error(`❌ Failed to generate calldata for ${dex}:`, error.response?.data || error.message);
        return null;
    }
}

// async function executeFlashLoanAndSwap(buyOn, sellOn, tokenAddress, amount) {
//     console.log(`🚀 Requesting Flash Loans & Swaps on ${buyOn} & ${sellOn} for ${amount} of ${tokenAddress}`);

//     // ✅ Get Correct Chain IDs
//     const buyChainID = NETWORKS[buyOn.toUpperCase()];
//     const sellChainID = NETWORKS[sellOn.toUpperCase()];

//     if (!buyChainID || !sellChainID) {
//         console.error(`❌ Invalid chain IDs! BuyOn: ${buyOn} (${buyChainID}), SellOn: ${sellOn} (${sellChainID})`);
//         return null;
//     }

//     // ✅ Ensure USDC Addresses Exist on Both Networks
//     const buyUSDC = TOKENS[buyOn.toUpperCase()].find(t => t.name === "USDC");
//     const sellUSDC = TOKENS[sellOn.toUpperCase()].find(t => t.name === "USDC");

//     if (!buyUSDC || !sellUSDC) {
//         console.error(`❌ USDC token address missing for BuyOn: ${buyOn} or SellOn: ${sellOn}`);
//         return null;
//     }

//     // ✅ Fetch Token Decimals & Convert Amount if Needed
//     const tokenDecimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()];
//     if (tokenDecimals === undefined) {
//         console.error(`❌ Missing token decimal for ${tokenAddress}`);
//         return null;
//     }

//     // Check if the amount is already in Wei (avoid double conversion)
//     const amountInWei = BigInt(amount) >= BigInt(10 ** tokenDecimals) ? amount.toString() : ethers.utils.parseUnits(amount.toString(), tokenDecimals).toString();
//     console.log(`🔹 Final Converted Amount to Wei: ${amountInWei} (${tokenDecimals} decimals)`);

//     // ✅ Select Smart Contracts for Each Network
//     const buyContract = buyOn === "Polygon" ? polygonContract : arbitrumContract;
//     const sellContract = sellOn === "Polygon" ? polygonContract : arbitrumContract;

//     // ✅ Construct Flash Loan Request Data for Buy & Sell Networks
//     const buyFlashLoanData = {
//         src: buyUSDC.address, // Buy USDC → Token
//         dst: tokenAddress,
//         amount: amountInWei,
//         from: buyContract.address,
//         origin: WALLET_ADDRESS,
//         slippage: 1
//     };

//     const sellFlashLoanData = {
//         src: tokenAddress, // Sell Token → USDC
//         dst: sellUSDC.address,
//         amount: amountInWei,
//         from: sellContract.address,
//         origin: WALLET_ADDRESS,
//         slippage: 1
//     };

//     // ✅ Respect 1inch Rate Limit
//     await delay(1000);

//     try {
//         // ✅ Fetch Swap Data for Buy & Sell Networks in Parallel
//         const [buyResponse, sellResponse] = await Promise.all([
//             axios.get(`https://api.1inch.dev/swap/v6.0/${buyChainID}/swap`, {
//                 headers: { Authorization: `Bearer ${API_KEY}` },
//                 params: buyFlashLoanData
//             }),
//             axios.get(`https://api.1inch.dev/swap/v6.0/${sellChainID}/swap`, {
//                 headers: { Authorization: `Bearer ${API_KEY}` },
//                 params: sellFlashLoanData
//             })
//         ]);

//         console.log("✅ Flash Loan Swap Data (Buy):", buyResponse.data);
//         console.log("✅ Flash Loan Swap Data (Sell):", sellResponse.data);

//         // ✅ Compile Smart Contract Payloads for Both Networks
//         const buyRouteData = buyResponse.data.tx.data;
//         const sellRouteData = sellResponse.data.tx.data;

//         const buyPayload = ethers.utils.defaultAbiCoder.encode(
//             ["address", "uint256", "bytes"],
//             [tokenAddress, amountInWei, buyRouteData]
//         );

//         const sellPayload = ethers.utils.defaultAbiCoder.encode(
//             ["address", "uint256", "bytes"],
//             [tokenAddress, amountInWei, sellRouteData]
//         );

//         // ✅ Execute Flash Loans on Both Networks in Parallel
//         console.log(`🔹 Sending Flash Loan Requests to Smart Contracts on ${buyOn} & ${sellOn}`);

//         const [buyTx, sellTx] = await Promise.all([
//             buyContract.fn_RequestFlashLoan(tokenAddress, amountInWei, buyPayload),
//             sellContract.fn_RequestFlashLoan(tokenAddress, amountInWei, sellPayload)
//         ]);

//         await Promise.all([buyTx.wait(), sellTx.wait()]);

//         console.log(`✅ Flash Loans Executed Successfully on ${buyOn} & ${sellOn}`);

//         return { buyResponse: buyResponse.data, sellResponse: sellResponse.data };
//     } catch (error) {
//         console.error("❌ Failed to generate Flash Loan Swap data:", error.response?.data || error.message);
//         return null;
//     }
// }

// 🔥 **Swap Execution & Loan Repayment Function**


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



// async function executeArbitrage() {
//     console.log("🔍 Starting continuous arbitrage detection...");

//     while (true) {
//         console.log("🔄 Fetching latest prices...");
//         const prices = await fetchPricesForBothChains();

//         if (!prices || !prices.POLYGON || !prices.ARBITRUM) {
//             console.error("❌ Failed to fetch valid price data. Retrying...");
//             await delay(5000);
//             continue;
//         }

//         console.log("✅ Prices fetched. Detecting arbitrage opportunities...");
//         const opportunities = await detectArbitrageOpportunities(prices);

//         if (!opportunities.length) {
//             console.log("⚠️ No profitable arbitrage opportunities found. Retrying...");
//             await delay(5000);
//             continue;
//         }

//         for (const bestTrade of opportunities) {
//             if (!bestTrade?.buyOn || !bestTrade?.sellOn || !bestTrade?.token || !bestTrade?.buyAmount || !bestTrade?.sellAmount || !bestTrade?.profit) {
//                 console.error("❌ Invalid trade data. Skipping.");
//                 continue;
//             }

//             console.log("🚀 Preparing Telegram Alert with Data:", bestTrade);

//             // ✅ Construct and Send Telegram Message for Arbitrage Alert
//            await sendTelegramTradeAlert(bestTrade);
//             console.log("✅ Telegram trade alert sent successfully.");
//             console.log(`🚀 Executing Trade: Buy on ${bestTrade.buyOn}, Sell on ${bestTrade.sellOn}`);

//             try {
//                 const buyNetwork = bestTrade.buyOn.toUpperCase();
//                 const sellNetwork = bestTrade.sellOn.toUpperCase();
//                 const token = bestTrade.token.toUpperCase();

//                 console.log(`🔄 Debugging trade details before validation:`);
//                 console.log(`➡️ Buy Network: ${buyNetwork}`);
//                 console.log(`➡️ Sell Network: ${sellNetwork}`);
//                 console.log(`➡️ Token: ${token}`);

//                 if (!TOKENS[buyNetwork] || !TOKENS[sellNetwork]) {
//                     console.error(`❌ Missing TOKENS data for ${buyNetwork} or ${sellNetwork}. Skipping trade.`);
//                     continue;
//                 }

//                 const buyToken = TOKENS[buyNetwork].find(t => t.name.toUpperCase() === token);
//                 const sellToken = TOKENS[sellNetwork].find(t => t.name.toUpperCase() === token);
//                 const buyUSDC = TOKENS[buyNetwork].find(t => t.name === "USDC");
//                 const sellUSDC = TOKENS[sellNetwork].find(t => t.name === "USDC");

//                 if (!buyToken || !sellToken || !buyUSDC || !sellUSDC) {
//                     console.error("❌ Missing token or USDC data. Retrying...");
//                     continue;
//                 }

//                 const buyNetworkId = prices[buyNetwork].networkId;
//                 const sellNetworkId = prices[sellNetwork].networkId;
//                 const buyAmountString = Math.floor(bestTrade.buyAmount).toString();

//                 console.log("🔄 Fetching live swap quotes...");

//                 // ✅ Fetch live buy swap quote (USDC → Token)
//                 const buyTokenAmount = await fetchSwapQuote(
//                     buyNetworkId,
//                     buyUSDC.address,
//                     buyToken.address,
//                     buyAmountString
//                 );

//                 if (!buyTokenAmount) {
//                     console.error("❌ Failed to fetch buy swap quote. Retrying...");
//                     continue;
//                 }

//                 console.log(`💰 Buy Swap Expected Amount: ${convertFromWei(buyTokenAmount, buyToken.address)} ${token}`);

//                 // ✅ Fetch Fusion+ cross-chain swap quote (Token → Token on Sell Network)
//                 const fusionQuote = await fetchFusionQuote(
//                     buyNetworkId,
//                     sellNetworkId,
//                     buyToken.address,
//                     sellToken.address,
//                     buyTokenAmount
//                 );

//                 if (!fusionQuote?.receivedAmount || !fusionQuote?.netLoanRequest) {
//                     console.error("❌ Failed to fetch Fusion+ cross-chain swap quote. Retrying...");
//                     continue;
//                 }

//                 // ✅ Convert received token amount from Wei
//                 const sellAmount = fusionQuote.receivedAmount ? convertFromWei(fusionQuote.receivedAmount, sellToken.address) : null;
//                 console.log(`💰 Expected Tokens After Cross-Chain Swap: ${sellAmount} ${token}`);
                
//                 if (!sellAmount) {
//                     console.error("❌ Sell Amount is missing. Skipping trade.");
//                     continue;
//                 }

//                 // ✅ Compute optimal loan amount covering 0.05% loan fees
//                 const netLoanRequest = fusionQuote.receivedAmount / 1.0005;
//                 const adjustedLoanRequest = Math.floor(netLoanRequest); // ✅ Round down
//                 console.log(`💰 Optimal Loan Request: ${adjustedLoanRequest} ${token} (After Loan Fee)`);

//                 // ✅ Fetch final USDC expected after selling loaned tokens
//                 const expectedFinalUSDC = await fetchSwapQuote(
//                     sellNetworkId,
//                     sellToken.address,
//                     sellUSDC.address,
//                     adjustedLoanRequest.toString()
//                 );

//                 if (!expectedFinalUSDC) {
//                     console.error("❌ Failed to fetch final USDC swap quote. Retrying...");
//                     continue;
//                 }

//                 const finalUSDCAmount = convertFromWei(expectedFinalUSDC, sellUSDC.address);
//                 console.log(`💵 Final USDC Expected: ${finalUSDCAmount} USDC`);

//                 // ✅ Calculate total repayment (loan amount + fees)
//                 const totalRepayment = bestTrade.buyAmount * 1.0005;
//                 if (finalUSDCAmount <= totalRepayment) {
//                     console.error("❌ Trade not profitable after fees. Skipping.");
//                     continue;
//                 }

//                 console.log(`✅ Profitable trade detected: Final USDC ${finalUSDCAmount} > Repayment ${totalRepayment}`);
//                 console.log(`🚀 Executing Buy Swap & Cross-Chain Swap...`);
//                 console.log(`💵 Buying ${bestTrade.buyAmount} USDC to purchase ${token} on ${buyNetwork}...`);
//                 console.log(`💵 Selling ${sellAmount} ${token} on ${sellNetwork}...`);

//                 // ✅ Prepare trade data for execution
//                 const tradeData = {
//                     token,
//                     buyOn: buyNetwork,
//                     sellOn: sellNetwork,
//                     buyAmount: bestTrade.buyAmount.toString(),
//                     sellAmount: sellAmount.toString(),
//                     netLoanRequest: netLoanRequest.toString(),
//                     tokenAddress: buyToken.address
//                 };

//                 console.log("✅ Sending Trade Data to Execute Swap:", tradeData);

//                 // ✅ Execute Swap
//                 await executeSwap(tradeData);

//                 // ✅ Send execution data to Telegram
//                 await sendTelegramTradeAlert(tradeData);

//                 console.log("✅ Trade Data Sent to Telegram:", tradeData);

//             } catch (error) {
//                 console.error("❌ Error executing arbitrage trade:", error);
//                 await sendTelegramMessage("🚨 **Critical Error:** Arbitrage execution failed. Manual intervention required.");
//             }
//         }

//         await delay(1000); // Respect 1inch 1 RPS limit
//     }
// }

async function executeArbitrage() {
    console.log("🔍 Starting continuous arbitrage detection...");

    while (true) {
        console.log("🔄 Detecting arbitrage opportunities...");

        // ✅ Detect arbitrage using updated logic
        const opportunities = await detectArbitrageOpportunities();

        if (!opportunities.length) {
            console.log("⚠️ No profitable arbitrage opportunities found. Retrying...");
            await delay(5000);
            continue;
        }

        for (const bestTrade of opportunities) {
            if (!bestTrade?.buyOn || !bestTrade?.sellOn || !bestTrade?.token || !bestTrade?.buyAmount || !bestTrade?.sellAmount || !bestTrade?.profit) {
                console.error("❌ Invalid trade data. Skipping.");
                continue;
            }

            console.log("🚀 Preparing Telegram Alert with Data:", bestTrade);

            // ✅ Notify Telegram about arbitrage opportunity
            await sendTelegramTradeAlert(bestTrade);
            console.log("✅ Telegram trade alert sent.");

            console.log(`🚀 Executing Trade: Buy on ${bestTrade.buyOn}, Sell on ${bestTrade.sellOn}`);

            try {
                // ✅ Execute swap with smart contract
                await executeSwap(bestTrade);

                // ✅ Notify Telegram after successful trade execution
                await sendTelegramTradeAlert(bestTrade);

                console.log("✅ Arbitrage Trade Executed Successfully!");

            } catch (error) {
                console.error("❌ Error executing arbitrage trade:", error);
                await sendTelegramMessage("🚨 **Critical Error:** Arbitrage execution failed. Manual intervention required.");
            }
        }

        await delay(1000); // Respect 1inch 1 RPS limit
    }
}


// 🚀 Start the Bot
executeArbitrage();
