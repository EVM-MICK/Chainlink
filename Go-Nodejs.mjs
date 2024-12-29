import dotenv from 'dotenv';
import axios from 'axios';
import Web3 from 'web3';
import { BigNumber } from 'bignumber.js';
import retry from 'async-retry';
import PQueue from 'p-queue';
import Redis from 'ioredis';
import { ethers } from 'ethers';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { abi as UNISWAP_ROUTER_ABI } from './UniswapV2Router.json'; // Replace with your contract's ABI

dotenv.config();

// Constants and Configuration
const web3 = new Web3(process.env.INFURA_URL);
const redis = new Redis(process.env.REDIS_URL); // Redis for distributed caching
const queue = new PQueue({ concurrency: 1 });
const RETRY_LIMIT = 3;
const RETRY_DELAY = 1000;
const CACHE_DURATION = 5 * 60; // 5 minutes in seconds
const CHAIN_ID = 42161;
const CAPITAL = new BigNumber(100000).shiftedBy(6); // $100,000 in USDC
const MIN_PROFIT = new BigNumber(500).shiftedBy(6); // $500 profit threshold
const TELEGRAM_BOT = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CIRCUIT_BREAKER_THRESHOLD = 5; // Max consecutive failures allowed
const errorSummary = new Map();
const ERROR_SUMMARY_INTERVAL = 10 * 60 * 1000; // 10 minutes


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
    // Decode the transaction input data using the Uniswap Router ABI
    const iface = new ethers.utils.Interface(UNISWAP_ROUTER_ABI); // Use appropriate ABI for decoding
    const decodedData = iface.parseTransaction({ data: tx.data });

    const tokenAddresses = [];

    // Check the method name and extract tokens based on method signature
    switch (decodedData.name) {
      case 'swapExactTokensForTokens':
      case 'swapTokensForExactTokens':
        tokenAddresses.push(...decodedData.args.path);
        break;

      case 'addLiquidity':
      case 'removeLiquidity':
        tokenAddresses.push(decodedData.args.tokenA, decodedData.args.tokenB);
        break;

      case 'addLiquidityETH':
      case 'removeLiquidityETH':
        tokenAddresses.push(decodedData.args.token);
        break;

      // Add more cases if your transactions use additional methods
      default:
        log(`Unhandled method in extractTokensFromTransaction: ${decodedData.name}`, 'warn');
    }

    // Remove duplicates and format token addresses for output
    const uniqueTokens = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
    return uniqueTokens;
  } catch (err) {
    log(`Error extracting tokens from transaction: ${err.message}`, 'error');
    return []; // Return an empty array if extraction fails
  }
}

async function fetchTokenPrices(tokens) {
  if (tokens.length === 0) {
    log('No tokens provided for price fetch.', 'warn');
    return {};
  }

  // Remove duplicates and sort tokens for consistent caching
  const uniqueTokens = [...new Set(tokens)].sort();
  const cacheKey = `prices:${uniqueTokens.join(',')}`;
  const url = `${process.env.TOKEN_API_URL}/${uniqueTokens.join(',')}`;

  return cachedFetch(cacheKey, async () => {
    try {
      const response = await retryRequest(() =>
        axios.get(url, { headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` } })
      );
      return response.data.tokens || {};
    } catch (err) {
      log(`Failed to fetch token prices for ${uniqueTokens.join(',')}: ${err.message}`, 'error');
      addErrorToSummary(err, `Token Prices Fetch: ${uniqueTokens.join(',')}`);
      throw err;
    }
  });
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


// Circuit-Breaker Logic
function checkCircuitBreaker() {
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    log('Circuit breaker activated. Halting operations temporarily.', 'error');
    sendTelegramMessage('*Circuit Breaker Activated*: Too many consecutive failures.', true);
    throw new Error('Circuit breaker activated');
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


// Mempool Monitoring and Live Data Retrieval
async function monitorMempool(targetContracts) {
  const connectWebSocket = () => {
    const provider = new ethers.WebSocketProvider(process.env.INFURA_WS_URL);
    log('WebSocket connection established.');

    provider.on('pending', async (txHash) => {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx && targetContracts.includes(tx.to.toLowerCase())) {
          log(`Detected transaction: ${txHash}`);

          // Extract tokens dynamically from the transaction or route
          const detectedTokens = extractTokensFromTransaction(tx); // Example helper function
          const tokenPrices = await fetchTokenPrices(detectedTokens);
          log(`Dynamic token prices fetched: ${JSON.stringify(tokenPrices)}`);

          // Call Go backend to evaluate profitability
          const response = await retryRequest(() =>
            axios.post(`${process.env.GO_BACKEND_URL}/evaluate`, { txHash, tokenPrices })
          );

          if (response.status === 200 && response.data.profit > 0) {
            await executeRoute(response.data.route, response.data.amount);
          } else {
            log(`Unprofitable transaction detected: ${txHash}`);
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
      log('WebSocket connection closed. Attempting to reconnect...', 'warn');
      setTimeout(connectWebSocket, 5000); // Retry after 5 seconds
    });

    provider._websocket.on('error', (err) => {
      log(`WebSocket error: ${err.message}`, 'error');
      addErrorToSummary(err, 'WebSocket Error');
    });

    // Send heartbeat pings without cluttering logs
    setInterval(() => {
      provider.send('ping', []).catch((err) => {
        log(`Failed to send WebSocket ping: ${err.message}`, 'error');
        addErrorToSummary(err, 'WebSocket Ping');
      });
    }, 30000);
  };

  connectWebSocket();
}


// Main Function
async function runArbitrageBot() {
  log('Starting arbitrage bot...');
  const targetContracts = ['targetContractAddress1', 'targetContractAddress2'];
  monitorMempool(targetContracts);

  // Periodic health check for Go backend
  cron.schedule('* * * * *', async () => {
    try {
      const response = await axios.get(`${process.env.GO_BACKEND_URL}/health`);
      if (response.status !== 200) {
        throw new Error('Go backend health check failed');
      }
      log('Go backend is healthy.');
    } catch (err) {
      await handleCriticalError(err, 'Health Check');
    }
  });
}

// Start Bot
runArbitrageBot();
