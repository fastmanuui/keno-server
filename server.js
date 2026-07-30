const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
// 1. GAME CONFIGURATION & STATE
// ==========================================
const CONFIG = {
    HOUSE_MARGIN: 0.06,      // 6% target house profit (94% RTP)
    BET_TIME: 60,            // Seconds players can bet
    DRAW_TIME: 18,           // Seconds for draw animation (matches frontend ~0.8s interval x 20)
    RESULT_TIME: 7,          // Seconds to view final results
    GRID_SIZE: 80,           // Keno 80-number grid
    DRAW_COUNT: 20,          // 20 numbers drawn per round
    SIMULATION_TRIALS: 200   // Candidate combinations tested for risk
};

// Full Keno Payout Odds matching client-side expectations
const PAYOUT_TABLE = {
    1: { 1: 3.5 },
    2: { 1: 1, 2: 10 },
    3: { 2: 2, 3: 50 },
    4: { 2: 1.5, 3: 10, 4: 80 },
    5: { 2: 1, 3: 3, 4: 30, 5: 150 },
    6: { 3: 2, 4: 15, 5: 60, 6: 500 },
    7: { 0: 1, 3: 2, 4: 4, 5: 20, 6: 80, 7: 1000 },
    8: { 0: 1, 4: 5, 5: 15, 6: 50, 7: 200, 8: 2000 },
    9: { 0: 2, 4: 2, 5: 10, 6: 25, 7: 125, 8: 1000, 9: 5000 },
    10: { 0: 2, 5: 5, 6: 30, 7: 100, 8: 300, 9: 2000, 10: 10000 }
};

let gameState = {
    roundId: Math.floor(100000 + Math.random() * 900000), // Clean numeric ID format
    phase: 'BETTING', // 'BETTING', 'DRAWING', 'RESULT' (Frontend expects 'RESULT' not 'RESULTS')
    timer: CONFIG.BET_TIME,
    endTime: Date.now() + (CONFIG.BET_TIME * 1000), // Timestamp required by frontend smooth timer
    winningNumbers: [],
    activeBets: [],
    totalPool: 0,
    globalResults: [] // Stores last 10 completed draws
};

// ==========================================
// 2. HELPER UTILITIES & CRYPTO RNG
// ==========================================

function getSecureRandomInt(min, max) {
    const range = max - min + 1;
    const bytesNeeded = Math.ceil(Math.log2(range) / 8);
    const maxValid = Math.floor(Math.pow(256, bytesNeeded) / range) * range;
    let randomVal;
    
    do {
        const buffer = crypto.randomBytes(bytesNeeded);
        randomVal = buffer.readUIntBE(0, bytesNeeded);
    } while (randomVal >= maxValid);

    return min + (randomVal % range);
}

function generateRandomDraw() {
    const numbers = new Set();
    while (numbers.size < CONFIG.DRAW_COUNT) {
        numbers.add(getSecureRandomInt(1, CONFIG.GRID_SIZE));
    }
    return Array.from(numbers); // Unsorted draw order feels more authentic
}

function evaluatePoolPayout(drawnNumbers, bets) {
    let totalPayout = 0;
    const drawnSet = new Set(drawnNumbers);

    for (const bet of bets) {
        const hits = bet.numbers.filter(num => drawnSet.has(num)).length;
        const spot = bet.numbers.length;

        if (PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits] !== undefined) {
            const multiplier = PAYOUT_TABLE[spot][hits];
            totalPayout += (bet.stake * multiplier);
        }
    }
    return totalPayout;
}

// Helper to broadcast uniform sync state
function getBroadcastStatePayload() {
    return {
        phase: gameState.phase,
        timer: gameState.timer,
        roundId: gameState.roundId,
        totalPool: gameState.totalPool,
        endTime: gameState.endTime,
        drawnNumbers: gameState.winningNumbers,
        globalResults: gameState.globalResults
    };
}

// ==========================================
// 3. SMART HOUSE RISK ENGINE
// ==========================================
function computeSmartDraw() {
    if (gameState.activeBets.length === 0) {
        return generateRandomDraw();
    }

    const maxAllowedPayout = gameState.totalPool * (1 - CONFIG.HOUSE_MARGIN);
    let bestDraw = null;
    let bestPayout = Infinity;
    let compliantDraws = [];

    for (let i = 0; i < CONFIG.SIMULATION_TRIALS; i++) {
        const candidateDraw = generateRandomDraw();
        const candidatePayout = evaluatePoolPayout(candidateDraw, gameState.activeBets);

        if (candidatePayout <= maxAllowedPayout) {
            compliantDraws.push({ draw: candidateDraw, payout: candidatePayout });
        }

        if (candidatePayout < bestPayout) {
            bestPayout = candidatePayout;
            bestDraw = candidateDraw;
        }
    }

    if (compliantDraws.length > 0) {
        const selected = compliantDraws[getSecureRandomInt(0, compliantDraws.length - 1)];
        return selected.draw;
    }

    return bestDraw;
}

// ==========================================
// 4. GAME ENGINE LOOP
// ==========================================
function gameLoop() {
    gameState.timer--;

    if (gameState.timer <= 0) {
        switch (gameState.phase) {
            case 'BETTING':
                gameState.phase = 'DRAWING';
                gameState.timer = CONFIG.DRAW_TIME;
                gameState.endTime = Date.now() + (CONFIG.DRAW_TIME * 1000);
                gameState.winningNumbers = computeSmartDraw();
                break;

            case 'DRAWING':
                gameState.phase = 'RESULT'; // Fixed: Matched with Frontend expected string 'RESULT'
                gameState.timer = CONFIG.RESULT_TIME;
                gameState.endTime = Date.now() + (CONFIG.RESULT_TIME * 1000);
                
                const totalPayout = evaluatePoolPayout(gameState.winningNumbers, gameState.activeBets);
                const houseProfit = gameState.totalPool - totalPayout;
                
                console.log(`[ROUND ${gameState.roundId} END] Pool: ${gameState.totalPool} ETB | Payout: ${totalPayout} ETB | Profit: ${houseProfit} ETB`);

                // Push to global result history (Keep last 10)
                gameState.globalResults.push({
                    id: gameState.roundId,
                    numbers: [...gameState.winningNumbers].sort((a, b) => a - b)
                });
                if (gameState.globalResults.length > 10) {
                    gameState.globalResults.shift();
                }
                break;

            case 'RESULT':
                gameState.roundId = Math.floor(100000 + Math.random() * 900000);
                gameState.phase = 'BETTING';
                gameState.timer = CONFIG.BET_TIME;
                gameState.endTime = Date.now() + (CONFIG.BET_TIME * 1000);
                gameState.winningNumbers = [];
                gameState.activeBets = [];
                gameState.totalPool = 0;
                break;
        }
    }

    // Broadcast sync pulse to all connected clients
    io.emit('gameStateUpdate', getBroadcastStatePayload());
}

setInterval(gameLoop, 1000);

// ==========================================
// 5. WEBSOCKET HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send full current state upon joining
    socket.emit('gameStateUpdate', getBroadcastStatePayload());

    // Handle incoming ticket bets
    socket.on('placeBet', (data) => {
        if (gameState.phase !== 'BETTING') {
            return socket.emit('betError', { message: "Betting phase closed!" });
        }

        // Adapted to handle both `bet` and `stake` property keys from client
        const betAmount = parseFloat(data.bet || data.stake);

        if (!data.numbers || !Array.isArray(data.numbers) || data.numbers.length === 0 || isNaN(betAmount) || betAmount <= 0) {
            return socket.emit('betError', { message: "Invalid bet payload." });
        }

        const ticket = {
            ticketId: data.id || Date.now(),
            socketId: socket.id,
            userId: data.userId || 'guest',
            numbers: data.numbers,
            stake: betAmount
        };

        gameState.activeBets.push(ticket);
        gameState.totalPool += ticket.stake;

        socket.emit('betSuccess', { message: "Ticket accepted!", ticket });
        io.emit('gameStateUpdate', getBroadcastStatePayload());
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Keno Game Engine running on port ${PORT}`);
});

