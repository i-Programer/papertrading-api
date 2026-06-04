import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws'; // Import WS features
import { createServer } from 'http';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

app.get('/api/candles', async (req, res) => {
    try {
        const { product_id, granularity, start, end } = req.query;
        const targetUrl = `https://api.exchange.coinbase.com/products/${product_id || 'BTC-USD'}/candles`;
        const response = await axios.get(targetUrl, {
            params: { granularity, start, end },
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Proxy endpoint for full asset pairs list
app.get('/api/products', async (req, res) => {
    try {
        const targetUrl = 'https://api.exchange.coinbase.com/products';
        
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });

        // Relay the complete raw product array back to your Next.js sidebar
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching market products:', error.message);
        res.status(error.response?.status || 500).json({
            error: 'Failed fetching markets from Coinbase',
            details: error.message
        });
    }
});

// 1. Wrap the Express app inside a standard HTTP server
const server = createServer(app);

// 2. Create a WebSocket server attached to our Render server instance
const wss = new WebSocketServer({ server });

wss.on('connection', (wsToFrontend) => {
    console.log('Frontend client connected to proxy WebSocket');

    // Open a parallel connection directly to Coinbase from the Render server
    const coinbaseWs = new WebSocket('wss://ws-feed.exchange.coinbase.com');

    wsToFrontend.on('message', (message) => {
        if (coinbaseWs.readyState === WebSocket.OPEN) {
            coinbaseWs.send(message.toString());
        } else {
            // Wait for it to open, then send
            coinbaseWs.once('open', () => coinbaseWs.send(message.toString()));
        }
    });

    // Forward live tickers from Coinbase -> React Frontend
    coinbaseWs.on('message', (data) => {
        if (wsToFrontend.readyState === WebSocket.OPEN) {
            wsToFrontend.send(data.toString());
        }
    });

    // Clean up connections if someone closes the tab
    wsToFrontend.on('close', () => {
        coinbaseWs.close();
        console.log('Frontend client disconnected');
    });

    coinbaseWs.on('close', () => {
        wsToFrontend.close();
    });
    
    coinbaseWs.on('error', (err) => console.error('Coinbase WS Error:', err));
});

// 3. Make sure to listen on the HTTP wrapper server, NOT the app instance
server.listen(PORT, () => {
    console.log(`Proxy backend running on port ${PORT}`);
});