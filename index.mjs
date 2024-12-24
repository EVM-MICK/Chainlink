import dotenv from 'dotenv';
import axios from 'axios';
import Web3 from 'web3';
import { BigNumber } from 'bignumber.js';
import pkg from 'telegraf';
import retry from 'async-retry';
import { createRequire } from 'module';
import { AllowanceTransfer, PERMIT2_ADDRESS } from '@uniswap/permit2-sdk'; // Correct import with proper package name.
import { ethers } from 'ethers';
import PQueue from 'p-queue';
import qs from 'qs';
import pLimit from '@esm2cjs/p-limit';
import { getAddress } from '@ethersproject/address';
import { gql, request } from 'graphql-request';
import cron from 'node-cron';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';

dotenv.config();
const { Telegraf } = pkg;
const require = createRequire(import.meta.url);
const UNISWAP_SUBGRAPH_URL = `https://gateway.thegraph.com/api/${process.env.UNISWAP_API_KEY}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`;
const ABI = require('./YourSmartContractABI.json');
// const ABI = await import('./YourSmartContractABI.json', { assert: { type: 'json' } }).then(module => module.default);
const web3 = new Web3(process.env.INFURA_URL);  // Ensure this is Polygon-compatible
const contract = new web3.eth.Contract(ABI, process.env.CONTRACT_ADDRESS);
const HEADERS = {
    Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    Accept: "application/json",
};
const RETRY_LIMIT = 5;
const RETRY_BASE_DELAY_MS = 1000; // Start with a 1-second delay
// const pLimit = require("p-limit");
// const limit = pLimit(5); // Limit to 5 concurrent requests


// Rate limiter state
let isRateLimited = false;
// Configurable parameters
const apiQueue = new PQueue({
    concurrency: 1, // Allow 1 request at a time
    interval: 1200, // 1 second interval
    intervalCap: 1, // 1 request per second
});

const CAPITAL = new BigNumber(100000).shiftedBy(6);  // $100,000 in USDC (6 decimals), Define the CAPITAL as $100,000 USDC with 6 decimals (to match USDC decimal places)
const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/42161";
const PROFIT_THRESHOLD = CAPITAL.multipliedBy(0.005);  // Equivalent to 0.5% profit
const MINIMUM_PROFIT_THRESHOLD = new BigNumber(500).shiftedBy(6);  // Minimum profit threshold $500 (6 decimals)
// Optional: Setting a higher threshold for "critical" profits
const CRITICAL_PROFIT_THRESHOLD = new BigNumber(1000).shiftedBy(6);  // Critical profit threshold $100 (6 decimals)
const chainId = 42161;
// Base URL for 1inch APIs
const ONEINCH_BASE_URL = "https://api.1inch.dev";
const CACHE_DURATION1 = 5 * 60 * 1000; // Cache duration: 5 minutes
// API Endpoints
const baseUrl = "https://api.1inch.dev/token/v1.2/42161";
const BASE_URL1 = "https://api.1inch.dev/token/v1.2";
const BASE_URL = "https://api.1inch.dev/price/v1.1";
const SWAP_API_URL = "https://api.1inch.dev/swap/v6.0/42161";   // Swap API
const TOKEN_API_URL = "https://api.1inch.dev/token/v1.2/42161/custom";
const PRICE_API_URL = "https://api.1inch.dev/price/v1.1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
// const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Replace with Permit2 address on Arbitrum
const CHAIN_ID = 42161;  // Arbitrum Mainnet
const Executor_ADDRESS = "0xE37e799D5077682FA0a244D46E5649F71457BD09";
// Stable, high-liquidity tokens to include in route evaluations
const STABLE_TOKENS = ["USDT", "USDC", "DAI", "WETH", "WBTC", "AAVE", "LINK", "ARB"];
const highLiquidityTokens = ["USDT", "USDC", "DAI", "WETH"];
const MAX_HOPS = 3;
let cachedGasPrice = null; // Cached gas price value
let lastGasPriceFetch = 0; // Timestamp of the last gas price fetch
const cacheDuration = 5 * 60 * 1000; // 5 minutes
const cache = new Map();
const quoteCache = new Map();
const priceCache = {
    data: null,
    timestamp: 0,
};
const CACHE_DURATION = 15 * 1000; // 10 seconds
const TARGET_CONTRACTS = [
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Example: Uniswap V3
    "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", // Example: SushiSwap
];

// Hardcoded stable token addresses
const HARDCODED_STABLE_ADDRESSES = [
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",//usdt
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",//usdc
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",//dai
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",//weth
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",//wbtc
];

const FALLBACK_TOKENS = [
  { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT"},
  { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC"},
  { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI"},
  { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH"},
  { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC"},
  { address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", symbol: "AAVE"},
  { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", symbol: "LINK"},
  { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB"},
];
// Contract configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Your deployed contract address

if (!process.env.INFURA_URL || !process.env.ONEINCH_API_KEY || !process.env.CONTRACT_ADDRESS || !process.env.WALLET_ADDRESS) {
    console.error("Environment variables are missing. Please check .env configuration.");
    process.exit(1);
}

let lastRequestTime = 0;
async function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
    }
    lastRequestTime = Date.now();
}
 function toDeadline(expirationMs) {
    return Math.floor(Date.now() / 1000) + Math.floor(expirationMs / 1000);
}

// Delay function for rate limiting
async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

 async function fetchNonce(walletAddress, tokenAddress) {
    return await contract.methods.nonce(walletAddress, tokenAddress).call();
}

 function log(message, level = "info") {
    if (process.env.DEBUG === 'true' || level === "error") {
        const timestamp = new Date().toISOString();
        console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }
}

 async function generatePermit2Signature(token, spender, amount) {
    const nonce = await getNonce(token);
    const expiration = Math.floor(Date.now() / 1000) + 86400; // 1-day validity
    const sigDeadline = Math.floor(Date.now() / 1000) + 3600; // 1-hour deadline

    const permitSingle = {
        details: {
            token,
            amount: BigNumber.from(amount),
            expiration,
            nonce,
        },
        spender,
        sigDeadline,
    };

    const { domain, types, values } = AllowanceTransfer.getPermitData(
        permitSingle,
        process.env.PERMIT2_ADDRESS,
        CHAIN_ID
    );

    const signature = await web3.eth.accounts.signTypedData(domain, types, values);
    return { signature, permitSingle };
}

// Generate a PermitBatch signature
 async function generatePermitBatchSignatures(tokens, spender) {
    const permitDetails = await Promise.all(
        tokens.map(async (token) => ({
            token: token.address,
            amount: token.amount.toFixed(),
            expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 1-day expiration
            nonce: await fetchNonce(process.env.WALLET_ADDRESS, token.address)
        }))
    );

    const permitBatch = {
        details: permitDetails,
        spender: spender,
        sigDeadline: Math.floor(Date.now() / 1000) + 60 * 60 // 1-hour signature validity
    };

    const { domain, types, values } = AllowanceTransfer.getPermitBatchData(
        permitBatch,
        process.env.PERMIT2_ADDRESS,
        CHAIN_ID
    );

    const signature = await web3.eth.accounts.signTypedData(domain, types, values);
    return { signature, permitBatch };
}

// Helper to fetch Permit2 nonce dynamically
 async function getNonce(tokenAddress) {
    const nonce = await AllowanceTransfer.getNonce(web3, process.env.PERMIT2_ADDRESS, process.env.WALLET_ADDRESS, tokenAddress);
    console.log(`Fetched nonce for ${tokenAddress}: ${nonce}`);
    return nonce;
}

cron.schedule("0 * * * *", async () => {
    console.log("Updating historical profit data...");
    const updatedProfitData = await getHistoricalProfitData(HARDCODED_STABLE_ADDRESSES);
    console.log("Updated Historical Profit Data:", updatedProfitData);
});

async function fetchCachedGasPrice() {
 const API_KEY1 = "40236ca9-813e-4808-b992-cb28421aba86"; // Blocknative API Key
    const url1 = "https://api.blocknative.com/gasprices/blockprices";
    const now = Date.now();

    // Use cached gas price if it is less than 5 minutes old
    if (cachedGasPrice && now - lastGasPriceFetch < 5 * 60 * 1000) {
        return cachedGasPrice;
    }

    try {
        // Fetch gas price data from the API
        const response = await axios.get(url1, {
            headers: { Authorization: `Bearer ${API_KEY1}` },
            params: {
                chainId: 42161, // Arbitrum Mainnet Chain ID
            },
        });
        const gasPriceInGwei = response.data.fast.maxFee; // Fast gas price in Gwei

        // Convert gas price from Gwei to Wei
        cachedGasPrice = new BigNumber(web3.utils.toWei(gasPriceInGwei.toString(), 'gwei'));
        lastGasPriceFetch = now; // Update the timestamp of the last fetch
        return cachedGasPrice;
    } catch (error) {
        console.error("Error fetching gas price:", error);

        // Fallback to the cached value or a default if no cache exists
        if (cachedGasPrice) {
            console.warn("Using cached gas price due to error in fetching new data.");
            return cachedGasPrice;
        }
        return new BigNumber(50).multipliedBy(1e9); // Fallback to 50 Gwei
    }
}

/**
 * Fetch historical volume for tokens.
 * @param {string} tokenAddress - Token contract address.
 * @returns {Promise<BigNumber>} - Historical volume in USD.
 */
const fetchHistoricalData = async (tokens) => {
    const results = await Promise.all(
        tokens.map((token) => limit(() => fetchHistoricalVolume(token)))
    );
    return results;
};

const fetchWithRetry = async (url, options, retries = 3, backoff = 1000) => {
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
        const response = await axios.get(url, options);
        return response.data;
    } catch (error) {
        if (retries > 0 && error.response?.status === 429) {
            console.log(`Rate limit hit. Retrying in ${backoff}ms...`);
            await delay(backoff);
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        throw error;
    }
};


/**
 * Fetch both token-specific volume and total factory volume.
 * @param {string} tokenAddress - The token address to fetch volume data for.
 * @returns {Object} - An object containing tokenVolumeUSD and totalVolumeUSD.
 */
async function fetchHistoricalVolume(tokenAddress) {
    const queries = {
        tokenQuery: gql`
            query ($token: String!) {
                token(id: $token) {
                    id
                    symbol
                    name
                    volumeUSD
                    derivedETH
                    decimals
                }
            }
        `,
        factoryQuery: gql`
            {
                factories(first: 1) {
                    totalVolumeUSD
                }
            }
        `,
    };

    try {
        // Parallel requests for token-specific and factory-wide volumes
        const [tokenResponse, factoryResponse] = await Promise.all([
            request(UNISWAP_SUBGRAPH_URL, queries.tokenQuery, {
                token: tokenAddress.toLowerCase(),
            }),
            request(UNISWAP_SUBGRAPH_URL, queries.factoryQuery),
        ]);

        // Validate and process token-specific volume
        let tokenVolumeUSD = new BigNumber(0);
        if (tokenResponse && tokenResponse.token && tokenResponse.token.volumeUSD) {
            tokenVolumeUSD = new BigNumber(tokenResponse.token.volumeUSD);
        } else {
            console.warn(`Invalid or missing data for token ${tokenAddress}:`, tokenResponse);
        }

        // Validate and process total factory volume
        let totalVolumeUSD = 0;
        if (
            factoryResponse &&
            factoryResponse.factories &&
            factoryResponse.factories[0] &&
            factoryResponse.factories[0].totalVolumeUSD
        ) {
            totalVolumeUSD = parseFloat(factoryResponse.factories[0].totalVolumeUSD);
            if (isNaN(totalVolumeUSD)) {
                console.warn(`Invalid totalVolumeUSD value:`, factoryResponse.factories[0].totalVolumeUSD);
                totalVolumeUSD = 0;
            }
        } else {
            console.warn(`Invalid or missing data for factories:`, factoryResponse);
        }

        return { tokenVolumeUSD, totalVolumeUSD };
    } catch (error) {
        console.error(`Error fetching volume data for token ${tokenAddress}:`, error.message);
        return {
            tokenVolumeUSD: new BigNumber(0), // Default for token-specific volume
            totalVolumeUSD: 0, // Default for total factory volume
        };
    }
}

/**
 * Fetch historical profit data from 1inch API.
 * @param {string} tokenAddress - Token contract address.
 * @returns {Promise<BigNumber>} - Historical profit estimation.
 */
async function fetchHistoricalProfit1Inch(tokenAddress) {
    const url = `https://api.1inch.dev/history/v2.0/history/${process.env.WALLET_ADDRESS}/events`;

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
            params: { tokenAddress, chainId: 42161, limit: 100 },
        });

        const profits = response.data.events
            .filter((event) => event.profit)
            .map((event) => new BigNumber(event.profit));

        return profits.reduce((acc, profit) => acc.plus(profit), new BigNumber(0));
    } catch (error) {
        console.error(`Error fetching historical profit for ${tokenAddress}:`, error.message);
        return new BigNumber(0);
    }
}

/**
 * Aggregate historical profit data for multiple tokens.
 * @param {string[]} tokenAddresses - List of token contract addresses.
 * @returns {Promise<Object>} - Historical profit data mapped by token address.
 */
async function getHistoricalProfitData(tokenAddresses = HARDCODED_STABLE_ADDRESSES) {
    const profitData = {};

    await Promise.all(
        tokenAddresses.map(async (token) => {
            try {
                const volumeUSD = await fetchHistoricalVolume(token);
                const profit1Inch = await fetchHistoricalProfit1Inch(token);

                // Aggregate data (volume can act as a proxy for profitability)
                profitData[token] = volumeUSD.plus(profit1Inch).toFixed();
            } catch (error) {
                console.error(`Error aggregating profit data for ${token}:`, error.message);
            }
        })
    );

    return profitData;
}



/**
 * Fetch order book depth for a token pair.
 * @param {string} srcToken - Source token address.
 * @param {string} dstToken - Destination token address.
 * @returns {Object} - Order book depth data.
 *
 * Fetches the order book depth for a given trading pair using the 1inch Orderbook API.
 * @param {string} srcToken - Address of the source token.
 * @param {string} dstToken - Address of the destination token.
 * @param {number} chainId - The chain ID (e.g., 1 for Ethereum, 42161 for Arbitrum).
 * @returns {Promise<Object|null>} - The order book data or null in case of failure.
 */
function getFromCache(key) {
    const cached = cache.get(key);
    if (cached && cached.expiry > Date.now()) {
        return cached.data;
    }
    return null;
}

function setToCache(key, data, ttl = 600000) { // Default TTL: 10 minutes
    cache.set(key, { data, expiry: Date.now() + ttl });
}

async function fetchOrderBookDepth(srcToken, dstToken, chainId) {
    const cacheKey = `orderBook-${srcToken}-${dstToken}-${chainId}`;
    const cachedData = getFromCache(cacheKey);

    if (cachedData) {
        console.log(`Using cached order book for ${srcToken} -> ${dstToken}`);
        return cachedData;
    }

    const url = `https://api.1inch.dev/orderbook/v4.0/${chainId}/all`;
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`, // Use your 1inch API key
    };

    const params = {
        makerAsset: srcToken.toLowerCase(),
        takerAsset: dstToken.toLowerCase(),
        limit: 50, // Max number of orders to fetch
    };

    // Retry logic with exponential backoff
    const maxRetries = 3;
    let backoff = 1000; // Initial delay in milliseconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(
                `Fetching order book for ${srcToken} -> ${dstToken} on chain ${chainId}, Attempt ${attempt}...`
            );

            const response = await axios.get(url, { headers, params });

            if (response.status === 200 && response.data) {
                console.log(`Order book fetched successfully for ${srcToken} -> ${dstToken}.`);
                setToCache(cacheKey, response.data); // Cache the data
                return response.data;
            }

            console.warn(`Unexpected response for ${srcToken} -> ${dstToken}:`, response.data);
            return null;
        } catch (error) {
            if (attempt < maxRetries && error.response?.status === 429) {
                console.warn(
                    `Rate limit hit while fetching order book for ${srcToken} -> ${dstToken}. Retrying in ${backoff}ms...`
                );
                await new Promise((resolve) => setTimeout(resolve, backoff));
                backoff *= 2; // Exponential backoff
            } else {
                console.error(
                    `Error fetching order book depth for ${srcToken} -> ${dstToken} on attempt ${attempt}:`,
                    error.message
                );
                if (attempt === maxRetries) {
                    console.error(`Max retries reached for ${srcToken} -> ${dstToken}. Returning null.`);
                }
            }
        }
    }

    return null;
}

/**
 * Adjust trade size based on slippage.
 * @param {BigNumber} amountIn - Input trade amount.
 * @param {BigNumber} liquidity - Available liquidity.
 * @returns {BigNumber} - Adjusted amount after accounting for slippage.
 */
function adjustForSlippage(amountIn, liquidity) {
    const slippage = amountIn.dividedBy(liquidity).multipliedBy(0.01); // Example: 1% slippage
    return amountIn.minus(slippage);
}

async function fetchFromPriceAPI(endpoint, params = {}) {
    const url = `${PRICE_API_URL}/${CHAIN_ID}${endpoint}`;
    try {
        const response = await apiQueue.add(() =>
            axios.get(url, { headers: HEADERS, params })
        );
        return response.data;
    } catch (error) {
        console.error(`Price API Error [${endpoint}]:`, error.response?.data || error.message);
        throw error;
    }
}


/**
 * Prioritize tokens based on historical profit data.
 * @param {string[]} tokens - Array of token addresses.
 * @param {Object} historicalProfitData - Mapping of token addresses to profit values.
 * @returns {string[]} - Sorted array of token addresses by priority.
 */
function prioritizeTokens(tokens, historicalProfitData) {
    return tokens.sort((a, b) => (historicalProfitData[b] || 0) - (historicalProfitData[a] || 0));
}

/**
 * Fetch historical trade data for tokens.
 * @param {string} address - Wallet address.
 * @param {number} chainId - Chain ID.
 * @param {number} [limit=100] - Number of events to fetch.
 * @returns {Object} - Historical trade events.
 */
async function fetchHistoricalTradeData(address, chainId, limit = 100) {
    const url = `https://api.1inch.dev/history/v2.0/history/${address}/events`;
    const config = {
        headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
        params: { chainId, limit },
    };

    try {
        const response = await axios.get(url, config);
        return response.data;
    } catch (error) {
        console.error(`Error fetching historical trade data:`, error.message);
        return [];
    }
}

 async function cachedGetLiquidityData(tokens) {
    const cacheKey = `liquidity:${tokens.join(",")}`;

    // Check if liquidity data is cached and fresh
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (Date.now() - timestamp < 60000) { // Cache for 60 seconds
            return data;
        }
    }

    // Fetch gas price before fetching liquidity data
    // const gasPrice = await fetchCachedGasPrice();
    // console.log(`Current gas price: ${gasPrice.dividedBy(1e9).toFixed(2)} Gwei`);

    // Fetch liquidity data (assuming `getLiquidityData` is implemented)
    const data = estimateLiquidity();
    
    // Cache the fetched liquidity data along with a timestamp
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
}

// Generic API call wrapper
async function safeApiCall(apiCallFunction, ...args) {
    return apiQueue.add(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await apiCallFunction(...args);
            } catch (error) {
                if (error.response?.status === 429) { // Too many requests
                    const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
                    console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    throw error; // Other errors
                }
            }
        }
        throw new Error("Max retries reached for API call");
    });
}

/**
 * Fetch multiple quotes in parallel with rate limiting.
 * @param {number} chainId - Chain ID.
 * @param {Object[]} quoteRequests - Array of quote request objects { srcToken, dstToken, amount }.
 * @returns {Object[]} - Array of fetched quotes.
 */
async function fetchMultipleQuotes(chainId, quoteRequests) {
    const limit = pLimit(1); // 1 request per second for rate limiting
    const results = await Promise.all(
        quoteRequests.map(({ srcToken, dstToken, amount }) =>
            limit(async () => {
                try {
                    const estimatedLiquidity = await estimateLiquidity(chainId, srcToken, dstToken);
                    if (estimatedLiquidity.isLessThan(amount)) {
                        console.warn(`Liquidity too low for ${srcToken} ➡️ ${dstToken}: ${estimatedLiquidity}`);
                        return null;
                    }
                    const quote = await fetchQuote(chainId, srcToken, dstToken, amount);
                    console.log(`Fetched quote for ${srcToken} ➡️ ${dstToken}`);
                    return { srcToken, dstToken, amount, quote };
                } catch (error) {
                    console.error(`Failed to fetch quote for ${srcToken} ➡️ ${dstToken}:`, error.message);
                    return null;
                }
            })
        )
    );
    return results.filter(Boolean); // Remove null entries
}

// Construct `params` with SwapDescription and Permit2 signature
async function constructParams(route, amount, permitBatchSignature) {
    const fromToken = route[0];
    const toToken = route[route.length - 1];

    const swapDescription = {
        srcToken: fromToken,
        dstToken: toToken,
        srcReceiver: Executor_ADDRESS,
        dstReceiver: CONTRACT_ADDRESS,
        amount: CAPITAL.toFixed(),
        minReturnAmount: PROFIT_THRESHOLD.toFixed(), // Adjust dynamically based on profit threshold
        flags: 0x04, // Update flags if needed
    };

    try {
        // Encode the parameters
        const params = web3.eth.abi.encodeParameters(
            ['tuple(address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags)', 'bytes', 'bytes'],
            [Object.values(swapDescription), permitBatchSignature, null]
        );

        console.log("Constructed Params:", params);
        return params;
    } catch (error) {
        console.error("Error constructing params:", error);
        throw error;
    }
}

// Approve tokens dynamically using Permit2
async function approveTokensWithPermit2(tokens) {
    try {
        for (const token of tokens) {
            // Ensure `token.amount` is a BigNumber
            const amount = new BigNumber(token.amount);

            if (!amount.isFinite()) {
                throw new Error(`Invalid amount for token ${token.address}: ${token.amount}`);
            }

            const allowance = await checkAllowance(token.address);

            if (allowance.isGreaterThanOrEqualTo(amount)) {
                console.log(`Sufficient allowance for ${token.address}. Skipping approval.`);
                continue;
            }

            const approvalResponse = await axios.get(`${PATHFINDER_API_URL}/approve/transaction`, {
                headers: {
                    Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
                },
                params: {
                    tokenAddress: token.address,
                    amount: amount.toFixed(), // Convert to string format compatible with the API
                },
            });

            const approvalTx = approvalResponse.data;
            const receipt = await web3.eth.sendTransaction({
                from: process.env.WALLET_ADDRESS,
                to: approvalTx.to,
                data: approvalTx.data,
            });

            console.log(`Approved ${token.address}. Transaction Hash: ${receipt.transactionHash}`);
        }
    } catch (error) {
        console.error("Error approving tokens:", error.message);
        throw error;
    }
}

// Function to check token allowance
async function checkAllowance(tokenAddress) {
    const url5 = `${PATHFINDER_API_URL}/approve/allowance`;

    try {
        const response = await axios.get(url5, {
            headers:{
        Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    },
            params: {
                tokenAddress,
                walletAddress: process.env.WALLET_ADDRESS,
            },
        });

        const allowance = new BigNumber(response.data.allowance || "0");
        console.log(`Allowance for ${tokenAddress}: ${allowance}`);
        return allowance;
    } catch (error) {
        console.error(`Error checking allowance for ${tokenAddress}:`, error.message);
        return new BigNumber(0);
    }
}


// Fetch swap data
async function getSwapData(fromToken, toToken, amount, slippage) {
    return safeApiCall(async () => {
        const url9 = `${PATHFINDER_API_URL}/swap`; // Adjusted to match API endpoint requirements
        const params = {
            fromTokenAddress: fromToken,
            toTokenAddress: toToken,
            amount: amount.toFixed(0), // Use the passed amount
            fromAddress: process.env.WALLET_ADDRESS, // Wallet performing the swap
            slippage: slippage.toFixed(2), // Set slippage tolerance
            allowPartialFill: false, // Ensure full swaps
            disableEstimate: false, // Enable price estimation
            includeProtocols: true, // Include detailed protocol data
        };

        try {
            // Make the API call to fetch swap data
            const response = await axios.get(url9, {headers: HEADERS}, params );

            // Extract transaction data from the response
            const swapData = response.data;
            if (!swapData.tx || !swapData.tx.data) {
                throw new Error("1inch API returned incomplete swap data");
            }
            console.log("Valid swap data fetched:", swapData.tx.data);
            // Return transaction data and protocols used for this swap
            return {
                txData: swapData.tx.data, // Transaction data for the swap
                protocols: swapData.protocols || [], // List of protocols used (optional)
            };
        } catch (error) {
            console.error("Error fetching swap data from 1inch API:", error.message);

            // Throw the error to be handled in higher-level functions
            throw error;
        }
    });
}



/**
 * Main arbitrage bot function.
 * Runs the monitoring loop for both mempool-based and periodic profitable route discovery.
 */
export async function runArbitrageBot() {
    console.log("Starting arbitrage bot...");

    // Mempool Monitoring for Arbitrage Opportunities
    monitorMempool(TARGET_CONTRACTS, process.env.CHAIN_ID, async ({ txHash, profit, srcToken, dstToken, amountIn }) => {
        console.log(`Mempool Arbitrage Opportunity Detected!`);
        console.log(`Transaction Hash: ${txHash}, Profit: ${profit.toFixed()} USDT`);
        console.log(`Route: ${srcToken} ➡️ ${dstToken}, Amount In: ${amountIn.toFixed()}`);

        try {
            const route = [srcToken, dstToken];
            await executeRouteWithRetry(route, CAPITAL); // Use retry logic for mempool opportunities
        } catch (error) {
            console.error("Error executing mempool arbitrage:", error.message);
        }
    });

    // Periodic Monitoring for Profitable Routes
    setInterval(async () => {
        try {
            console.log("Running periodic profitable route discovery...");

            const gasPrice = await fetchGasPrice();
            console.log(`Current gas price: ${gasPrice.dividedBy(1e9).toFixed(2)} Gwei`);

            // Refresh liquidity data every 15 minutes
            if (Date.now() % (15 * 60 * 1000) === 0) {
                console.log("Refreshing liquidity data...");
                await cachedGetLiquidityData(STABLE_TOKENS);
            }

            const profitableRoutes = await findProfitableRoutes();
            if (profitableRoutes.length > 0) {
                const bestRoute = profitableRoutes[0];
                console.log(`Executing best route: ${bestRoute.route.join(" ➡️ ")}, Profit: ${bestRoute.profit.toFixed()}`);
                await executeRouteWithRetry(bestRoute.route, bestRoute.profit);
            } else {
                console.log("No profitable routes found in this cycle.");
            }
        } catch (error) {
            console.error("Error in periodic monitoring loop:", error.message);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes
}

// Step 1: Find profitable routes within high-liquidity stable pairs
async function findProfitableRoutes() {
    try {
        console.log("Finding profitable routes...");

        // Step 1: Fetch stable tokens
        const stableTokens = await getStableTokenList(CHAIN_ID);
        if (stableTokens.length === 0) {
            console.error("No stable tokens available. Skipping profitable route search.");
            return [];
        }

        // Step 2: Fetch token prices across protocols
        const tokenPrices = await fetchTokenPrices();
        if (!tokenPrices || Object.keys(tokenPrices).length === 0) {
            console.error("Failed to fetch token prices. Skipping profitable route search.");
            return [];
        }

        // Step 3: Generate routes
        const maxHops = 3;
        const startToken = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
        const topN = 5;
        const routes = await generateRoutes(CHAIN_ID, startToken, CAPITAL);

        if (routes.length === 0) {
            console.error("No profitable routes generated.");
            return [];
        }

        // Step 4: Evaluate routes and their profitability
        const profitableRoutes = [];
        for (const route of routes) {
            const profit = await evaluateRouteProfit(route);

            if (profit > 0) {
                console.log(`Profitable route found: ${route.join(" ➡️ ")} with estimated profit: $${profit.toFixed(2)}`);
                profitableRoutes.push({ route, profit });
            }
        }

        // Step 5: Sort routes by profitability and return
        profitableRoutes.sort((a, b) => b.profit - a.profit);
        return profitableRoutes.slice(0, topN);
    } catch (error) {
        console.error("Error in finding profitable routes:", error.message);
        return [];
    }
}


/**
 * Retrieve a list of stable tokens dynamically from the 1inch Token API.
 * This function prioritizes tokens listed in the STABLE_TOKENS array and uses caching for efficiency.
 *
 * @param {number} chainId - The blockchain network chain ID (default: 42161 for Arbitrum).
 * @returns {Promise<Object[]>} - A list of stable token objects (address, symbol, decimals).
 */
// Add token addresses for the Arbitrum chain
const STABLE_TOKENS_ADD = {
  USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  DAI: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
  WETH: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  WBTC: "0x2f2a2543b76a4166549f7aab2e75bef0f6acb6de",
  AAVE: "0xba5ddf906d8bbf63d4095028c164e8243b77c77d",
  LINK: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
  ARB: "0x912ce59144191c1204e64559fe8253a0e49e6548",
};
/**
 * Fetch token data with enhanced error handling and rate-limiting logic.
 */

/**
 * Fetch stable token details from 1inch Token API with fallback logic.
 *
 * @param {number} chainId - Blockchain network chain ID (default: 42161 for Arbitrum).
 * @returns {Promise<Object[]>} - A list of stable token objects with address, symbol, and decimals.
 */
// Main function: Fetch stable token list

async function getStableTokenList(CHAIN_ID) {
    const cacheKey = `stableTokens:${HARDCODED_STABLE_ADDRESSES.join(",")}`;
    const now = Date.now();

    // Check if cached data is available and valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION1) {
            console.log("Returning cached stable token list.");
            return data;
        }
    }

    console.log(`Fetching stable token list for chain ID ${CHAIN_ID}...`);

    const url = `${BASE_URL1}/${CHAIN_ID}/custom`;
    const config = {
        headers: {
            Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
        },
        params: {
            addresses: HARDCODED_STABLE_ADDRESSES.join(","), // Pass addresses as comma-separated string
        },
        paramsSerializer: (params) => qs.stringify(params, { indices: false }),
    };

    try {
        // Fetch token details from the API
        const response = await axios.get(url, config);
        await rateLimit(); // Respect API rate limit

        if (response.data && response.data.tokens) {
            // Process and normalize the response
            const stableTokens = Object.entries(response.data.tokens).map(([address, token]) => ({
                address: web3.utils.toChecksumAddress(address), // Normalize to checksum format
                symbol: token.symbol || "UNKNOWN",
                decimals: token.decimals || 18,
                name: token.name || "UNKNOWN",
            }));

            // Cache the results for future use
            cache.set(cacheKey, { data: stableTokens, timestamp: now });
            console.log("Fetched stable token list:", stableTokens);
            return stableTokens;
        } else {
            throw new Error("Invalid or empty response from 1inch API.");
        }
    } catch (error) {
        console.error("Error fetching stable token list from API:", error.message);

        // Log response details if available
        if (error.response) {
            console.error("Error response from stable token API:", {
                status: error.response.status,
                data: error.response.data,
            });
        }

        // Use fallback tokens if API fails
        const fallbackTokens = HARDCODED_STABLE_ADDRESSES.map((address) => {
            if (!web3.utils.isAddress(address)) {
                console.warn(`Invalid fallback token address: ${address}`);
                return null;
            }
            return {
                address: web3.utils.toChecksumAddress(address),
                symbol: "UNKNOWN",
                decimals: 18,
                name: "Fallback Token",
            };
        }).filter(Boolean); // Remove invalid entries

        cache.set(cacheKey, { data: fallbackTokens, timestamp: now });
        return fallbackTokens;
    }
}


/**
 * Fetch token prices using POST or GET from the 1inch Spot Price API.
 *
 * @param {string[]} tokenAddresses - Array of token addresses to fetch prices for.
 * @param {number} chainId - Blockchain network chain ID (e.g., 42161 for Arbitrum).
 * @returns {Promise<Object>} - Mapping of token addresses to their prices.
 */

const TOKEN_ADDRESSES = [
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
  "0x82aF49447D8a07e3bd95bd0d56f35241523fbab1", // WETH
  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
  "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", // AAVE
  "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", // LINK
  "0x912CE59144191C1204E64559FE8253a0e49E6548", // ARB
];


/**
 * Fetch token prices using the 1inch Price API.
 * Hardcoded token addresses are used and passed as a comma-separated string.
 *
 * @param {string} currency - The target currency for price conversion (default: USD).
 * @returns {Promise<Object>} - A mapping of token addresses to their price data.
 */

async function retryRequest(requestFn, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            if (error.response?.status === 429 && attempt < retries) {
                console.warn(`Rate limit hit. Retrying in ${delay}ms... (Attempt ${attempt}/${retries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
}

/**
 * Fetch token prices using 1inch API with fallback to Uniswap Subgraph.
 * @param {string[]} tokenAddresses - Array of token contract addresses.
 * @param {Object} historicalProfitData - Historical profit data for prioritization.
 * @returns {Promise<Object>} - Token prices mapped by token address.
 */

async function fetchTokenPrices(tokenAddresses = HARDCODED_STABLE_ADDRESSES) {
    if (!tokenAddresses || tokenAddresses.length === 0) {
        console.warn("No token addresses provided to fetchTokenPrices.");
        return {};
    }

    // Fetch historical profit data for tokens
    let historicalProfitData = {};
    try {
        console.log("Fetching historical profit data...");
        historicalProfitData = await getHistoricalProfitData(tokenAddresses);
    } catch (error) {
        console.error("Error fetching historical profit data:", error.message);
        historicalProfitData = {}; // Fallback to empty data if the fetch fails
    }

    // Prioritize tokens based on historical profit data
    const prioritizedTokens = prioritizeTokens(tokenAddresses, historicalProfitData);

    const batchSize = 4; // Number of tokens per batch to avoid rate limits
    const now = Date.now();
    const cacheKey = `prices:${tokenAddresses.join(",")}`;

    // Check if cached data is still valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION) {
            console.log("Using cached token prices.");
            return data;
        }
    }

    const tokenBatches = [];
    for (let i = 0; i < prioritizedTokens.length; i += batchSize) {
        tokenBatches.push(prioritizedTokens.slice(i, i + batchSize));
    }

    const prices = {};

    for (const batch of tokenBatches) {
        try {
            const url = `${PRICE_API_URL}/${CHAIN_ID}/${batch.join(",")}`;
            console.log(`Fetching token prices from 1inch URL: ${url}`);

            const response = await axios.get(url, {
                headers: {
                    Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
                    Accept: "application/json",
                },
                params: { currency: "USD" },
            });

            if (response.status === 200 && response.data) {
                Object.assign(prices, response.data);
            }
        } catch (error) {
            console.warn("1inch API failed for token prices. Falling back to alternative APIs.");

            // Fallback to an alternative API (e.g., Uniswap Subgraph)
            for (const token of batch) {
                try {
                    const alternativeResponse = await fetchTokenPriceAlternativeAPI(token);
                    if (alternativeResponse) {
                        prices[token] = new BigNumber(alternativeResponse);
                        console.log(`Fallback: Fetched price for ${token}: ${prices[token].toFixed(4)}`);
                    }
                } catch (fallbackError) {
                    console.error(`Error fetching price for token ${token}:`, fallbackError.message);
                }
            }
        }
    }

    // Cache the fetched prices
    cache.set(cacheKey, { data: prices, timestamp: now });
    return prices;
}

/**
 * Fetches the token price using the Uniswap Subgraph API.
 * @param {string} tokenAddress - The token's contract address.
 * @returns {Promise<BigNumber>} - The token price in USD.
 */
async function fetchTokenPriceAlternativeAPI(tokenAddress) {
    try {
        // GraphQL Query to fetch token and ETH price
        const query = gql`
            {
                token(id: "${tokenAddress.toLowerCase()}") {
                    derivedETH
                    symbol
                    name
                    decimals
                }
                bundles(first: 1) {
                    ethPriceUSD
                }
            }
        `;

        const data = await request(UNISWAP_SUBGRAPH_URL, query);

        // Extract token and ETH price data
        const tokenData = data.token;
        const ethPriceUSD = data.bundles[0].ethPriceUSD;

        if (!tokenData || !ethPriceUSD) {
            throw new Error(`Failed to fetch price for token: ${tokenAddress}`);
        }

        // Calculate token price in USD
        const tokenPriceUSD = new BigNumber(tokenData.derivedETH).multipliedBy(new BigNumber(ethPriceUSD));
        console.log(`Fetched price for ${tokenData.symbol}: $${tokenPriceUSD.toFixed(4)}`);
        return tokenPriceUSD;
    } catch (error) {
        console.error(`Error fetching token price from Uniswap Subgraph: ${error.message}`);
        throw error;
    }
}

// Function to generate all possible routes within a max hop limit using stable, liquid tokens
/**
 * Generate profitable routes using stable tokens.
 * @param {number} chainId - Blockchain network chain ID (e.g., 42161 for Arbitrum).
 * @param {number} maxHops - Maximum number of hops for routes.
 * @param {string} preferredStartToken - Preferred starting token (e.g., "USDC").
 * @returns {Promise<string[][]>} - Array of profitable routes.
 */

// Unified fetch with retries for handling rate limits
async function fetchWithRetries(url, config, maxRetries = 3, backoff = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, config);
            return response.data;
        } catch (error) {
            if (error.response?.status === 429 && attempt < maxRetries) {
                console.warn(`Rate limit hit. Retrying in ${backoff}ms... (Attempt ${attempt}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
                backoff *= 2; // Exponential backoff
            } else {
                console.error(`Error fetching data: ${error.message}`);
                throw error;
            }
        }
    }
    throw new Error(`Failed to fetch data after ${maxRetries} attempts.`);
}

// Fetch quote with caching and retries
async function fetchQuote(chainId, srcToken, dstToken, amount, complexityLevel = 2, slippage = 1) {
    const cacheKey = `${srcToken}_${dstToken}_${amount}`;

    // Check the cache for a previously fetched quote
    const cachedQuote = getFromCache(cacheKey);
    if (cachedQuote) {
        console.log(`Using cached quote for ${cacheKey}`);
        return cachedQuote;
    }

    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/quote`;

    try {
        // Validate input tokens
        srcToken = web3.utils.toChecksumAddress(srcToken);
        dstToken = web3.utils.toChecksumAddress(dstToken);

        if (!new BigNumber(amount).isInteger() || new BigNumber(amount).lte(0)) {
            throw new Error(`Invalid amount: ${amount}`);
        }
    } catch (validationError) {
        console.error("Validation error:", validationError.message);
        throw validationError;
    }

    const config = {
        headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
        params: {
            src: srcToken,
            dst: dstToken,
            amount: amount.toString(),
            complexityLevel,
            includeTokensInfo: true, // Use booleans instead of strings
            includeProtocols: true,
            includeGas: true,
        },
    };

    try {
        console.log(`Fetching quote for ${srcToken} ➡️ ${dstToken}, amount: ${amount}`);
        const quote = await fetchWithRetries(url, config);
        console.log(`Received quote:`, quote);

        // Cache the result
        setToCache(cacheKey, quote);
        return quote;
    } catch (error) {
        console.error(`Failed to fetch quote for ${srcToken} ➡️ ${dstToken}: ${error.message}`);
        throw error;
    }
}

// Fetch multiple quotes with rate-limiting and caching
async function fetchQuotes(chainId, tokenPairs, amount, complexityLevel = 2, slippage = 1) {
    const pLimit = require("p-limit");
    const limit = pLimit(5); // Limit concurrent requests to avoid rate limits

    // Fetch quotes for all token pairs
    const results = await Promise.all(
        tokenPairs.map(([srcToken, dstToken]) =>
            limit(() => fetchQuote(chainId, srcToken, dstToken, amount, complexityLevel, slippage))
        )
    );

    return results.filter(Boolean); // Filter out failed results
}

/**
 * Find the optimal route between two tokens in a weighted graph.
 * Uses Dijkstra's algorithm for shortest path based on weights (e.g., slippage, fees).
 *
 * @param {Object} graph - Weighted graph where keys are token addresses and values are neighbors.
 * @param {string} startToken - Address of the starting token.
 * @param {string} endToken - Address of the ending token.
 * @returns {Object} - An object containing the optimal path and total cost.
 */
function findOptimalRoute(graph, startToken, endToken) {
    if (!graph[startToken]) {
        throw new Error(`Start token ${startToken} not found in the graph.`);
    }
    if (!graph[endToken]) {
        throw new Error(`End token ${endToken} not found in the graph.`);
    }

    const distances = {}; // Stores the shortest distance to each token
    const previous = {}; // Stores the previous token for path reconstruction
    const visited = new Set(); // Tracks visited nodes
    const priorityQueue = new PriorityQueue(); // Custom priority queue for Dijkstra's algorithm

    // Initialize distances with Infinity, and starting token with 0
    for (const token in graph) {
        distances[token] = Infinity;
    }
    distances[startToken] = 0;

    // Add the starting token to the priority queue
    priorityQueue.enqueue(startToken, 0);

    while (!priorityQueue.isEmpty()) {
        const { element: currentToken } = priorityQueue.dequeue();

        if (visited.has(currentToken)) continue;
        visited.add(currentToken);

        // If we reached the end token, construct the path
        if (currentToken === endToken) {
            const path = [];
            let token = endToken;

            while (token) {
                path.unshift(token);
                token = previous[token];
            }

            return { path, cost: distances[endToken] };
        }

        // Explore neighbors
        for (const neighbor of Object.keys(graph[currentToken])) {
            const edgeWeight = graph[currentToken][neighbor];
            const newDistance = distances[currentToken] + edgeWeight;

            if (newDistance < distances[neighbor]) {
                distances[neighbor] = newDistance;
                previous[neighbor] = currentToken;
                priorityQueue.enqueue(neighbor, newDistance);
            }
        }
    }

    // If no path is found, return empty path and Infinity cost
    return { path: [], cost: Infinity };
}

class PriorityQueue {
    constructor() {
        this.items = [];
    }

    enqueue(element, priority) {
        this.items.push({ element, priority });
        this.items.sort((a, b) => a.priority - b.priority); // Sort by priority
    }

    dequeue() {
        return this.items.shift(); // Remove the element with the highest priority
    }

    isEmpty() {
        return this.items.length === 0;
    }
}

// Generate routes using a BFS approach and inferred liquidity
async function generateRoutes(chainId, startToken, startAmount, maxHops = 2, profitThreshold = 300000000) {
    try {
        if (!web3.utils.isAddress(startToken)) {
            throw new Error(`Invalid start token address: ${startToken}`);
        }

        const stableTokens = await getStableTokenList(chainId);
        const validStableTokenAddresses = stableTokens
            .map(token => token.address)
            .filter(web3.utils.isAddress);

        if (validStableTokenAddresses.length === 0) {
            throw new Error("No valid stable token addresses available.");
        }

        const tokenPairs = [];
        for (const srcToken of validStableTokenAddresses) {
            for (const dstToken of validStableTokenAddresses) {
                if (srcToken !== dstToken) {
                    tokenPairs.push({ srcToken, dstToken });
                }
            }
        }

        console.log("Building graph with token pairs...");
        const graph = await buildGraph(tokenPairs, chainId);

        const averageLiquidity = await calculateAverageLiquidity(validStableTokenAddresses, chainId, startToken);
        maxHops = adjustMaxHops(maxHops, averageLiquidity);

        console.log(`Dynamic maxHops adjusted to: ${maxHops}`);

        const profitableRoutes = [];
        for (const endToken of validStableTokenAddresses) {
            if (endToken !== startToken) {
                const { path, cost } = findOptimalRoute(graph, startToken, endToken);

                if (path.length > 1) {
                    const profit = startAmount.minus(cost);
                    if (profit.isGreaterThan(profitThreshold)) {
                        profitableRoutes.push({ path, profit });
                        console.log(`Profitable route found: ${path.join(" ➡️ ")} with profit: ${profit}`);
                    }
                }
            }
        }

        return profitableRoutes
            .sort((a, b) => new BigNumber(b.profit).minus(a.profit))
            .slice(0, 3);

    } catch (error) {
        console.error("Error in generateRoutes:", error.message);
        return [];
    }
}


/**
 * Adjust maxHops dynamically based on average liquidity.
 *
 * @param {number} initialMaxHops - Initial maxHops value.
 * @param {BigNumber} averageLiquidity - Average liquidity of tokens in the current graph.
 * @returns {number} - Adjusted maxHops value.
 */
function adjustMaxHops(initialMaxHops, averageLiquidity) {
    if (averageLiquidity.isGreaterThan(CAPITAL.multipliedBy(10))) {
        return Math.min(initialMaxHops + 1, 4); // Increase hops if liquidity is very high
    } else if (averageLiquidity.isLessThan(CAPITAL.dividedBy(2))) {
        return Math.max(initialMaxHops - 1, 1); // Decrease hops if liquidity is low
    }
    return initialMaxHops; // Keep maxHops unchanged
}

/**
 * Calculate the average liquidity for a list of tokens.
 *
 * @param {string[]} tokens - Array of token addresses.
 * @param {number} chainId - Chain ID.
 * @param {string} startToken - Starting token for the calculation.
 * @returns {BigNumber} - Average liquidity of the tokens.
 */
async function calculateAverageLiquidity(tokens, chainId, startToken) {
    let totalLiquidity = new BigNumber(0);
    let count = 0;

    await Promise.all(
        tokens.map(async (token) => {
            try {
                const liquidity = await estimateLiquidity(chainId, startToken, token);
                if (liquidity.isGreaterThan(0)) {
                    totalLiquidity = totalLiquidity.plus(liquidity);
                    count++;
                }
            } catch (error) {
                console.warn(`Failed to estimate liquidity for token: ${token}`, error.message);
            }
        })
    );

    return count > 0 ? totalLiquidity.dividedBy(count) : new BigNumber(0);
}

/**
 * Build the weighted graph for tokens based on fees and slippage.
 *
 * @param {Object[]} tokenPairs - Array of token pair objects { srcToken, dstToken }.
 * @param {number} chainId - Chain ID.
 * @returns {Object} - The graph object representing weights for each token pair.
 */
async function buildGraph(tokenPairs, chainId) {
    const graph = {};

    await Promise.all(
        tokenPairs.map(async ({ srcToken, dstToken }) => {
            try {
                const quote = await fetchQuote(chainId, srcToken, dstToken, CAPITAL.toFixed());
                if (quote && quote.toAmount) {
                    const fee = new BigNumber(quote.estimatedGas || 0).times(await fetchGasPrice());
                    const slippage = new BigNumber(quote.toAmount).times(0.01); // Example: 1% slippage
                    const weight = fee.plus(slippage);

                    if (!graph[srcToken]) graph[srcToken] = {};
                    graph[srcToken][dstToken] = weight;
                }
            } catch (error) {
                console.warn(`Failed to fetch quote for ${srcToken} ➡️ ${dstToken}:`, error.message);
            }
        })
    );

    return graph;
}

// Estimate liquidity by progressive trade analysis
/**
 * Estimate token pair liquidity using dynamic trade analysis.
 * @param {number} chainId - Chain ID.
 * @param {string} srcToken - Source token address.
 * @param {string} dstToken - Destination token address.
 * @returns {BigNumber} - Estimated liquidity.
 */
async function estimateLiquidity(chainId, srcToken, dstToken) {
    const orderBook = await fetchOrderBookDepth(srcToken, dstToken);
    if (!orderBook || !orderBook.liquidity) {
        throw new Error(`Liquidity data unavailable for ${srcToken} ➡️ ${dstToken}`);
    }

    let low = new BigNumber(10).pow(18);
    let high = new BigNumber(10).pow(24);
    let bestAmount = low;

    while (low.isLessThanOrEqualTo(high)) {
        const mid = low.plus(high).dividedBy(2).integerValue(BigNumber.ROUND_FLOOR);
        try {
            const adjustedAmount = adjustForSlippage(mid, new BigNumber(orderBook.liquidity));
            if (adjustedAmount.isGreaterThan(0)) {
                bestAmount = mid;
                low = mid.plus(1);
            } else {
                high = mid.minus(1);
            }
        } catch (error) {
            console.warn(`Liquidity estimation failed: ${error.message}`);
            high = mid.minus(1);
        }
    }
    return bestAmount;
}
/**
 * Fetch token prices and critical data across protocols using the 1inch Price API.
 * @param {string[]} tokens - Array of token symbols (e.g., ["USDT", "USDC", ...]).
 * @param {number} chainId - Blockchain network chain ID (default: 42161 for Arbitrum).
 * @returns {Promise<Object>} - An object mapping token addresses to their prices, symbols, decimals, and other critical data.
 */
async function fetchPriceWithRetryBatch(addresses, chainId = 42161, maxRetries = 3) {
    const url = `${PRICE_API_URL}/${chainId}/${addresses.join(",")}`;
    let retries = 0;

    while (retries < maxRetries) {
        try {
            const response = await axios.get(url, { headers: HEADERS });
            if (response.status === 200) {
                return response.data; // Return price data
            }
        } catch (error) {
            if (error.response?.status === 429) {
                retries++;
                const retryDelay = Math.pow(2, retries) * 1000; // Exponential backoff
                console.warn(`Rate limit hit. Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } else {
                console.error(`Unexpected error: ${error.message}`);
                throw error;
            }
        }
    }
    throw new Error(`Failed to fetch prices after ${maxRetries} retries.`);
}



async function validateToken(address, chainId = 42161) {
    const url = `${PRICE_API_URL}/${chainId}/${address}`;
    try {
        const response = await axios.get(url, { headers: HEADERS });
        return response.status === 200;
    } catch (error) {
        console.warn(`Token validation failed for ${address}: ${error.message}`);
        return false;
    }
}

async function fetchTokenPricesAcrossProtocols(tokens, chainId = 42161) {
    if (!tokens || tokens.length === 0) {
        console.warn("Token array is empty. Using fallback tokens...");
        tokens = FALLBACK_TOKENS;
    }

    const tokenAddresses = tokens
        .map((token) => (typeof token === "object" ? token.address : token))
        .filter((address) => web3.utils.isAddress(address));

    console.log("Resolved Token Addresses:", tokenAddresses);

    const prices = {};
    for (const address of tokenAddresses) {
        console.log(`Fetching price for token: ${address}`);
        const priceData = await fetchTokenPrices();
        if (priceData && priceData[address]) {
            prices[address] = {
                price: new BigNumber(priceData[address].price || 0),
                symbol: priceData[address].symbol || "UNKNOWN",
                decimals: priceData[address].decimals || 18,
            };
            console.log(`Fetched price for ${address}:`, prices[address]);
        } else {
            console.warn(`No price data returned for ${address}. Skipping.`);
        }
    }

    console.log("Final Token Prices:", prices);
    return prices;
}


function calculateSlippage(path, priceData) {
    const slippageFactors = path.map(token => {
        const liquidity = getLiquidityForToken(token, priceData);
        return liquidity < CAPITAL.toFixed() ? 0.01 : 0.005; // Higher slippage for low-liquidity tokens
    });

    return slippageFactors.reduce((total, factor) => total.plus(factor), new BigNumber(0));
}

function getLiquidityForToken(token, priceData) {
    return priceData[token] ? new BigNumber(priceData[token].liquidity || 0) : new BigNumber(0);
}

async function calculateDynamicProfitThreshold() {
    const gasPrice = await fetchGasPrice();
    const estimatedGas = new BigNumber(800000); // Replace with dynamic estimate
    const gasCost = gasPrice.multipliedBy(estimatedGas);

    // Include flash loan fee and slippage
    const flashLoanFee = CAPITAL.multipliedBy(0.0005); // 0.05% fee
    const dynamicThreshold = MINIMUM_PROFIT_THRESHOLD.plus(gasCost).plus(flashLoanFee);

    return dynamicThreshold;
}

async function safeExecute(fn, ...args) {
    try {
        return await fn(...args);
    } catch (error) {
        console.error(`Error executing ${fn.name}:`, error.message);
        return null; // Or a default value specific to the function
    }
}

// Fetch current gas price in Gwei from Polygon Gas Station
async function fetchGasPrice() {
    const cacheKey = `gasPrice:${CHAIN_ID}`;
    const now = Date.now();

    // Check cache validity
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION) {
            console.log("Using cached gas price.");
            return data;
        }
    }

    return apiQueue.add(async () => {
        try {
            const response = await retryRequest(
                () =>
                    axios.get("https://api.blocknative.com/gasprices/blockprices", {
                        headers: { Authorization: `Bearer ${process.env.BLOCKNATIVE_API_KEY}` },
                        params: { chainId: 42161 }, // Arbitrum network
                    }),
                3, // Retry up to 3 times
                1000 // Start with a 1-second delay
            );

            const gasPriceGwei = response.data.blockPrices?.[0]?.baseFeePerGas;
            if (gasPriceGwei) {
                const weiGasPrice = new BigNumber(gasPriceGwei).shiftedBy(9); // Convert Gwei to Wei
                cache.set(cacheKey, { data: weiGasPrice, timestamp: now });
                return weiGasPrice;
            }

            console.warn("Gas price not found in API response. Using fallback value: 50 Gwei.");
            return new BigNumber(50).shiftedBy(9); // Fallback to 50 Gwei
        } catch (error) {
            console.error("Error fetching gas price. Using fallback value:", error.message);
            return new BigNumber(50).shiftedBy(9); // Fallback to 50 Gwei
        }
    });
}


async function fetchTokenDataParallel(tokenAddresses, headers, baseUrl) {
    const results = await Promise.all(
        tokenAddresses.map(async (address) => {
            try {
                const checksummedAddress = getAddress(address); // Normalize address
                const response = await apiQueue.add(() =>
                    axios.get(`${baseUrl}/${checksummedAddress}`, { headers })
                );
                return { address: checksummedAddress, data: response.data?.tokens?.[checksummedAddress.toLowerCase()] };
            } catch (error) {
                console.warn(`Failed to fetch data for ${address}:`, error.message);
                return null;
            }
        })
    );

    return results.filter(Boolean).reduce((acc, { address, data }) => {
        acc[address] = data;
        return acc;
    }, {});
}

/**
 * Monitors the Ethereum mempool for pending transactions.
 * Detects arbitrage opportunities by analyzing swaps and price changes.
 * 
 * @param {string[]} targetContracts - List of smart contract addresses to monitor (e.g., Uniswap, Sushiswap).
 * @param {number} chainId - The chain ID of the network (e.g., 42161 for Arbitrum).
 * @param {function} onArbitrage - Callback function to execute when an opportunity is detected.
 */

async function createProviderWithRetry(rpcUrl, maxRetries = 5, retryDelay = 1000) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            await provider.getNetwork(); // Trigger network detection
            console.log("Connected to network:", await provider.getNetwork());
            return provider;
        } catch (error) {
            retries++;
            console.error(`Retrying to connect (${retries}/${maxRetries}):`, error.message);
            if (retries >= maxRetries) {
                throw new Error("Failed to connect to the network after maximum retries.");
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
    }
}


async function monitorMempool(targetContracts, chainId, onArbitrage) {
    try {
        // Initialize provider with retry logic
        const provider = await createProviderWithRetry(process.env.INFURA_WS_URL);

        console.log("Starting mempool monitoring using polling...");

        // Polling mechanism for pending transactions
        setInterval(async () => {
            try {
                const block = await provider.getBlock("pending");
                if (block && block.transactions) {
                    for (const txHash of block.transactions) {
                        const tx = await provider.getTransaction(txHash);
                        if (!tx || !tx.to) continue;

                        // Filter transactions for target contracts
                        if (targetContracts.includes(tx.to.toLowerCase())) {
                            console.log(`Detected relevant transaction: ${txHash}`);

                            // Analyze transaction data (e.g., method, params)
                            const decodedData = decodeTransactionData(tx.data);

                            // Check for arbitrage opportunities
                            const { srcToken, dstToken } = decodedData;

                            // Use the fixed capital amount for all evaluations
                            const quote = await fetchQuote(chainId, srcToken, dstToken, CAPITAL.toFixed());

                            if (quote && quote.toAmount) {
                                // Evaluate profitability using the fixed capital
                                const profit = await evaluateRouteProfit([srcToken, dstToken]);

                                if (profit.isGreaterThan(0)) {
                                    console.log(`Arbitrage opportunity detected: Profit = ${profit.toFixed()} USDC`);
                                    await onArbitrage({
                                        txHash,
                                        profit,
                                        srcToken,
                                        dstToken,
                                        amountIn: CAPITAL,
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (pollingError) {
                console.error("Error polling pending transactions:", pollingError.message);
            }
        }, 5000); // Poll every 5 seconds
    } catch (error) {
        console.error("Error initializing mempool monitoring:", error.message);
    }
}


/**
 * Decodes transaction input data to extract trade details.
 * 
 * @param {string} data - The input data of the transaction.
 * @returns {Object} - Decoded trade details (e.g., srcToken, dstToken, amountIn).
 */
function decodeTransactionData(data) {
    // Replace with ABI and decoding logic for the target smart contracts
    const decoded = ethers.utils.defaultAbiCoder.decode(
        ["address", "address", "uint256"],
        data
    );

    return {
        srcToken: decoded[0],
        dstToken: decoded[1],
        amountIn: new BigNumber(decoded[2].toString()),
    };
}

 /**
 * Evaluate the profitability of a given route with dynamic profit adjustment
 * Evaluate route profitability with dynamic slippage and gas cost.
 * @param {string[]} route - Array of token addresses representing the route.
 * @returns {BigNumber} - Calculated profit.
 */
 async function evaluateRouteProfit(route) {
    try {
        // Fetch token prices across protocols
        const priceData = await fetchTokenPrices();
        if (!priceData || Object.keys(priceData).length === 0) {
            console.error("Failed to fetch price data.");
            return new BigNumber(0);
        }

        let amountIn = CAPITAL; // Start with the full trading capital
        const gasPrice = await fetchGasPrice();

        // Evaluate profitability across the route
        for (let i = 0; i < route.length - 1; i++) {
            const fromToken = route[i];
            const toToken = route[i + 1];

            // Get prices for current tokens in the route
            const fromPrice = priceData[fromToken]?.price || 0;
            const toPrice = priceData[toToken]?.price || 0;
            const fromLiquidity = priceData[fromToken]?.liquidity || 0;

            // Ensure price data is available
            if (!fromPrice || !toPrice) {
                console.warn(`Missing price data for tokens: ${fromToken}, ${toToken}`);
                return new BigNumber(0); // Abort evaluation
            }

            // Adjust trade size for slippage
            const adjustedAmount = adjustForSlippage(amountIn, new BigNumber(fromLiquidity));
            amountIn = adjustedAmount.multipliedBy(toPrice).dividedBy(fromPrice);

            // Ensure positive amount remains after each hop
            if (amountIn.isZero() || amountIn.isNegative()) {
                console.error(`Trade resulted in zero or negative output: ${fromToken} ➡️ ${toToken}`);
                return new BigNumber(0);
            }
        }

        // Calculate total gas cost for the route
        const gasCost = gasPrice.multipliedBy(new BigNumber(route.length).multipliedBy(800000)); // Adjust gas per hop if needed

        // Calculate profit by deducting capital and gas costs
        const profit = amountIn.minus(CAPITAL).minus(gasCost);

        // Ensure profit is positive
        if (profit.isGreaterThan(0)) {
            console.log(`Profitable route: ${route.join(" ➡️ ")} with profit: $${profit.dividedBy(1e6).toFixed(2)}`);
            return profit;
        } else {
            console.log(`Route ${route.join(" ➡️ ")} did not meet the profit threshold.`);
            return new BigNumber(0);
        }
    } catch (error) {
        console.error(`Error evaluating route profit: ${error.message}`);
        return new BigNumber(0); // Return zero on error
    }
}

// Function to execute the profitable route using flash loan and swap
 /**
 * Executes a profitable arbitrage route with optimized gas management and front-running protection.
 * @param {string[]} route - Array of token addresses representing the arbitrage route.
 * @param {BigNumber} amount - Initial capital amount for the trade.
 */
export async function executeRoute(route, amount) {
    const assets = USDC_ADDRESS; // Start with USDC as the primary asset
    const gasPrice = await fetchGasPrice(); // Fetch the current gas price
    const scaledAmount = await adjustTradeSizeForGas(amount, gasPrice); // Adjust trade size based on gas cost
    const amounts = [scaledAmount.toFixed()]; // Scaled trade size

    try {
        // Step 1: Approve tokens using Permit2
        const tokens = route.map((token) => ({ address: token, amount: scaledAmount.toFixed() }));
        await approveTokensWithPermit2(tokens);
        console.log("Tokens approved successfully.");

        // Step 2: Generate PermitBatch signature
        const { signature } = await generatePermitBatchSignatures(tokens, process.env.CONTRACT_ADDRESS);

        // Step 3: Construct calldata with route and signature
        const params = await constructParams(route, amounts, signature);

        // Step 4: Estimate gas and prepare the transaction
        const gasEstimate = await estimateGas(route, scaledAmount);

        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: process.env.CONTRACT_ADDRESS,
            data: contract.methods.fn_RequestFlashLoan(assets, amounts, params).encodeABI(),
            gas: gasEstimate.toFixed(),
            gasPrice: gasPrice.toFixed(),
        };

        // Step 5: Use Flashbots or private RPC to send the transaction securely
        const receipt = await sendTransactionPrivately(tx);

        console.log("Flash loan and swap executed successfully. Transaction Hash:", receipt.transactionHash);

        // Step 6: Notify success via Telegram
        const successMessage = `
            ✅ *Flash Loan and Swap Executed Successfully!*
            - Transaction Hash: [${receipt.transactionHash}](https://arbiscan.io/tx/${receipt.transactionHash})
            - Route: ${route.join(" ➡️ ")}
            - Amount: ${scaledAmount.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(successMessage);
    } catch (error) {
        console.error("Error executing route:", error);

        // Notify failure via Telegram
        const errorMessage = `
            ❌ *Error Executing Flash Loan and Swap!*
            - Error: ${error.message}
            - Route: ${route.join(" ➡️ ")}
            - Amount: ${scaledAmount.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(errorMessage);

        throw error; // Rethrow the error to trigger any retry logic
    }
}
async function executeRouteWithRetry(route, amount) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`Attempt ${attempt} to execute route.`);
            await executeRoute(route, amount);
            return; // Exit loop on success
        } catch (error) {
            console.error(`Attempt ${attempt} failed. Error: ${error.message}`);
            if (attempt === 3) throw new Error("Max retries reached");
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000)); // Exponential backoff
        }
    }
}

async function adjustTradeSizeForGas(amount, gasPrice) {
    const estimatedGasCost = gasPrice.multipliedBy(new BigNumber(800000)); // Estimate gas cost
    const maxGasCostRatio = new BigNumber(0.005); // 0.5% of trade amount
    if (estimatedGasCost.isGreaterThan(amount.multipliedBy(maxGasCostRatio))) {
        console.warn(`Gas cost (${estimatedGasCost.toFixed()}) exceeds profit margin (${amount.multipliedBy(maxGasCostRatio).toFixed()}). Scaling down trade size.`);
        return amount.multipliedBy(0.8); // Scale down trade size to 80% of the original
    }
    return amount;
}

/**
 * Sends a transaction privately using Flashbots on the Arbitrum network.
 * 
 * @param {Object} tx - The transaction object (to, from, data, gas, gasPrice, etc.).
 * @returns {Object} - Transaction receipt.
 */
export async function sendTransactionPrivately(tx) {
    try {
        // Step 1: Set up providers
        const publicProvider = new ethers.providers.JsonRpcProvider(process.env.INFURA_URL); // Standard RPC provider
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, publicProvider); // Wallet connected to the provider

        // Flashbots Provider for Arbitrum (custom URL required for Arbitrum compatibility)
        const flashbotsProvider = await FlashbotsBundleProvider.create(
            publicProvider,
            wallet,
            "https://relay.flashbots.net", // Flashbots relay URL
            "arbitrum" // Network override
        );

        // Step 2: Sign transaction
        const txRequest = {
            ...tx,
            nonce: await publicProvider.getTransactionCount(tx.from), // Fetch nonce
        };

        const signedTx = await wallet.signTransaction(txRequest);

        // Step 3: Create bundle and send it via Flashbots
        const bundleResponse = await flashbotsProvider.sendBundle(
            [
                {
                    signedTransaction: signedTx, // Pre-signed transaction
                },
            ],
            Math.floor(Date.now() / 1000) + 60 // Expiry time (60 seconds)
        );

        if ("error" in bundleResponse) {
            throw new Error(`Flashbots bundle submission error: ${bundleResponse.error.message}`);
        }

        // Wait for inclusion
        const waitResponse = await bundleResponse.wait();
        if (waitResponse === 0) {
            console.log("Bundle included in the next block.");
            return bundleResponse;
        } else {
            console.warn("Bundle not included. Reverting to public transaction submission.");
            throw new Error("Bundle not included.");
        }
    } catch (error) {
        console.error("Error sending transaction privately via Flashbots:", error.message);
        throw error;
    }
}



// Helper function to encode calldata for a multi-hop route using 1inch API
 async function encodeSwapData(route, amount, slippagePercent) {
    const fromToken = route[0];
    const toToken = route[route.length - 1];
    const formattedAmount = amount.toFixed(STABLE_TOKENS.includes(fromToken) ? 6 : 18);

    try {
        // Construct the API request with parameters that ensure protocol details are included
        const response = await axios.get(`${PATHFINDER_API_URL}/swap`, {
            headers: {
        Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    },
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                amount: formattedAmount,
                fromAddress: process.env.WALLET_ADDRESS,
                slippage: slippagePercent,
                disableEstimate: false,
                allowPartialFill: false,
                includeProtocols: true, // Include protocol details in response
            },
        });

        const swapData = response.data;
        const txData = swapData.tx.data;

        // Get protocol information from the response if it exists
        const protocols = swapData.protocols; // Array of protocols used for each hop
        if (!protocols) {
            throw new Error("Protocol information not provided in swap response.");
        }

        // Ensure txData and protocols are returned in the correct format
        return { txData, protocols };
    } catch (error) {
        console.error("Error fetching swap data:", error);
        throw error;
    }
}



 async function estimateGas(route, amount) {
    try {
        // Fetch the latest gas price
        const gasPrice = await fetchGasPrice();

        // Adjust trade size based on gas price
        const adjustedAmount = await adjustTradeSizeForGas(amount, gasPrice);

        // Estimate gas cost for the adjusted trade size
        const gasEstimate = await web3.eth.estimateGas({
            from: process.env.WALLET_ADDRESS,
            to: process.env.CONTRACT_ADDRESS,
            data: await constructParams(route, adjustedAmount, null), // Ensure params are encoded correctly
        });

        console.log(`Gas estimate: ${gasEstimate}, Adjusted trade size: ${adjustedAmount.toFixed()}`);
        return new BigNumber(gasEstimate);
    } catch (error) {
        console.error("Error estimating gas:", error.message);
        return new BigNumber(800000); // Fallback to a default estimate
    }
}



function getCacheDuration(type) {
    switch (type) {
        case "tokenPrices":
            return 5 * 60 * 1000; // Cache token prices for 5 minutes
        case "liquidityData":
            return 10 * 60 * 1000; // Cache liquidity data for 10 minutes
        case "swapQuotes":
            return 1 * 60 * 1000; // Cache swap quotes for 1 minute
        default:
            return 5 * 60 * 1000; // Default cache duration
    }
}

async function cachedGet(key, fetchFunction, type) {
    const now = Date.now();
    const cacheDuration = getCacheDuration(type);

    // Check cache validity
    if (cache.has(key)) {
        const { data, timestamp } = cache.get(key);
        if (now - timestamp < cacheDuration) {
            console.log(`Returning cached data for key: ${key}`);
            return data;
        }
    }

    // Fetch fresh data if cache is stale or missing
    const data = await fetchFunction();
    cache.set(key, { data, timestamp: now });
    console.log(`Fetched and cached data for key: ${key}`);
    return data;
}


// Function to send Telegram notifications
async function sendTelegramMessage(message, isCritical = false) {
    const chatId = isCritical ? process.env.TELEGRAM_CRITICAL_CHAT_ID : process.env.TELEGRAM_CHAT_ID;

    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
        });
        console.log("Telegram message sent:", message);
    } catch (error) {
        console.error("Failed to send Telegram message:", {
            message: error.message,
            stack: error.stack,
        });
    }
}



// Start the arbitrage bot
runArbitrageBot();

