//backend-api index.js

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// Simple in-memory rate limiting cache (consider Redis for production)
const rateLimitCache = new Map();

// Clean up old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of rateLimitCache.entries()) {
    if (now - timestamp > 5000) { // Remove after 5 seconds
      rateLimitCache.delete(key);
    }
  }
}, 60000);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Initialize Supabase on backend only (environment variables stay on server)
const supabaseBackend = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Use SERVICE_ROLE_KEY, NOT anon key!
);

// Helper to verify Clerk user from request headers
async function verifyClerkUser(req) {
  const clerkUserId = req.headers['x-clerk-user-id'];
  if (!clerkUserId) {
    throw new Error('Unauthorized: No user ID provided');
  }
  return clerkUserId;
}

// GET /api/profile - Fetch user profile, balance, positions, trade history
app.get('/api/profile', async (req, res) => {
  try {
    const clerkUserId = await verifyClerkUser(req);
    
    // Fetch profile
    const { data: profile } = await supabaseBackend
      .from('profiles')
      .select('*')
      .eq('id', clerkUserId)
      .single();
    
    // Fetch positions
    const { data: positions } = await supabaseBackend
      .from('positions')
      .select('*')
      .eq('user_id', clerkUserId);
    
    // Fetch trade history (last 100)
    const { data: tradeHistory } = await supabaseBackend
      .from('trade_history')
      .select('*')
      .eq('user_id', clerkUserId)
      .order('timestamp', { ascending: false })
      .limit(100);
    
    res.json({
      profile: profile || null,
      balance: {
        cash: profile?.cash || 100000,
        equity: profile?.equity || 100000,
      },
      positions: positions || [],
      tradeHistory: tradeHistory || [],
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(401).json({ error: error.message });
  }
});

// POST /api/profile/sync - Create/update user profile
app.post('/api/profile/sync', async (req, res) => {
  try {
    const clerkUserId = await verifyClerkUser(req);
    const { name, email } = req.body;
    
    const { data, error } = await supabaseBackend
      .from('profiles')
      .upsert(
        { id: clerkUserId, name, email },
        { onConflict: 'id' }
      )
      .select()
      .single();
    
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch (error) {
    console.error('Profile sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/trade/execute - Execute a trade (server-side validation)
app.post('/api/trade/execute', async (req, res) => {
  try {
    const clerkUserId = await verifyClerkUser(req);
    const { symbol, side, quantity, price } = req.body;
    
    // VALIDATION (critical security checks)
    if (!symbol || !side || !quantity || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (quantity <= 0 || price <= 0) {
      return res.status(400).json({ error: 'Invalid quantity or price' });
    }
    
    if (side !== 'BUY' && side !== 'SELL') {
      return res.status(400).json({ error: 'Invalid side' });
    }
    
    // Rate limiting (server-side)
    const rateLimitKey = `trade:${clerkUserId}`;
    const lastTrade = rateLimitCache.get(rateLimitKey);
    const now = Date.now();
    if (lastTrade && (now - lastTrade) < 1000) {
      return res.status(429).json({ 
        error: `Rate limit exceeded. Please wait ${((1000 - (now - lastTrade)) / 1000).toFixed(1)} seconds` 
      });
    }
    rateLimitCache.set(rateLimitKey, now);
    
    // Fetch current user state
    const { data: profile } = await supabaseBackend
      .from('profiles')
      .select('cash, equity')
      .eq('id', clerkUserId)
      .single();
    
    const currentCash = profile?.cash || 100000;
    const totalCost = quantity * price;
    
    // Validate sufficient funds/crypto
    if (side === 'BUY' && currentCash < totalCost) {
      return res.status(400).json({ 
        error: `Insufficient funds. Need $${totalCost.toFixed(2)}, have $${currentCash.toFixed(2)}` 
      });
    }
    
    if (side === 'SELL') {
      const { data: position } = await supabaseBackend
        .from('positions')
        .select('quantity')
        .eq('user_id', clerkUserId)
        .eq('symbol', symbol)
        .single();
      
      const currentQty = position?.quantity || 0;
      if (currentQty < quantity) {
        return res.status(400).json({ 
          error: `Insufficient ${symbol}. You have ${currentQty}, trying to sell ${quantity}` 
        });
      }
    }
    
    // Execute transaction (use Supabase transaction or manual steps)
    const newCash = side === 'BUY' ? currentCash - totalCost : currentCash + totalCost;
    
    // 1. Insert trade history
    const { error: historyError } = await supabaseBackend
      .from('trade_history')
      .insert({
        user_id: clerkUserId,
        symbol,
        side,
        quantity,
        price,
        timestamp: new Date().toISOString(),
      });
    
    if (historyError) throw historyError;
    
    // 2. Update position
    if (side === 'BUY') {
      await supabaseBackend
        .from('positions')
        .upsert(
          {
            user_id: clerkUserId,
            symbol,
            side: 'BUY',
            quantity,
            entry_price: price,
          },
          { onConflict: 'user_id,symbol' }
        );
    } else {
      // SELL - get current position
      const { data: currentPos } = await supabaseBackend
        .from('positions')
        .select('quantity, entry_price')
        .eq('user_id', clerkUserId)
        .eq('symbol', symbol)
        .single();
      
      const newQty = currentPos.quantity - quantity;
      
      if (newQty <= 0) {
        // Delete position
        await supabaseBackend
          .from('positions')
          .delete()
          .eq('user_id', clerkUserId)
          .eq('symbol', symbol);
      } else {
        // Update quantity
        await supabaseBackend
          .from('positions')
          .update({ quantity: newQty })
          .eq('user_id', clerkUserId)
          .eq('symbol', symbol);
      }
    }
    
    // 3. Update profile cash
    const { error: profileError } = await supabaseBackend
      .from('profiles')
      .update({ cash: newCash, equity: newCash })
      .eq('id', clerkUserId);
    
    if (profileError) throw profileError;
    
    // In backend-api/index.js, inside POST /api/trade/execute

    // After updating the database, before sending response:
    const { data: updatedPositions } = await supabaseBackend
    .from('positions')
    .select('*')
    .eq('user_id', clerkUserId);

    const { data: updatedHistory } = await supabaseBackend
    .from('trade_history')
    .select('*')
    .eq('user_id', clerkUserId)
    .order('timestamp', { ascending: false })
    .limit(50);

    console.log("=== BACKEND TRADE RESPONSE ===");
    console.log("Updated positions:", updatedPositions);
    console.log("Updated history:", updatedHistory);
    console.log("New cash:", newCash);

    res.json({
    success: true,
    newCash,
    newEquity: newCash,
    positions: updatedPositions || [],
    tradeHistory: updatedHistory || [],
    });
    
  } catch (error) {
    console.error('Trade execution error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/reset-account - Reset user account to default
app.post('/api/reset-account', async (req, res) => {
  try {
    const clerkUserId = await verifyClerkUser(req);
    
    // Reset cash in profile
    await supabaseBackend
      .from('profiles')
      .update({ cash: 100000, equity: 100000 })
      .eq('id', clerkUserId);
    
    // Delete all positions
    await supabaseBackend
      .from('positions')
      .delete()
      .eq('user_id', clerkUserId);
    
    // Optionally: keep trade history or clear it? I'll keep for transparency
    
    res.json({ success: true, message: 'Account reset to $100,000' });
  } catch (error) {
    console.error('Reset account error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get candles/klines from Binance
app.get('/api/candles', async (req, res) => {
    try {
        const { symbol, interval, startTime, endTime, limit } = req.query;
        
        const targetUrl = 'https://api.binance.com/api/v3/klines';
        
        const params = {
            symbol: symbol || 'BTCUSDT',
            interval: interval || '1h',
            limit: limit || 500
        };
        
        if (startTime) params.startTime = startTime;
        if (endTime) params.endTime = endTime;
        
        const response = await axios.get(targetUrl, {
            params,
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching klines:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get all trading pairs from Binance
app.get('/api/products', async (req, res) => {
    try {
        const targetUrl = 'https://api.binance.com/api/v3/exchangeInfo';
        
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });

        const symbols = response.data.symbols
            .filter(symbol => symbol.status === 'TRADING' && symbol.quoteAsset === 'USDT')
            .map(symbol => ({
                id: symbol.symbol,
                base_currency: symbol.baseAsset,
                quote_currency: symbol.quoteAsset,
                base_min_size: symbol.filters.find(f => f.filterType === 'LOT_SIZE')?.minQty || '0',
                base_max_size: symbol.filters.find(f => f.filterType === 'LOT_SIZE')?.maxQty || '0',
                quote_increment: symbol.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || '0',
                status: symbol.status
            }));
        
        res.json(symbols);
    } catch (error) {
        console.error('Error fetching market products:', error.message);
        res.status(error.response?.status || 500).json({
            error: 'Failed fetching markets from Binance',
            details: error.message
        });
    }
});

// Get 24hr ticker price change statistics
app.get('/api/ticker', async (req, res) => {
    try {
        const { symbol } = req.query;
        const targetUrl = 'https://api.binance.com/api/v3/ticker/24hr';
        
        const response = await axios.get(targetUrl, {
            params: symbol ? { symbol } : {},
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching ticker:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get current price for a symbol
app.get('/api/price', async (req, res) => {
    try {
        const { symbol } = req.query;
        const targetUrl = 'https://api.binance.com/api/v3/ticker/price';
        
        const response = await axios.get(targetUrl, {
            params: { symbol },
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching price:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get order book depth
app.get('/api/depth', async (req, res) => {
    try {
        const { symbol, limit = 100 } = req.query;
        const targetUrl = 'https://api.binance.com/api/v3/depth';
        
        const response = await axios.get(targetUrl, {
            params: { symbol, limit },
            headers: { 'User-Agent': 'PaperTradingProxy/1.0' }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching depth:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Wrap the Express app inside a standard HTTP server
const server = createServer(app);

// Create a WebSocket server attached to our server instance
const wss = new WebSocketServer({ server });

// Global single Binance WebSocket connection pool
let globalBinanceWs = null;
let globalSubscriptions = new Set(); // Track all active subscriptions
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let pingInterval = null;
let clientConnectionCount = 0;

// Function to create/maintain single Binance connection
function getBinanceConnection() {
    if (globalBinanceWs && (globalBinanceWs.readyState === WebSocket.OPEN || globalBinanceWs.readyState === WebSocket.CONNECTING)) {
        return globalBinanceWs;
    }

    console.log('Creating new global Binance WebSocket connection...');
    
    if (globalBinanceWs) {
        try {
            globalBinanceWs.terminate();
        } catch(e) {}
    }

    globalBinanceWs = new WebSocket('wss://stream.binance.com:9443/ws');
    
    globalBinanceWs.on('open', () => {
        console.log('Global Binance WebSocket connected');
        reconnectAttempts = 0;
        
        // Resubscribe to all active subscriptions
        if (globalSubscriptions.size > 0) {
            const subscriptionMsg = {
                method: 'SUBSCRIBE',
                params: Array.from(globalSubscriptions),
                id: Date.now()
            };
            globalBinanceWs.send(JSON.stringify(subscriptionMsg));
            console.log(`Resubscribed to ${globalSubscriptions.size} streams`);
        }
        
        // Start ping interval to keep connection alive (every 3 minutes)
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (globalBinanceWs && globalBinanceWs.readyState === WebSocket.OPEN) {
                globalBinanceWs.send(JSON.stringify({ event: 'ping' }));
            }
        }, 180000);
    });
    
    // In backend/index.js, update the Binance WebSocket message handler:

    globalBinanceWs.on('message', (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            
            // Handle Binance ping
            if (parsed.e === 'ping' || parsed.event === 'ping') {
                if (globalBinanceWs && globalBinanceWs.readyState === WebSocket.OPEN) {
                    globalBinanceWs.send(JSON.stringify({ event: 'pong' }));
                }
                return;
            }
            
            // Ensure we're forwarding ticker data properly
            if (parsed.e === '24hrTicker' || parsed.stream) {
                console.log(`[Backend] Forwarding ${parsed.s || parsed.stream} ticker data to ${wss.clients.size} clients`);
            }
            
            // Broadcast to all connected frontend clients
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data.toString());
                }
            });
        } catch (error) {
            // If not JSON, broadcast raw
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data.toString());
                }
            });
        }
    });
    
    globalBinanceWs.on('close', (code, reason) => {
        console.log(`Global Binance WebSocket closed: ${code} - ${reason}`);
        if (pingInterval) clearInterval(pingInterval);
        
        // Attempt to reconnect if not intentional
        if (clientConnectionCount > 0 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            console.log(`Reconnecting in ${delay}ms... (Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
            
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                reconnectAttempts++;
                getBinanceConnection();
            }, delay);
        }
    });
    
    globalBinanceWs.on('error', (err) => {
        console.error('Global Binance WebSocket error:', err.message);
    });
    
    return globalBinanceWs;
}

// Function to add subscriptions
function addSubscriptions(streams) {
    if (!streams || streams.length === 0) return;
    
    const newStreams = streams.filter(stream => !globalSubscriptions.has(stream));
    if (newStreams.length === 0) return;
    
    newStreams.forEach(stream => globalSubscriptions.add(stream));
    
    const binanceWs = getBinanceConnection();
    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        const subscriptionMsg = {
            method: 'SUBSCRIBE',
            params: newStreams,
            id: Date.now()
        };
        binanceWs.send(JSON.stringify(subscriptionMsg));
        console.log(`Subscribed to new streams: ${newStreams.join(', ')}`);
    } else {
        console.log('Binance connection not ready, will subscribe when connected');
    }
}

// Function to remove subscriptions (optional, for cleanup)
function removeSubscriptions(streams) {
    if (!streams || streams.length === 0) return;
    
    const streamsToRemove = streams.filter(stream => globalSubscriptions.has(stream));
    if (streamsToRemove.length === 0) return;
    
    streamsToRemove.forEach(stream => globalSubscriptions.delete(stream));
    
    const binanceWs = getBinanceConnection();
    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        const unsubscriptionMsg = {
            method: 'UNSUBSCRIBE',
            params: streamsToRemove,
            id: Date.now()
        };
        binanceWs.send(JSON.stringify(unsubscriptionMsg));
        console.log(`Unsubscribed from streams: ${streamsToRemove.join(', ')}`);
    }
}

wss.on('connection', (wsToFrontend) => {
    clientConnectionCount++;
    console.log(`Frontend client connected (Total clients: ${clientConnectionCount})`);
    
    // Track subscriptions for this specific client
    const clientSubscriptions = new Set();
    
    wsToFrontend.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message.toString());
            
            if (parsedMessage.method === 'SUBSCRIBE') {
                // Add to global subscriptions
                const streams = parsedMessage.params || [];
                streams.forEach(stream => {
                    clientSubscriptions.add(stream);
                });
                addSubscriptions(streams);
                
            } else if (parsedMessage.method === 'UNSUBSCRIBE') {
                const streams = parsedMessage.params || [];
                streams.forEach(stream => {
                    clientSubscriptions.delete(stream);
                });
                // Only remove from global if no other clients need it
                // For simplicity, we keep subscriptions unless no clients need them
                let shouldRemove = true;
                wss.clients.forEach((client) => {
                    if (client !== wsToFrontend && client.clientSubscriptions) {
                        if (client.clientSubscriptions.has(stream)) {
                            shouldRemove = false;
                        }
                    }
                });
                if (shouldRemove) {
                    removeSubscriptions(streams);
                }
            }
        } catch (error) {
            console.error('Error parsing frontend message:', error);
        }
    });
    
    wsToFrontend.on('close', () => {
        clientConnectionCount--;
        console.log(`Frontend client disconnected (Remaining clients: ${clientConnectionCount})`);
        
        // If no clients left, close global connection after delay
        if (clientConnectionCount === 0) {
            console.log('No clients connected, closing global Binance connection in 30 seconds...');
            setTimeout(() => {
                if (clientConnectionCount === 0 && globalBinanceWs) {
                    console.log('Closing idle global Binance connection');
                    if (pingInterval) clearInterval(pingInterval);
                    globalBinanceWs.close();
                    globalBinanceWs = null;
                    globalSubscriptions.clear();
                }
            }, 30000);
        }
    });
    
    // Store clientSubscriptions on the client object for reference
    wsToFrontend.clientSubscriptions = clientSubscriptions;
    
    // Send initial connection success
    wsToFrontend.send(JSON.stringify({ event: 'connected', message: 'Connected to Binance proxy' }));
});

// Increase max listeners to avoid warning
server.setMaxListeners(20);

// Listen on the HTTP wrapper server
server.listen(PORT, () => {
    console.log(`Proxy backend running on port ${PORT}`);
    console.log(`Connected to Binance API`);
});