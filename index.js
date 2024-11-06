require('dotenv').config();
const axios = require('axios');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

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
const MAX_HOPS = 3;

// Contract configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Your deployed contract address
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);

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
async function findProfitableRoutes() {
    const tokens = await getStableTokenList();
    const allRoutes = generateRoutes(tokens, MAX_HOPS);
    const profitableRoutes = [];

    // Evaluate routes in parallel using Promise.all for speed
    const routePromises = allRoutes.map(async route => {
        const profit = await evaluateRouteProfit(route);
        if (profit.isGreaterThanOrEqualTo(PROFIT_THRESHOLD)) {
            console.log(`Profitable route found: ${route} with profit: $${profit.dividedBy(1e6).toFixed(2)}`);
            const message = `Profitable route found: ${route} with profit: $${profit.dividedBy(1e6).toFixed(2)}`;
            console.log(message);
            await sendTelegramMessage(message);  // Send notification
            return { route, profit };
        }
        return null;
    });

    // Filter out null results and return profitable routes
    const results = await Promise.all(routePromises);
    return results.filter(route => route !== null);
}

// Get stable, high-liquidity tokens to focus on profitable paths
async function getStableTokenList() {
    const response = await axios.get(`${PATHFINDER_API_URL}/tokens`, { headers: HEADERS });
    const tokens = Object.keys(response.data.tokens).filter(token => STABLE_TOKENS.includes(response.data.tokens[token].symbol));
    return tokens;
}

// Generate all possible routes within max hops limit
function generateRoutes(tokens, maxHops) {
    const routes = [];

    function permute(path) {
        if (path.length > 1 && path.length <= maxHops) {
            routes.push([...path]);
        }
        if (path.length < maxHops) {
            for (const token of tokens) {
                if (!path.includes(token) && STABLE_TOKENS.includes(token)) { // Only allow stable, liquid tokens
                    path.push(token);
                    permute(path);
                    path.pop();
                }
            }
        }
    }

    for (const token of tokens) {
        permute([token]);
    }

    return routes;
}

// Evaluate profit for a given route
async function evaluateRouteProfit(route) {
    let amountIn = CAPITAL;

    for (let i = 0; i < route.length - 1; i++) {
        const fromToken = route[i];
        const toToken = route[i + 1];
        amountIn = await getSwapQuote(fromToken, toToken, amountIn);
        if (amountIn.isZero()) {
            return new BigNumber(0);  // Exit if any hop fails or returns zero
        }
    }

    return amountIn.minus(CAPITAL);  // Calculate profit after final output
}

// Get a swap quote for a single hop with retry logic
// Function to format amount based on token decimals
function formatAmount(amount, decimals) {
    return amount.toFixed(decimals);
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
async function executeRoute(route, profit) {
    try {
        const initialToken = route[0];
        const routeData = await encodeSwapData(route, CAPITAL, 0.5);
        console.log(`Executing route: ${route} with expected profit of $${profit.dividedBy(1e6).toFixed(2)}`);
        console.log(`Executing route: ${route} with expected profit of $${profit.dividedBy(1e6).toFixed(2)}`);
       await sendTelegramMessage(`Executing route: ${route} with expected profit of $${profit.dividedBy(1e6).toFixed(2)}`);  // Notify execution
        await initiateFlashLoan(initialToken, CAPITAL, routeData);
        
    } catch (error) {
        console.error("Error executing route:", error);
    }
}


// Encode the swap data for route with adjustable slippage
async function encodeSwapData(route, amount, slippagePercent) {
    const formattedAmount1 = formatAmount(amount, tokenDecimals);
    const swapData = await axios.get(`${PATHFINDER_API_URL}/swap`, {
        headers: HEADERS,
        params: {
            fromTokenAddress: route[0],
            toTokenAddress: route[route.length - 1],
            amount: formattedAmount1,
            fromAddress: process.env.WALLET_ADDRESS,
            slippage: slippagePercent,
            disableEstimate: false
        }
    });
    return swapData.data.tx.data;  // Returns the encoded calldata for 1inch
}

// Initiate flash loan through Solidity contract to execute trade
async function initiateFlashLoan(asset, amount, routeData) {
     const formattedAmount2 = formatAmount(amount, tokenDecimals);
    try {
        const txData = contract.methods.fn_RequestFlashLoan(asset, formattedAmount2, routeData).encodeABI();
        const gasEstimate = await web3.eth.estimateGas({ from: process.env.WALLET_ADDRESS, to: CONTRACT_ADDRESS, data: txData });
        const gasPrice = await getOptimalGasPrice(new BigNumber(50).multipliedBy(1e9));  // 50 Gwei max gas price

        if (!gasPrice) {
            console.log("Gas price too high; skipping execution.");
            return;
        }

        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txData,
            gas: gasEstimate,
            gasPrice: gasPrice.toFixed()
        };

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
