import { runArbitrageBot } from '../index.mjs';

export default async function handler(req, res) {
    if (req.method === 'POST') {
        try {
            // Call the arbitrage bot
            await runArbitrageBot();
            res.status(200).json({ message: "Arbitrage bot started in the background." });
        } catch (error) {
            console.error("Error starting arbitrage bot:", error);
            res.status(500).json({ error: "Failed to start arbitrage bot." });
        }
    } else {
        res.setHeader('Allow', ['POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}
