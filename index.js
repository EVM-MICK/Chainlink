require('dotenv').config();
const axios = require('axios');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

const ABI = require('./YourSmartContractABI.json'); // ABI of the Solidity contract
const web3 = new Web3(process.env.INFURA_URL);  // Ensure this is Polygon-compatible

const CAPITAL = new BigNumber(100000 * 1e6);  // USDT with 6 decimals on Polygon
const TARGET_PROFIT = new BigNumber(1500 * 1e6);  // Minimum $1,500 profit in USDT
const API_KEY = process.env.ONEINCH_API_KEY;
const HEADERS = { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' };

const PATHFINDER_API_URL = "https://api.1inch.dev/swap/v6.0/137";
const FUSION_API_URL = "https://fusion.1inch.io/v6.0/137";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  // Address of the deployed Solidity contract
// Instantiate the contract
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);

// Primary Function to Manage Hybrid Arbitrage
async function findAndExecuteArbitrage() {
    // Step 1: Get optimal swap path
    const { bestRoute, bestOutput } = await getOptimalSwapPath();
    const expectedProfit = bestOutput.minus(CAPITAL);

    console.log(`Best expected profit: ${expectedProfit.toFixed()} (target: ${TARGET_PROFIT.toFixed()})`);

    if (bestRoute) {
        // Step 2: Check allowance for the 1inch router
        const allowance = await checkAllowance(bestRoute[0], process.env.WALLET_ADDRESS);
        if (allowance.isLessThan(CAPITAL)) {
            console.log("Router lacks allowance, creating approval transaction...");
            await approveRouter(bestRoute[0], CAPITAL);
        }

        // Step 3: Evaluate gas and initiate flash loan if profitable
        const gasPrice = await getGasPrice();
        const estimatedGasCost = gasPrice.multipliedBy(2000000); // Estimated gas cost for transaction
        const netProfit = expectedProfit.minus(estimatedGasCost);

       if (netProfit.isGreaterThanOrEqualTo(TARGET_PROFIT)) {
    console.log("Profitable opportunity found. Initiating flash loan and swap...");

    // Encode 1inch swap data for `routeData`
    const routeData = await encode1InchSwapData(bestRoute, CAPITAL);

    // Initiate flash loan and execute swap
    await initiateFlashLoan(bestRoute[0], CAPITAL, routeData);
}
 else {
            console.log("Not profitable after gas costs.");
        }
    } else {
        console.log("No profitable route found.");
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
        console.log("Flash loan and trade executed, transaction receipt:", receipt);
    } catch (error) {
        console.error("Error initiating flash loan and executing trade:", error);
    }
}


// Retrieve the full list of tokens on Polygon supported by 1inch
async function getTokenList() {
    const response = await axios.get(`${PATHFINDER_API_URL}/tokens`, { headers: HEADERS });
    return Object.keys(response.data.tokens);  // Return an array of token addresses
}

// Function to get optimal path by evaluating token pairs
async function getOptimalSwapPath() {
    const tokens = await getTokenList();
    let bestRoute = null;
    let bestOutput = CAPITAL;

    for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
            const route = [tokens[i], tokens[j]];
            const outputAmount = await getMultiHopQuote(route, CAPITAL);
            const expectedProfit = outputAmount.minus(CAPITAL);

            if (expectedProfit.isGreaterThan(TARGET_PROFIT) && outputAmount.isGreaterThan(bestOutput)) {
                bestOutput = outputAmount;
                bestRoute = route;
            }
        }
    }

    return { bestRoute, bestOutput };
}


// Helper function to encode the 1inch swap data
async function encode1InchSwapData(route, amount) {
    const swapData = await axios.get(`${PATHFINDER_API_URL}/swap`, {
        headers: HEADERS,
        params: {
            fromTokenAddress: route[0],
            toTokenAddress: route[route.length - 1],
            amount: amount.toFixed(),
            fromAddress: process.env.WALLET_ADDRESS,
            slippage: 1,  // Set appropriate slippage
            disableEstimate: false
        }
    });

    return swapData.data.tx.data;  // Returns the encoded calldata for 1inch
}


// Simulate multi-hop quotes
async function getMultiHopQuote(tokens, amount) {
    let currentAmount = amount;
    for (let i = 0; i < tokens.length - 1; i++) {
        const fromToken = tokens[i];
        const toToken = tokens[i + 1];

        const outputAmount = await getQuote(fromToken, toToken, currentAmount);
        if (outputAmount.isEqualTo(0)) {
            console.log(`No liquidity for ${fromToken} to ${toToken}`);
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
        console.error(`Error fetching quote for ${fromToken} to ${toToken}:`, error);
        return new BigNumber(0);
    }
}


// Check allowance for the 1inch Router
async function checkAllowance(tokenAddress, walletAddress) {
    const response = await axios.get(`${PATHFINDER_API_URL}/approve/allowance`, {
        headers: HEADERS,
        params: { tokenAddress, walletAddress }
    });
    return new BigNumber(response.data.allowance);
}

// Approve 1inch router if allowance is insufficient
async function approveRouter(tokenAddress, amount) {
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
    console.log("Approval transaction receipt:", receipt);
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
    const response = await axios.get("https://gasstation-mainnet.matic.network/v2");
    const gasPrice = response.data.fast.maxFee;  // Using the fast gas price
    return new BigNumber(web3.utils.toWei(gasPrice.toString(), 'gwei'));
}

// Run Hybrid Arbitrage
(async () => {
    await findAndExecuteArbitrage();
})();
