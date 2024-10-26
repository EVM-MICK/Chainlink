const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // To sign the requests
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const BINANCE_API_URL = 'https://api.binance.com';
const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3';

// Function to generate a signature for Binance API
function generateSignature(queryString, secretKey) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(queryString)
    .digest('hex');
}

// Main POST endpoint for Chainlink requests
app.post('/', async (req, res) => {
  const jobId = req.body.id;
  const data = req.body.data;

  // Extract API keys from the Chainlink request
  const apiKey = data.binanceAPIKey;
  const secretKey = data.binanceSecretKey;

  try {
    // Step 1: Fetch tradable tokens and their liquidity from Binance
    const binanceResponse = await axios.get(`${BINANCE_API_URL}/api/v3/ticker/24hr`);
    const binanceTokens = binanceResponse.data;

    // Step 2: Cross-reference with CoinGecko for Ethereum mainnet token addresses
    const ethTokens = await filterEthereumTokens(binanceTokens);

    // Step 3: Process tokens and return a list of tokens with liquidity and addresses
    const processedTokens = ethTokens.map((token) => ({
      symbol: token.symbol,
      liquidity: token.quoteVolume,
      address: token.address
    }));

    // Step 4: Send the response back to the Chainlink node
    const response = {
      jobRunID: jobId,
      data: { tokens: processedTokens },
      result: processedTokens,
      statusCode: 200
    };
    res.status(200).send(response);
  } catch (error) {
    console.error(`Error processing Chainlink request: ${error.message}`);
    const response = {
      jobRunID: jobId,
      status: 'errored',
      error: error.message,
      statusCode: 500
    };
    res.status(500).send(response);
  }
});

// Function to cross-reference Binance tokens with CoinGecko to get Ethereum addresses
async function filterEthereumTokens(binanceTokens) {
  const ethTokens = [];

  for (const token of binanceTokens) {
    try {
      // Use CoinGecko to get Ethereum token address for each token symbol
      const coingeckoResponse = await axios.get(`${COINGECKO_API_URL}/coins/ethereum/contract/${token.symbol}`);
      const ethTokenData = coingeckoResponse.data;

      // Add Ethereum token address and liquidity to the array
      ethTokens.push({
        symbol: token.symbol,
        quoteVolume: token.quoteVolume, // Example of liquidity
        address: ethTokenData.contract_address
      });
    } catch (error) {
      console.error(`Error fetching token data from CoinGecko for ${token.symbol}: ${error.message}`);
    }
  }

  return ethTokens;
}

app.post('/', async (req, res) => {
  const jobId = req.body.id;
  const { tokenIn, tokenOut, amount, binanceAPIKey, binanceSecretKey } = req.body.data;

  try {
    // Binance price fetch
    const priceUrl = `${BINANCE_API_URL}/api/v3/ticker/price?symbol=${tokenIn}${tokenOut}`;
    const priceResponse = await axios.get(priceUrl);
    const binancePrice = priceResponse.data.price;

    // Binance trade execution
    const tradeResult = await triggerCEXTrade(tokenIn, tokenOut, amount, binanceAPIKey, binanceSecretKey);
    const response = { jobRunID: jobId, data: { status: tradeResult.status }, statusCode: 200 };
    res.status(200).send(response);
  } catch (error) {
    res.status(500).send({ jobRunID: jobId, error: error.message });
  }
});

// Binance trade execution
async function triggerCEXTrade(tokenIn, tokenOut, amount, apiKey, secretKey) {
  const timestamp = Date.now();
  const params = `symbol=${tokenIn}${tokenOut}&side=BUY&type=MARKET&quantity=${amount}&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', secretKey).update(params).digest('hex');

  try {
    const tradeResponse = await axios.post(`${BINANCE_API_URL}/api/v3/order?${params}&signature=${signature}`, {}, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    return { status: 'trade_success', orderId: tradeResponse.data.orderId };
  } catch (error) {
    return { status: 'trade_failed', error: error.message };
  }
}


app.listen(PORT, () => {
  console.log(`Chainlink External Adapter listening on port ${PORT}`);
});

module.exports = app;
