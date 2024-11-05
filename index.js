require('dotenv').config();
const axios = require('axios');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const winston = require('winston');  // For structured logging

// Load environment variables
const ABI = require('./YourSmartContractABI.json');
const web3 = new Web3(process.env.INFURA_URL);
const CAPITAL = new BigNumber(process.env.CAPITAL || 100000 * 1e6); // USDT with 6 decimals
const TARGET_PROFIT = new BigNumber(process.env.TARGET_PROFIT || 1500 * 1e6);
const API_KEY = process.env.ONEINCH_API_KEY;
const HEADERS = { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' };
const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/137";
const FUSION_API_URL = "https://fusion.1inch.io/v6.0/137";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);


// Logger Configuration for debugging and monitoring
const logger = winston.createLogger({
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'arbitrage.log' })
    ]
});

// Primary Function to Manage Hybrid Arbitrage
async function findAndExecuteArbitrage() {
    try {
        const { bestRoute, bestOutput } = await getOptimalSwapPath();
        if (!bestRoute) {
            logger.info("No profitable route found.");
            return;
        }

        const expectedProfit = bestOutput.minus(CAPITAL);

        // Check and approve allowance if needed
        const allowance = await checkAllowance(bestRoute[0], process.env.WALLET_ADDRESS);
        if (allowance.isLessThan(CAPITAL)) {
            logger.info("Router lacks allowance, creating approval transaction...");
            await approveRouter(bestRoute[0], CAPITAL);
        }

        // Dynamic gas price retrieval
        const gasPrice = await getGasPrice();
        const estimatedGasCost = gasPrice.multipliedBy(2000000); // Estimated gas
        const netProfit = expectedProfit.minus(estimatedGasCost);

        if (netProfit.isGreaterThanOrEqualTo(TARGET_PROFIT)) {
            logger.info("Profitable opportunity found. Initiating flash loan and swap...");
            const routeData = await encode1InchSwapData(bestRoute, CAPITAL);
            await initiateFlashLoan(bestRoute[0], CAPITAL, routeData);
        } else {
            logger.info("Not profitable after gas costs.");
        }
    } catch (error) {
        logger.error(`Error in arbitrage execution: ${error}`);
    }
}

// Function to call the contract to initiate flash loan and execute trade
async function initiateFlashLoan(asset, amount, routeData) {
    try {
        const txData = contract.methods.fn_RequestFlashLoan(asset, amount.toFixed(), routeData).encodeABI();

        const tx = {
            from: process.env.WALLET_ADDRESS,
            to: CONTRACT_ADDRESS,
            data: txData,
            gas: 3000000,
            gasPrice: await getGasPrice().toFixed(),
        };

        const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        logger.info("Flash loan and trade executed, transaction receipt:", receipt);
    } catch (error) {
        logger.error("Error initiating flash loan and executing trade:", error);
    }
}


// Retrieve the full list of tokens on Polygon supported by 1inch
async function getTokenList() {
    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/tokens`, { headers: HEADERS });
        return Object.keys(response.data.tokens);
    } catch (error) {
        logger.error("Error fetching token list:", error);
        throw error;
    }
}

// Function to get optimal path by evaluating token pairs
async function getOptimalSwapPath() {
    const tokens = await getTokenList();
    let bestRoute = null;
    let bestOutput = CAPITAL;

    await Promise.all(tokens.map(async (tokenA, i) => {
        for (let j = i + 1; j < tokens.length; j++) {
            const tokenB = tokens[j];
            const route = [tokenA, tokenB];
            const outputAmount = await getMultiHopQuote(route, CAPITAL);
            const expectedProfit = outputAmount.minus(CAPITAL);

            if (expectedProfit.isGreaterThan(TARGET_PROFIT) && outputAmount.isGreaterThan(bestOutput)) {
                bestOutput = outputAmount;
                bestRoute = route;
                logger.info(`New best route found: ${route} with profit: ${expectedProfit.toFixed()}`);
            }
        }
    }));

    return { bestRoute, bestOutput };
}

// Helper function to encode the 1inch swap data
async function encode1InchSwapData(route, amount) {
    try {
        const swapData = await axios.get(`${PATHFINDER_API_URL}/swap`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: route[0],
                toTokenAddress: route[route.length - 1],
                amount: amount.toFixed(),
                fromAddress: process.env.WALLET_ADDRESS,
                slippage: 1,
                disableEstimate: false
            }
        });
        return swapData.data.tx.data;
    } catch (error) {
        logger.error("Error encoding swap data:", error);
        throw error;
    }
}

// Simulate multi-hop quotes
async function getMultiHopQuote(tokens, amount) {
    let currentAmount = amount;
    for (let i = 0; i < tokens.length - 1; i++) {
        const fromToken = tokens[i];
        const toToken = tokens[i + 1];

        const outputAmount = await getQuote(fromToken, toToken, currentAmount);
        if (outputAmount.isEqualTo(0)) {
            logger.warn(`No liquidity for ${fromToken} to ${toToken}`);
            return new BigNumber(0);
        }

        currentAmount = outputAmount;
    }
    return currentAmount;
}

// Get quote for a token pair
async function getQuote(fromToken, toToken, amount) {
    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/quote`, {
            headers: HEADERS,
            params: {
                fromTokenAddress: fromToken,
                toTokenAddress: toToken,
                amount: amount.toFixed(),
                disableEstimate: false
            }
        });
        return new BigNumber(response.data.toTokenAmount);
    } catch (error) {
        logger.error(`Error fetching quote for ${fromToken} to ${toToken}:`, error);
        return new BigNumber(0);
    }
}


// Check allowance for the 1inch Router
async function checkAllowance(tokenAddress, walletAddress) {
    try {
        const response = await axios.get(`${PATHFINDER_API_URL}/approve/allowance`, {
            headers: HEADERS,
            params: { tokenAddress, walletAddress }
        });
        return new BigNumber(response.data.allowance);
    } catch (error) {
        logger.error("Error checking allowance:", error);
        throw error;
    }
}


// Approve 1inch router if allowance is insufficient
async function approveRouter(tokenAddress, amount) {
    try {
        const approvalData = await axios.get(`${PATHFINDER_API_URL}/approve/transaction`, {
            headers: HEADERS,
            params: { tokenAddress, amount }
        });

        const approveTx = {
            ...approvalData.data,
            from: process.env.WALLET_ADDRESS,
            gas: await web3.eth.estimateGas({ ...approvalData.data, from: process.env.WALLET_ADDRESS })
        };

        const signedApproveTx = await web3.eth.accounts.signTransaction(approveTx, process.env.PRIVATE_KEY);
        const receipt = await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);
        logger.info("Approval transaction receipt:", receipt);
    } catch (error) {
        logger.error("Error during approval transaction:", error);
    }
}


// Execute swap using Pathfinder for high-frequency, immediate arbitrage
async function executeSwap(route) {
    const swapData = await axios.get(`${PATHFINDER_API_URL}/swap`, {
        headers: HEADERS,
        params: {
            fromTokenAddress: route[0],
            toTokenAddress: route[route.length - 1],
            amount: CAPITAL.toFixed(),
            fromAddress: process.env.WALLET_ADDRESS,
            slippage: 1,  // Set appropriate slippage
            disableEstimate: false
        }
    });

    const swapTx = {
        ...swapData.data.tx,
        gas: await web3.eth.estimateGas({ ...swapData.data.tx, from: process.env.WALLET_ADDRESS })
    };

    const signedSwapTx = await web3.eth.accounts.signTransaction(swapTx, process.env.PRIVATE_KEY);
    return await web3.eth.sendSignedTransaction(signedSwapTx.rawTransaction);
}

// Place Fusion intent order for cost-saving, lower-frequency arbitrage
async function placeFusionIntent(route, expectedProfit) {
    try {
        const fusionOrder = {
            fromTokenAddress: route[0],
            toTokenAddress: route[route.length - 1],
            amount: CAPITAL.toFixed(),
            minReturnAmount: expectedProfit.toFixed(),
            gasPrice: "0",
            gasLimit: 2000000,
            allowPartialFill: false,
            parts: 1,
            mainRouteParts: 1,
            complexityLevel: 1,
        };

        const response = await axios.post(`${FUSION_API_URL}/swap`, fusionOrder, { headers: HEADERS });
        console.log("Fusion intent order placed successfully:", response.data);
    } catch (error) {
        console.error("Error placing Fusion intent order:", error);
    }
}

// Fetch current gas price from Polygon Gas Station API
async function getGasPrice() {
    try {
        const response = await axios.get("https://gasstation-mainnet.matic.network/v2");
        const gasPrice = response.data.fast.maxFee;
        return new BigNumber(web3.utils.toWei(gasPrice.toString(), 'gwei'));
    } catch (error) {
        logger.warn("Failed to fetch gas price from Polygon Gas Station. Using default gas price.");
        return new BigNumber(web3.utils.toWei('100', 'gwei'));  // Default to 100 gwei if API fails
    }
}

// Run Hybrid Arbitrage
(async () => {
    await findAndExecuteArbitrage();
})();
