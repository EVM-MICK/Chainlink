import dotenv from 'dotenv';
import axios from 'axios';
import Web3 from 'web3';
import BigNumber from 'bignumber.js';
import pkg from 'telegraf';
import retry from 'async-retry';
import { createRequire } from 'module'; 
import { AllowanceTransfer, PERMIT2_ADDRESS } from '@uniswap/permit2-sdk'; // Correct import with proper package name.
import { ethers } from 'ethers';
import PQueue from 'p-queue';
import cache from "node-cache"; // Replace with your caching logic if needed
dotenv.config();
const { Telegraf } = pkg;
const require = createRequire(import.meta.url);
const ABI = require('./YourSmartContractABI.json');
// const ABI = await import('./YourSmartContractABI.json', { assert: { type: 'json' } }).then(module => module.default);
const web3 = new Web3(process.env.INFURA_URL);  // Ensure this is Polygon-compatible
const contract = new web3.eth.Contract(ABI, process.env.CONTRACT_ADDRESS);
const HEADERS = {
    Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    Accept: "application/json",
};

// Configurable parameters
const apiQueue = new PQueue({
    concurrency: 1, // Allow 1 request at a time
    interval: 1000, // 1 second interval
    intervalCap: 1, // 1 request per second
});

// Define the CAPITAL as $100,000 USDC with 6 decimals (to match USDC decimal places)
const CAPITAL = new BigNumber(100000).shiftedBy(6);   // $100,000 in USDC (6 decimals)
const PROFIT_THRESHOLD = CAPITAL.multipliedBy(0.005);  // Equivalent to 0.5% profit
const MINIMUM_PROFIT_THRESHOLD = new BigNumber(500).shiftedBy(6);  // Minimum profit threshold $500 (6 decimals)
// Optional: Setting a higher threshold for "critical" profits
const CRITICAL_PROFIT_THRESHOLD = new BigNumber(1000).shiftedBy(6);  // Critical profit threshold $100 (6 decimals)
//const chainId = 42161;
// Base URL for 1inch APIs
const ONEINCH_BASE_URL = "https://api.1inch.dev";
const CACHE_DURATION = 5 * 60 * 1000; // Cache duration: 5 minutes
// API Endpoints
const SWAP_API_URL = `${ONEINCH_BASE_URL}/swap/v6.0`;   // Swap API
const TOKEN_API_URL = "https://api.1inch.dev/token/v1.2";
const PRICE_API_URL = "https://api.1inch.dev/price/v1.1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
// const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Replace with Permit2 address on Arbitrum
const CHAIN_ID = 42161;  // Arbitrum Mainnet
const Executor_ADDRESS = "0xE37e799D5077682FA0a244D46E5649F71457BD09";
// Stable, high-liquidity tokens to include in route evaluations
const STABLE_TOKENS = ["usdt", "usdc", "dai", "weth", "wbtc", "aave", "link", "arb"];
const highLiquidityTokens = ["usdt", "usdc", "dai", "weth"];
const MAX_HOPS = 3;
let cachedGasPrice = null; // Cached gas price value
let lastGasPriceFetch = 0; // Timestamp of the last gas price fetch
const cacheDuration = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

// Contract configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Your deployed contract address

if (!process.env.INFURA_URL || !process.env.ONEINCH_API_KEY || !process.env.CONTRACT_ADDRESS || !process.env.WALLET_ADDRESS) {
    console.error("Environment variables are missing. Please check .env configuration.");
    process.exit(1);
}

export function toDeadline(expirationMs) {
    return Math.floor(Date.now() / 1000) + Math.floor(expirationMs / 1000);
}

export async function fetchNonce(walletAddress, tokenAddress) {
    return await contract.methods.nonce(walletAddress, tokenAddress).call();
}

export function log(message, level = "info") {
    if (process.env.DEBUG === 'true' || level === "error") {
        const timestamp = new Date().toISOString();
        console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }
}

export async function generatePermit2Signature(token, spender, amount) {
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
export async function generatePermitBatchSignatures(tokens, spender) {
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
export async function getNonce(tokenAddress) {
    const nonce = await AllowanceTransfer.getNonce(web3, process.env.PERMIT2_ADDRESS, process.env.WALLET_ADDRESS, tokenAddress);
    console.log(`Fetched nonce for ${tokenAddress}: ${nonce}`);
    return nonce;
}

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
async function fetchFromTokenAPI(endpoint, params = {}) {
    const url = `${TOKEN_API_URL}/${CHAIN_ID}${endpoint}`;
    try {
        const response = await apiQueue.add(() =>
            axios.get(url, { headers: HEADERS, params })
        );
        return response.data;
    } catch (error) {
        console.error(`Token API Error [${endpoint}]:`, error.response?.data || error.message);
        throw error;
    }
}

async function fetchFromSwapAPI(endpoint, params = {}) {
    const url = `${SWAP_API_URL}/${CHAIN_ID}${endpoint}`;
    try {
        const response = await apiQueue.add(() =>
            axios.get(url, { headers: HEADERS, params })
        );
        return response.data;
    } catch (error) {
        console.error(`Swap API Error [${endpoint}]:`, error.response?.data || error.message);
        throw error;
    }
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


export async function cachedGetLiquidityData(tokens) {
    const cacheKey = `liquidity:${tokens.join(",")}`;

    // Check if liquidity data is cached and fresh
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (Date.now() - timestamp < 60000) { // Cache for 60 seconds
            return data;
        }
    }

    // Fetch gas price before fetching liquidity data
    const gasPrice = await fetchCachedGasPrice();
    console.log(`Current gas price: ${gasPrice.dividedBy(1e9).toFixed(2)} Gwei`);

    // Fetch liquidity data (assuming `getLiquidityData` is implemented)
    const data = await getLiquidityData(tokens);
    
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
            const allowance = await checkAllowance(token.address);
            if (allowance.isGreaterThanOrEqualTo(token.amount)) {
                console.log(`Sufficient allowance for ${token.address}. Skipping approval.`);
                continue;
            }

            const approvalResponse = await axios.get(`${PATHFINDER_API_URL}/approve/transaction`, {
                headers: {
        Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    },
                params: {
                    tokenAddress: token.address,
                    amount: token.amount.toFixed(),
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


// Primary function to run the arbitrage bot with automated monitoring
export async function runArbitrageBot() {
    console.log("Starting arbitrage bot... Monitoring for profitable swaps...");

    setInterval(async () => {
        try {
            // Step 1: Fetch gas price (cache this every 5 minutes)
            const gasPrice = await fetchGasPrice();

            // Step 2: Get liquidity data (refresh every 15 minutes)
            if (Date.now() % (15 * 60 * 1000) === 0) {
                await cachedGetLiquidityData(STABLE_TOKENS);
            }

            // Step 3: Find profitable routes (limit to top 3-5 tokens)
            const profitableRoutes = await findProfitableRoutes();
            if (profitableRoutes.length > 0) {
                const bestRoute = profitableRoutes[0];
                await executeRoute(bestRoute.route, bestRoute.profit);
            }
        } catch (error) {
            console.error("Error in monitoring loop:", error);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes
}

// Step 1: Find profitable routes within high-liquidity stable pairs
async function findProfitableRoutes() {
    try {
        console.log("Finding profitable routes...");

        // Step 1: Fetch stable tokens
        const stableTokens = await getStableTokenList();
        if (stableTokens.length === 0) {
            console.error("No stable tokens available. Skipping profitable route search.");
            return [];
        }

        // Step 2: Fetch token prices across protocols
        const tokenPrices = await fetchTokenPricesAcrossProtocols(stableTokens, CHAIN_ID);
        if (!tokenPrices || Object.keys(tokenPrices).length === 0) {
            console.error("Failed to fetch token prices. Skipping profitable route search.");
            return [];
        }

        // Step 3: Generate routes
        const maxHops = 3;
        const preferredStartToken = "usdc";
        const topN = 5;
        const routes = await generateRoutes(CHAIN_ID, maxHops, preferredStartToken, topN);

        if (routes.length === 0) {
            console.error("No profitable routes generated.");
            return [];
        }

        // Step 4: Evaluate routes and their profitability
        const profitableRoutes = [];
        for (const route of routes) {
            const profit = estimateRoutePotential(route, CAPITAL, tokenPrices);

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


// Utility: Priority queue implementation
class PriorityQueue {
    constructor(comparator) {
        this.queue = [];
        this.comparator = comparator;
    }

    enqueue(item) {
        this.queue.push(item);
        this.queue.sort(this.comparator);
    }

    dequeue() {
        return this.queue.shift();
    }

    isEmpty() {
        return this.queue.length === 0;
    }
}

// Utility: Estimate route potential (placeholder logic)
function estimateRoutePotential(route, capital, cachedPriceData) {
    const preferredTokens = ["usdc", "usdt"];
    const basePriority = preferredTokens.includes(route[0]) ? 100 : 50;
    let estimatedProfit = new BigNumber(0);

    for (let i = 0; i < route.length - 1; i++) {
        const fromToken = route[i];
        const toToken = route[i + 1];

        const fromPrice = cachedPriceData[fromToken]?.price;
        const toPrice = cachedPriceData[toToken]?.price;

        if (!fromPrice || !toPrice) {
            console.warn(`Missing price data for ${fromToken} or ${toToken}. Skipping route.`);
            return basePriority; // Fallback priority
        }

        const stepProfit = new BigNumber(toPrice).minus(fromPrice).multipliedBy(capital).dividedBy(fromPrice);
        estimatedProfit = estimatedProfit.plus(stepProfit);
    }

    return basePriority + estimatedProfit.toNumber();
}

function expandStableTokens(unmatchedTokens) {
    // Example logic to include dynamically determined stable tokens
    const additionalStableTokens = unmatchedTokens.filter((token) => {
        // Criteria: Could include high liquidity or frequent usage in routes
        return token.liquidity > 1_000_000; // Example threshold
    });

    STABLE_TOKENS.push(...additionalStableTokens);
    console.log("Updated STABLE_TOKENS list:", STABLE_TOKENS);
}

/**
 * Retrieve critical info for stable tokens from the 1inch Token API.
 * Prioritizes tokens listed in the STABLE_TOKENS array and uses caching for efficiency.
 *
 * @param {number} chainId - The blockchain network chain ID (default: 42161 for Arbitrum).
 * @returns {Promise<Object[]>} - A list of objects containing token details (address, symbol, decimals).
 */
export async function getStableTokenList(chainId = CHAIN_ID ) {
    const cacheKey = `stableTokens:${chainId}`;
    const cacheDuration = 5 * 60 * 1000; // Cache duration: 5 minutes
    const now = Date.now();

    // Check if cached data exists and is valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < cacheDuration) {
            console.log("Returning cached stable token list.");
            return data;
        }
    }

    try {
        // Fetch token data from the 1inch Token API
        const response = await axios.get(`${TOKEN_API_URL}/${chainId}/tokens`, {
            headers: HEADERS,
        });

        // Validate the response structure
        const tokenData = response.data?.tokens;
        if (!tokenData || Object.keys(tokenData).length === 0) {
            throw new Error("Invalid or empty token data received from 1inch API.");
        }

        // Normalize the STABLE_TOKENS array for case-insensitive matching
        const normalizedStableTokens = STABLE_TOKENS.map((symbol) => symbol.toLowerCase());

        // Match tokens from the STABLE_TOKENS list and extract details
        const matchedTokens = Object.entries(tokenData)
            .filter(([_, token]) => normalizedStableTokens.includes(token.symbol.toLowerCase()))
            .map(([address, token]) => ({
                address,
                symbol: token.symbol,
                decimals: token.decimals,
            }));

        if (matchedTokens.length === 0) {
            console.error("No tokens matched the STABLE_TOKENS list.");
            return [];
        }

        // Cache the matched tokens with a timestamp
        cache.set(cacheKey, { data: matchedTokens, timestamp: now });

        console.log("Fetched and cached stable token list:", matchedTokens);
        return matchedTokens;
    } catch (error) {
        console.error("Error fetching stable tokens:", {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });

        // Use stale cached data if available
        if (cache.has(cacheKey)) {
            console.warn("Using stale cached stable tokens due to errors.");
            return cache.get(cacheKey).data;
        }

        return [];
    }
}
/**
 * Fetch the prices of given tokens using the 1inch Price API.
 * This function caches the results to minimize redundant API calls.
 *
 * @param {string[]} tokenAddresses - Array of token addresses to fetch prices for.
 * @param {number} chainId - Blockchain network chain ID (default: CHAIN_ID).
 * @returns {Promise<Object>} - An object mapping token addresses to their prices and liquidity.
 */
export async function fetchTokenPrices(tokenAddresses, CHAIN_ID) {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
        throw new Error("Invalid tokenAddresses array provided.");
    }

    // Generate a unique cache key based on chainId and token addresses
    const cacheKey = `tokenPrices:${CHAIN_ID}:${tokenAddresses.join(",")}`;
    const cacheDuration = 5 * 60 * 1000; // Cache duration: 5 minutes
    const now = Date.now();

    // Check if cached data exists and is still valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < cacheDuration) {
            console.log("Returning cached token prices.");
            return data;
        }
    }

    try {
        // Prepare the request payload for the 1inch Price API
        const payload = {
            tokens: tokenAddresses,
            currency: "USD", // Fetch prices in USD
        };

        // Make an API request to the 1inch Price API
        const response = await axios.post(`${PRICE_API_URL}/${CHAIN_ID}`, payload, {
            headers: HEADERS,
        });

        // Parse and validate the API response
        const tokenPrices = response.data;
        if (!tokenPrices || Object.keys(tokenPrices).length === 0) {
            throw new Error("Invalid or empty token price data received from 1inch API.");
        }

        // Cache the results along with a timestamp
        cache.set(cacheKey, { data: tokenPrices, timestamp: now });

        console.log("Fetched and cached token prices:", tokenPrices);
        return tokenPrices;
    } catch (error) {
        console.error("Error fetching token prices:", {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });

        // Use stale cached data if available in case of an error
        if (cache.has(cacheKey)) {
            console.warn("Using stale cached token prices due to errors.");
            return cache.get(cacheKey).data;
        }

        // Return an empty object if no data is available
        return {};
    }
}

// Function to generate all possible routes within a max hop limit using stable, liquid tokens
/**
 * Generate profitable routes using stable tokens.
 * @param {number} chainId - Blockchain network chain ID (e.g., 42161 for Arbitrum).
 * @param {number} maxHops - Maximum number of hops for routes.
 * @param {string} preferredStartToken - Preferred starting token (e.g., "usdc").
 * @returns {Promise<string[][]>} - Array of profitable routes.
 */
async function generateRoutes( CHAIN_ID, maxHops = 3, preferredStartToken = "usdc", topN = 3) {
    const stableTokens = await getStableTokenList();
    if (stableTokens.length === 0) {
        console.error("No stable tokens found for route generation.");
        return [];
    }

    const tokenPrices = await fetchTokenPricesAcrossProtocols(stableTokens, CHAIN_ID);
    if (!tokenPrices || Object.keys(tokenPrices).length === 0) {
        console.error("Failed to fetch token prices for route generation.");
        return [];
    }

    const routes = new Set();
    const startTokens = [preferredStartToken, ...stableTokens.filter(t => t !== preferredStartToken)];

    for (const startToken of startTokens) {
        const generatePaths = async (path, hopsRemaining) => {
            if (hopsRemaining === 0) return;

            for (const token of stableTokens) {
                if (!path.includes(token)) {
                    const newPath = [...path, token];
                    const profit = estimateRoutePotential(newPath, CAPITAL, tokenPrices);
                    if (profit > 0) routes.add(newPath.join(","));
                    await generatePaths(newPath, hopsRemaining - 1);
                }
            }
        };

        await generatePaths([startToken], maxHops);
    }

    return Array.from(routes).map(route => route.split(",")).slice(0, topN);
}


/**
 * Fetch token prices and critical data across protocols using the 1inch Price API.
 * @param {string[]} tokens - Array of token symbols (e.g., ["usdt", "usdc", ...]).
 * @param {number} chainId - Blockchain network chain ID (default: 42161 for Arbitrum).
 * @returns {Promise<Object>} - An object mapping token addresses to their prices, symbols, decimals, and other critical data.
 */
export async function fetchTokenPricesAcrossProtocols(tokens, chainId = 42161) {
    if (!tokens || tokens.length === 0) {
        console.error("Token array is empty or undefined.");
        return {};
    }

    const cacheKey = `tokenPrices:${chainId}:${tokens.join(",")}`;
    const now = Date.now();

    // Return cached data if still valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < CACHE_DURATION) {
            console.log("Returning cached token prices.");
            return data;
        }
    }

    // Prepare API URL and payload
    const url = `${PRICE_API_URL}/${chainId}/${tokens.join(",")}`;

    try {
        console.log("Fetching token prices from 1inch Price API...");

        const response = await apiQueue.add(() =>
            axios.get(url, { headers: HEADERS })
        );

        if (!response || response.status !== 200 || !response.data) {
            throw new Error("Invalid response from 1inch Price API.");
        }

        const tokenData = response.data; // Expected format: { address: { price, symbol, decimals, ... }, ... }

        // Validate and normalize token data
        const normalizedData = {};
        for (const [address, data] of Object.entries(tokenData)) {
            if (web3.utils.isAddress(address)) {
                normalizedData[address] = {
                    price: new BigNumber(data.price || 0),
                    symbol: data.symbol,
                    decimals: data.decimals,
                    address,
                };
            } else {
                console.warn(`Invalid token address found in API response: ${address}`);
            }
        }

        console.log("Fetched and validated token data:", normalizedData);

        // Cache the results
        cache.set(cacheKey, { data: normalizedData, timestamp: now });

        return normalizedData;
    } catch (error) {
        console.error("Error fetching token prices:", error.message);

        if (error.response?.status === 429) {
            console.warn(
                `Rate limit exceeded. Retry-After: ${error.response.headers["retry-after"] || "unknown"} seconds.`
            );
        }

        // Fallback to stale cache if available
        if (cache.has(cacheKey)) {
            console.warn("Using stale cached data due to API failure.");
            return cache.get(cacheKey).data;
        }

        return {};
    }
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


// Helper: Get the best price from protocol data
function getBestPrice(protocolPrices) {
    return protocolPrices
        ? protocolPrices.reduce((best, current) => {
              const currentPrice = new BigNumber(current.price);
              return currentPrice.isGreaterThan(best) ? currentPrice : best;
          }, new BigNumber(0))
        : null;
}

// Helper Function: Fetch Liquidity Data (1inch API Example)
export async function getLiquidityData(tokens) {
    const cacheKey = `liquidityData:${tokens.join(",")}`;
    return cachedGet(cacheKey, async () => {
        const response = await fetchFrom1Inch(`/tokens`, { tokens });
        return tokens.reduce((acc, token) => {
            acc[token] = response.tokens[token]?.liquidity || 0;
            return acc;
        }, {});
    }, "liquidityData");
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
    return cachedGet(cacheKey, async () => {
        try {
            // Make the API call to fetch gas prices
            const response = await axios.get("https://api.blocknative.com/gasprices/blockprices", {
                headers: { Authorization: `Bearer ${process.env.BLOCKNATIVE_API_KEY}` },
                params: { chainId: CHAIN_ID },
            });

            // Log the entire response to determine the structure
            console.log("Gas Price API Response:", JSON.stringify(response.data, null, 2));

            // Attempt to extract gas price from other possible locations
            const gasPrice = response.data.blockPrices?.[0]?.baseFeePerGas; // Example alternative property
            if (gasPrice) {
                return new BigNumber(gasPrice).shiftedBy(9); // Convert Gwei to Wei
            }

            // If gas price cannot be determined, use a fallback value
            console.warn("Gas price not found in API response. Using fallback value: 50 Gwei.");
            return new BigNumber(50).shiftedBy(9); // Fallback to 50 Gwei in Wei
        } catch (error) {
            console.error("Error fetching gas price:", error.message);
            console.warn("Using fallback gas price: 50 Gwei.");
            return new BigNumber(50).shiftedBy(9); // Fallback to 50 Gwei in Wei
        }
    }, "gasPrice");
}



// Calculate dynamic minimum profit threshold based on gas fees and flash loan repayment
export async function calculateDynamicMinimumProfit() {
    const gasPrice = await fetchGasPrice();
    const estimatedGas = await estimateGas(800000); // Example estimated gas; adjust based on actual route complexity
    const gasCost = gasPrice.multipliedBy(estimatedGas);

    // Flash loan fee (0.05% of CAPITAL)
    const flashLoanFee = CAPITAL.multipliedBy(0.0005);

    // Total dynamic minimum profit required
    return MINIMUM_PROFIT_THRESHOLD.plus(gasCost).plus(flashLoanFee);
}

// Evaluate the profitability of a given route with dynamic profit adjustment
export async function evaluateRouteProfit(route) {
    try {
        // Fetch real-time token prices across protocols
        const priceData = await fetchTokenPricesAcrossProtocols(route);
        if (!priceData || Object.keys(priceData).length === 0) {
            console.error("Failed to fetch price data for route evaluation.");
            return new BigNumber(0);
        }

        // Calculate dynamic minimum profit threshold
        const minimumProfitThreshold = await calculateDynamicMinimumProfit();

        // Initial input amount (CAPITAL in usdt, assumed 6 decimals)
        let amountIn = CAPITAL;

        // Estimate gas cost
        const gasEstimate = await estimateGas(route, amountIn);
        const gasPrice = await fetchGasPrice();
        const gasCost = gasPrice.multipliedBy(gasEstimate);

        // Process each step in the route
        for (let i = 0; i < route.length - 1; i++) {
            const fromToken = route[i];
            const toToken = route[i + 1];

            const fromTokenPrices = priceData[fromToken];
            const toTokenPrices = priceData[toToken];

            if (!fromTokenPrices || !toTokenPrices) {
                console.error(`Missing price data for ${fromToken} or ${toToken}`);
                return new BigNumber(0); // Abort evaluation if any hop is invalid
            }

            // Use the best price for each protocol
            const fromPrice = getBestPrice(fromTokenPrices);
            const toPrice = getBestPrice(toTokenPrices);

            if (!fromPrice || !toPrice) {
                console.error(`Invalid price data for ${fromToken} or ${toToken}`);
                return new BigNumber(0); // Abort if price data is invalid
            }

            // Adjust amount based on slippage
            const slippage = calculateSlippage([fromToken, toToken], priceData);
            const adjustedAmount = amountIn.multipliedBy(1 - slippage / 100);
            amountIn = adjustedAmount.multipliedBy(toPrice).dividedBy(fromPrice);

            if (amountIn.isZero()) {
                console.error(`Received zero amount during hop from ${fromToken} to ${toToken}`);
                return new BigNumber(0); // Abort evaluation if a zero amount occurs
            }
        }

        // Calculate profit by deducting initial capital and gas cost
        const profit = amountIn.minus(CAPITAL).minus(gasCost);

        // Return profit only if it meets the minimum profit threshold
        if (profit.isGreaterThanOrEqualTo(minimumProfitThreshold)) {
            console.log(`Profitable route found: Profit = ${profit.dividedBy(1e6).toFixed(2)} usdt`);
            return profit;
        } else {
            console.log("Route did not meet the minimum profit threshold.");
            return new BigNumber(0);
        }
    } catch (error) {
        console.error("Unexpected error in evaluateRouteProfit:", error.message);
        return new BigNumber(0); // Return zero profit on unexpected error
    }
}

export function formatAmount(amount, decimals) {
    return new BigNumber(amount).toFixed(decimals);
}

/**
 * Fetch a swap quote using the 1inch Swap API.
 * Retrieves the transaction data required to execute a token swap.
 *
 * @param {string} fromToken - The address of the token to swap from.
 * @param {string} toToken - The address of the token to swap to.
 * @param {BigNumber} amount - The amount of the `fromToken` to swap (in the smallest unit).
 * @param {number} slippage - The slippage tolerance percentage (default: 1).
 * @param {number} chainId - Blockchain network chain ID (default: CHAIN_ID).
 * @returns {Promise<Object>} - The transaction data required to execute the swap.
 */
export async function getSwapQuote(fromToken, toToken, amount, slippage = 1, CHAIN_ID) {
    if (!fromToken || !toToken || !amount || amount.lte(0)) {
        throw new Error("Invalid parameters provided for getSwapQuote.");
    }

    // Generate a unique cache key for the swap quote
    const cacheKey = `swapQuote:${CHAIN_ID}:${fromToken}-${toToken}-${amount.toFixed()}-${slippage}`;
    const cacheDuration = 1 * 60 * 1000; // Cache duration: 1 minute
    const now = Date.now();

    // Check if cached data exists and is still valid
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (now - timestamp < cacheDuration) {
            console.log("Returning cached swap quote.");
            return data;
        }
    }

    try {
        // Prepare the request parameters for the 1inch Swap API
        const params = {
            fromTokenAddress: fromToken,
            toTokenAddress: toToken,
            amount: amount.toFixed(0), // Convert BigNumber to string in the smallest unit
            slippage: slippage.toFixed(2), // Format slippage as a percentage
            disableEstimate: false, // Enable price estimation
            allowPartialFill: false, // Ensure full swaps only
            includeProtocols: true, // Include protocol details in the response
        };

        // Make an API request to the 1inch Swap API
        const response = await axios.get(`${SWAP_API_URL}/${CHAIN_ID}/swap`, {
            headers: HEADERS,
            params,
        });

        // Validate the API response and extract transaction data
        const swapData = response.data;
        if (!swapData || !swapData.tx || !swapData.tx.data) {
            throw new Error("Invalid or incomplete swap data received from 1inch API.");
        }

        // Cache the response data along with a timestamp
        cache.set(cacheKey, { data: swapData.tx, timestamp: now });

        console.log("Fetched and cached swap quote:", swapData.tx);
        return swapData.tx;
    } catch (error) {
        console.error("Error fetching swap quote:", {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });

        // Use stale cached data if available during an API error
        if (cache.has(cacheKey)) {
            console.warn("Using stale cached swap quote due to errors.");
            return cache.get(cacheKey).data;
        }

        throw error; // Re-throw the error if no cached data is available
    }
}

// Function to execute the profitable route using flash loan and swap
export async function executeRoute(route, amount) {
    const assets = [process.env.USDC_ADDRESS]; // Always start with USDC as the first asset
    const amounts = [CAPITAL.toFixed()]; // Flash loan amount in USDC

    try {
        // Step 1: Approve tokens using Permit2
        const tokens = route.map((token) => ({ address: token, amount: CAPITAL.toFixed() }));
        await approveTokensWithPermit2(tokens);
        console.log("Tokens approved successfully");

        // Step 2: Generate PermitBatch signature
        const { signature } = await generatePermitBatchSignatures(tokens, process.env.CONTRACT_ADDRESS);

        // Step 3: Construct calldata with route and signature
        const params = await constructParams(route, amounts, signature);

        // Step 4: Encode calldata and send transaction to the smart contract
        const txData = contract.methods.fn_RequestFlashLoan(assets, amounts, params).encodeABI();

        const gasEstimate = await estimateGas(route, CAPITAL);
        const gasPrice = await fetchGasPrice();

        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: process.env.CONTRACT_ADDRESS,
            data: txData,
            gas: gasEstimate.toFixed(),
            gasPrice: gasPrice.toFixed(),
        };

        const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

        console.log("Flash loan and swap executed successfully. Transaction Hash:", receipt.transactionHash);

        // Step 5: Send Telegram notification for success
        const successMessage = `
            ✅ *Flash Loan and Swap Executed Successfully!*
            - Transaction Hash: [${receipt.transactionHash}](https://arbiscan.io/tx/${receipt.transactionHash})
            - Route: ${route.join(" ➡️ ")}
            - Amount: ${amount.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(successMessage);
    } catch (error) {
        console.error("Error executing route:", error);

        // Send Telegram notification for failure
        const errorMessage = `
            ❌ *Error Executing Flash Loan and Swap!*
            - Error: ${error.message}
            - Stack: ${error.stack}
            - Route: ${route.join(" ➡️ ")}
            - Amount: ${amount.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(errorMessage);

        throw error;
    }
}

// Helper function to encode calldata for a multi-hop route using 1inch API
export async function encodeSwapData(route, amount, slippagePercent) {
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

export async function fetchTokenDecimals(tokenAddress) {
    try {
        const contract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
        return await contract.methods.decimals().call();
    } catch (error) {
        console.warn(`Error fetching decimals for ${tokenAddress}. Defaulting to known stablecoin decimals.`);
        return STABLE_TOKENS.includes(tokenAddress.toLowerCase()) ? 6 : 18; // Default based on token type
    }
}

export async function estimateGas(route, amount) {
    try {
        const gasEstimate = await web3.eth.estimateGas({
            from: process.env.WALLET_ADDRESS,
            to: process.env.CONTRACT_ADDRESS,
            data: await constructParams(route, CAPITAL, null), // Ensure params are encoded correctly
        });
        return new BigNumber(gasEstimate);
    } catch (error) {
        console.error("Error estimating gas:", error.message);
        return new BigNumber(800000); // Fallback to default
    }
}

// Fetch current gas price with a maximum threshold
export async function fetchOptimalGasPrice() {
const API_KEY2 = "40236ca9-813e-4808-b992-cb28421aba86"; // Blocknative API Key
    const url3 = "https://api.blocknative.com/gasprices/blockprices";
    try {
        // Fetch gas price from Arbitrum Gas Station or similar API
        const response = await axios.get(url3, {
            headers: { Authorization: `Bearer ${API_KEY2}` },
            params: {
                chainId: 42161, // Arbitrum Mainnet Chain ID
            },
        });
        const gasPriceInGwei = response.data.fast.maxFee; // Fast gas price in Gwei
        const networkCongestion = gasPriceInGwei > 100 ? 1 : gasPriceInGwei / 100; // Normalize to 0-1 range

        // Dynamically adjust max gas price based on network congestion
        const maxGasPrice = networkCongestion > 0.8 ? 100e9 : 50e9; // In wei

        // Convert gas price from Gwei to Wei
        const gasPriceInWei = new BigNumber(web3.utils.toWei(gasPriceInGwei.toString(), 'gwei'));

        // Return gas price if it is within the acceptable threshold
        return gasPriceInWei.isLessThanOrEqualTo(maxGasPrice) ? gasPriceInWei : null;
    } catch (error) {
        console.error("Error fetching gas price:", error);
        return null; // Fallback or indicate failure
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

