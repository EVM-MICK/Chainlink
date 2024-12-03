require('dotenv').config();
const axios = require('axios');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const { Telegraf } = require('telegraf');
const retry = require('async-retry');
const { AllowanceTransfer, PERMIT2_ADDRESS } = require('@uniswap/permit2-sdk ethers');
if (!process.env.INFURA_URL || !process.env.ONEINCH_API_KEY || !process.env.CONTRACT_ADDRESS || !process.env.WALLET_ADDRESS) {
    console.error("Environment variables are missing. Please check .env configuration.");
    process.exit(1);
}

const ABI = require('./YourSmartContractABI.json'); // ABI of the Solidity contract
const web3 = new Web3(process.env.INFURA_URL);  // Ensure this is Polygon-compatible


// Configurable parameters
const CAPITAL = new BigNumber(100000).shiftedBy(6);   // $100,000 in USDC (6 decimals)
const PROFIT_THRESHOLD = new BigNumber(0.3).multipliedBy(1e6);  // Equivalent to 0.3 * 1e6 in smallest units // 0.3% to 0.5% profit threshold ($300 - $500)
const MINIMUM_PROFIT_THRESHOLD = new BigNumber(200).multipliedBy(1e6);
const chainId = 42161;
const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/" + chainId;
const HEADERS = { headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`, accept: "application/json" } };
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
//const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Replace with Permit2 address on Arbitrum
const CHAIN_ID = 42161;  // Arbitrum Mainnet
const Executor_ADDRESS = "0xE37e799D5077682FA0a244D46E5649F71457BD09";
// Stable, high-liquidity tokens to include in route evaluations
const STABLE_TOKENS = ["USDT", "USDC", "DAI", "WETH", "WBTC", "AAVE", "LINK", "ARB"];
const highLiquidityTokens = ["USDT", "USDC", "DAI", "WETH"];
const CRITICAL_PROFIT_THRESHOLD = new BigNumber(500).multipliedBy(1e6); // Example: $500 in smallest units
const MAX_HOPS = 4;
const cache = new Map();
// Contract configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Your deployed contract address
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);


(async () => {
    const nonce = await permit2Contract.methods.nonce(walletAddress, tokenAddress).call();
})();

function apiRequestUrl(methodName, queryParams) {
    return `${API_BASE_URL}${methodName}?${new URLSearchParams(queryParams).toString()}`;
}

// Convert expiration to deadline in seconds
function toDeadline(expirationMs) {
    return Math.floor(Date.now() / 1000) + Math.floor(expirationMs / 1000);
}
// Helper function: Fetch the current nonce for a token
async function fetchNonce(walletAddress, tokenAddress) {
    return await permit2Contract.methods.nonce(walletAddress, tokenAddress).call();
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
            amount: ethers.BigNumber.from(amount),
            expiration,
            nonce,
        },
        spender,
        sigDeadline,
    };

    const { domain, types, values } = AllowanceTransfer.getPermitData(
        permitSingle,
        PERMIT2_ADDRESS,
        CHAIN_ID
    );

    const signature = await wallet._signTypedData(domain, types, values);
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
        PERMIT2_ADDRESS,
        CHAIN_ID
    );

    const signature = await web3.eth.accounts.signTypedData(domain, types, values);
    return { signature, permitBatch };
}

// Helper to fetch Permit2 nonce dynamically
async function getNonce(tokenAddress) {
    const nonce = await AllowanceTransfer.getNonce(web3, PERMIT2_ADDRESS, process.env.WALLET_ADDRESS, tokenAddress);
    console.log(`Fetched nonce for ${tokenAddress}: ${nonce}`);
    return nonce;
}

async function cachedGetLiquidityData(tokens) {
    const cacheKey = `liquidity:${tokens.join(",")}`;
    if (cache.has(cacheKey)) {
        const { data, timestamp } = cache.get(cacheKey);
        if (Date.now() - timestamp < 60000) { // Cache for 60 seconds
            return data;
        }
    }

    const data = await getLiquidityData(tokens);
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
}


// Construct `params` with SwapDescription and Permit2 signature

async function constructParams(route, amount, permitBatchSignature) {
    const fromToken = route[0];
    const toToken = route[route.length - 1];

    const swapDescription = {
        srcToken: fromToken,
        dstToken: toToken,
        srcReceiver: Executor_ADDRESS,
        dstReceiver: process.env.CONTRACT_ADDRESS,
        amount: CAPITAL.toFixed(),
        minReturnAmount: PROFIT_THRESHOLD.toFixed(), // Adjust dynamically based on profit threshold
        flags: 0x04, // Update flags if needed
    };

    try {
        // Encode the parameters
        const params = web3.eth.abi.encodeParameters(
            ['tuple(address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags)', 'bytes', 'bytes'],
            [Object.values(swapDescription), permitBatchSignature, routeData ]
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
    const spender = process.env.CONTRACT_ADDRESS; // The contract address acting as the spender

    try {
        // Generate PermitBatch signature for all tokens
        for (const token of tokens) {
            const currentAllowance = await checkAllowance(token.address);
            if (currentAllowance.isGreaterThan(token.CAPITAL)) {
                console.log(`Sufficient allowance already granted for ${token.address}. Skipping approval.`);
                continue; // Skip tokens that already have sufficient allowance
            }
        }
        const { signature, permitBatch } = await generatePermitBatchSignatures(tokens, spender);
        

        console.log("Generated PermitBatch Signature:", signature);

        // Optional: Log the PermitBatch details for debugging
        console.log("PermitBatch Details:", permitBatch);

        // Send the signature and PermitBatch to the contract for verification
        const tx = await contract.methods
            .permitThroughPermit2(permitBatch, signature)
            .send({ from: process.env.WALLET_ADDRESS });

        console.log("PermitBatch approved successfully. Transaction Hash:", tx.transactionHash);
    } catch (error) {
        console.error("Error in approving tokens with Permit2:", error);
        throw error;
    }
}

// Function to check token allowance
async function checkAllowance(tokenAddress) {
    const url = apiRequestUrl("/approve/allowance", { tokenAddress, walletAddress: process.env.WALLET_ADDRESS });
    const response = await axios.get(url, { headers: HEADERS });
    return new BigNumber(response.data.allowance);
}

// Fetch swap data
async function getSwapData(fromToken, toToken, amount, slippage) {
    const tokenLiquidity = 150000000000; // Example liquidity value
    const url = `${PATHFINDER_API_URL}/swap?${new URLSearchParams({
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amount: CAPITAL.toFixed(0),
        fromAddress: process.env.WALLET_ADDRESS,
        slippage: slippage.toFixed(2),
        allowPartialFill: false,
        disableEstimate: false,
    }).toString()}`;

    try {
        const response = await axios.get(url, { headers: HEADERS });
        const routeData = response.data.tx.data;
        if (!routeData) throw new Error("1inch API returned incomplete route data");

        console.log("Valid route data fetched:", routeData);
        return routeData;
    } catch (error) {
        console.error("Error fetching swap data from 1inch API:", error.message);
        throw error;
    }
}


// Primary function to run the arbitrage bot with automated monitoring
async function runArbitrageBot() {
    console.log("Starting arbitrage bot... Monitoring for profitable swaps...");
    setInterval(async () => {
        try {
            const profitableRoutes = await findProfitableRoutes();
            if (profitableRoutes.length > 0) {
                // Execute the first profitable route found
                const bestRoute = profitableRoutes[0];
                await executeRoute(bestRoute.route, bestRoute.profit);
            }
        } catch (error) {
            console.error("Error in monitoring loop:", error);
        }
    }, 1800000);  // Check for opportunities every 30 minutes to set it to every 1 second use  1000
}

// Step 1: Find profitable routes within high-liquidity stable pairs
// Function to find profitable routes
async function findProfitableRoutes() {
    const tokens = await getStableTokenList();
    const preferredStartToken = "USDC"; // The preferred token to start with
    const topN = 3; // Consider top 3 most liquid tokens

    // Generate routes and initialize priority queue
    const allRoutes = await generateRoutes(tokens, MAX_HOPS, preferredStartToken, topN);
    const profitableRoutes = [];
    const routeQueue = new PriorityQueue((a, b) => b.priority - a.priority); // Higher priority first

    // Populate the queue with initial routes and priorities (e.g., based on liquidity or other criteria)
    for (const route of allRoutes) {
        const potentialProfit = estimateRoutePotential(route, CAPITAL); // Estimate potential profit based on CAPITAL
        routeQueue.enqueue({ route, priority: potentialProfit });
    }

    // Process routes from the queue
    while (!routeQueue.isEmpty()) {
        const { route } = routeQueue.dequeue(); // Get the highest-priority route

        try {
            const profit = await evaluateRouteProfit(route); // Evaluate the actual profit for the route

            // Check for critical profit threshold
            if (profit.isGreaterThanOrEqualTo(CRITICAL_PROFIT_THRESHOLD)) {
                console.log(
                    `Critical profit route found: ${route.join(" ➡️ ")} with profit: $${profit.dividedBy(1e6).toFixed(2)}`
                );
                await sendTelegramMessage(
                    `🚨 Critical Profit! Route: ${route.join(" ➡️ ")} with profit: $${profit.dividedBy(1e6).toFixed(2)}`
                );
                return [{ route, profit }]; // Early exit with the critical route
            }

            // Check for normal profit threshold
            if (profit.isGreaterThanOrEqualTo(PROFIT_THRESHOLD)) {
                console.log(
                    `Profitable route found: ${route.join(" ➡️ ")} with profit: $${profit.dividedBy(1e6).toFixed(2)}`
                );
                await sendTelegramMessage(
                    `Profitable Route: ${route.join(" ➡️ ")} with profit: $${profit.dividedBy(1e6).toFixed(2)}`
                );
                profitableRoutes.push({ route, profit });
            }
        } catch (error) {
            console.error(`Error evaluating route ${route.join(" ➡️ ")}:`, error.message);
        }
    }

    // Sort profitable routes by profit in descending order
    profitableRoutes.sort((a, b) => b.profit.minus(a.profit).toNumber());

    return profitableRoutes; // Return all profitable routes, sorted by profit
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
function estimateRoutePotential(route, capital) {
    const preferredTokens = ["USDC", "USDT"];
    const basePriority = preferredTokens.includes(route[0]) ? 100 : 50;

    // Simulate potential profit based on a conservative slippage estimate
    const estimatedProfit = capital.multipliedBy(0.0015); // Assume 0.15% profit
    const slippageAdjustment = capital.multipliedBy(0.0002); // Assume 0.02% slippage
    return basePriority + estimatedProfit.minus(slippageAdjustment).toNumber();
}


// Function to retrieve a list of stable, high-liquidity tokens from the 1inch API Get stable, high-liquidity tokens to focus on profitable paths
async function getStableTokenList() {
    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/tokens`, { headers: HEADERS });

        // Check if the response structure matches the expected format
        if (response.data && response.data.tokens) {
            const tokens = Object.keys(response.data.tokens)
                .filter(tokenAddress => STABLE_TOKENS.includes(response.data.tokens[tokenAddress].symbol))
                .map(tokenAddress => tokenAddress); // Return only token addresses

            console.log("Retrieved stable tokens:", tokens);
            return tokens;
        } else {
            console.error("Unexpected response structure:", response.data);
            return [];
        }

    } catch (error) {
        console.error("Error fetching stable tokens from 1inch API:", error);
        return [];
    }
}


// Generate all possible routes within max hops limit
// Function to generate all possible routes within a max hop limit using stable, liquid tokens
async function generateRoutes(tokens, MAX_HOPS, preferredStartToken = "USDC", topN = 3) {
    const routez = new Set(); // Use a Set to ensure uniqueness

    // Step 1: Filter tokens to include only those in STABLE_TOKENS
    const stableTokens = tokens.filter(token => STABLE_TOKENS.includes(token));
    if (stableTokens.length === 0) {
        console.error("No tokens matched the STABLE_TOKENS list. Skipping route generation.");
        return []; // Return an empty array if no valid tokens
    }

    // Step 2: Fetch and rank tokens by liquidity
    const liquidityData = await safeExecute(getLiquidityData, stableTokens);
    if (!liquidityData) {
        console.error("Failed to fetch liquidity data. Skipping route generation.");
        return []; // Return an empty array if liquidity data is unavailable
    }

    // Filter tokens that can support the capital amount
    const filteredTokens = Object.entries(liquidityData)
        .filter(([, liquidity]) => new BigNumber(liquidity).isGreaterThanOrEqualTo(CAPITAL)) // Ensure token liquidity >= CAPITAL
        .sort(([, liquidityA], [, liquidityB]) => liquidityB - liquidityA) // Sort by liquidity (descending)
        .map(([token]) => token); // Extract token addresses/symbols

    if (filteredTokens.length === 0) {
        console.error("No tokens have sufficient liquidity to support the capital amount. Skipping route generation.");
        return []; // Return an empty array if no tokens meet the liquidity requirement
    }

    // Step 3: Select the top N tokens by liquidity
    const highLiquidityTokens = filteredTokens.slice(0, topN);

    // Step 4: Ensure the preferred start token is included
    const startTokens = highLiquidityTokens.includes(preferredStartToken)
        ? [preferredStartToken, ...highLiquidityTokens.filter(token => token !== preferredStartToken)]
        : [preferredStartToken, ...highLiquidityTokens]; // Include preferredStartToken even if it's not in highLiquidityTokens

    console.log("Filtered Tokens by Liquidity:", filteredTokens);
    console.log("Starting Tokens for Routes:", startTokens);

    // Step 5: Generate routes using filtered tokens
    function permute(path, remainingHops) {
        if (remainingHops === 0) return;
        for (const token of filteredTokens) {
            if (!path.includes(token)) {
                const newPath = [...path, token];
                routez.add(newPath.join(",")); // Store as a string for uniqueness
                permute(newPath, remainingHops - 1);
            }
        }
    }

    // Step 6: Generate routes starting from each token in the prioritized start tokens
    for (const startToken of startTokens) {
        permute([startToken], MAX_HOPS - 1); // Start with MAX_HOPS - 1 because the first token is already included
    }

    // Convert back to an array of arrays after generating all routes
    return Array.from(routez).map(route => route.split(","));
}

// Helper Function: Fetch Liquidity Data (1inch API Example)
async function getLiquidityData(tokens) {
    const liquidityData = {};
    try {
        const response = await axios.get(`https://api.1inch.io/v5.0/${chainId}/tokens`);
        const tokenData = response.data.tokens;

        tokens.forEach(token => {
            const tokenInfo = tokenData[token.toLowerCase()];
            liquidityData[token] = tokenInfo ? tokenInfo.liquidity || 0 : 0;
        });
    } catch (error) {
        console.error("Error fetching liquidity data from 1inch:", error.message);
        console.warn("Falling back to predefined liquidity ranking.");
        tokens.forEach(token => {
            liquidityData[token] = STABLE_TOKENS.includes(token) ? 1 : 0; // Assign low liquidity to non-stable tokens
        });
    }
    return liquidityData;
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
async function fetchGasPrice({ useOptimal = false } = {}) {
    try {
        const response = await axios.get("https://gasstation-mainnet.arbitrum.io/v2");
        const gasPriceInGwei = response.data.fast.maxFee; // Fast gas price in Gwei

        // Convert gas price from Gwei to Wei
        const gasPriceInWei = new BigNumber(web3.utils.toWei(gasPriceInGwei.toString(), 'gwei'));

        if (useOptimal) {
            const networkCongestion = gasPriceInGwei > 100 ? 1 : gasPriceInGwei / 100; // Normalize to 0-1 range
            const maxGasPrice = networkCongestion > 0.8 ? 100e9 : 50e9; // In wei

            if (gasPriceInWei.isGreaterThan(maxGasPrice)) {
                console.warn("Gas price exceeds optimal threshold. Skipping transaction.");
                return null;
            }
        }

        return gasPriceInWei;
    } catch (error) {
        console.error("Error fetching gas price:", error);
        return new BigNumber(50).multipliedBy(1e9); // Fallback to 50 Gwei
    }
}


// Calculate dynamic minimum profit threshold based on gas fees and flash loan repayment
async function calculateDynamicMinimumProfit() {
    const gasPrice = await fetchGasPrice();
    const estimatedGas = await estimateGas(route, CAPITAL); // Example estimated gas; adjust based on actual route complexity
    const gasCost = gasPrice.multipliedBy(estimatedGas);

    // Flash loan fee (0.05% of CAPITAL)
    const flashLoanFee = CAPITAL.multipliedBy(0.0005);

    // Total dynamic minimum profit required
    return MINIMUM_PROFIT_THRESHOLD.plus(gasCost).plus(flashLoanFee);
}

// Evaluate the profitability of a given route with dynamic profit adjustment
async function evaluateRouteProfit(route) {
    try {
        // Dynamic slippage based on token liquidity (dummy value here, replace with actual logic)
        const tokenLiquidity = 150000000000; // Example liquidity value
        const slippage = tokenLiquidity > 100000000000 ? 0.5 : 1.0;

        // Calculate dynamic minimum profit threshold
        const minimumProfitThreshold = await calculateDynamicMinimumProfit();

        // Initial input amount (CAPITAL in USDT, assumed 6 decimals)
        let amountIn = CAPITAL;

        const gasEstimate = await estimateGas(route, amountIn);
        const gasPrice = await fetchGasPrice();
        const gasCost = gasPrice.multipliedBy(gasEstimate);

        // Process each step in the route
        for (let i = 0; i < route.length - 1; i++) {
            const fromToken = route[i];
            const toToken = route[i + 1];

            // Fetch token decimals to ensure accurate conversions
            const decimals = await fetchTokenDecimals(fromToken);

            try {
                // Fetch swap data for the current hop
                const swapData = await getSwapData(fromToken, toToken, amountIn, slippage);
                amountIn = new BigNumber(swapData.toTokenAmount).shiftedBy(-decimals);

                if (amountIn.isZero()) throw new Error("Received zero amount during hop");
            } catch (error) {
                console.error(`Error in route evaluation (${fromToken} -> ${toToken}): ${error.message}`);
                return new BigNumber(0); // Abort evaluation if any hop fails
            }
        }

        // Calculate profit by deducting initial capital and gas cost
        const profit = amountIn.minus(CAPITAL).minus(gasCost);

        // Return profit only if it meets the minimum profit threshold
        return profit.isGreaterThanOrEqualTo(minimumProfitThreshold) ? profit : new BigNumber(0);
    } catch (error) {
        console.error("Unexpected error in evaluateRouteProfit:", error.message);
        return new BigNumber(0); // Return zero profit on unexpected error
    }
}


function formatAmount(amount, decimals) {
    return new BigNumber(amount).toFixed(decimals);
}

// Get a swap quote for a multihop with retry logic
async function getSwapQuote(fromToken, toToken,srcReceiver, dstReceiver, amountIn, minReturnAmount, flags, route, retries = 3) {
    const tokenDecimals = STABLE_TOKENS.includes(fromToken) || STABLE_TOKENS.includes(toToken) ? 6 : 18;
    const formattedAmount = formatAmount(CAPITAL, tokenDecimals);
    

    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/quote`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                 amount: formattedAmount,   
                slippage: "1",                 
                disableEstimate: false
            }
        });
        return new BigNumber(response.data.toTokenAmount);
    } catch (error) {
        if (retries > 0) {
            console.warn(`Retrying getSwapQuote for ${fromToken} to ${toToken}. Retries left: ${retries - 1}`);
            return getSwapQuote(fromToken, toToken,CONTRACT_ADDRESS,CONTRACT_ADDRESS, formattedAmount, minReturnAmount, flags, permit, retries - 1);
        } else {
            const errorMessage = `Error fetching route quote for ${fromToken} to ${toToken}: ${error}`;
            console.error(errorMessage);
            await sendTelegramMessage(errorMessage);  // Notify error
            return new BigNumber(0);
        }
    }
}

// Function to execute the profitable route using flash loan and swap Execute the best profitable route found 
async function executeRoute(route, amount) {
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
            - Amount: ${amounts.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(successMessage);
    } catch (error) {
        console.error("Error executing route:", error);

        // Send Telegram notification for failure
        const errorMessage = `
            ❌ *Error Executing Flash Loan and Swap!*
            - Error: ${error.message}
             - CAPITAL: ${CAPITAL.dividedBy(1e6).toFixed(2)} USDC
            - Stack: ${error.stack}
            - Route: ${route.join(" ➡️ ")}
            - Amount: ${amounts.toFixed()} (${assets[0]})
        `;
        await sendTelegramMessage(errorMessage);

        throw error;
    }
}

// Helper function to encode calldata for a multi-hop route using 1inch API  Encode the swap data for route with adjustable slippage
async function encodeSwapData(route, amount, slippagePercent) {
    const fromToken = route[0];
    const toToken = route[route.length - 1];
    const formattedAmount = amount.toFixed(STABLE_TOKENS.includes(fromToken) ? 6 : 18);

    try {
        // Construct the API request with parameters that ensure protocol details are included
        const response = await axios.get(`${PATHFINDER_API_URL}/swap`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                amount: formattedAmount,
                fromAddress: process.env.WALLET_ADDRESS,
                slippage: slippagePercent,
                disableEstimate: false,
                allowPartialFill: false,
                includeProtocols: true // Include protocol details in response
            }
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

async function fetchTokenDecimals(tokenAddress) {
    try {
        const contract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
        return await contract.methods.decimals().call();
    } catch (error) {
        console.warn(`Error fetching decimals for ${tokenAddress}. Assuming 18 decimals.`);
        return 18; // Default to 18 decimals
    }
}

async function estimateGas(route, amount) {
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
async function fetchOptimalGasPrice() {
    try {
        // Fetch gas price from Arbitrum Gas Station or similar API
        const response = await axios.get("https://gasstation-mainnet.arbitrum.io/v2");
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


// Function to send Telegram notifications
async function sendTelegramMessage(message, isCritical = false) {
    if (!isCritical && process.env.DEBUG !== 'true') return;
    try {
        const response = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown",
        });
        console.log("Telegram notification sent:", message);
        return response.data;
    } catch (error) {
        console.error("Failed to send Telegram message:", error.message);
    }
}


// Start the arbitrage bot
runArbitrageBot();
