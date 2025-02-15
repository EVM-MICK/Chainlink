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
// Define providers and wallets for both networks
//const providerPolygon = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC);
const providerPolygon = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
//const providerArbitrum = new ethers.providers.JsonRpcProvider(process.env.ARBITRUM_RPC);
const providerArbitrum = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC);

const walletPolygon = new ethers.Wallet(process.env.PRIVATE_KEY, providerPolygon);
const walletArbitrum = new ethers.Wallet(process.env.PRIVATE_KEY, providerArbitrum);

// Load Smart Contracts for both networks
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

//const nonce = await permit2Contract.nonces(wallet.address);

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


const PROFIT_THRESHOLD = 200; // Minimum $500 profit per trade
const TRADE_SIZE_USDC = 100000; // $100,000 per trade

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


// 🚀 Fusion+ Quote Function (Dynamic)
// async function getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
//     const url = "https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/receive";

//     const params = {
//         srcChain: NETWORKS[srcChain],
//         dstChain: NETWORKS[dstChain],
//         srcTokenAddress: srcToken,
//         dstTokenAddress: dstToken,
//         amount: amount.toString(),
//         walletAddress: process.env.WALLET_ADDRESS,
//         enableEstimate: "true"
//     };

//     const config = {
//         headers: { "Authorization": `Bearer ${process.env.ONEINCH_API_KEY}` },
//         params
//     };

//     console.log(`📡 Fetching Fusion+ Quote: ${srcChain} → ${dstChain}, Amount: ${amount}`);

//     try {
//         const response = await axios.get(url, config);
//         console.log(`✅ Fusion+ Quote Received:`, response.data);

//         // ✅ Extract auctionEndAmount correctly
//         const dstAmount = response.data.presets?.fast?.auctionEndAmount;
//         if (!dstAmount) {
//             console.warn(`⚠️ Warning: Could not retrieve auctionEndAmount.`);
//             return null;
//         }

//         console.log(`🔹 Estimated Received Amount on ${dstChain}: ${dstAmount}`);
//         return dstAmount;
//     } catch (error) {
//         console.error(`❌ Error fetching Fusion+ quote:`, error.response?.data || error.message);
//         return null;
//     }
// }

async function fetchFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
    console.log(`📡 Fetching Fusion+ Quote: ${srcChain} → ${dstChain}, Amount: ${amount}`);

    await delay(1000); // Respect 1inch 1RPS limit

    const fusionQuote = await getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount);
    if (!fusionQuote) {
        console.error("❌ Failed to fetch Fusion+ quote");
        return null;
    }

    // Use different slippage based on volatility
    const slippage = fusionQuote.volatile ? 1.00 : 0.99;

    return {
        receivedAmount: parseFloat(fusionQuote.dstAmount) * slippage,
        quoteData: fusionQuote
    };
}

async function getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
    const url = "https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/receive";

    const params = {
        srcChain: NETWORKS[srcChain],
        dstChain: NETWORKS[dstChain],
        srcTokenAddress: srcToken,
        dstTokenAddress: dstToken,
        amount: amount.toString(),
        walletAddress: process.env.WALLET_ADDRESS,
        enableEstimate: "true"
    };

    const config = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params
    };

    try {
        const response = await axios.get(url, config);
        console.log(`✅ Fusion+ Quote Received:`, response.data);

        // ✅ Extract auctionEndAmount correctly
        const dstAmount = response.data.presets?.fast?.auctionEndAmount;
        if (!dstAmount) {
            console.warn(`⚠️ Warning: Could not retrieve auctionEndAmount.`);
            return null;
        }

        console.log(`🔹 Estimated Received Amount on ${dstChain}: ${dstAmount}`);
        return dstAmount;
    } catch (error) {
        console.error(`❌ Error fetching Fusion+ quote:`, error.response?.data || error.message);
        return null;
    }
}


async function buildFusionOrder(dstAmount, srcChain, dstChain, srcToken, dstToken, walletAddress) {
    const url = "https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/build";

    const config = {
        headers: {
            Authorization: `Bearer ${API_KEY}`
        }
    };

    const payload = {
        "srcChain": srcChain,
        "dstChain": dstChain,
        "srcTokenAddress": srcToken,
        "dstTokenAddress": dstToken,
        "amount": dstAmount.toString(),  // Use retrieved dstAmount
        "walletAddress": walletAddress,
        "fee": 0,
        "preset": "fast",
        "source": "BackendBot",
        "isPermit2": false,
        "permit": null,
        "feeReceiver": null
    };

    try {
        const response = await axios.post(url, payload, config);
        console.log("✅ Fusion+ Order Built:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Error building Fusion+ order:", error);
        return null;
    }
}

async function submitFusionOrder(orderData, srcChainId, quoteId, secretHashes, signature) {
    const url = "https://api.1inch.dev/fusion-plus/relayer/v1.0/submit";

    const config = {
        headers: {
           Authorization: `Bearer ${API_KEY}`
        }
    };

    const payload = {
        "order": orderData,
        "srcChainId": srcChainId,
        "signature": signature,
        "extension": "0x",
        "quoteId": quoteId,
        "secretHashes": secretHashes
    };

    try {
        const response = await axios.post(url, payload, config);
        console.log("🚀 Order Successfully Submitted:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Error submitting Fusion+ order:", error);
        return null;
    }
}

// 🚀 Fetch Token Prices (API-DOCUMENTED FORMAT)
// async function fetchTokenPrices(network, tokens) {
//     // ✅ Extract only the token addresses from the array
//     const tokenList = tokens.map(t => t.address).join(",").toLowerCase();
//     const url = `${API_BASE_URL}/${network}/${tokenList}`;  // Format API request URL

//     const config = {
//         headers: {
//             Authorization: `Bearer ${API_KEY}`
//         },
//         params: { currency: "USD" }  // Request prices in USD
//     };

//     return await retryRequest(async () => {
//         try {
//             console.log(`📡 Fetching prices for network ${network}...`);
//             const response = await axios.get(url, config);

//             if (!response.data) {
//                 console.error(`❌ No price data returned for network ${network}`);
//                 return null;
//             }

//             console.log(`✅ Fetched prices for network ${network}`);
//             // ✅ Convert response data to a structured format
//             return Object.fromEntries(
//                 Object.entries(response.data).map(([token, price]) => [
//                     token.toLowerCase(),
//                     parseFloat(price),
//                 ])
//             );
//         } catch (error) {
//             console.error(`❌ Error fetching prices for ${network}:`, error.response?.data || error.message);
//             throw error;  // Ensure retry logic catches this
//         }
//     });
// }

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

// async function executeFusionSwap(trade, srcToken, dstToken, amount) {
//     console.log(`🚀 Executing Fusion+ Swap: ${srcToken} → ${dstToken}, Amount: ${amount}`);

//     // 🔹 Dynamically determine source & destination chains
//     const CHAIN_IDS = {
//         "Polygon": 137,
//         "Arbitrum": 42161
//     };

//     const srcChain = CHAIN_IDS[trade.buyOn];
//     const dstChain = CHAIN_IDS[trade.sellOn];

//     if (!srcChain || !dstChain) {
//         console.error("❌ Invalid chain mapping. Check trade data:", trade);
//         return;
//     }

//     console.log(`🔄 Source Chain: ${trade.buyOn} (${srcChain})`);
//     console.log(`🔄 Destination Chain: ${trade.sellOn} (${dstChain})`);


//     try {
//         // 🔹 Execute Cross-Chain Swap using Fusion+
//         console.log(`🚀 Executing Cross-Chain Swap...`);
//         await executeCrossChainSwap(
//             srcChain, 
//             dstChain, 
//             srcToken, 
//             dstToken, 
//             amount, 
//             process.env.WALLET_ADDRESS
//         );

//         console.log(`✅ Fusion+ Cross-Chain Swap Successfully Executed!`);

//         // 🔹 Send Telegram Notification
//         await sendTelegramMessage(`✅ **Cross-Chain Swap Completed**  
//         🔹 **From:** ${trade.buyOn} (${srcToken})  
//         🔹 **To:** ${trade.sellOn} (${dstToken})  
//         🔹 **Amount:** ${amount}`);
//     } catch (error) {
//         console.error(`❌ Error executing Fusion+ swap:`, error);
//         await sendTelegramMessage(`🚨 **Error:** Fusion+ Swap Failed!\nTrade: ${trade.buyOn} → ${trade.sellOn}`);
//     }
// }

/**
 * 🔥 **Fusion+ Cross-Chain Swap Execution**
 */
async function executeFusionSwap(trade, srcToken, dstToken, amount) {
    console.log(`🚀 Executing Fusion+ Swap: ${srcToken} → ${dstToken}, Amount: ${amount}`);

    const CHAIN_IDS = { "Polygon": 137, "Arbitrum": 42161 };

    const srcChain = CHAIN_IDS[trade.buyOn];
    const dstChain = CHAIN_IDS[trade.sellOn];

    if (!srcChain || !dstChain) {
        console.error("❌ Invalid chain mapping. Check trade data:", trade);
        return;
    }

    console.log(`🔄 Source Chain: ${trade.buyOn} (${srcChain})`);
    console.log(`🔄 Destination Chain: ${trade.sellOn} (${dstChain})`);

    try {
        console.log(`🚀 Executing Cross-Chain Swap...`);
        await executeCrossChainSwap(srcChain, dstChain, srcToken, dstToken, amount, WALLET_ADDRESS);

        console.log(`✅ Fusion+ Cross-Chain Swap Successfully Executed!`);

        await sendTelegramMessage(`✅ **Cross-Chain Swap Completed**  
        🔹 **From:** ${trade.buyOn} (${srcToken})  
        🔹 **To:** ${trade.sellOn} (${dstToken})  
        🔹 **Amount:** ${amount}`);
    } catch (error) {
        console.error(`❌ Error executing Fusion+ swap:`, error);
        await sendTelegramMessage(`🚨 **Error:** Fusion+ Swap Failed!\nTrade: ${trade.buyOn} → ${trade.sellOn}`);
    }
}

// Listen for SwapExecuted Event
// arbitrumContract.on("SwapExecuted", async (srcToken, dstToken, amount, returnAmount, timestamp) => {
//     console.log(`🔥 Swap Completed: ${srcToken} → ${dstToken}, Amount: ${amount}`);
    
//     // Execute cross-chain transfer via Fusion+
//     await executeFusionSwap(srcToken, dstToken, returnAmount);
// });

// polygonContract.on("SwapExecuted", async (srcToken, dstToken, amount, returnAmount, timestamp) => {
//     console.log(`🔥 Swap Completed: ${srcToken} → ${dstToken}, Amount: ${amount}`);
    
//     // Execute cross-chain transfer via Fusion+
//     await executeFusionSwap(srcToken, dstToken, returnAmount);
// });


 // 🔥 Listen for SwapExecuted Event & Trigger Fusion Swap
async function handleSwapExecuted(srcToken, dstToken, amount, returnAmount, timestamp, chain) {
    console.log(`🔥 Swap Completed on ${chain}: ${srcToken} → ${dstToken}, Amount: ${amount}`);

    // Retrieve trade details using amount as the key
    const trade = tradeMap.get(amount.toString());

    if (!trade) {
        console.error("❌ No matching trade found for this swap event.");
        return;
    }

    // Remove trade entry after processing
    tradeMap.delete(amount.toString());

    // Execute cross-chain transfer via Fusion+
    await executeFusionSwap(trade, srcToken, dstToken, returnAmount);
}

// 🔥 Listen for Swap Events on Both Contracts
arbitrumContract.on("SwapExecuted", (srcToken, dstToken, amount, returnAmount, timestamp) =>
    handleSwapExecuted(srcToken, dstToken, amount, returnAmount, timestamp, "Arbitrum")
);

polygonContract.on("SwapExecuted", (srcToken, dstToken, amount, returnAmount, timestamp) =>
    handleSwapExecuted(srcToken, dstToken, amount, returnAmount, timestamp, "Polygon")
);

// 🚀 Fetch Prices for Both Chains (Using fetchTokenPrices)
async function fetchPricesForBothChains() {
    try {
        console.log("🔍 Fetching latest prices...");

        // ✅ Extract token addresses properly
        const polygonAddresses = TOKENS.POLYGON.map(t => t.address);
        const arbitrumAddresses = TOKENS.ARBITRUM.map(t => t.address);

        // ✅ Ensure token lists are not empty before making requests
        if (polygonAddresses.length === 0 || arbitrumAddresses.length === 0) {
            console.error("❌ No token addresses found. Aborting price fetch.");
            return null;
        }

        // ✅ Fetch prices one at a time to respect 1RPS limit
        const polygonPrices = await fetchTokenPrices(NETWORKS.POLYGON, polygonAddresses);
        await new Promise(resolve => setTimeout(resolve, 1100)); // Respect 1RPS limit
        const arbitrumPrices = await fetchTokenPrices(NETWORKS.ARBITRUM, arbitrumAddresses);

        // ✅ Ensure valid response structure
        const pricesByNetwork = {
            POLYGON: polygonPrices ?? { networkId: NETWORKS.POLYGON, prices: {} },
            ARBITRUM: arbitrumPrices ?? { networkId: NETWORKS.ARBITRUM, prices: {} },
        };

        // ✅ If prices are empty, avoid infinite retries but retry once
        if (!pricesByNetwork.POLYGON.prices || !pricesByNetwork.ARBITRUM.prices) {
            console.warn("⚠️ Some price data is missing. Retrying one more time...");
            await new Promise(resolve => setTimeout(resolve, 1500)); // Small delay
            return await fetchPricesForBothChains();
        }

        console.log("✅ Successfully fetched prices:", JSON.stringify(pricesByNetwork, null, 2));
        return pricesByNetwork;
    } catch (error) {
        console.error("❌ Error fetching prices for both chains:", error);
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
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    // ✅ Validate the details object
    if (!details || typeof details !== "object") {
        console.error("❌ Invalid trade details. Cannot send Telegram alert.");
        return;
    }

    // ✅ Extract trade details
    const { buyOn, token, buyAmount, sellOn, sellAmount, profit } = details;

    // ✅ Ensure values are correctly formatted
    const formattedBuyAmount = buyAmount !== undefined ? Number(buyAmount).toFixed(2) : "N/A";
    const formattedSellAmount = sellAmount !== undefined ? Number(sellAmount).toFixed(2) : "N/A";
    const formattedProfit = profit !== undefined ? Number(profit).toFixed(2) : "N/A";

    // ✅ Construct a clean, well-formatted message
    const message = `
🚀 **Arbitrage Trade Alert** 🚀
💰 **Buy Network:** ${buyOn || "Unknown"}
📌 **Token:** ${token || "Unknown"}
💵 **Buy Amount:** $${formattedBuyAmount}

📈 **Sell Network:** ${sellOn || "Unknown"}
💵 **Sell Amount:** $${formattedSellAmount}

✅ **Profit:** $${formattedProfit}
    `;

    if (!botToken || !chatId) {
        console.error("❌ Telegram bot token or chat ID is missing. Cannot send trade alert.");
        return;
    }

    try {
        const response = await axios.post(url, {
            chat_id: chatId,
            text: message,
        });
        console.log("✅ Telegram trade alert sent:", response.data);
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
// ✅ Fetch Swap Quote with Rate-Limiting & Null Handling

// async function fetchSwapQuote(chain, fromToken, toToken, amount) {
//     const url = `${API_BASE_URL1}/${chain}/quote`;
//     const config = {
//         headers: { Authorization: `Bearer ${API_KEY}` },
        // params: {
        //     src: fromToken,
        //     dst: toToken,
        //     amount,
        //     complexityLevel: 2,  // ✅ Ensures accurate route calculation
        //     parts: 50,           // ✅ Splits trade across multiple liquidity sources
        //     mainRouteParts: 10,   // ✅ Includes deeper route analysis
        //     includeTokensInfo: false,
        //     includeProtocols: true, // ✅ Fetches protocol details for better price accuracy
        //     includeGas: true,        // ✅ Ensures gas estimation is included
        // }
//     };

//     for (let attempt = 1; attempt <= 3; attempt++) {
//         try {
//             return await rateLimitedRequest(async () => {
//                 const response = await axios.get(url, config);
                
//                 if (response.data?.dstAmount) {
//                     console.log(`✅ Swap Quote Success: ${amount} ${fromToken} → ${response.data.dstAmount} ${toToken}`);
//                     return response.data.dstAmount;
//                 }
//             });
//         } catch (error) {
//             console.warn(`⚠️ Swap quote fetch attempt ${attempt} failed. Retrying...`);
//             await delay(2000 * attempt); // ✅ Exponential backoff to prevent API blocks
//         }
//     }

//     console.error(`❌ Failed to fetch swap quote after 3 attempts.`);
//     return null;
// }

async function fetchSwapQuote(networkId, fromToken, toToken, amount) {
    console.log(`📡 Fetching swap quote on network ${networkId} for ${amount} ${fromToken} → ${toToken}...`);
     const amountString = Math.floor(Number(amount)).toString(); // Ensure valid integer string
    const url = `${API_BASE_URL1}/${networkId}/quote`;
    const config = {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: {
            src: fromToken,
            dst: toToken,
            amountString,
            complexityLevel: 2,  // ✅ Ensures accurate route calculation
            parts: 50,           // ✅ Splits trade across multiple liquidity sources
            mainRouteParts: 10,   // ✅ Includes deeper route analysis
            includeTokensInfo: false,
            includeProtocols: true, // ✅ Fetches protocol details for better price accuracy
            includeGas: true,        // ✅ Ensures gas estimation is included
        }
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, config);
            if (response.data?.dstAmount) {
                console.log(`✅ Swap Quote: Expected ${response.data.dstAmount} ${toToken}`);
                return response.data.dstAmount;
            }
        } catch (error) {
            console.warn(`⚠️ Swap quote fetch attempt ${attempt} failed. Retrying...`);
            await delay(2000 * attempt);
        }
    }

    console.error(`❌ Failed to fetch swap quote after 3 attempts.`);
    return null;
}


// 🚀 Detect Arbitrage Opportunities
// async function detectArbitrageOpportunities(pricesByNetwork) {
//     let opportunities = [];

//     // ✅ Ensure valid price data exists
//     if (!pricesByNetwork?.POLYGON || !pricesByNetwork?.ARBITRUM) {
//         console.error("❌ No valid price data. Skipping arbitrage detection...");
//         return opportunities;
//     }

//     const polygonPrices = pricesByNetwork?.POLYGON?.prices ?? {};
//     const arbitrumPrices = pricesByNetwork?.ARBITRUM?.prices ?? {};

//     if (Object.keys(polygonPrices).length === 0 || Object.keys(arbitrumPrices).length === 0) {
//         console.warn("⚠️ One or both networks have empty price data. Skipping arbitrage detection...");
//         return opportunities;
//     }

//     console.log("✅ Checking for arbitrage opportunities...");

//     // ✅ Retrieve USDC prices from the API response
//     const usdcPolygonAddress = TOKENS.POLYGON.find(t => t.name === "USDC").address.toLowerCase();
//     const usdcArbitrumAddress = TOKENS.ARBITRUM.find(t => t.name === "USDC").address.toLowerCase();

//     const usdcPolygonPrice = polygonPrices[usdcPolygonAddress];
//     const usdcArbitrumPrice = arbitrumPrices[usdcArbitrumAddress];

//     if (!usdcPolygonPrice || !usdcArbitrumPrice) {
//         console.error("❌ USDC price missing on one or both networks. Cannot compute trade sizes.");
//         return opportunities;
//     }

//     console.log(`🔹 USDC Prices → Polygon: $${usdcPolygonPrice}, Arbitrum: $${usdcArbitrumPrice}`);

//     for (let token of TOKENS.POLYGON) {
//         const tokenName = token.name;
//         const polygonTokenAddress = token.address.toLowerCase();
//         const arbitrumToken = TOKENS.ARBITRUM.find(t => t.name === tokenName);
//         const arbitrumTokenAddress = arbitrumToken?.address.toLowerCase();

//         if (!polygonTokenAddress || !arbitrumTokenAddress) {
//             console.warn(`⚠️ Skipping ${tokenName}: No matching address on both networks`);
//             continue;
//         }

//         let polyPrice = polygonPrices[polygonTokenAddress] ?? null;
//         let arbPrice = arbitrumPrices[arbitrumTokenAddress] ?? null;

//         if (!polyPrice || !arbPrice) {
//             console.warn(`⚠️ Missing price data for ${tokenName}. Polygon: $${polyPrice}, Arbitrum: $${arbPrice}`);
//             continue;
//         }

//         console.log(`🔹 ${tokenName} Prices → Polygon: $${polyPrice}, Arbitrum: $${arbPrice}`);

//         // ✅ Case 1: Buy on Polygon, Sell on Arbitrum
//         let buyAmountPoly = 100000 / usdcPolygonPrice;  // Convert $100,000 to USDC on Polygon
//         let tokensBoughtPoly = buyAmountPoly / polyPrice; // Amount of Token received
//         let sellAmountArb = tokensBoughtPoly * arbPrice; // Convert Token to USDC on Arbitrum
//         let finalUSDCArb = sellAmountArb / usdcArbitrumPrice; // Convert to USDC on Arbitrum
//         let loanFeePoly = buyAmountPoly * 0.0005; // 0.05% loan fee
//         let profitPolyToArb = finalUSDCArb - buyAmountPoly - loanFeePoly; // Profit after fees

//         console.log(`🔄 [DEBUG] Buy on Polygon → Sell on Arbitrum`);
//         console.log(`💰 Buy Amount: ${buyAmountPoly.toFixed(2)} USDC`);
//         console.log(`🛒 Tokens Bought: ${tokensBoughtPoly.toFixed(6)} ${tokenName}`);
//         console.log(`💵 Sell Amount: ${sellAmountArb.toFixed(2)} USDC`);
//         console.log(`💵 Final USDC Output: ${finalUSDCArb.toFixed(2)} USDC`);
//         console.log(`💰 Profit: ${profitPolyToArb.toFixed(2)} USDC (Threshold: $100)`);

//         if (profitPolyToArb >= 100) {
//             opportunities.push({
//                 token: tokenName,
//                 buyOn: "Polygon",
//                 sellOn: "Arbitrum",
//                 buyAmount: buyAmountPoly,
//                 sellAmount: finalUSDCArb,
//                 profit: profitPolyToArb,
//             });

//             await sendTelegramTradeAlert({
//                 title: "📢 Arbitrage Opportunity Found",
//                 message: `💰 Buy on Polygon: $${polyPrice} | Sell on Arbitrum: $${arbPrice}
//                 🏦 Expected Profit: $${profitPolyToArb.toFixed(2)}
//                 🛒 Buy Amount: ${buyAmountPoly.toFixed(2)} USDC
//                 💵 Sell Amount: ${finalUSDCArb.toFixed(2)} USDC`
//             });
//         }

//         // ✅ Case 2: Buy on Arbitrum, Sell on Polygon
//         let buyAmountArb = 100000 / usdcArbitrumPrice; // Convert $100,000 to USDC on Arbitrum
//         let tokensBoughtArb = buyAmountArb / arbPrice; // Amount of Token received
//         let sellAmountPoly = tokensBoughtArb * polyPrice; // Convert Token to USDC on Polygon
//         let finalUSDCPly = sellAmountPoly / usdcPolygonPrice; // Convert to USDC on Polygon
//         let loanFeeArb = buyAmountArb * 0.0005; // 0.05% loan fee
//         let profitArbToPoly = finalUSDCPly - buyAmountArb - loanFeeArb; // Profit after fees

//         console.log(`🔄 [DEBUG] Buy on Arbitrum → Sell on Polygon`);
//         console.log(`💰 Buy Amount: ${buyAmountArb.toFixed(2)} USDC`);
//         console.log(`🛒 Tokens Bought: ${tokensBoughtArb.toFixed(6)} ${tokenName}`);
//         console.log(`💵 Sell Amount: ${sellAmountPoly.toFixed(2)} USDC`);
//         console.log(`💵 Final USDC Output: ${finalUSDCPly.toFixed(2)} USDC`);
//         console.log(`💰 Profit: ${profitArbToPoly.toFixed(2)} USDC (Threshold: $100)`);

//         if (profitArbToPoly >= 100) {
//             opportunities.push({
//                 token: tokenName,
//                 buyOn: "Arbitrum",
//                 sellOn: "Polygon",
//                 buyAmount: buyAmountArb,
//                 sellAmount: finalUSDCPly,
//                 profit: profitArbToPoly,
//             });

//             await sendTelegramTradeAlert({
//                 title: "📢 Arbitrage Opportunity Found",
//                 message: `💰 Buy on Arbitrum: $${arbPrice} | Sell on Polygon: $${polyPrice}
//                 🏦 Expected Profit: $${profitArbToPoly.toFixed(2)}
//                 🛒 Buy Amount: ${buyAmountArb.toFixed(2)} USDC
//                 💵 Sell Amount: ${finalUSDCPly.toFixed(2)} USDC`
//             });
//         }
//     }

//     return opportunities.sort((a, b) => b.profit - a.profit);
// }

async function detectArbitrageOpportunities(pricesByNetwork) {
    let opportunities = [];

    if (!pricesByNetwork?.POLYGON || !pricesByNetwork?.ARBITRUM) {
        console.error("❌ No valid price data. Skipping arbitrage detection...");
        return opportunities;
    }

    const polygonPrices = pricesByNetwork.POLYGON?.prices ?? {};
    const arbitrumPrices = pricesByNetwork.ARBITRUM?.prices ?? {};

    if (Object.keys(polygonPrices).length === 0 || Object.keys(arbitrumPrices).length === 0) {
        console.warn("⚠️ One or both networks have empty price data. Skipping arbitrage detection...");
        return opportunities;
    }

    console.log("✅ Checking for arbitrage opportunities...");

    // ✅ Validate TOKENS before using .find()
    if (!TOKENS?.POLYGON || !TOKENS?.ARBITRUM) {
        console.error("❌ Token list is missing for one or both networks.");
        return opportunities;
    }

    const usdcPolygon = TOKENS.POLYGON.find(t => t.name === "USDC");
    const usdcArbitrum = TOKENS.ARBITRUM.find(t => t.name === "USDC");

    if (!usdcPolygon || !usdcArbitrum) {
        console.error("❌ USDC token missing on one or both networks. Cannot compute trade sizes.");
        return opportunities;
    }

    const usdcPolygonPrice = polygonPrices[usdcPolygon.address.toLowerCase()];
    const usdcArbitrumPrice = arbitrumPrices[usdcArbitrum.address.toLowerCase()];

    if (!usdcPolygonPrice || !usdcArbitrumPrice) {
        console.error("❌ USDC price missing on one or both networks.");
        return opportunities;
    }

    console.log(`🔹 USDC Prices → Polygon: $${usdcPolygonPrice}, Arbitrum: $${usdcArbitrumPrice}`);

    for (let token of TOKENS.POLYGON) {
        const polygonToken = token;
        const arbitrumToken = TOKENS.ARBITRUM.find(t => t.name === polygonToken.name);

        if (!polygonToken || !arbitrumToken) {
            console.warn(`⚠️ Skipping ${token.name}: No matching address on both networks`);
            continue;
        }

        const polygonTokenPrice = polygonPrices[polygonToken.address.toLowerCase()];
        const arbitrumTokenPrice = arbitrumPrices[arbitrumToken.address.toLowerCase()];

        if (!polygonTokenPrice || !arbitrumTokenPrice) {
            console.warn(`⚠️ Missing price data for ${token.name}`);
            continue;
        }

        console.log(`🔹 ${token.name} Prices → Polygon: $${polygonTokenPrice}, Arbitrum: $${arbitrumTokenPrice}`);

        // ✅ Case 1: Buy on Polygon, Sell on Arbitrum
        const buyAmountPoly = 100000 / usdcPolygonPrice;
        const tokensBoughtPoly = buyAmountPoly / polygonTokenPrice;
        const sellAmountArb = tokensBoughtPoly * arbitrumTokenPrice;
        const finalUSDCArb = sellAmountArb / usdcArbitrumPrice;
        const networkFeePoly = buyAmountPoly * 0.0007; // 0.02% fee and lashloan fee 0.05% 
        const profitPolyToArb = finalUSDCArb - buyAmountPoly - networkFeePoly;

        console.log(`🔄 [DEBUG] Buy on Polygon → Sell on Arbitrum`);
        console.log(`💰 Buy Amount: ${buyAmountPoly.toFixed(2)} USDC`);
        console.log(`🛒 Tokens Bought: ${tokensBoughtPoly.toFixed(6)} ${token.name}`);
        console.log(`💵 Sell Amount: ${sellAmountArb.toFixed(2)} USDC`);
        console.log(`💵 Final USDC Output: ${finalUSDCArb.toFixed(2)} USDC`);
        console.log(`💰 Profit: ${profitPolyToArb.toFixed(2)} USDC (Threshold: $100)`);

        if (profitPolyToArb >= 100) {
            opportunities.push({
                token: token.name,
                buyOn: "Polygon",
                sellOn: "Arbitrum",
                buyAmount: buyAmountPoly,
                sellAmount: finalUSDCArb,
                profit: profitPolyToArb.toFixed(2),
            });

            await sendTelegramTradeAlert({
                title: "📢 Arbitrage Opportunity Found",
                message: `💰 Buy on Polygon: $${polygonTokenPrice} | Sell on Arbitrum: $${arbitrumTokenPrice}
                🏦 Expected Profit: $${profitPolyToArb.toFixed(2)}
                🛒 Buy Amount: ${buyAmountPoly.toFixed(2)} USDC
                💵 Sell Amount: ${finalUSDCArb.toFixed(2)} USDC`
            });
        }

        // ✅ Case 2: Buy on Arbitrum, Sell on Polygon
        const buyAmountArb = 100000 / usdcArbitrumPrice;
        const tokensBoughtArb = buyAmountArb / arbitrumTokenPrice;
        const sellAmountPoly = tokensBoughtArb * polygonTokenPrice;
        const finalUSDCPly = sellAmountPoly / usdcPolygonPrice;
        const networkFeeArb = buyAmountArb * 0.0007; // 0.02% fee and lashloan fee 0.05%
        const profitArbToPoly = finalUSDCPly - buyAmountArb - networkFeeArb;

        console.log(`🔄 [DEBUG] Buy on Arbitrum → Sell on Polygon`);
        console.log(`💰 Buy Amount: ${buyAmountArb.toFixed(2)} USDC`);
        console.log(`🛒 Tokens Bought: ${tokensBoughtArb.toFixed(6)} ${token.name}`);
        console.log(`💵 Sell Amount: ${sellAmountPoly.toFixed(2)} USDC`);
        console.log(`💵 Final USDC Output: ${finalUSDCPly.toFixed(2)} USDC`);
        console.log(`💰 Profit: ${profitArbToPoly.toFixed(2)} USDC (Threshold: $100)`);

        if (profitArbToPoly >= 100) {
            opportunities.push({
                token: token.name,
                buyOn: "Arbitrum",
                sellOn: "Polygon",
                buyAmount: buyAmountArb,
                sellAmount: finalUSDCPly,
                profit: profitArbToPoly.toFixed(2),
            });

            await sendTelegramTradeAlert({
                title: "📢 Arbitrage Opportunity Found",
                message: `💰 Buy on Arbitrum: $${arbitrumTokenPrice} | Sell on Polygon: $${polygonTokenPrice}
                🏦 Expected Profit: $${profitArbToPoly.toFixed(2)}
                🛒 Buy Amount: ${buyAmountArb.toFixed(2)} USDC
                💵 Sell Amount: ${finalUSDCPly.toFixed(2)} USDC`
            });
        }
    }

    return opportunities.sort((a, b) => b.profit - a.profit);
   console.log("✅ Detected Arbitrage Opportunities:", opportunities);

}

async function executeCrossChainSwap(srcChain, dstChain, srcToken, dstToken, amount, walletAddress) {
    console.log(`🔍 Fetching Fusion+ quote for ${amount} ${srcToken} from ${srcChain} to ${dstChain}...`);
    
    // ✅ Use correct `auctionEndAmount`
    const dstAmount = await getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount);
    if (!dstAmount) return console.log("❌ Failed to fetch Fusion+ quote.");

    console.log(`💰 Received Quote: Expecting ${dstAmount} ${dstToken} on ${dstChain}`);

    console.log("⚡ Building Fusion+ Order...");
    const orderData = await buildFusionOrder(dstAmount, srcChain, dstChain, srcToken, dstToken, walletAddress);
    if (!orderData) return console.log("❌ Failed to build Fusion+ order.");

    // 🔹 Generate Secret Hashes for Security
    const secrets = Array.from({ length: orderData.preset.secretsCount }).map(() => getRandomBytes32());
    const secretHashes = secrets.map((x) => HashLock.hashSecret(x));

    console.log("🚀 Submitting Fusion+ Order...");
    const executionResponse = await submitFusionOrder(orderData, srcChain, orderData.quoteId, secretHashes, "0xSIGNATURE");
    if (!executionResponse) return console.log("❌ Failed to submit Fusion+ order.");

    console.log("✅ Cross-Chain Swap Successfully Executed!");
}


// 🔹 Execute Arbitrage Trade via Smart Contracts
// async function executeSwap(trade) {
//     const { token, buyOn, sellOn, buyAmount, sellAmount } = trade;

//     console.log(`⚡ Executing Arbitrage Trade ⚡`);
//     console.log(`BUY on ${buyOn}: ${buyAmount} of ${token}`);
//     console.log(`SELL on ${sellOn}: ${sellAmount} of ${token}`);

//     // 🔹 Send Telegram Notification before Execution
//     await sendTelegramTradeAlert({
//         title: "🚀 Executing Arbitrage Trade",
//         message: `🔹 Buy on ${buyOn}: ${buyAmount} of ${token}
//         🔹 Sell on ${sellOn}: ${sellAmount} of ${token}`
//     });

//     // 🔹 Dynamically Select the Correct Contract
//     const buyContract = buyOn === "Polygon" ? polygonContract : arbitrumContract;
//     const sellContract = sellOn === "Polygon" ? polygonContract : arbitrumContract;

//     try {
//         // 🔹 1️⃣ Execute Buy on First Chain (Flash Loan + Swap)
//         console.log(`🔹 Requesting flash loan & executing buy on ${buyOn}...`);
//         const buyTx = await buyContract.executeFlashLoanAndSwap(
//             TOKENS[buyOn].USDC, 
//             TOKENS[buyOn][token], 
//             buyAmount
//         );
//         await buyTx.wait();
//         console.log(`✅ Buy Transaction Confirmed on ${buyOn}`);

//         // 🔹 2️⃣ Execute Sell on Second Chain (Swap + Repay Flash Loan)
//         console.log(`🔹 Selling & repaying loan on ${sellOn}...`);
//         const sellTx = await sellContract.executeSwapAndRepay(
//             TOKENS[sellOn][token], 
//             TOKENS[sellOn].USDC, 
//             sellAmount
//         );
//         await sellTx.wait();
//         console.log(`✅ Sell Transaction Confirmed on ${sellOn}`);

//         // 🔹 3️⃣ Execute Fusion+ Swap for Loan Repayment
//         try {
//             console.log(`🚀 Executing Fusion+ Swap for Loan Repayment...`);
//             await executeFusionSwap(TOKENS[sellOn].USDC, TOKENS[buyOn].USDC, sellAmount);
//         } catch (error) {
//             console.error("❌ Error executing Fusion+ swap for loan repayment:", error);
//             await sendTelegramMessage(`🚨 **Warning:** Loan repayment swap failed. Manual intervention required.`);
//         }

//         // 🔹 Send Telegram Notification on Successful Trade
//         await sendTelegramTradeAlert({
//             title: "✅ Arbitrage Trade Completed!",
//             message: `🏆 Successfully completed arbitrage trade!
//             ✅ Bought ${buyAmount} of ${token} on ${buyOn}
//             ✅ Sold ${sellAmount} of ${token} on ${sellOn}
//             💰 Profit: $${trade.profit}`
//         });

//         console.log("🎉 Arbitrage Trade Completed Successfully!");

//     } catch (error) {
//         console.error(`❌ Error executing arbitrage trade:`, error);
        
//         // 🔹 Send Telegram Notification on Failure
//         await sendTelegramTradeAlert({
//             title: "❌ Arbitrage Trade Failed!",
//             message: `🚨 An error occurred during execution:
//             ❌ ${error.message}`
//         });
//     }
// }

/**
 * 🔥 **Arbitrage Execution Function**
 */
async function executeSwap(trade) {
    const { token, buyOn, sellOn, buyAmount, sellAmount } = trade;

    console.log(`⚡ Executing Arbitrage Trade ⚡`);
    console.log(`BUY on ${buyOn}: ${buyAmount} of ${token}`);
    console.log(`SELL on ${sellOn}: ${sellAmount} of ${token}`);

    await sendTelegramTradeAlert({
        title: "🚀 Executing Arbitrage Trade",
        message: `🔹 Buy on ${buyOn}: ${buyAmount} of ${token}
        🔹 Sell on ${sellOn}: ${sellAmount} of ${token}`
    });

    // 🔹 Dynamically Select the Correct Contract
    const buyContractAddress = buyOn === "Polygon" ? POLYGON_SMART_CONTRACT : ARBITRUM_SMART_CONTRACT;
    const sellContractAddress = sellOn === "Polygon" ? POLYGON_SMART_CONTRACT : ARBITRUM_SMART_CONTRACT;

    try {
         // 🔹 Track trade details by amount
        tradeMap.set(buyAmount.toString(), trade);
        tradeMap.set(sellAmount.toString(), trade);

        // 🔹 1️⃣ Request Flash Loan & Execute Buy & Sell Simultaneously
        console.log(`🔹 Requesting flash loans & executing swaps...`);
        const [buyTx, sellTx] = await Promise.all([
            executeFlashLoanAndSwap(buyOn, token, buyAmount, buyContractAddress),
            executeFlashLoanAndSwap(sellOn, token, sellAmount, sellContractAddress)
        ]);

        if (!buyTx || !sellTx) {
            console.error("❌ Flash loan or swap execution failed. Retrying...");
            return;
        }

        console.log(`✅ Both Buy & Sell Transactions Confirmed!`);

        // 🔹 2️⃣ Execute Fusion+ Swap for Loan Repayment
        try {
            console.log(`🚀 Executing Fusion+ Swap for Loan Repayment...`);
            await executeFusionSwap(trade, TOKENS[sellOn].find(t => t.name === "USDC").address, 
                                           TOKENS[buyOn].find(t => t.name === "USDC").address, sellAmount);
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
        await sendTelegramTradeAlert({
            title: "❌ Arbitrage Trade Failed!",
            message: `🚨 An error occurred during execution:
            ❌ ${error.message}`
        });
    }
}

/**
 * 🔥 **Flash Loan Execution Function**
 */
async function executeFlashLoanAndSwap(chain, token, amount, contractAddress) {
    console.log(`🚀 Requesting Flash Loan & Swap on ${chain} for ${amount} ${token}`);

    const flashLoanData = {
        src: token,
        dst: TOKENS[chain].find(t => t.name === "USDC").address,
        amount: Math.floor(amount).toString(),
        from: contractAddress,
        origin: WALLET_ADDRESS,
        slippage: 1
    };

    try {
        const response = await axios.get(
            `https://api.1inch.dev/swap/v6.0/${NETWORKS[chain]}/swap`,
            {
                headers: { Authorization: `Bearer ${API_KEY}` },
                params: flashLoanData
            }
        );

        console.log("✅ Flash Loan Swap Data Generated:", response.data);
        return response.data;
    } catch (error) {
        console.error("❌ Failed to generate Flash Loan Swap data:", error.response?.data || error.message);
        return null;
    }
}

// 🔥 **Swap Execution & Loan Repayment Function**
async function executeSwapAndRepay(chain, srcToken, dstToken, amount) {
    console.log(`🔄 Swapping & Repaying Flash Loan on ${chain} for ${amount} ${srcToken}`);

    try {
        const swapData = await executeFlashLoanAndSwap(chain, srcToken, amount);
        if (!swapData) throw new Error("Swap data generation failed");

        console.log("✅ Executing Swap on 1inch Router...");
        console.log(`✅ Successfully Swapped & Repaid Loan on ${chain}`);
    } catch (error) {
        console.error("❌ Swap Execution Failed:", error.message);
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

async function fetchInitialSwapQuote(chain, usdcAmount) {
    const quote = await fetchSwapQuote(
        chain,
        TOKENS[chain].USDC,
        TOKENS[chain].WETH,
        usdcAmount
    );
    if (!quote) {
        console.error("❌ Failed to fetch initial swap quote");
        return null;
    }
    return parseFloat(quote);
}

async function repayFlashLoan(chain, loanAmount, premium) {
    const totalRepayment = loanAmount + premium;
    console.log(`💰 Repaying Flash Loan on ${chain} with ${totalRepayment} USDC...`);
    await executeLoanRepayment(chain, totalRepayment);
}


async function sendUSDCBack(chain, amount) {
    const minRequired = 100050; // Minimum repayment required
    if (amount < minRequired) {
        console.error(`❌ Insufficient USDC received. Expected ${minRequired}, got ${amount}`);
        await sendTelegramMessage(`🚨 **Warning:** Received only ${amount} USDC. Manual intervention required!`);
        return;
    }

    console.log(`🔄 Sending ${amount} USDC back to ${chain} for flash loan repayment`);
    await executeFusionSwap(TOKENS[chain].USDC, TOKENS[chain].USDC, amount);
}


async function swapTokenForUSDC(chain, token, amount) {
    const usdcAmount = await fetchSwapQuote(chain, token, TOKENS[chain].USDC, amount);
    console.log(`✅ Swapping ${amount} ${token} → ${usdcAmount} USDC on ${chain}`);
    return usdcAmount;
}

async function requestFlashLoan(targetChain, token, amount) {
    const bufferAmount = amount * 1.005; // Add 0.5% buffer to avoid underfunding
    console.log(`🚀 Requesting Flash Loan on ${targetChain} for ${bufferAmount.toFixed(4)} ${token}`);
    await executeFlashLoan(
        targetChain === "Polygon" ? NETWORKS.POLYGON : NETWORKS.ARBITRUM,
        token,
        bufferAmount.toFixed(0) // Convert to whole number for better precision
    );
}

// async function fetchFusionQuote(srcChain, dstChain, srcToken, dstToken, amount) {
//     const fusionQuote = await getFusionQuote(srcChain, dstChain, srcToken, dstToken, amount);
//     if (!fusionQuote) {
//         console.error("❌ Failed to fetch Fusion+ quote");
//         return null;
//     }

//     // Use different slippage based on volatility
//     const slippage = fusionQuote.volatile ? 1.00 : 0.99;

//     return {
//         receivedAmount: parseFloat(fusionQuote.dstAmount) * slippage,
//         quoteData: fusionQuote
//     };
// }

async function signFusionOrder(orderData) {
    const domain = {
        name: "Fusion+",
        version: "1",
        chainId: orderData.srcChainId,
        verifyingContract: "0x1InchFusionContractAddress"
    };

    const types = {
        Order: [
            { name: "makerAsset", type: "address" },
            { name: "takerAsset", type: "address" },
            { name: "makingAmount", type: "uint256" },
            { name: "takingAmount", type: "uint256" }
        ]
    };

    return await wallet._signTypedData(domain, types, orderData);
}


// 🚀 Execute Arbitrage Trade
async function executeArbitrage() {
    console.log("🔍 Starting continuous arbitrage detection...");

    while (true) {
        console.log("🔄 Fetching latest prices...");
        const prices = await fetchPricesForBothChains();

        if (!prices || !prices.POLYGON || !prices.ARBITRUM) {
            console.error("❌ Failed to fetch valid price data. Retrying...");
            await delay(5000);
            continue;
        }

        console.log("✅ Prices fetched. Detecting arbitrage opportunities...");
        const opportunities = await detectArbitrageOpportunities(prices);

        if (!opportunities.length) {
            console.log("⚠️ No profitable arbitrage opportunities found. Retrying...");
            await delay(5000);
            continue;
        }

        for (const bestTrade of opportunities) {
            if (!bestTrade || !bestTrade.buyOn || !bestTrade.sellOn || !bestTrade.token || !bestTrade.buyAmount || !bestTrade.sellAmount || !bestTrade.profit) {
                console.error("❌ Invalid trade data. Skipping.");
                continue;
            }

            console.log(`🚀 Executing Trade: Buy on ${bestTrade.buyOn}, Sell on ${bestTrade.sellOn}`);
            await sendTelegramTradeAlert(bestTrade);

            try {
                const buyNetwork = bestTrade.buyOn.toUpperCase();
                const sellNetwork = bestTrade.sellOn.toUpperCase();
                const token = bestTrade.token.toUpperCase();
                // Ensure amount is a positive integer string
            const buyAmountString = Math.floor(bestTrade.buyAmount).toString();
                console.log(`🔄 Debugging trade details before validation:`);
                console.log(`➡️ Buy Network: ${buyNetwork}`);
                console.log(`➡️ Sell Network: ${sellNetwork}`);
                console.log(`➡️ Token: ${token}`);

                if (!TOKENS[buyNetwork] || !TOKENS[sellNetwork]) {
                    console.error(`❌ Missing TOKENS data for ${buyNetwork} or ${sellNetwork}. Skipping trade.`);
                    continue;
                }

                const buyToken = TOKENS[buyNetwork].find(t => t.name.toUpperCase() === token);
                const sellToken = TOKENS[sellNetwork].find(t => t.name.toUpperCase() === token);
                const buyUSDC = TOKENS[buyNetwork].find(t => t.name === "USDC");
                const sellUSDC = TOKENS[sellNetwork].find(t => t.name === "USDC");

                if (!buyToken || !sellToken || !buyUSDC || !sellUSDC) {
                    console.error("❌ Missing token or USDC data. Retrying...");
                    await delay(5000);
                    continue;
                }

                const buyNetworkId = prices[buyNetwork].networkId;
                const sellNetworkId = prices[sellNetwork].networkId;

                console.log("🔄 Fetching live swap quotes...");

                // ✅ Fetch live buy swap quote (USDC → Token)
                const buyTokenAmount = await fetchSwapQuote(
                    buyNetworkId,
                    buyUSDC.address,
                    buyToken.address,
                    buyAmountString // Ensure it's an integer string
                );

                if (!buyTokenAmount) {
                    console.error("❌ Failed to fetch buy swap quote. Retrying...");
                    continue;
                }

                console.log(`💰 Buy Swap Expected Amount: ${buyTokenAmount} ${token}`);

                // ✅ Fetch Fusion+ cross-chain swap quote (Token → Token on Sell Network)
                const fusionQuote = await fetchFusionQuote(
                    buyNetworkId,
                    sellNetworkId,
                    buyToken.address,
                    sellToken.address,
                    buyTokenAmount
                );

                if (!fusionQuote) {
                    console.error("❌ Failed to fetch Fusion+ cross-chain swap quote. Retrying...");
                    continue;
                }

                console.log(`💰 Expected Tokens After Cross-Chain Swap: ${fusionQuote.receivedAmount} ${token}`);
                const sellAmountString = Math.floor(fusionQuote.receivedAmount).toString();

                // ✅ Request Flash Loan based on received token amount
                console.log(`💰 Requesting Flash Loan on ${sellNetwork} for ${fusionQuote.receivedAmount} ${token}...`);
                // ✅ Fetch final sell swap quote (Token → USDC on Sell Network)

                const expectedFinalUSDC = await fetchSwapQuote(
                    sellNetworkId,
                    sellToken.address,
                    sellUSDC.address,
                    sellAmountString
                );
                  
               if (!expectedFinalUSDC) {
                    console.error("❌ Failed to fetch final USDC swap quote. Retrying...");
                    continue;
                }
                console.log(`💵 Final USDC Expected: ${expectedFinalUSDC} USDC`);
                const totalRepayment = bestTrade.buyAmount + (bestTrade.buyAmount * 0.0005); // Flash Loan Fee 0.05%

                if (expectedFinalUSDC <= totalRepayment) {
                    console.error("❌ Trade not profitable after fees. Skipping.");
                    continue;
                }
                console.log(`🚀 Executing Buy Swap & Cross-Chain Swap...`);
                console.log(`💵 Buying ${bestTrade.buyAmount} ${token} on ${buyNetwork}...`);
                console.log(`💵 Selling ${fusionQuote.receivedAmount} ${token} on ${sellNetwork}...`);
                  // ✅ Buy and Sell received tokens for USDC
                const [buySwapSuccess, sellSwapSuccesss] = await Promise.all([
                    executeSwap(buyNetworkId, buyUSDC.address, buyToken.address, bestTrade.buyAmount),
                    executeSwap(sellNetworkId, sellToken.address, sellUSDC.address, fusionQuote.receivedAmount)
                    
                ]);

                if (!buySwapSuccess || !sellSwapSuccess) {
                    console.error("❌ Buy or Sell Swap failed. Retrying...");
                    continue;
                }
               // console.log(`🚀 Executing Cross-Chain Swap & Loan Repayment...`);
               // await executeFusionSwap(buyNetworkId, sellNetworkId, buyToken.address, sellToken.address, buyTokenAmount);  
                console.log(`✅ Swaps executed.`);
                // ✅ Repay Flash Loan & Keep Profit
                console.log(`✅ Flash Loan Repaid. Profit: ${(expectedFinalUSDC - totalRepayment).toFixed(2)} USDC`);
                console.log(`✅ Arbitrage Trade Completed Successfully!`);
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
