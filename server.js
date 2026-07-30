// server.js
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
    DRAW_TIME: 15,           // Seconds for draw animation
    RESULT_TIME: 5,          // Seconds to view final results
    GRID_SIZE: 80,           // Keno 80-number grid
    DRAW_COUNT: 20,          // 20 numbers drawn per round
    SIMULATION_TRIALS: 200   // Candidate combinations tested for risk
};

// Standard Keno Payout Odds (Spot Multipliers)
const PAYOUT_TABLE = {
    1: { 1: 3.8 },
    2: { 2: 15, 1: 1 },
    3: { 3: 42, 2: 2.5 },
    4: { 4: 100, 3: 5, 2: 1 },
    5: { 5: 300, 4: 15, 3: 2 }
};

let gameState = {
    roundId: Date.now(),
    phase: 'BETTING', // 'BETTING', 'DRAWING', 'RESULTS'
    timer: CONFIG.BET_TIME,
    winningNumbers: [],
    activeBets: [],
    totalPool: 0
};

// ==========================================
// 2. HELPER UTILITIES & CRYPTO RNG
// ==========================================

// Secure Random Integer Generator
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

// Generate 20 unique random numbers from 1 to 80
function generateRandomDraw() {
    const numbers = new Set();
    while (numbers.size < CONFIG.DRAW_COUNT) {
        numbers.add(getSecureRandomInt(1, CONFIG.GRID_SIZE));
    }
    return Array.from(numbers).sort((a, b) => a - b);
}

// Calculate total payout for a given set of 20 drawn numbers against all current bets
function evaluatePoolPayout(drawnNumbers, bets) {
    let totalPayout = 0;
    const drawnSet = new Set(drawnNumbers);

    for (const bet of bets) {
        // Find how many picked numbers matched the draw
        const hits = bet.numbers.filter(num => drawnSet.has(num)).length;
        const spot = bet.numbers.length;

        if (PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits]) {
            const multiplier = PAYOUT_TABLE[spot][hits];
            totalPayout += (bet.stake * multiplier);
        }
    }
    return totalPayout;
}

// ==========================================
// 3. SMART HOUSE RISK ENGINE
// ==========================================
function computeSmartDraw() {
    // If no bets placed, generate purely random draw
    if (gameState.activeBets.length === 0) {
        return generateRandomDraw();
    }

    const maxAllowedPayout = gameState.totalPool * (1 - CONFIG.HOUSE_MARGIN);
    let bestDraw = null;
    let bestPayout = Infinity;
    let compliantDraws = [];

    // Simulate multiple candidate draws to analyze financial risk
    for (let i = 0; i < CONFIG.SIMULATION_TRIALS; i++) {
        const candidateDraw = generateRandomDraw();
        const candidatePayout = evaluatePoolPayout(candidateDraw, gameState.activeBets);

        // Track draws that stay under the 6% house edge ceiling
        if (candidatePayout <= maxAllowedPayout) {
            compliantDraws.push({ draw: candidateDraw, payout: candidatePayout });
        }

        if (candidatePayout < bestPayout) {
            bestPayout = candidatePayout;
            bestDraw = candidateDraw;
        }
    }

    // Pick randomly from valid profit-guaranteed candidates for true randomness feel
    if (compliantDraws.length > 0) {
        const selected = compliantDraws[getSecureRandomInt(0, compliantDraws.length - 1)];
        return selected.draw;
    }

    // Fallback: Pick candidate that minimized loss if all exceeded target
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
                // Phase switch to DRAWING
                gameState.phase = 'DRAWING';
                gameState.timer = CONFIG.DRAW_TIME;
                
                // Execute Smart Draw
                gameState.winningNumbers = computeSmartDraw();
                
                io.emit('drawStarted', {
                    winningNumbers: gameState.winningNumbers,
                    duration: CONFIG.DRAW_TIME
                });
                break;

            case 'DRAWING':
                // Phase switch to RESULTS
                gameState.phase = 'RESULTS';
                gameState.timer = CONFIG.RESULT_TIME;
                
                // Resolve Winners
                const totalPayout = evaluatePoolPayout(gameState.winningNumbers, gameState.activeBets);
                const houseProfit = gameState.totalPool - totalPayout;
                
                console.log(`[ROUND END] Pool: ${gameState.totalPool} ETB | Payout: ${totalPayout} ETB | Profit: ${houseProfit} ETB`);

                io.emit('roundResults', {
                    roundId: gameState.roundId,
                    winningNumbers: gameState.winningNumbers,
                    totalPayout: totalPayout
                });
                break;

            case 'RESULTS':
                // Reset for next round
                gameState.roundId = Date.now();
                gameState.phase = 'BETTING';
                gameState.timer = CONFIG.BET_TIME;
                gameState.winningNumbers = [];
                gameState.activeBets = [];
                gameState.totalPool = 0;
                break;
        }
    }

    // Broadcast sync pulse to all connected frontend clients
    io.emit('gameStateUpdate', {
        phase: gameState.phase,
        timer: gameState.timer,
        roundId: gameState.roundId,
        totalPool: gameState.totalPool
    });
}

// Tick every second
setInterval(gameLoop, 1000);

// ==========================================
// 5. WEBSOCKET HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send current state upon joining
    socket.emit('gameStateUpdate', {
        phase: gameState.phase,
        timer: gameState.timer,
        roundId: gameState.roundId,
        totalPool: gameState.totalPool
    });

    // Handle ticket placement
    socket.on('placeBet', (data) => {
        if (gameState.phase !== 'BETTING') {
            return socket.emit('betError', { message: "Betting phase closed!" });
        }

        if (!data.numbers || !data.stake || data.stake <= 0) {
            return socket.emit('betError', { message: "Invalid bet payload." });
        }

        const ticket = {
            socketId: socket.id,
            userId: data.userId || 'guest',
            numbers: data.numbers,
            stake: parseFloat(data.stake)
        };

        gameState.activeBets.push(ticket);
        gameState.totalPool += ticket.stake;

        socket.emit('betSuccess', { message: "Ticket accepted!", ticket });
        io.emit('poolUpdated', { totalPool: gameState.totalPool });
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Betting Engine running on port ${PORT}`);
});
