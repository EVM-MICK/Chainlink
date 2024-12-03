import dotenv from 'dotenv';
import axios from 'axios';
import Web3 from 'web3';
import BigNumber from 'bignumber.js';
import { runArbitrageBot } from '../index.mjs'; // Adjust import based on file location.

dotenv.config();

export default async function handler(req, res) {
    if (req.method === 'POST') {
        try {
            // Trigger the arbitrage bot asynchronously
            runArbitrageBot();
            res.status(200).json({ success: true, message: 'Arbitrage bot started in the background.' });
        } catch (error) {
            console.error('Error starting arbitrage bot:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        res.status(405).json({ error: 'Method not allowed. Use POST to start the bot.' });
    }
}
