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
import { Wallet, JsonRpcProvider, Contract } from "ethers";
import cron from "node-cron";
import { promisify } from "util";
import pkg from "telegraf";

dotenv.config();
const { Telegraf } = pkg;
const INFURA_URL = process.env.INFURA_URL;
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
//const redis = new Redis(process.env.REDIS_URL); // Redis for distributed caching
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
const API_BASE_URL = `https://api.1inch.dev/price/v1.1/42161`;
const API_BASE_URL1 = "https://api.1inch.dev/swap/v6.0/42161";
const API_KEY = process.env.ONEINCH_API_KEY; // Set 1inch API Key in .env
// Constants and Configuration
const GO_BACKEND_URL = process.env.GO_BACKEND_URL || "http://humble-mindfulness-production.up.railway.app"; // Go service endpoint
const MARKET_DATA_INTERVAL_MS = 1 * 60 * 1000; // Every 1 minutes
const RETRY_LIMIT = 3;
const RETRY_DELAY = 1000;
const CACHE_DURATION = 5 * 60; // 5 minutes in seconds
const MAX_HOPS = 3;
const CAPITAL = new BigNumber(100000).shiftedBy(6); // $100,000 in USDC
const MIN_PROFIT = new BigNumber(500).shiftedBy(6); // $500 profit threshold
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Max consecutive failures allowed
const errorSummary = new Map();
const ERROR_SUMMARY_INTERVAL = 2 * 60 * 1000; // 10 minutes
const queue = new PQueue({ concurrency: 1 });
const HARDCODED_STABLE_ADDRESSES = [
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", // WBTC
];


const HARDCODED_STABLE_ADDRESSES_WITH_COMMA = [
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", // WBTC
];

// Initialize Permit2 contract instance
const permit2Contract = new web3.eth.Contract(permit2Abi, PERMIT2_ADDRESS);
// Initialize Express app
const app = express();
app.use(express.json());


// Add private key to Web3 wallet
const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);
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
  "GO_BACKEND_URL",
  "REDIS_URL",
  "MONITORING_SERVICE_URL",
  "CHAIN_ID",
]);

// Helper function to construct 1inch API URLs
/**
 * Generic function to make HTTP GET requests using Axios.
 * @param {string} endpoint - The API endpoint to call.
 * @param {object} params - Query parameters to include in the request.
 * @returns {Promise<object>} - The response data from the API.
 */
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

async function constructApiUrl(endpoint, params = {}) {
  const baseToken1 = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC
  const amount1 = "100000000000"; // $100,000 in USDC

  try {
    // Fetch token prices
    const tokenPrices = await fetchTokenPrices(HARDCODED_STABLE_ADDRESSES);
    console.log("Token Prices Response:", JSON.stringify(tokenPrices, null, 2));

    // Fetch liquidity data
    const liquidityData = await fetchAllLiquidityData(
      baseToken1,
      amount1,
      HARDCODED_STABLE_ADDRESSES_WITH_COMMA
    );
    console.log("Liquidity Data Response:", JSON.stringify(liquidityData, null, 2));

    // Construct API response based on the endpoint and params
    const apiResponse = {
      endpoint,
      params,
      tokenPrices,
      liquidityData,
    };

    return apiResponse;
  } catch (error) {
    console.error("Error constructing API URL:", error.message);
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

async function fetchNonce() {
  let nonce = null;

  try {
    if (!wallet.address) {
      console.warn('Wallet address is not configured. Skipping nonce retrieval.');
    } else {
      nonce = await web3.eth.getTransactionCount(wallet.address, 'pending');
      console.log(`Nonce fetched for wallet ${wallet.address}:`, nonce);
    }
  } catch (error) {
    console.error(`Error fetching nonce for wallet ${wallet?.address || 'unknown address'}:`, error.message);
    // Proceed without crashing
  }

  return nonce;
}

// Usage
(async () => {
  const nonce = await fetchNonce();
  if (nonce !== null) {
    console.log(`Using nonce: ${nonce}`);
  } else {
    console.log('Skipping operations that depend on nonce.');
  }
})();

/**
 * Function to handle retry requests with 1 RPS throttling and exponential backoff.
 * @param {Function} fn - The function to execute (e.g., an API call).
 * @param {number} retries - The maximum number of retry attempts.
 * @param {number} delay - The base delay in milliseconds.
 * @returns {Promise<any>} - The result of the function call.
 */
async function rateLimitedRequest(fn, retries = RETRY_LIMIT, delay = RETRY_DELAY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Throttle requests to maintain 1 RPS
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTimestamp;

      if (timeSinceLastRequest < delay) {
        const waitTime = delay - timeSinceLastRequest;
        console.log(`Throttling: Waiting ${waitTime}ms before next request...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      lastRequestTimestamp = Date.now(); // Update the timestamp for this request
      return await fn(); // Execute the function
    } catch (err) {
      if (err.response?.status === 429) {
        // Handle rate limit error
        const retryAfter = parseInt(err.response.headers['retry-after'], 10) || delay / 1000;
        console.warn(`Rate-limited. Retrying after ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt === retries) {
        // Throw error if max retries reached
        console.error(`Request failed after ${retries} retries:`, err.message);
        throw err;
      } else {
        // Exponential backoff for other errors
        const backoff = delay * Math.pow(2, attempt - 1); // Exponential increase in delay
        console.warn(`Retrying (${attempt}/${retries}) after ${backoff}ms due to error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw new Error('Maximum retry attempts exceeded.');
}


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


async function cacheLiquidityData(baseToken, targetToken, liquidityData) {
  const cacheKey = `liquidity:${baseToken}-${targetToken}`;
  await redisClient.set(cacheKey, JSON.stringify(liquidityData), "EX", 300); // Cache for 5 minutes
}

async function getCachedLiquidityData(baseToken, targetToken) {
  const cacheKey = `liquidity:${baseToken}-${targetToken}`;
  const cachedData = await redisClient.get(cacheKey);
  return cachedData ? JSON.parse(cachedData) : null;
}

async function validateTokenPrices(prices, tokens) {
  const invalidTokens = tokens.filter((token) => !prices[token.toLowerCase()]);
  if (invalidTokens.length > 0) {
    throw new Error(`Invalid token prices for addresses: ${invalidTokens.join(", ")}`);
  }
}


// Fetch Functions
async function fetchGasPrice() {
  const url = `https://api.blocknative.com/gasprices/blockprices`;
  return cachedFetch('gasPrice', async () => {
    try {
      const { data } = await retryRequest(() =>
        axios.get(url, { headers: { Authorization: `Bearer ${process.env.BLOCKNATIVE_API_KEY}` } })
      );
      const gasPriceGwei = data.blockPrices?.[0]?.baseFeePerGas;
      return new BigNumber(web3.utils.toWei(gasPriceGwei.toString(), 'gwei'));
    } catch (err) {
      log(`Failed to fetch gas price: ${err.message}`, 'error');
      addErrorToSummary(err, 'Gas Price Fetch');
      throw err;
    }
  });
}

function extractTokensFromTransaction(tx) {
  try {
    // Define the ABI for the 1inch Aggregation Router
    const AGGREGATION_ROUTER_ABI = [
      "function swap(address executor, (address srcToken, address dstToken, address payable srcReceiver, address payable dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes permit, bytes data)",
      "function unoswap(address srcToken, uint256 amount, uint256 minReturn, bytes32[] pools)",
      "function ethUnoswap(address srcToken, uint256 minReturn, bytes32[] pools)",
      "function unoswapTo(address to, address srcToken, uint256 amount, uint256 minReturn, bytes32[] pools)",
      "function ethUnoswapTo(address to, address srcToken, uint256 minReturn, bytes32[] pools)",
      "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
    ];

    // Use ethers.js Interface to parse the ABI
    const iface = new ethers.utils.Interface(AGGREGATION_ROUTER_ABI);

    // Decode the transaction input data
    const decodedData = iface.parseTransaction({ data: tx.data });

    const tokenAddresses = [];

    // Handle decoding based on the function name
    switch (decodedData.name) {
      case "swap": {
        // Extract srcToken and dstToken from SwapDescription
        const { srcToken, dstToken } = decodedData.args.desc;
        tokenAddresses.push(srcToken, dstToken);
        break;
      }

      case "unoswap":
      case "ethUnoswap": {
        // Extract the source token
        const { srcToken } = decodedData.args;
        tokenAddresses.push(srcToken);
        break;
      }

      case "unoswapTo":
      case "ethUnoswapTo": {
        // Extract the source token
        const { srcToken } = decodedData.args;
        tokenAddresses.push(srcToken);
        break;
      }

      case "swapExactTokensForTokens": {
        // Extract tokens from the `path` array
        const { path } = decodedData.args;
        tokenAddresses.push(...path);
        break;
      }

      default:
        log(`Unhandled method in extractTokensFromTransaction: ${decodedData.name}`, "warn");
    }

    // Remove duplicate addresses and return them in lowercase
    const uniqueTokens = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
    return uniqueTokens;
  } catch (err) {
    log(`Error extracting tokens from transaction: ${err.message}`, "error");
    return []; // Return an empty array if extraction fails
  }
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

// Caching Helper
async function cachedFetchPrices(tokenAddresses) {
  const cacheKey = `prices:${tokenAddresses.join(",")}`;
  const endpoint = tokenAddresses.join(",");

  // Use the cache or fetch fresh data if expired
  return cachedFetch(cacheKey, async () => {
    try {
      const data = await constructApiUrl(endpoint);
      console.log("Fetched token prices from API:", data);
      return data;
    } catch (error) {
      console.error("Error fetching token prices:", error.message);
      throw error;
    }
  });
}


async function fetchTokenPrices(tokens) {
  validateAddresses(tokens);

  const tokenList = tokens.join(",").toLowerCase();
  const cacheKey = `prices:${tokenList}`;

  return fetchAndCache(cacheKey, async () => {
    const url = `${API_BASE_URL}/${tokenList}`;
    const config = {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
      params: { currency: "USD" },
    };

    try {
      const response = await axios.get(url, config);
      const prices = response.data;

      // Ensure token keys are lowercase
      return Object.fromEntries(
        Object.entries(prices).map(([token, price]) => [token.toLowerCase(), price.toString()])
      );
    } catch (error) {
      console.error("Error fetching token prices:", error.response?.data || error.message);
      throw error;
    }
  });
}

// Fetch liquidity data for a token pair using 1inch Swap API
/**
 * Fetch liquidity data for a token pair using the 1inch API.
 * @param {string} fromToken - The address of the source token.
 * @param {string} toToken - The address of the destination token.
 * @param {string} amount - The amount to swap (in smallest units).
 * @returns {Promise<object>} - Liquidity data from the API.
 */
async function fetchLiquidityData(fromToken, toToken, amount) {
  const cacheKey = `liquidity:${fromToken}-${toToken}-${amount}`;
  return fetchAndCache(cacheKey, async () => {
    const url = `${API_BASE_URL1}/quote`;
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
      },
    };

    try {
      const response = await axios.get(url, config);
      return response.data;
    } catch (error) {
      console.error(`Error fetching liquidity for ${fromToken} -> ${toToken}:`, error.message);
      throw error;
    }
  });
}

async function fetchAllLiquidityData(baseToken, amount, stableAddresses) {
  console.log(`Fetching liquidity data for base token: ${baseToken}`);

  const liquidity = []; // Array to hold all token pair data in the required format

  for (const targetToken of stableAddresses) {
    if (targetToken.toLowerCase() === baseToken.toLowerCase()) continue; // Skip cases where the base token is the same as the target token

    try {
      // Fetch liquidity data for the token pair
      const data = await rateLimitedRequest1(() =>
        fetchLiquidityData(baseToken, targetToken, amount)
      );

      // Check if the response contains valid protocols
      if (!data || !data.protocols) {
        console.warn(`No protocols found for pair ${baseToken} -> ${targetToken}`);
        continue;
      }

      // Process each route in the `protocols` field
     const tokenPairLiquidity = data.protocols.map((route) =>
  route.map((step) =>
    step.map((protocol) => {
      if (
        protocol.name && // Ensure protocol name exists
        protocol.part > 0 && // Ensure part is greater than 0
        /^0x[a-fA-F0-9]{40}$/.test(protocol.fromTokenAddress) && // Validate Ethereum address
        /^0x[a-fA-F0-9]{40}$/.test(protocol.toTokenAddress) // Validate Ethereum address
      ) {
        // Include all fields from the protocol object
        return {
          name: protocol.name,
          part: protocol.part,
          fromTokenAddress: protocol.fromTokenAddress,
          toTokenAddress: protocol.toTokenAddress,
          ...protocol, // Spread operator to include any additional fields dynamically
        };
      } else {
        console.warn(
          `Invalid protocol data skipped for pair ${baseToken} -> ${targetToken}:`,
          protocol
        );
        return null; // Skip invalid protocol
      }
    }).filter((protocol) => protocol !== null) // Remove null protocols
  ).filter((step) => step.length > 0) // Remove empty steps
  ).filter((route) => route.length > 0); // Remove empty routes

      // Skip if no valid paths were found
      if (tokenPairLiquidity.length === 0) {
        console.warn(`No valid paths for pair ${baseToken} -> ${targetToken}`);
        continue;
      }

      // Add this token pair's liquidity data to the overall liquidity array
      liquidity.push({
        baseToken, // Source token address
        targetToken, // Target token address
        dstAmount: data.dstAmount, // Destination amount from API response
        gas: data.gas, // Gas information from API response
        paths: tokenPairLiquidity, // All processed paths for this token pair
      });
    } catch (error) {
      console.error(`Error fetching liquidity for ${baseToken} -> ${targetToken}:`, error.message);
    }
  }

  return liquidity; // Return the complete liquidity array
}

// Helper function for delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedRequest1(fn, retries = RETRY_LIMIT, delay = RETRY_DELAY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTimestamp;

      if (timeSinceLastRequest < delay) {
        const waitTime = delay - timeSinceLastRequest;
        console.log(`Throttling: Waiting ${waitTime}ms before next request...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      lastRequestTimestamp = Date.now(); // Update timestamp
      return await fn(); // Execute the request
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers["retry-after"], 10) || delay / 1000;
        console.warn(`Rate-limited. Retrying after ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt === retries) {
        console.error(`Request failed after ${retries} retries:`, err.message);
        throw err;
      } else {
        const backoff = delay * Math.pow(2, attempt - 1);
        console.warn(`Retrying (${attempt}/${retries}) after ${backoff}ms: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw new Error("Maximum retry attempts exceeded.");
}

async function gatherMarketData() {
  try {
    // Fetch token prices for the hardcoded stable addresses
    const tokenPrices = await fetchTokenPrices(HARDCODED_STABLE_ADDRESSES);
    const baseToken = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC
    const amount = "100000000000"; // Example amount

    // Fetch all liquidity data
    const liquidityData = await fetchAllLiquidityData(baseToken, amount, HARDCODED_STABLE_ADDRESSES);

    // Transform liquidity data for the Go backend
    const compiledLiquidity = liquidityData.map((entry) => ({
      baseToken: entry.baseToken,
      targetToken: entry.targetToken,
      dstAmount: entry.dstAmount,
      gas: entry.gas,
      paths: entry.paths, // Nested paths for the token pair
    }));

    // Construct the market data payload
    const marketData = {
      chainId: CHAIN_ID, // Ensure CHAIN_ID is defined elsewhere in your code
      startToken: baseToken, // The base token (e.g., USDC)
      startAmount: amount, // The amount in base token
      maxHops: 3, // Maximum hops allowed in the route
      profitThreshold: "500000000", // Minimum profit threshold (adjust as needed)
      tokenPrices, // Token prices fetched earlier
      liquidity: compiledLiquidity, // Transformed liquidity data
    };
  //console.log("Compiled market data payload:", JSON.stringify(marketData, null, 2));

    //  const cacheKey = "marketData";
    // console.log(`Caching market data with key: ${cacheKey}`);
    // await setAsync(cacheKey, JSON.stringify(marketData), "EX", 60);
    // console.log("Market data cached successfully.");

    console.log("Sending market data to Go backend...");
    await sendMarketDataToGo(marketData);
    console.log("Market data sent successfully to Go backend.");

  } catch (error) {
    console.error("Error gathering market data:", error.message);
    throw error;
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
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

// Endpoint to receive profitable routes
app.post('/notify-routes', async (req, res) => {
    const { routes } = req.body;

    if (!routes || routes.length === 0) {
        return res.status(400).json({ message: "No routes provided." });
    }

    // Format the message for Telegram
    const message = routes
        .map((route, index) => {
            return `Route ${index + 1}:\nPath: ${route.path.join(' ➡️ ')}\nProfit: ${(parseFloat(route.profit) / 1e18).toFixed(2)} USDC`;
        })
        .join('\n\n');

    // Send the formatted message to Telegram
    try {
        await sendTelegramMessage(`Profitable Routes Found:\n\n${message}`);
        console.log("Notification sent to Telegram.");
        res.status(200).json({ message: "Notification sent successfully." });
    } catch (error) {
        console.error("Failed to send Telegram notification:", error.message);
        res.status(500).json({ message: "Failed to send Telegram notification." });
    }
});

// Start the Express server
const PORT = process.env.PORT1 || 3000;
app.listen(PORT, () => {
    console.log(`Node.js server listening on port ${PORT}`);
});

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
    const domain = {
        name: "Permit2",
        version: "1",
        chainId: await wallet.getChainId(),
        verifyingContract: PERMIT2_ADDRESS
    };

    const permitData = {
        permitted: { token, amount },
        nonce: nonce, // Replace with actual nonce fetched from Permit2
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
function checkCircuitBreaker() {
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    log('Circuit breaker activated. Halting operations temporarily.', 'error');
    sendTelegramMessage('*Circuit Breaker Activated*: Too many consecutive failures.', true);
    throw new Error('Circuit breaker activated');
  }
}

// Function to send data to the Go backend for computation
async function sendMarketDataToGo(marketData) {
  try {
    console.log("Sending market data to Go backend...");
    console.log("Payload being sent:", JSON.stringify(marketData, null, 2));

    // Use retryRequest3 with proper return
    const response = await retryRequest3(async () => {
      return axios.post(`${process.env.GO_BACKEND_URL}/process-market-data`, marketData, {
        headers: { "Content-Type": "application/json" },
        timeout: 5000, // Timeout in milliseconds
      });
    });

    // Handle successful response
    if (response.status === 200) {
      console.log("Market data successfully sent to Go backend:", response.data);
      return response.data;
    } else {
      console.error(
        `Go backend responded with error: ${response.status} - ${response.statusText}`
      );
      throw new Error(`Unexpected response from backend: ${response.statusText}`);
    }
  } catch (error) {
    console.error("Error sending market data to Go backend:", error.message);

    // Log detailed backend response for debugging
    if (error.response) {
      console.error("Backend response data:", error.response.data);
      console.error("Backend response status:", error.response.status);
    }

    throw error; // Rethrow to allow higher-level handling
  }
}

async function retryRequest3(requestFn, retries = 3, delay = 1000) {
  let attempts = 0;

  while (attempts < retries) {
    try {
      return await requestFn();
    } catch (error) {
      attempts++;

      if (attempts >= retries) {
        console.error(`Failed after ${retries} attempts:`, error.message);
        if (error.response) {
          console.error("Error response data:", error.response.data);
        }
        throw error;
      }

      console.warn(`Retrying request (${attempts}/${retries}) due to error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay * attempts)); // Exponential backoff
    }
  }
}


// Integration with Go Backend
async function executeRoute(route, amount) {
  try {
    log(`Executing route: ${route.join(' ➡️ ')} with amount: ${amount.toFixed()}`);
    const response = await retryRequest(() =>
      axios.post(`${process.env.GO_BACKEND_URL}/execute`, { route, amount: amount.toFixed() })
    );
    if (response.status !== 200) {
      throw new Error(`Execution failed with status: ${response.status}`);
    }
    consecutiveFailures = 0; // Reset failures
  } catch (err) {
    consecutiveFailures++;
    checkCircuitBreaker();
    await handleCriticalError(err, `Route: ${route.join(' ➡️ ')}`);
  }
}

// Main function
async function processMarketData() {
  try {
    const marketData = await gatherMarketData();

  } catch (error) {
    console.error("Error in processing market data:", error.message);
    await sendTelegramMessage(`❌ Error in market data processing: ${error.message}`, true);
  }
}

async function fetchLiquidityForAllPairs(baseToken, amount) {
  try {
    const liquidityData = await Promise.all(
      HARDCODED_STABLE_ADDRESSES.map(async (targetToken) => {
        if (targetToken !== baseToken) {
          const data = await fetchLiquidityData(baseToken, targetToken, amount);
          return {
            fromToken: baseToken,
            toToken: targetToken,
            liquidity: data, // Replace with actual liquidity values
          };
        }
        return null;
      })
    );

    return liquidityData.filter((entry) => entry !== null);
  } catch (error) {
    log(`Error fetching liquidity data: ${error.message}`, 'error');
    throw error;
  }
}

// Mempool Monitoring and Live Data Retrieval
async function monitorMempool(targetContracts) {
  const web3 = new Web3(process.env.INFURA_WS_URL);

  console.log('Starting block polling...');

  web3.eth.subscribe('newBlockHeaders', async (error, blockHeader) => {
    if (error) {
      console.error(`Error subscribing to newBlockHeaders: ${error.message}`);
      addErrorToSummary(error, 'Block Subscription');
      return;
    }

    console.log(`New block received: ${blockHeader.number}`);

    try {
      // Fetch full block details
      const block = await web3.eth.getBlock(blockHeader.number, true);

      for (const tx of block.transactions) {
        if (tx.to && targetContracts.includes(tx.to.toLowerCase())) {
          console.log(`Transaction detected targeting monitored contract: ${tx.hash}`);

          // Implement token extraction logic
          const detectedTokens = extractTokensFromTransaction(tx);

          // Filter tokens to relevant stable addresses
          const relevantTokens = detectedTokens.filter((token) =>
            HARDCODED_STABLE_ADDRESSES.includes(token.toLowerCase())
          );

          if (relevantTokens.length > 0) {
            console.log(`Relevant tokens detected: ${relevantTokens.join(', ')}`);

            // Fetch token prices
            const tokenPrices = await fetchTokenPrices(relevantTokens);
            console.log(`Fetched token prices: ${JSON.stringify(tokenPrices)}`);

            // Call backend to evaluate transaction profitability
            const response = await retryRequest(() =>
              axios.post(`${process.env.INFURA_WS_URL}/evaluate`, { txHash: tx.hash, tokenPrices })
            );

            if (response.status === 200 && response.data.profit > 0) {
              console.log(`Profitable transaction detected: ${tx.hash}`);
              await executeRoute(response.data.route, response.data.amount);
              await sendTelegramMessage(
                `🚀 Profitable transaction executed from block polling!\nProfit: ${response.data.profit} USDT`
              );
            } else {
              console.log(`Unprofitable transaction detected: ${tx.hash}`);
            }
          } else {
            console.log(`No relevant tokens detected in transaction: ${tx.hash}`);
          }
        }
      }
    } catch (err) {
      console.error(`Error processing block ${blockHeader.number}: ${err.message}`);
      addErrorToSummary(err, `Block ${blockHeader.number}`);
    }
  });

  // Handle WebSocket reconnections
  web3.currentProvider.on('close', () => {
    console.warn('WebSocket connection closed. Reconnecting...');
    setTimeout(() => monitorMempool(targetContracts), 5000);
  });

  web3.currentProvider.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
    addErrorToSummary(err, 'WebSocket Error');
  });
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

// Main Function
async function runArbitrageBot() {
  log('Starting arbitrage bot...', 'info');

  // Periodic market data processing
  setInterval(async () => {
    log('Running periodic market data processing...', 'info');
    try {
      await processMarketData();
      log('Market data processed successfully.', 'info');
    } catch (err) {
      log(`Error in processing market data: ${err.message}`, 'error');
      await handleCriticalError(err, 'Market Data Processing');
    }
  }, MARKET_DATA_INTERVAL_MS);

  // Health check for Go backend
  cron.schedule('* * * * *', async () => {
    try {
      const response = await axios.get(`${GO_BACKEND_URL}/health`);
      if (response.status !== 200) {
        throw new Error('Go backend health check failed');
      }
      log('Go backend is healthy.', 'info');
    } catch (err) {
      log('Health check failed. Attempting recovery...', 'error');
      await handleCriticalError(err, 'Health Check');
    }
  });
}

// Start Bot
runArbitrageBot();
