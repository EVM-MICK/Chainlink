const dotenv = require("dotenv");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Web3 = require("web3");
const BigNumber = require("bignumber.js");
const retry = require("async-retry");
const Redis = require("ioredis");
const { createClient } = require("redis");
//const {  parseUnits, AbiCoder, ethers, Wallet, JsonRpcProvider, Contract } = require("ethers");
const ethers = require("ethers");
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
const baseAbiPath = path.join(__dirname, "baseSmartContract.json");

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
const BASE_ABI = safeLoadJson(baseAbiPath);
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
// ENV variable to set BASE_WS, baseSmartContract.json
const POLYGON_CONTRACT_ADDRESS = process.env.POLYGON_SMART_CONTRACT;
const ARBITRUM_CONTRACT_ADDRESS = process.env.ARBITRUM_SMART_CONTRACT;
const BASE_CONTRACT_ADDRESS = process.env.BASE_SMART_CONTRACT;
const DAILY_PROFIT_TARGET = ethers.parseUnits("5000", 6); // 5000 USDC
const WALLET_ADDRESS = process.env.WALLET_ADDRESS_MAIN;
const providerPolygon = new ethers.WebSocketProvider(process.env.POLYGON_WS);
const providerArbitrum = new ethers.WebSocketProvider(process.env.ARBITRUM_WS);
const providerBase = new ethers.WebSocketProvider(process.env.BASE_WS);
const walletPolygon = new ethers.Wallet(process.env.PRIVATE_KEY, providerPolygon);
const walletArbitrum = new ethers.Wallet(process.env.PRIVATE_KEY, providerArbitrum);
const walletBase = new ethers.Wallet(process.env.PRIVATE_KEY, providerBase);
// Load Smart Contracts for both networks polygonContract arbitrumContract
const DEBUG_MODE = process.env.DEBUG === "true";
const polygonContract = new ethers.Contract(POLYGON_CONTRACT_ADDRESS, POLYGON_ABI, walletPolygon);
const arbitrumContract = new ethers.Contract(ARBITRUM_CONTRACT_ADDRESS, ARBITRUM_ABI, walletArbitrum);
const BaseContract = new ethers.Contract(BASE_CONTRACT_ADDRESS, BASE_ABI, walletBase);
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
const provider = new ethers.JsonRpcProvider(process.env.INFURA_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const REDIS_HOST = process.env.REDIS_HOST || 'memcached-13219.c83.us-east-1-2.ec2.redns.redis-cloud.com';
const REDIS_PORT = process.env.REDIS_PORT || 13219;
const REDIS_USERNAME = process.env.REDIS_USERNAME || 'mc-1JAiM';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'A03DC9FzAQu3fixrUEZXOj2BJx9oeIC7';
const REDIS_TTL = 60; // Cache data for 1 minute
const redisClient = createClient({
    username: 'default',
    password: '*******',
    socket: {
        host: 'memcached-13219.c83.us-east-1-2.ec2.redns.redis-cloud.com',
        port: 13219
    }
});

// createClient({
//   username: 'mc-1JAiM',
//   password: 'A03DC9FzAQu3fixrUEZXOj2BJx9oeIC7',
//   socket: {
//     host: 'memcached-13219.c83.us-east-1-2.ec2.redns.redis-cloud.com',
//     port: 13219,
//   },
// });

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


const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"; // Arbitrum WBTC
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // Arbitrum USDC

const NETWORK_ID = 42161; // Arbitrum
const CAPITAL_USDC = 150000; // Trading capital in USDC
const MIN_EXTRA_WBTC = 0.0012; // Additional buffer to ensure profitable swap

const TOKEN_DECIMALS = {
  [WBTC]: 8,  // WBTC has 8 decimals
  [USDC]: 6   // USDC has 6 decimals
};

// Initialize Permit2 contract instance
const permit2Contract = new web3.eth.Contract(permit2Abi, PERMIT2_ADDRESS);
// Initialize Express app
const app = express();
app.use(express.json());

// let fetch;
// (async () => {
//   fetch = (await import("node-fetch")).default;
// })();



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
// (async () => {
//   try {
//     await redisClient.connect();
//     console.log('Connected to Redis');
//   } catch (err) {
//     console.error('Error connecting to Redis:', err);
//     process.exit(1);
//   }
// })();

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

async function retryRequest(fn, retries = 5, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn(); // ✅ Attempt request
        } catch (err) {
            if (err.response?.status === 429) {
                // ✅ Handle rate-limiting (Retry-After Header)
                const retryAfter = parseInt(err.response.headers['retry-after'], 10) || delay / 1000;
                console.warn(`[WARN] Rate-limited by API. Retrying in ${retryAfter} seconds...`);
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
        optimizedWbtcAmount = "0",
        spotPrice = "0",
        orderSplits = [],
    } = tradeDetails;

    // ✅ Ensure numeric values are correctly formatted
    const formattedBuyAmount = parseFloat(buyAmount).toFixed(2);
    const formattedSellAmount = parseFloat(sellAmount).toFixed(2);
    const formattedProfit = parseFloat(profit).toFixed(2);
    const formattedWbtcAmount = parseFloat(optimizedWbtcAmount).toFixed(8);

    // ✅ Format limit order details if available
    let orderDetails = "";
    if (orderSplits.length > 0) {
        orderDetails = `\n🔹 **Limit Order Details:**\n`;
        orderSplits.forEach((order, index) => {
            orderDetails += `   📌 Order ${index + 1}: **${order.splitAmount} USDC** → **${order.expectedWbtc} WBTC** @ ${order.price} \n`;
        });
    }

    // ✅ Construct message correctly
    const message = `
🚀 **Arbitrage Trade Executed!**  
📍 **Trade Summary**  
✅ **BUYING:** ${formattedBuyAmount} USDC → ${formattedWbtcAmount} WBTC on *${buyOn}*  
✅ **SELLING:** ${formattedSellAmount} WBTC → USDC on *${sellOn}*  
💰 **Profit:** $${formattedProfit}  
${orderDetails}
🔄 **Trade executed successfully!**
    `.trim();

    if (!botToken || !chatId) {
        console.error("❌ Telegram bot token or chat ID is missing. Cannot send trade alert.");
        return;
    }

    try {
        const response = await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
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

function convertToWei(amount, token) {
    const tokenDecimals = TOKEN_DECIMALS[token.toLowerCase()];
    if (!tokenDecimals) {
        throw new Error(`❌ Missing token decimal for ${token}`);
    }

    // ✅ Multiply by decimals & floor to ensure it's an integer
    return BigInt(Math.floor(amount * 10 ** tokenDecimals));
}

// 📡 Fetch a live swap quote from USDC → WBTC using 1inch API

/**
 * Fetches market prices for WBTC and USDC, calculates spot price, and determines expected WBTC amount for given USDC.
 * @param {number} usdcAmount - The amount of USDC to swap for WBTC.
 * @returns {Promise<{expectedWbtc: number, spotPrice: number} | null>}
 */
async function getExpectedWbtc(usdcAmount) {
    console.log(`📡 Fetching WBTC & USDC prices for ${usdcAmount} USDC...`);

    // ✅ Format token addresses for API request
    const NETWORK_ID = 42161; // Arbitrum
    const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831".toLowerCase();
    const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f".toLowerCase();

    const tokenList = [WBTC, USDC].join(",");
    const url = `https://api.1inch.dev/price/v1.1/${NETWORK_ID}/${tokenList}`;

    const config = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: { currency: "USD" }
    };

    let retries = 5;
    let delay = 1000; // Start with 1-second delay

    while (retries > 0) {
        try {
            // ✅ Fetch WBTC & USDC prices
            const response = await axios.get(url, config);
            const responseData = response.data;

            if (!responseData || typeof responseData !== "object") {
                throw new Error("Invalid API response structure.");
            }

            console.log(`✅ Raw API Response:`, responseData);

            // ✅ Extract WBTC & USDC prices from response
            const wbtcPrice = parseFloat(responseData[WBTC]); // ✅ Extract price directly
            const usdcPrice = parseFloat(responseData[USDC]);

            if (!wbtcPrice || !usdcPrice) {
                throw new Error("Missing WBTC or USDC price data.");
            }

            console.log(`✅ WBTC Price: $${wbtcPrice} | USDC Price: $${usdcPrice}`);

            // ✅ Calculate spot price: (WBTC/USD ÷ USDC/USD)
            let spotPrice = wbtcPrice / usdcPrice;
            console.log(`🔹 Spot Price: ${spotPrice}`);

            // ✅ Adjust buy price (subtract 0.010% for better entry)
            let adjustedBuyPrice = spotPrice * (1 - 0.0001);
            console.log(`🔹 Adjusted Buy Price: ${adjustedBuyPrice}`);

            // ✅ Calculate expected WBTC amount
            let expectedWbtc = usdcAmount / adjustedBuyPrice;
            console.log(`✅ Expected WBTC to Receive: ${expectedWbtc}`);

            return { expectedWbtc, spotPrice };

        } catch (error) {
            console.error(`❌ Error fetching USDC/WBTC prices (Retries left: ${retries - 1}):`, error.message);
            retries--;

            if (retries > 0) {
                console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential Backoff
            }
        }
    }

    console.error("❌ Failed to fetch valid USDC/WBTC prices after multiple attempts.");
    return null;
}

// 📡 Check the USDC output when swapping WBTC back to USDC
async function validateWbtcToUsdc(wbtcAmount1) {
    console.log(`📡 Checking expected USDC output for ${wbtcAmount1} WBTC...`);

    const NETWORK_ID1 = 42161; // Arbitrum
    const USDC1 = "0xaf88d065e77c8cc2239327c5edb3a432268e5831".toLowerCase();
    const WBTC1 = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f".toLowerCase();

    const tokenList1 = [WBTC1, USDC1].join(",");
    const url1 = `https://api.1inch.dev/price/v1.1/${NETWORK_ID1}/${tokenList1}`;

    const config1 = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: { currency: "USD" }
    };

    try {
        const response1 = await retryRequest(() => axios.get(url1, config1));
        if (!response1 || !response1.data || typeof response1.data !== "object") {
            throw new Error("Invalid API response structure.");
        }

        const prices1 = response1.data;
        const wbtcPrice1 = parseFloat(prices1[WBTC1]);
        const usdcPrice1 = parseFloat(prices1[USDC1]);

        if (!wbtcPrice1 || !usdcPrice1) {
            throw new Error("Missing WBTC or USDC price data.");
        }

        console.log(`✅ WBTC Price: $${wbtcPrice1} | USDC Price: $${usdcPrice1}`);

        // ✅ Calculate spot price & adjusted sell price
        let spotPrice1 = wbtcPrice1 / usdcPrice1;
        let adjustedSellPrice1 = spotPrice1 * (1 + 0.0016); // Increase by 0.16%

        console.log(`🔹 Spot Price: ${spotPrice1} USDC per WBTC`);
        console.log(`🔹 Adjusted Sell Price: ${adjustedSellPrice1} USDC per WBTC`);

        // ✅ Calculate expected USDC output
        let expectedUsdc1 = wbtcAmount1 * adjustedSellPrice1;
        console.log(`✅ Expected USDC from WBTC: ${expectedUsdc1}`);

        return { expectedUsdc1, newSpotPrice: spotPrice1 }; // ✅ Return updated spot price

    } catch (error) {
        console.error(`❌ Failed to fetch WBTC/USDC price data: ${error.message}`);
        return null;
    }
}



// 🔄 Optimize WBTC Amount Until USDC Output is Profitable
async function optimizeWbtcAmount(usdcCapital) {
    console.log(`📡 Fetching expected WBTC amount for ${usdcCapital} USDC...`);

    let marketData = await getExpectedWbtc(usdcCapital);
    if (!marketData) return null;

    let { expectedWbtc, spotPrice } = marketData;
    console.log(`✅ Expected WBTC: ${expectedWbtc} at Spot Price: ${spotPrice}`);

    // ✅ Return `expectedWbtc` and `spotPrice` without modification
    return { expectedWbtc, spotPrice };
}
 
/**
 🚀 Create and submit multiple limit orders for faster execution
 * 🚀 Creates and submits a limit order on 1inch Fusion.
 * @param {string} fromToken - Token we are selling.
 * @param {string} toToken - Token we want to buy.
 * @param {number} amount - Amount of `fromToken` to sell.
 * @param {number} expectedReceive - Expected amount of `toToken` to receive.
 * @returns {Object} - Response data from 1inch API.
 */

async function createLimitOrders(fromToken, toToken, amount, expectedReceive, spotPrice, isSellOrder = false) {
    console.log(`📡 Getting limit order quote: ${amount} ${fromToken} → ${toToken}`);
    
    const NETWORK_ID = 42161; // Arbitrum
    const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f".toLowerCase();
    const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831".toLowerCase();
    const FromToken = fromToken.toLowerCase();
    const ToToken = toToken.toLowerCase();
    const quoterUrl = `https://api.1inch.dev/fusion/quoter/v2.0/${NETWORK_ID}/quote/receive`;
    const relayerUrl = `https://api.1inch.dev/fusion/relayer/v2.0/${NETWORK_ID}/order/submit`;

    const config = { headers: { Authorization: `Bearer ${API_KEY}` } };

    try {
        // ✅ Step 1: Determine Auction Price Range Based on Buy/Sell
        let auctionStartAmount, auctionEndAmount;

        if (isSellOrder) {
            // 🚀 Selling WBTC → USDC (Ensure a higher price)
            let sellPrice = spotPrice * (1 + 0.0016);  // Ensure above market price
            auctionStartAmount = sellPrice;
            auctionEndAmount = sellPrice + 20;   // Add $20 buffer for best rate
        } else {
            // 🚀 Buying USDC → WBTC (Ensure a lower price)
            auctionStartAmount = spotPrice;      // Buy at market price
            auctionEndAmount = spotPrice + 10;   // Allow up to $10 increase in worst case
        }

        console.log(`💰 Auction Start: ${auctionStartAmount}, Auction End: ${auctionEndAmount}`);

        // ✅ Step 2: Get Quote for Limit Order
        const quoteBody = {
            auctionDuration: 300, // 5 minutes
            auctionStartAmount: auctionStartAmount.toString(),
            auctionEndAmount: auctionEndAmount.toString(),
            points: []
        };

        const quoteParams = {
            fromTokenAddress: FromToken,
            toTokenAddress: ToToken,
            amount: ethers.utils.parseUnits(amount.toString(), 6).toString(),
            walletAddress: WALLET_ADDRESS,
            enableEstimate: true
        };

        const quoteResponse = await axios.post(quoterUrl, quoteBody, { ...config, params: quoteParams });
        const quoteId = quoteResponse.data.quoteId;

        if (!quoteId) throw new Error("Failed to fetch quoteId from 1inch API.");
        console.log(`✅ Quote ID Received: ${quoteId}`);

        // ✅ Step 3: Build and Sign Limit Order
        const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        const makingAmount = ethers.utils.parseUnits(amount.toString(), 6).toString();
        const takingAmount = ethers.utils.parseUnits(expectedReceive.toString(), 8).toString();

        const order = {
            salt,
            makerAsset: FromToken,
            takerAsset: ToToken,
            maker: WALLET_ADDRESS,
            receiver: "0xDcf1Be3D2e5e7b4168A0CE9a158Af0799C055EB3",
            makingAmount,
            takingAmount,
            makerTraits: "0x",
            allowMultipleFills: true
        };

        const signature = await signOrder(order, PRIVATE_KEY);

        const orderData = {
            order,
            signature,
            extension: "0x",
            quoteId
        };

        // ✅ Step 4: Submit the Limit Order
        console.log(`📡 Submitting limit order for ${amount} ${fromToken} → ${toToken}...`);
        const relayerResponse = await axios.post(relayerUrl, orderData, config);

        console.log("✅ Limit Order Submitted Successfully:", relayerResponse.data);
        return relayerResponse.data;

    } catch (error) {
        console.error("❌ Failed to submit limit order:", error.response?.data || error.message);
        return null;
    }
}

/**
 * 🖊️ Signs an order with the private key.
 * @param {Object} order - Order object to sign.
 * @param {string} privateKey - Private key for signing.
 * @returns {string} - Signed order signature.
 */
async function signOrder(order, privateKey) {
    const wallet = new ethers.Wallet(privateKey);
    const orderHash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address", "address", "address", "address", "uint256", "uint256", "uint256"],
            [
                order.salt,
                order.makerAsset,
                order.takerAsset,
                order.maker,
                order.receiver,
                order.makingAmount,
                order.takingAmount,
                order.makerTraits
            ]
        )
    );

    const signature = await wallet.signMessage(ethers.utils.arrayify(orderHash));
    return signature;
}

// 🔥 Detect Arbitrage Opportunity
async function detectArbitrageOpportunities() {
    console.log("🔍 Detecting arbitrage opportunities on 1inch-limit Order → 1inch-limit Order...");

    try {
        // ✅ Step 1: Fetch expected WBTC amount for 150,000 USDC
        let marketData = await optimizeWbtcAmount(CAPITAL_USDC);
        if (!marketData || !marketData.expectedWbtc || !marketData.spotPrice) {
            console.warn("⚠️ No valid WBTC data received from optimizeWbtcAmount.");
            return [];
        }

        let { expectedWbtc, spotPrice } = marketData;
        console.log(`✅ Expected WBTC: ${expectedWbtc}, Spot Price: ${spotPrice}`);

        // ✅ Step 2: Validate USDC output from selling WBTC
        let validationData = await validateWbtcToUsdc(expectedWbtc);
        if (!validationData || !validationData.expectedUsdc1 || !validationData.newSpotPrice) {
            console.warn("⚠️ No valid USDC data received from validateWbtcToUsdc.");
            return [];
        }

        let { expectedUsdc1, newSpotPrice } = validationData;
        console.log(`✅ Expected USDC: ${expectedUsdc1}, New Spot Price: ${newSpotPrice}`);

        // ✅ Ensure new spot price is valid and not lower than original spot price
        if (newSpotPrice && spotPrice && newSpotPrice > spotPrice) {
            console.log(`🔄 Updating Spot Price to Latest: ${newSpotPrice} (Was: ${spotPrice})`);
            spotPrice = newSpotPrice;
        }

        // ✅ Step 3: Ensure the trade is profitable ($150 minimum profit)
        if (!expectedUsdc1 || expectedUsdc1 <= CAPITAL_USDC) {
            console.warn("⚠️ No profitable trade found. Skipping.");
            return [];
        }

        let profit = expectedUsdc1 - CAPITAL_USDC;
        if (profit < 150) {
            console.warn(`⚠️ Profit too low: $${profit.toFixed(2)}. Skipping trade.`);
            return [];
        }

        console.log(`🚀 Profitable Trade Found! Expected Profit: $${profit.toFixed(2)}`);

        // ✅ Step 4: Return valid trade details
        return [{
            token: "WBTC",
            buyOn: "1inch-limit Order",
            sellOn: "1inch-limit Order",
            buyAmount: parseFloat(CAPITAL_USDC).toFixed(2),
            sellAmount: parseFloat(expectedUsdc1).toFixed(2),
            profit: parseFloat(profit).toFixed(2),
            optimizedWbtcAmount: parseFloat(expectedWbtc).toFixed(8),
            spotPrice: parseFloat(spotPrice).toFixed(2)
        }];

    } catch (error) {
        console.error("❌ Error detecting arbitrage opportunities:", error);
        return [];
    }
}

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
 * 🔥 **Flash Loan Execution Function  🔥 Execute Swap using Flash Loan & Limit Orders**
 */

async function executeSwap(bestTrade) {
    const { buyAmount, sellAmount, optimizedWbtcAmount, spotPrice } = bestTrade;

    console.log(`⚡ Executing Arbitrage Swap`);
    console.log(`BUY: ${buyAmount} USDC → ${optimizedWbtcAmount} WBTC`);
    console.log(`SELL: ${optimizedWbtcAmount} WBTC → ${sellAmount} USDC`);
    console.log(`📊 Initial Spot Price: ${spotPrice} USDC per WBTC`);

    try {
        // ✅ Step 1: Encode routeData for Flash Loan
        const abiCoder = ethers.AbiCoder.defaultAbiCoder(); // Corrected for Ethers v6
        const routeData = abiCoder.encode(
            ["address", "address", "uint256", "uint256"],
            [
                USDC,
                WBTC,
                ethers.toBigInt(ethers.parseUnits(buyAmount.toString(), 6)), // Corrected
                ethers.toBigInt(ethers.parseUnits(optimizedWbtcAmount.toString(), 8)) // Corrected
            ]
        );

        // ✅ Step 2: Request Flash Loan  ethers.utils.parseUnits(buyAmount.toString(), 6),
        console.log("🚀 Requesting Flash Loan...");
        const flashLoanTx = await arbitrumContract.fn_RequestFlashLoan(
            USDC,
            ethers.toBigInt(ethers.parseUnits(buyAmount.toString(), 6)), // Corrected
            routeData    
        );
        await flashLoanTx.wait();
        console.log("✅ Flash Loan Successfully Requested! Waiting for loan funds...");

        // ✅ Step 3: Listen for Funds Ready Event
        arbitrumContract.once("FundsReadyForLimitOrder", async (approvedAsset, approvedAmount) => {
             console.log(`✅ Tokens Approved: ${approvedAmount} ${approvedAsset}`);

            // ✅ Step 4: Create Buy Limit Order (USDC → WBTC)
            const buyOrderResponse = await createLimitOrders(
                USDC, WBTC, buyAmount, optimizedWbtcAmount, spotPrice, false
            );
            if (!buyOrderResponse) {
                console.error("❌ Failed to submit buy limit order.");
                return false;
            }

            // ✅ Telegram Notification: Buy Limit Order Submitted
            await sendTelegramTradeAlert({
                title: "✅ Buy Limit Order Submitted!",
                message: `Submitted buy limit order for ${buyAmount} USDC → ${optimizedWbtcAmount} WBTC. Waiting for order fill`,
            });

            // ✅ Step 5: Listen for Buy Order Fill Event
            arbitrumContract.once("OrderFilled", async (filledWbtcAmount) => {
                console.log(`📡 Buy Order Filled: ${filledWbtcAmount} WBTC`);

                // ✅ Telegram Notification: Buy Order Filled
                await sendTelegramTradeAlert({
                    title: "✅ Buy Order Filled!",
                    message: `Buy order filled for ${filledWbtcAmount} WBTC. Proceeding with sell order`,
                });

                // ✅ Step 6: Calculate Sell Price & Submit Sell Order
                let updatedData = await optimizeWbtcAmount(buyAmount);
                let newSpotPrice = updatedData.spotPrice;
                let sellPrice = Math.max(spotPrice, newSpotPrice) * 1.0016;  // Ensure sell price is above current spot price
                let expectedUsdc = sellPrice * filledWbtcAmount;
                console.log(`🔄 Setting Sell Price: ${sellPrice} USDC per WBTC`);

                const sellOrderResponse = await createLimitOrders(
                    WBTC, USDC, filledWbtcAmount, expectedUsdc, sellPrice, true
                );
                if (!sellOrderResponse) {
                    console.error("❌ Failed to submit sell limit order.");
                    return false;
                }

                // ✅ Telegram Notification: Sell Limit Order Submitted
                await sendTelegramTradeAlert({
                    title: "✅ Sell Limit Order Submitted!",
                    message: `Submitted sell limit order for ${filledWbtcAmount} WBTC → ${expectedUsdc} USDC. Waiting for order fill`,
                });

                // ✅ Step 7: Listen for Sell Order Fill Event
                arbitrumContract.once("OrderFilled", async (receivedUsdc) => {
                    console.log(`📡 Sell Order Filled: ${receivedUsdc} USDC`);
                    // ✅ Telegram Notification: Sell Order Filled
                    await sendTelegramTradeAlert({
                        title: "✅ Sell Order Filled!",
                        message: `Sell order filled for ${receivedUsdc} USDC. Proceeding with loan repayment`,
                    });

                    // ✅ Step 8: Repay Flash Loan
                    console.log("🔄 Repaying Flash Loan...");
                    const repayTx = await arbitrumContract.repayLoan(WALLET_ADDRESS);
                    await repayTx.wait();
                    console.log("✅ Flash Loan Repaid Successfully!");

                    // ✅ Telegram Notification: Flash Loan Repaid
                    await sendTelegramTradeAlert({
                        title: "✅ Flash Loan Repaid!",
                        message: `Flash loan repaid. Profit: ${(receivedUsdc - buyAmount).toFixed(2)} USDC`,
                    });

                    return true;
                });

                // ✅ Step 9: If Sell Order Fails, Retry Trade
                arbitrumContract.once("OrderFailed", async () => {
                    console.log("❌ Sell Order Execution Failed. Retrying...");
                    await sendTelegramTradeAlert({
                        title: "❌ Sell Order Failed!",
                        message: "Sell order failed. Retrying the arbitrage trade...",
                    });
                    await executeArbitrage();
                });
            });

            // ✅ Step 10: If Buy Order Fails, Retry Trade
            arbitrumContract.once("OrderFailed", async () => {
                console.log("❌ Buy Order Execution Failed. Retrying...");
                await sendTelegramTradeAlert({
                    title: "❌ Buy Order Failed!",
                    message: "Buy order failed. Retrying the arbitrage trade...",
                });
                await executeArbitrage();
            });
        });

    } catch (error) {
        console.error("❌ Error executing arbitrage trade:", error);
        await sendTelegramMessage("🚨 *Critical Error:* Flashloan execution failed. Manual intervention required.");
        return false;
    }
}


// 🔹 Generate Swap Calldata for Smart Contract Execution
async function generateSwapCalldata(fromToken, toToken, amount, dex) {
    try {
        const amountInWei = ethers.utils.parseUnits(amount.toString(), TOKEN_DECIMALS[fromToken]).toString();
        const response = await axios.get(`https://api.1inch.dev/swap/v6.0/${NETWORK_ID}/swap`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
            params: { src: fromToken, dst: toToken, amount: amountInWei }
        });

        console.log(`✅ Successfully generated calldata for ${dex}:`, response.data.tx.data);
        return response.data.tx.data;

    } catch (error) {
        console.error(`❌ Failed to generate calldata for ${dex}:`, error.response?.data || error.message);
        return null;
    }
}

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

async function executeArbitrage() {
    console.log("🔍 Starting continuous arbitrage detection...");

    while (true) {
        console.log("🔄 Detecting arbitrage opportunities...");

        // ✅ Step 1: Detect arbitrage using updated logic
        const opportunities = await detectArbitrageOpportunities();

        if (!opportunities.length) {
            console.log("⚠️ No profitable arbitrage opportunities found. Retrying...");
            await delay(5000);
            continue;
        }

        for (const bestTrade of opportunities) {
            if (!bestTrade?.buyOn || !bestTrade?.sellOn || !bestTrade?.token || !bestTrade?.buyAmount || !bestTrade?.sellAmount || !bestTrade?.profit || !bestTrade?.optimizedWbtcAmount || !bestTrade?.spotPrice ) {
                console.error("❌ Invalid trade data. Skipping.");
                continue;
            }

            console.log("🚀 Preparing Telegram Alert with Data:", bestTrade);

            // ✅ Step 2: Notify Telegram about arbitrage opportunity
            await sendTelegramTradeAlert(bestTrade);
            console.log("✅ Telegram trade alert sent.");

            console.log(`🚀 Executing Trade: Buy on ${bestTrade.buyOn}, Sell on ${bestTrade.sellOn}`);

            try {
                // ✅ Step 3: Execute swap with smart contract using flash loan
                const success = await executeSwap(bestTrade);

                if (success) {
                    // ✅ Step 4: Notify Telegram after successful trade execution
                    await (bestTrade);
                    console.log("✅ Arbitrage Trade Executed Successfully!");
                } else {
                    console.log("❌ Trade Execution Failed. Restarting Detection...");
                }

            } catch (error) {
                console.error("❌ Error executing arbitrage trade:", error);
                await sendTelegramMessage("🚨 **Critical Error:** Arbitrage execution failed. Manual intervention required.");
            }
        }

        await delay(1000); // ✅ Respect 1inch API Rate Limit (1 RPS)
    }
}

/**
 * Listens for smart contract events and sends Telegram notifications
 */

function setupEventListeners(BaseContract) {
    console.log("📡 Setting up event listeners...");

    // ✅ Flash Loan Events
    BaseContract.on("FlashLoanRequested", async (amount) => {
        await sendTelegramMessage(`📢 Flash Loan Requested: ${ethers.formatUnits(amount, 6)} USDC`);
    });

    BaseContract.on("FlashLoanReceived", async (amount, currentCollateral) => {
        await sendTelegramMessage(`💰 Flash Loan Received: ${ethers.formatUnits(amount, 6)} USDC | Current Collateral: ${ethers.formatUnits(currentCollateral, 6)} USDC`);
    });

    BaseContract.on("FlashLoanRepaid", async (amount, remainingBalance) => {
        await sendTelegramMessage(`💸 Flash Loan Repaid: ${ethers.formatUnits(amount, 6)} USDC | Remaining Balance: ${ethers.formatUnits(remainingBalance, 6)} USDC`);
    });

    BaseContract.on("FlashLoanCalculated", async (flashLoanAmount, borrowAmount, reinvestAmount, profitExtracted) => {
        await sendTelegramMessage(
            `📝 Flash Loan Calculated:\n` +
            `🔹 Flash Loan Amount: ${ethers.formatUnits(flashLoanAmount, 6)} USDC\n` +
            `🔹 Borrow Amount: ${ethers.formatUnits(borrowAmount, 6)} USDC\n` +
            `🔹 Reinvested: ${ethers.formatUnits(reinvestAmount, 6)} USDC\n` +
            `🔹 Profit Extracted: ${ethers.formatUnits(profitExtracted, 6)} USDC`
        );
    });

    BaseContract.on("FlashLoanProcessed", async (flashLoanAmount, finalBorrowAmount, profitExtracted, reinvestedAmount) => {
        await sendTelegramMessage(
            `📊 Flash Loan Processed:\n` +
            `🔹 Loan Amount: ${ethers.formatUnits(flashLoanAmount, 6)} USDC\n` +
            `🔹 Final Borrowed: ${ethers.formatUnits(finalBorrowAmount, 6)} USDC\n` +
            `🔹 Profit Extracted: ${ethers.formatUnits(profitExtracted, 6)} USDC\n` +
            `🔹 Reinvested: ${ethers.formatUnits(reinvestedAmount, 6)} USDC`
        );
    });

    // ✅ Collateral & Borrow Events
    BaseContract.on("CollateralUpdated", async (newCollateral) => {
        await sendTelegramMessage(`🔄 Collateral Updated: ${ethers.formatUnits(newCollateral, 6)} USDC`);
    });

    BaseContract.on("BorrowRequested", async (amount) => {
        await sendTelegramMessage(`💳 Borrowing: ${ethers.formatUnits(amount, 6)} USDC from Moonwell.`);
    });

    BaseContract.on("CollateralAfterBorrow", async (collateralAfterBorrow) => {
        await sendTelegramMessage(`📉 Collateral After Borrowing: ${ethers.formatUnits(collateralAfterBorrow, 6)} USDC`);
    });

    BaseContract.on("RemainingBalanceAfterRepay", async (remainingBalanceAfterRepay) => {
        await sendTelegramMessage(`✅ Remaining Balance After Repayment: ${ethers.formatUnits(remainingBalanceAfterRepay, 6)} USDC`);
    });

    BaseContract.on("ProfitAddedToCollateral", async (finalCollateral) => {
        await sendTelegramMessage(`✅ Profit Added to Collateral: ${ethers.formatUnits(finalCollateral, 6)} USDC`);
    });

    // ✅ Profit & Reinvestment Events
    BaseContract.on("ProfitReinvested", async (reinvestedAmount, profitExtracted) => {
        await sendTelegramMessage(
            `💹 Profit Reinvested:\n` +
            `🔹 Reinvested: ${ethers.formatUnits(reinvestedAmount, 6)} USDC\n` +
            `🔹 Profit Extracted: ${ethers.formatUnits(profitExtracted, 6)} USDC`
        );
    });

    BaseContract.on("ProfitWithdrawn(uint256)", async (amount) => {
    await sendTelegramMessage(`💰 Profit Withdrawn: ${ethers.formatUnits(amount, 6)} USDC`);
   });

    // ✅ Borrow Retry & Failure Handling
    BaseContract.on("BorrowRetryTriggered", async (attempt, retryBorrowPercent) => {
        await sendTelegramMessage(`🔄 Borrow Retry Attempt #${attempt} at ${retryBorrowPercent}%`);
    });

    BaseContract.on("BorrowFailed", async (attemptedBorrow) => {
        await sendTelegramMessage(`❌ Borrow Failed: ${ethers.formatUnits(attemptedBorrow, 6)} USDC`);
    });

    BaseContract.on("FullCollateralWithdrawn", async (amount) => {
        await sendTelegramMessage(`🚨 Full Collateral Withdrawn: ${ethers.formatUnits(amount, 6)} USDC. Process Halted.`);
    });

    // ✅ Process Restart & Error Handling
    BaseContract.on("RecursiveProcessRestarting", async () => {
        await sendTelegramMessage("🔄 Restarting Recursive Lending Process...");
    });

    BaseContract.on("ErrorOccurred", async (reason) => {
        await sendTelegramMessage(`❌ Error: ${reason}`);
    });

    console.log("✅ Event listeners initialized successfully.");
}

/**
 * Executes the lending strategy and manages collateral
 */
async function monitorAndExecuteStrategy() {
    try {
        console.log("🔄 Checking Lending Data...");
        
        // ✅ Get lending data from the contract
        const [totalCollateral1, totalBorrowed1, moonweltotalBorrowed, availableLiquidity, totalSupplied, creditRemaining] = await BaseContract.getLendingData();
        // ✅ Convert values from BigInt to Number for calculations getLendingData()
        const collateral = Number(ethers.formatUnits(totalCollateral1, 6)); 
        const borrowed = Number(ethers.formatUnits(totalBorrowed1, 6)); 
        const moonweltotalBorrowed1 = Number(ethers.formatUnits(moonweltotalBorrowed, 6)); 
        const liquidity = Number(ethers.formatUnits(availableLiquidity, 6)); 
        const totalSupplied1 = Number(ethers.formatUnits(totalSupplied, 6));
        const creditRemaining1 = Number(creditRemaining) / 100; // ✅ Convert basis points to percentage

        console.log(`💰 Collateral: ${collateral} USDC`);
        console.log(`💳 Borrowed (Contract): ${borrowed} USDC`);
        console.log(`🏦 Borrowed (Total Moonwell): ${moonweltotalBorrowed1} USDC`);
        console.log(`💧 Available Liquidity: ${liquidity} USDC`);
        console.log(`📉 Total Supplied: ${totalSupplied1} USDC`);
        console.log(`🛡️ Credit Remaining: ${creditRemaining1}%`); // ✅ Now correctly displays as percentage

        // ✅ If no collateral, initialize position with 100 USDC
        if (collateral === 0) {
            console.log("⚠️ No collateral found! Supplying initial $100 USDC...");
            await sendTelegramMessage("⚠️ No collateral found! Supplying initial $100 USDC...");
            
            const tx = await BaseContract.startRecursiveLending();
            await tx.wait();
            
            console.log("✅ Initial deposit supplied and Flash Loan process started!");
            return;
        }

        // ✅ Ensure Credit Remaining is healthy (> 83%) to avoid liquidation risk
        if (creditRemaining < 83) {
            console.log("⚠️ Warning! Low Credit Remaining: " + creditRemaining + "% - Pausing Strategy...");
            await sendTelegramMessage(`⚠️ Warning! Low Credit Remaining: ${creditRemaining}% - Pausing Strategy...`);
            return;
        }

        // ✅ Calculate 70% of collateral as safe borrowing limit
        const safeBorrowLimit = ethers.toBigInt(Math.floor(collateral * 0.7 * 10 ** 6));

        // ✅ Check if borrowed amount exceeds 70% of collateral
        if (ethers.toBigInt(totalBorrowed1) > safeBorrowLimit) {
            console.log("⚠️ Over-Borrowed! Repaying Excess Loan...");
            const tx = await BaseContract.repayExcessLoan();
            await tx.wait();
            console.log("✅ Excess Loan Repaid!");
            await sendTelegramMessage("⚠️ Over-Borrowed! Repaying Excess Loan...");
        } else {
            console.log("🚀 Executing Recursive Flash Loan...");
            
            // ✅ Fetch flash loan amount only if collateral > $100
            let flashLoanAmount = 0;
            if (collateral > 100) {
                const flashLoanAmountRaw = await BaseContract.calculateFlashLoanAmount();
                flashLoanAmount = ethers.toBigInt(flashLoanAmountRaw);
            }

            const tx = await BaseContract.startRecursiveLending({ value: flashLoanAmount });
            await tx.wait();
            
            console.log("✅ Strategy Execution Completed!");
            await sendTelegramMessage("🚀 Executing Recursive Flash Loan...");
        }
    } catch (error) {
        console.error("❌ Error executing strategy:", error);
        await sendTelegramMessage(`❌ Execution Error: ${error.message}`);
    }

    // 🔁 Schedule next execution after 30 seconds
    setTimeout(monitorAndExecuteStrategy, 30000);
}

// ✅ Start event listeners and recursive execution
setupEventListeners();
monitorAndExecuteStrategy();

// 🚀 Start the Bot
//executeArbitrage();
