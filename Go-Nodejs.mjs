import dotenv from 'dotenv';
import fetch from 'node-fetch'; // Ensure you have node-fetch installed
import axios from 'axios';
import Web3 from 'web3';
import { BigNumber } from 'bignumber.js';
import retry from 'async-retry';
import PQueue from 'p-queue';
import Redis from 'ioredis';
import { ethers } from 'ethers';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { promisify } from 'util';

// Initialize Redis cache
const redisClient = redis.createClient();
const setAsync = promisify(redisClient.set).bind(redisClient);
const getAsync = promisify(redisClient.get).bind(redisClient)
const REDIS_TTL = 60; // Cache data for 1 minute
const API_BASE_URL = `https://api.1inch.dev/swap/v6.0/${CHAIN_ID}`;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Permit2 contract address
const API_KEY = process.env.ONEINCH_API_KEY; // Set 1inch API Key in .env
dotenv.config();

// Constants and Configuration
const GO_BACKEND_URL = process.env.GO_BACKEND_URL || "http://localhost:8080"; // Go service endpoint
const web3 = new Web3(process.env.INFURA_URL);
const redis = new Redis(process.env.REDIS_URL); // Redis for distributed caching
const queue = new PQueue({ concurrency: 1 });
const RETRY_LIMIT = 3;
const RETRY_DELAY = 1000;
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, new ethers.providers.JsonRpcProvider(process.env.INFURA_URL));
const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, permit2Abi, wallet);
const CACHE_DURATION = 5 * 60; // 5 minutes in seconds
const CHAIN_ID = 42161;
const CAPITAL = new BigNumber(100000).shiftedBy(6); // $100,000 in USDC
const MIN_PROFIT = new BigNumber(500).shiftedBy(6); // $500 profit threshold
const TELEGRAM_BOT = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CIRCUIT_BREAKER_THRESHOLD = 5; // Max consecutive failures allowed
const errorSummary = new Map();
const ERROR_SUMMARY_INTERVAL = 2 * 60 * 1000; // 10 minutes
const HARDCODED_STABLE_ADDRESSES = [
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",//usdt
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",//usdc
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",//dai
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",//weth
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",//wbtc
];

const permit2Abi = [
    // Add relevant parts of the ABI for Permit2
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
        "internalType": "address",
        "name": "owner",
        "type": "address"
    },
    { "internalType": "bytes", "name": "signature", "type": "bytes" }
];

const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, permit2Abi, wallet);

// State Variables
let consecutiveFailures = 0;

function addErrorToSummary(error, context = '') {
  const errorKey = `${error.message} | Context: ${context}`;
  const currentCount = errorSummary.get(errorKey) || 0;
  errorSummary.set(errorKey, currentCount + 1);
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

// Schedule periodic error summaries
setInterval(sendErrorSummary, ERROR_SUMMARY_INTERVAL);

// Helper function to construct 1inch API URLs
function constructApiUrl(endpoint, params) {
  const url = new URL(`${API_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });
  return url.toString();
}

// Utility Functions
function log(message, level = 'info') {
  if (process.env.DEBUG === 'true' || level === 'error') {
    const timestamp = new Date().toISOString();
    console[level === 'error' ? 'error' : 'log'](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
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


// Redis Cache Helper
async function cachedFetch(key, fetchFn, duration = CACHE_DURATION) {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const data = await fetchFn();
  await redis.setex(key, duration, JSON.stringify(data));
  return data;
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

// Caching Helper
async function cachedFetchPrices(tokenAddresses) {
    const cacheKey = `prices:${tokenAddresses.join(',')}`;
    const cachedPrices = await redis.get(cacheKey);

    if (cachedPrices) {
        log(`Cache hit for token prices: ${tokenAddresses.join(',')}`);
        return JSON.parse(cachedPrices);
    }

    // Fetch prices from 1inch API
    const url = `https://api.1inch.dev/price/v1.1/42161/${tokenAddresses.join(',')}`;
return cachedFetch(cacheKey, async () => {
    try {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
        });

        if (!response.ok) {
            log(`1inch API request failed with status: ${response.statusText}`, 'error');
            throw new Error(`Failed to fetch prices: ${response.statusText}`);
        }

        const prices = await response.json();
        await redis.setex(cacheKey, 60, JSON.stringify(prices)); // Cache for 1 minute
        log(`Fetched token prices and updated cache: ${JSON.stringify(prices)}`);
        return prices;
    } catch (error) {
        log(`Error fetching token prices from 1inch API: ${error.message}`, 'error');
        throw error;
    }
});
}

async function fetchTokenPrices(tokens) {
    if (tokens.length === 0) {
        log('No tokens provided for price fetch.', 'warn');
        return {};
    }

    // Remove duplicates and sort tokens for consistent caching
    const uniqueTokens = [...new Set(tokens)].sort();

    try {
        const prices = await cachedFetchPrices(uniqueTokens);
        log(`Successfully fetched prices for tokens: ${uniqueTokens.join(', ')}`);
        return prices;
    } catch (error) {
        log(`Failed to fetch prices for tokens: ${uniqueTokens.join(',')}. Error: ${error.message}`, 'error');
        addErrorToSummary(error, `Token Prices Fetch: ${uniqueTokens.join(',')}`);
        throw error;
    }
}

// Fetch liquidity data for a token pair using 1inch Swap API
async function fetchLiquidityData(fromToken, toToken, amount) {
  const cacheKey = `liquidity:${fromToken}-${toToken}-${amount}`;
  const url = constructApiUrl("quote", {
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    amount,
    slippage: "1", // 1% slippage
    disableEstimate: "false",
  });

  return cachedFetch(cacheKey, async () => {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch liquidity data: ${response.statusText}`);
      }

      const liquidityData = await response.json();
      console.log(`Liquidity Data for ${fromToken} -> ${toToken}:`, liquidityData);
      return liquidityData;
    } catch (err) {
      console.error("Error fetching liquidity data:", err.message);
      throw err;
    }
  });
}

// Fetch liquidity for all stable tokens in HARDCODED_STABLE_ADDRESSES
async function fetchAllLiquidityData(baseToken, amount) {
  const liquidityData = await Promise.all(
    HARDCODED_STABLE_ADDRESSES.map(async (token) => {
      if (token !== baseToken) {
        return fetchLiquidityData(baseToken, token, amount);
      }
      return null;
    })
  );

  return liquidityData.filter((data) => data !== null);
}

// Main function to gather all critical data
async function gatherMarketData() {
  try {
    console.log("Fetching token prices...");
    const prices = await fetchTokenPrices();

    console.log("Fetching liquidity data for USDC...");
    const liquidityData = await fetchAllLiquidityData(
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      "100000000000" // $100,000 in USDC (assuming 6 decimals)
    );

    // Combine data to be passed to Go script
    const marketData = {
      prices,
      liquidity: liquidityData,
    };

    console.log("Combined Market Data:", marketData);
    return marketData;
  } catch (err) {
    console.error("Error gathering market data:", err.message);
    throw err;
  }
}


// Error Handling and Notifications
function sendTelegramMessage(message, isCritical = false) {
  const chatId = isCritical ? process.env.TELEGRAM_CRITICAL_CHAT_ID : process.env.TELEGRAM_CHAT_ID;
  return TELEGRAM_BOT.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
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
        nonce: 0, // Replace with actual nonce fetched from Permit2
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
            nonce: 0, // Replace with actual nonce
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
    const response = await axios.post(`${GO_BACKEND_URL}/generate-routes`, marketData);
    console.log("Go backend response:", response.data);
  } catch (err) {
    console.error("Failed to send market data to Go backend:", err.message);
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

// Function to process and send market data
export async function processMarketData() {
  console.log("Starting market data processing...");

  try {
    // Step 1: Fetch token prices
    console.log("Fetching token prices...");
    const tokenPrices = await fetchTokenPrices(HARDCODED_STABLE_ADDRESSES);
    console.log("Token prices fetched successfully.");

    // Step 2: Fetch liquidity data for all token pairs
    console.log("Fetching liquidity data...");
    const liquidityData = {};
    for (const token of HARDCODED_STABLE_ADDRESSES) {
      liquidityData[token] = await fetchAllLiquidityData(
        token,
        "100000000000" // $100,000 (scaled to 6 decimals for USDC/USDT/DAI)
      );
    }
    console.log("Liquidity data fetched successfully.");

    // Step 3: Aggregate market data
    const marketData = {
      tokenPrices,
      liquidity: liquidityData,
    };

    // Step 4: Cache the market data (optional but recommended)
    console.log("Caching market data...");
    const cacheKey = "marketData";
    await setAsync(cacheKey, JSON.stringify(marketData), "EX", 60); // Cache for 60 seconds
    console.log("Market data cached successfully.");

    // Step 5: Send market data to Go backend
    console.log("Sending market data to Go backend...");
    await sendMarketDataToGo(marketData);
    console.log("Market data sent successfully to Go backend.");
  } catch (error) {
    console.error("Error in processing market data:", error.message);
    // Optional: Notify a monitoring system or retry based on error type
  }
}

// Retry helper function
async function retry(fn, retries, delay) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError; // Rethrow the last error after all retries fail
}

/ Main function
export async function processMarketData() {
  console.log("Starting market data processing...");

  try {
    // Step 1: Fetch token prices with retry logic
    console.log("Fetching token prices...");
    const tokenPrices = await retry(
      () => fetchTokenPrices(HARDCODED_STABLE_ADDRESSES),
      3, // Max retries
      1000 // Retry delay in ms
    );
    console.log("Token prices fetched successfully.");

    // Step 2: Fetch liquidity data for all token pairs with retry logic
    console.log("Fetching liquidity data...");
    const liquidityData = {};
    for (const token of HARDCODED_STABLE_ADDRESSES) {
      liquidityData[token] = await retry(
        () => fetchAllLiquidityData(token, "100000000000"), // $100,000 scaled to 6 decimals
        3, // Max retries
        1000 // Retry delay in ms
      );
    }
    console.log("Liquidity data fetched successfully.");

    // Step 3: Aggregate market data
    const marketData = {
      tokenPrices,
      liquidity: liquidityData,
    };

    // Step 4: Cache the market data
    console.log("Caching market data...");
    const cacheKey = "marketData";
    await setAsync(cacheKey, JSON.stringify(marketData), "EX", 60); // Cache for 60 seconds
    console.log("Market data cached successfully.");

    // Step 5: Send market data to Go backend
    console.log("Sending market data to Go backend...");
    await retry(
      () => sendMarketDataToGo(marketData),
      3, // Max retries
      2000 // Retry delay in ms
    );
    console.log("Market data sent successfully to Go backend.");
  } catch (error) {
    // Log the error
    console.error("Error in processing market data:", error.message);

    // Step 6: Notify the monitoring system
    const notificationMessage = `Market data processing error: ${error.message}`;
    try {
      await notifyMonitoringSystem(notificationMessage);
      console.log("Monitoring system notified successfully.");
    } catch (monitoringError) {
      console.error("Failed to notify monitoring system:", monitoringError.message);
    }
  }
}
// Mempool Monitoring and Live Data Retrieval
async function monitorMempool(targetContracts) {
    const connectWebSocket = () => {
        const provider = new ethers.WebSocketProvider(process.env.INFURA_WS_URL);
        log('WebSocket connection established.');

        provider.on('pending', async (txHash) => {
            try {
                // Fetch transaction details using txHash
                const tx = await provider.getTransaction(txHash);
                if (!tx) {
                    log(`Transaction ${txHash} not found or null. Skipping...`, 'warn');
                    return;
                }

                // Ensure the transaction involves a target contract
                if (tx.to && targetContracts.includes(tx.to.toLowerCase())) {
                    log(`Transaction detected targeting monitored contract: ${txHash}`);

                    // Extract tokens from the transaction
                    const detectedTokens = extractTokensFromTransaction(tx);

                    // Filter tokens to HARDCODED_STABLE_ADDRESSES
                    const relevantTokens = detectedTokens.filter((token) =>
                        HARDCODED_STABLE_ADDRESSES.includes(token.toLowerCase())
                    );

                    if (relevantTokens.length > 0) {
                        log(`Relevant tokens detected: ${relevantTokens.join(', ')}`);

                        // Fetch live prices for the relevant tokens using shared caching
                        const tokenPrices = await fetchTokenPrices(relevantTokens);
                        log(`Fetched token prices: ${JSON.stringify(tokenPrices)}`);

                        // Call Go backend to evaluate profitability
                        const response = await retryRequest(() =>
                            axios.post(`${process.env.GO_BACKEND_URL}/evaluate`, { txHash, tokenPrices })
                        );

                        if (response.status === 200 && response.data.profit > 0) {
                            log(`Profitable transaction detected: ${txHash}`);
                            await executeRoute(response.data.route, response.data.amount);
                            await sendTelegramMessage(
                                `🚀 Profitable transaction executed from mempool!\nProfit: ${response.data.profit} USDT`
                            );
                        } else {
                            log(`Unprofitable transaction detected: ${txHash}`);
                        }
                    } else {
                        log(`No relevant tokens detected in transaction: ${txHash}`);
                    }
                }
            } catch (err) {
                log(`Error processing transaction ${txHash}: ${err.message}`, 'error');
                consecutiveFailures++;
                checkCircuitBreaker();
                addErrorToSummary(err, `Transaction: ${txHash}`);
            }
        });

        // Handle WebSocket closure and errors
        provider._websocket.on('close', () => {
            log('WebSocket connection closed. Reconnecting...', 'warn');
            setTimeout(connectWebSocket, 5000); // Retry after 5 seconds
        });

        provider._websocket.on('error', (err) => {
            log(`WebSocket error: ${err.message}`, 'error');
            addErrorToSummary(err, 'WebSocket Error');
        });

        // Send heartbeat pings to keep WebSocket alive
        setInterval(() => {
            provider.send('ping', []).catch((err) => {
                log(`Failed to send WebSocket ping: ${err.message}`, 'error');
                addErrorToSummary(err, 'WebSocket Ping');
            });
        }, 30000);
    };

    connectWebSocket();
}

export async function notifyMonitoringSystem(message) {
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
  log('Starting arbitrage bot...');

  // Define target contracts and token addresses
  const targetContracts = ['targetContractAddress1', 'targetContractAddress2'];
  const tokenAddresses = HARDCODED_STABLE_ADDRESSES;

  // Mempool Monitoring for Arbitrage Opportunities
  monitorMempool(targetContracts, process.env.CHAIN_ID, async ({ txHash, profit, srcToken, dstToken, amountIn }) => {
    log(`Mempool Arbitrage Opportunity Detected!`, 'info');
    log(`Transaction Hash: ${txHash}, Profit: ${profit.toFixed()} USDT`);
    log(`Route: ${srcToken} ➡️ ${dstToken}, Amount In: ${amountIn.toFixed()}`);

    try {
      const route = [srcToken, dstToken];
      await executeRoute(route, amountIn); // Execute using Go backend
      await sendTelegramMessage(`🚀 Executed mempool arbitrage! Profit: ${profit.toFixed()} USDT`);
    } catch (error) {
      log(`Error executing mempool arbitrage: ${error.message}`, 'error');
      await sendTelegramMessage(`❌ Error in mempool arbitrage: ${error.message}`, true);
    }
  });

  // Periodic Live Market Data Monitoring for Profitable Routes
  setInterval(async () => {
    log('Running periodic profitable route discovery...', 'info');

    try {
      // Fetch gas price and log it
      const gasPrice = await fetchGasPrice();
      log(`Current gas price: ${gasPrice.dividedBy(1e9).toFixed(2)} Gwei`, 'info');

      // Fetch live token prices for HARDCODED_STABLE_ADDRESSES
      const tokenPrices = await fetchTokenPrices(tokenAddresses);
      log(`Live token prices: ${JSON.stringify(tokenPrices)}`, 'info');

      // Call Go backend for route evaluation
      const response = await retryRequest(() =>
        axios.post(`${process.env.GO_BACKEND_URL}/evaluate`, { tokenPrices })
      );

      if (response.status === 200 && response.data.profit > 0) {
        const { route, amount } = response.data;
        log(`Executing live arbitrage: Route: ${route.join(' ➡️ ')}, Profit: ${response.data.profit}`, 'info');
        await executeRoute(route, amount); // Execute using Go backend
        await sendTelegramMessage(`🚀 Executed live arbitrage! Profit: ${response.data.profit} USDT`);
      } else {
        log('No profitable routes found in live market data.', 'info');
      }
    } catch (error) {
      log(`Error in live market data monitoring: ${error.message}`, 'error');
      await sendTelegramMessage(`❌ Error in live market data monitoring: ${error.message}`, true);
    }
  }, 5 * 60 * 1000); // Run every 5 minutes

  // Periodic Health Check for Go Backend
  cron.schedule('* * * * *', async () => {
    try {
      const response = await axios.get(`${process.env.GO_BACKEND_URL}/health`);
      if (response.status !== 200) {
        throw new Error('Go backend health check failed');
      }
      log('Go backend is healthy.', 'info');
    } catch (err) {
      await handleCriticalError(err, 'Health Check');
    }
  });
}


// Start Bot
runArbitrageBot();
