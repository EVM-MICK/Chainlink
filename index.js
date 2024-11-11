require('dotenv').config();
const axios = require('axios');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const { Telegraf } = require('telegraf');
const retry = require('async-retry');

if (!process.env.INFURA_URL || !process.env.ONEINCH_API_KEY || !process.env.CONTRACT_ADDRESS || !process.env.WALLET_ADDRESS) {
    console.error("Environment variables are missing. Please check .env configuration.");
    process.exit(1);
}

const ABI = require('./YourSmartContractABI.json'); // ABI of the Solidity contract
const web3 = new Web3(process.env.INFURA_URL);  // Ensure this is Polygon-compatible

// Configurable parameters
const CAPITAL = new BigNumber(100000).shiftedBy(6);   // $100,000 in USDT (6 decimals)
const PROFIT_THRESHOLD = new BigNumber(0.3).multipliedBy(1e6);  // Equivalent to 0.3 * 1e6 in smallest units // 0.3% to 0.5% profit threshold ($300 - $500)
const MINIMUM_PROFIT_THRESHOLD = new BigNumber(200).multipliedBy(1e6);
const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/137";
const HEADERS = { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`, Accept: 'application/json' };
const USDT_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Stable, high-liquidity tokens to include in route evaluations
const STABLE_TOKENS = ["USDT", "USDC", "DAI", "ETH", "MATIC",  "WBTC", "AAVE", "LINK"];
const MAX_HOPS = 4;

// Contract configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Your deployed contract address
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);

function apiRequestUrl(methodName, queryParams) {
    return `${API_BASE_URL}${methodName}?${new URLSearchParams(queryParams).toString()}`;
}

// Function to check token allowance
async function checkAllowance(tokenAddress) {
    const url = apiRequestUrl("/approve/allowance", { tokenAddress, walletAddress: process.env.WALLET_ADDRESS });
    const response = await axios.get(url, { headers: HEADERS });
    return new BigNumber(response.data.allowance);
}

// Function to create an approval transaction
async function requestTokenApproval(tokenAddress, amount) {
    const url = apiRequestUrl("/approve/transaction", { tokenAddress, amount });
    const response = await axios.get(url, { headers: HEADERS });
    const approveTx = response.data;

    // Estimate gas
    const gasLimit = await web3.eth.estimateGas({ ...approveTx, from: process.env.WALLET_ADDRESS });
    return { ...approveTx, gas: gasLimit };
}

// Approve token if needed
async function approveTokenIfNeeded(tokenAddress, amount) {
    const allowance = await checkAllowance(tokenAddress);
    if (allowance.isLessThan(amount)) {
        console.log(`Approving ${amount.shiftedBy(-6)} for 1inch Router.`);
        const approvalTx = await requestTokenApproval(tokenAddress, amount.toFixed(0));
        const signedTx = await web3.eth.accounts.signTransaction(approvalTx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log("Approval Transaction Hash:", receipt.transactionHash);
    }
}

// Fetch swap data
async function getSwapData(fromToken, toToken, amount, slippage) {
    const url = `${PATHFINDER_API_URL}/swap?${new URLSearchParams({
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amount: amount.toFixed(0),
        fromAddress: process.env.WALLET_ADDRESS,
        slippage,
        allowPartialFill: false,
        disableEstimate: false,
        includeProtocols: true // Ensures response includes protocol details for each hop
    }).toString()}`;

    try {
        const response = await axios.get(url, { headers: HEADERS });
        const routeData = response.data.tx.data; // Ensure `routeData` contains DEX paths
        return routeData;
    } catch (error) {
        console.error("Error fetching swap data:", error);
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
    }, 1000);  // Check for opportunities every 1 second
}

// Step 1: Find profitable routes within high-liquidity stable pairs
// Function to find profitable routes
async function findProfitableRoutes() {
    const tokens = await getStableTokenList();
    const allRoutes = generateRoutes(tokens, MAX_HOPS);
    const profitableRoutes = [];

    // Evaluate routes in parallel using Promise.all for speed
    const routePromises = allRoutes.map(async (route) => {
        try {
            const profit = await evaluateRouteProfit(route);
            
            if (profit.isGreaterThanOrEqualTo(PROFIT_THRESHOLD)) {
                const message = `Profitable route found: ${route} with profit: $${profit.dividedBy(1e6).toFixed(2)}`;
                console.log(message);
                await sendTelegramMessage(message);  // Send notification
                return { route, profit };
            }
        } catch (error) {
            console.error(`Error evaluating route ${route}:`, error);
        }
        return null;  // Return null if not profitable or an error occurred
    });

    // Filter out null results and return only profitable routes
    const results = await Promise.all(routePromises);
    return results.filter((route) => route !== null);
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
function generateRoutes(tokens, maxHops) {
    const routes = [];
    const stableTokens = tokens.filter(token => STABLE_TOKENS.includes(token)); // Pre-filter for stable tokens

    // Helper function to recursively build routes
    function permute(path) {
        // If the path length is valid, add it to routes
        if (path.length > 1 && path.length <= maxHops) {
            routes.push([...path]);
        }

        // Recurse only if maxHops not yet reached
        if (path.length < maxHops) {
            for (const token of stableTokens) {
                // Prevent cyclic paths by checking if token is already in the path
                if (!path.includes(token)) {
                    path.push(token);  // Add token to the current path
                    permute(path);     // Recurse to build longer paths
                    path.pop();        // Remove token to backtrack
                }
            }
        }
    }

    // Generate routes starting from each stable token
    for (const token of STABLE_TOKENS) {
        permute([token]);
    }

    return routes;
}


// Fetch current gas price in Gwei from Polygon Gas Station
async function fetchGasPrice() {
    try {
        const response = await axios.get("https://gasstation-mainnet.matic.network/v2");
        const gasPriceGwei = new BigNumber(response.data.fast.maxFee); // Fast gas price in Gwei
        return gasPriceGwei.multipliedBy(1e9); // Convert Gwei to Wei
    } catch (error) {
        console.error("Error fetching gas price:", error);
        return new BigNumber(50).multipliedBy(1e9); // Fallback to 50 Gwei in Wei if API fails
    }
}

// Calculate dynamic minimum profit threshold based on gas fees and flash loan repayment
async function calculateDynamicMinimumProfit() {
    const gasPrice = await fetchGasPrice();
    const estimatedGas = new BigNumber(200000); // Example estimated gas; adjust based on actual route complexity
    const gasCost = gasPrice.multipliedBy(estimatedGas);

    // Flash loan fee (0.05% of CAPITAL)
    const flashLoanFee = CAPITAL.multipliedBy(0.0005);

    // Total dynamic minimum profit required
    return MINIMUM_BASE_PROFIT.plus(gasCost).plus(flashLoanFee);
}

// Evaluate the profitability of a given route with dynamic profit adjustment
async function evaluateRouteProfit(route) {
    const minimumProfitThreshold = await calculateDynamicMinimumProfit();
    let amountIn = CAPITAL;

    for (let i = 0; i < route.length - 1; i++) {
        const fromToken = route[i];
        const toToken = route[i + 1];

        try {
            const swapData = await getSwapData(fromToken, toToken, amountIn, 0.5);
            amountIn = new BigNumber(swapData.toTokenAmount); // Update with next token amount

            if (amountIn.isZero()) {
                console.log(`Route ${route} failed: received zero amount.`);
                return new BigNumber(0);
            }

            console.log(`Hop ${fromToken} -> ${toToken}: ${amountIn.dividedBy(1e6).toFixed(2)} (USD)`);

        } catch (error) {
            console.error(`Error evaluating hop ${fromToken} -> ${toToken}:`, error);
            return new BigNumber(0);
        }
    }

    const profit = amountIn.minus(CAPITAL);
    return profit.isGreaterThanOrEqualTo(minimumProfitThreshold) ? profit : new BigNumber(0);
}


function formatAmount(amount, decimals) {
    return new BigNumber(amount).toFixed(decimals);
}

// Get a swap quote for a multihop with retry logic
async function getSwapQuote(fromToken, toToken,srcReceiver, dstReceiver, amountIn, minReturnAmount, flags, route, retries = 3) {
    const tokenDecimals = STABLE_TOKENS.includes(fromToken) || STABLE_TOKENS.includes(toToken) ? 6 : 18;
    const formattedAmount = formatAmount(amount, tokenDecimals);

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
            return getSwapQuote(fromToken, toToken,CONTRACT_ADDRESS,CONTRACT_ADDRESS, amountIn, minReturnAmount, flags, permit, retries - 1);
        } else {
            const errorMessage = `Error fetching route quote for ${fromToken} to ${toToken}: ${error}`;
            console.error(errorMessage);
            await sendTelegramMessage(errorMessage);  // Notify error
            return new BigNumber(0);
        }
    }
}

// Function to execute the profitable route using flash loan and swap Execute the best profitable route found 
async function executeRoute(route, profit) {
    const initialToken = USDT_ADDRESS;
    const { txData, protocols } = await encodeSwapData(route, CAPITAL, 0.5); 

    await approveTokenIfNeeded(initialToken, CAPITAL);

    try {
        // Encode `routeData` and `protocols` into the `params` expected by the contract
        const params = web3.eth.abi.encodeParameters(
            ['bytes', 'bytes[]'], // Adjust types for route data and protocols
            [txData, protocols]
        );

        const txDataToSend = contract.methods.fn_RequestFlashLoan(initialToken, CAPITAL, params).encodeABI();

        const gasEstimate = await web3.eth.estimateGas({
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txDataToSend
        });
        const gasPrice = await fetchOptimalGasPrice(new BigNumber(50).multipliedBy(1e9));
        if (!gasPrice) {
            console.log("Gas price too high; skipping execution.");
            return;
        }

        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txDataToSend,
            gas: gasEstimate,
            gasPrice: gasPrice.toFixed()
        };

        const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log("Transaction receipt:", receipt);
        profitMessage = console.log("Flash loan and trade executed, transaction receipt:", receipt);
        await sendTelegramMessage(profitMessage) 
    } catch (error) {
        console.error("Error executing route:", error);
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


// Fetch current gas price with a maximum threshold
async function fetchOptimalGasPrice(maxGasPriceInWei) {
    try {
        const response = await axios.get("https://gasstation-mainnet.matic.network/v2");
        const gasPrice = new BigNumber(web3.utils.toWei(response.data.fast.maxFee.toString(), 'gwei'));
        return gasPrice.isLessThanOrEqualTo(maxGasPriceInWei) ? gasPrice : null;
    } catch (error) {
        console.error("Error fetching gas price:", error);
        return null;
    }
}

// Function to send Telegram notifications
async function sendTelegramMessage(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown"  // Optional: Format message with Markdown
        });
        console.log("Telegram notification sent:", message);
    } catch (error) {
        console.error("Failed to send Telegram message:", error);
    }
}


// Start the arbitrage bot
runArbitrageBot();
