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
const CAPITAL = new BigNumber(100000 * 1e6);  // $100,000 in USDT (6 decimals)
const PROFIT_THRESHOLD = new BigNumber(0.3 * 1e6); // 0.3% to 0.5% profit threshold ($300 - $500)
const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/137";
const HEADERS = { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`, Accept: 'application/json' };

// Stable, high-liquidity tokens to include in route evaluations
const STABLE_TOKENS = ["USDT", "USDC", "DAI", "ETH", "MATIC"];
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
        console.log(`Insufficient allowance. Approving ${formatAmount(amount, 6)} for 1inch Router.`);
        const approvalTx = await requestTokenApproval(tokenAddress, formatAmount(amount, 6));
        const signedTx = await web3.eth.accounts.signTransaction(approvalTx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log("Approval Transaction Hash:", receipt.transactionHash);
    }
}

// Fetch swap data
async function getSwapData(fromToken, toToken, amount, slippage) {
    const url = apiRequestUrl("/swap", {
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amount: formatAmount(amount, STABLE_TOKENS.includes(fromToken) ? 6 : 18),
        fromAddress: process.env.WALLET_ADDRESS,
        slippage: slippage,
        disableEstimate: false
    });

    try {
        const response = await axios.get(url, { headers: HEADERS });
        return response.data.tx.data;  // Returns calldata for 1inch swap
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
    for (const token of stableTokens) {
        permute([token]);
    }

    return routes;
}



// Function to evaluate the profitability of a given route
async function evaluateRouteProfit(route) {
    let amountIn = CAPITAL;

    for (let i = 0; i < route.length - 1; i++) {
        const fromToken = route[i];
        const toToken = route[i + 1];
        
        // Attempt to get the swap quote for each hop in the route
        try {
            amountIn = await getSwapQuote(fromToken, toToken, amountIn);
            
            // Check if swap quote returned a valid output amount
            if (amountIn.isZero()) {
                console.log(`Route ${route} failed at hop ${fromToken} -> ${toToken}: received zero amount.`);
                return new BigNumber(0);  // Exit if any hop fails or returns zero
            }
            
            // Log the amount after each successful hop for debugging
            console.log(`Hop ${fromToken} -> ${toToken}: amount after swap = ${amountIn.dividedBy(1e6).toFixed(2)} (USD equivalent)`);
            
        } catch (error) {
            console.error(`Error fetching quote for hop ${fromToken} -> ${toToken} in route ${route}:`, error);
            return new BigNumber(0);  // Exit if there’s an error in any hop
        }
    }

    // Calculate and return the profit after the final output
    const profit = amountIn.minus(CAPITAL);
    console.log(`Final profit for route ${route}: $${profit.dividedBy(1e6).toFixed(2)}`);
    
    return profit;
}

function formatAmount(amount, decimals) {
    return new BigNumber(amount).toFixed(decimals);
}

// Get a swap quote for a single hop with retry logic
async function getSwapQuote(fromToken, toToken, amount, retries = 3) {
    const tokenDecimals = STABLE_TOKENS.includes(fromToken) || STABLE_TOKENS.includes(toToken) ? 6 : 18;
    const formattedAmount = formatAmount(amount, tokenDecimals);

    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/quote`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                amount: formattedAmount,
                disableEstimate: false
            }
        });
        return new BigNumber(response.data.toTokenAmount);
    } catch (error) {
        if (retries > 0) {
            console.warn(`Retrying getSwapQuote for ${fromToken} to ${toToken}. Retries left: ${retries - 1}`);
            return getSwapQuote(fromToken, toToken, amount, retries - 1);
        } else {
            const errorMessage = `Error fetching quote for ${fromToken} to ${toToken}: ${error}`;
            console.error(errorMessage);
            await sendTelegramMessage(errorMessage);  // Notify error
            return new BigNumber(0);
        }
    }
}

// Execute the best profitable route found
// Function to execute the profitable route using flash loan and swap
async function executeRoute(route, profit) {
    try {
        // Initial token in the route
        const initialToken = route[0];
        
        // Encode swap data with a slippage tolerance of 0.5%
        const routeData = await encodeSwapData(route, CAPITAL, 0.5);
        
        // Log and send notification about the route and expected profit
        const profitMessage = `Executing route: ${route} with expected profit of $${profit.dividedBy(1e6).toFixed(2)}`;
        console.log(profitMessage);
        await sendTelegramMessage(profitMessage);
        
        // Initiate flash loan and perform swap
        await initiateFlashLoan(initialToken, CAPITAL, routeData);

    } catch (error) {
        console.error("Error executing route:", error);

        // Optionally send an error notification to Telegram
        const errorMessage = `Error executing route ${route}: ${error.message}`;
        await sendTelegramMessage(errorMessage);
    }
}


// Encode the swap data for route with adjustable slippage
// Helper function to encode calldata for a multi-hop route using 1inch API
async function encodeSwapData(route, amount, slippagePercent) {
    const fromToken = route[0];  // Initial token in the route
    const toToken = route[route.length - 1];  // Final token in the route

    // Determine token decimals for formatting amount
    const tokenDecimals = STABLE_TOKENS.includes(fromToken) ? 6 : 18;
    const formattedAmount = formatAmount(amount, tokenDecimals);  // Format amount with correct decimals

    // Call 1inch swap API to get swap data
    try {
        const response = await axios.get(`${API_BASE_URL}/swap`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                amount: formattedAmount,
                fromAddress: process.env.WALLET_ADDRESS,
                slippage: slippagePercent,
                disableEstimate: false,
                allowPartialFill: false  // Ensure full swaps only
            }
        });

        return response.data.tx.data;  // Returns calldata to perform the multi-hop swap on 1inch
    } catch (error) {
        console.error("Error fetching swap data:", error);
        throw error;
    }
}


// Initiate flash loan through Solidity contract to execute trade
// Function to initiate a flash loan and execute swap via the contract
async function initiateFlashLoan(asset, amount, routeData) {
    // Determine token decimals for `amount` formatting
    const tokenDecimals = STABLE_TOKENS.includes(asset) ? 6 : 18;
    const formattedAmount = formatAmount(amount, tokenDecimals);  // Format amount for flash loan

    // Step 1: Approve token if needed
    await approveTokenIfNeeded(asset, amount);

    try {
        // Step 2: Encode calldata to request flash loan and initiate swap
        const txData = contract.methods.fn_RequestFlashLoan(asset, formattedAmount, routeData).encodeABI();

        // Step 3: Estimate gas and fetch optimal gas price
        const gasEstimate = await web3.eth.estimateGas({
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txData
        });

        const gasPrice = await getOptimalGasPrice(new BigNumber(50).multipliedBy(1e9));  // Limit gas price to 50 Gwei

        // Check if the gas price is acceptable
        if (!gasPrice) {
            console.log("Gas price too high; skipping execution.");
            return;
        }

        // Step 4: Create transaction
        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txData,
            gas: gasEstimate,
            gasPrice: gasPrice.toFixed()
        };

        // Step 5: Sign and send transaction
        const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log("Flash loan and trade executed, transaction receipt:", receipt);

    } catch (error) {
        console.error("Error executing flash loan:", error);
    }
}

// Fetch current gas price with a maximum threshold
async function getOptimalGasPrice(maxGasPriceInWei) {
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
