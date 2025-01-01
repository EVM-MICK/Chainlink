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
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Permit2 contract address

dotenv.config();

// Constants and Configuration
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

async function fetchTokenPrices(tokens) {
  if (tokens.length === 0) {
    log('No tokens provided for price fetch.', 'warn');
    return {};
  }

  // Remove duplicates and sort tokens for consistent caching
  const uniqueTokens = [...new Set(tokens)].sort();
  const cacheKey = `prices:${uniqueTokens.join(',')}`;

  return cachedFetch(cacheKey, async () => {
    const url = `https://api.1inch.dev/price/v1.1/1/${uniqueTokens.join(',')}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`, // Ensure this is set in .env
        },
      });

      if (response.ok) {
        const prices = await response.json();
        log(`Fetched token prices: ${JSON.stringify(prices)}`);
        return prices; // Return the prices directly
      } else {
        log(`Failed to fetch token prices. Status: ${response.status}`, 'error');
        throw new Error(`Status: ${response.status}, Message: ${response.statusText}`);
      }
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
        // Fetch transaction details using txHash
        const tx = await provider.getTransaction(txHash); 
        if (!tx) return; // Ignore if transaction is null

        // Ensure the transaction involves a target contract
        if (targetContracts.includes(tx.to?.toLowerCase())) {
          log(`Detected transaction targeting monitored contract: ${txHash}`);

          // Extract tokens from the transaction
          const detectedTokens = extractTokensFromTransaction(tx);

          // Filter tokens to focus only on HARDCODED_STABLE_ADDRESSES
          const relevantTokens = detectedTokens.filter((token) =>
            HARDCODED_STABLE_ADDRESSES.includes(token.toLowerCase())
          );

          if (relevantTokens.length > 0) {
            log(`Relevant tokens detected in transaction: ${relevantTokens.join(', ')}`);

            // Fetch live prices for the relevant tokens
            const tokenPrices = await fetchTokenPrices(relevantTokens);
            log(`Dynamic token prices fetched: ${JSON.stringify(tokenPrices)}`);

            // Call Go backend to evaluate profitability
            const response = await retryRequest(() =>
              axios.post(`${process.env.GO_BACKEND_URL}/evaluate`, { txHash, tokenPrices })
            );

            if (response.status === 200 && response.data.profit > 0) {
              log(`Profitable transaction detected: ${txHash}`);
              await executeRoute(response.data.route, response.data.amount);
              await sendTelegramMessage(`🚀 Executed profitable transaction from mempool! Profit: ${response.data.profit} USDT`);
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
      log('WebSocket connection closed. Attempting to reconnect...', 'warn');
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
