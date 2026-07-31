const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==================== SUPABASE ====================
// Prefer environment variables on Render:
// SUPABASE_URL and SUPABASE_KEY (use service_role key when you have it)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://khdrauqyqzayrnrlhlgv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtoZHJhdXF5cXpheXJucmxobGd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MzAxMTYsImV4cCI6MjEwMTAwNjExNn0.u4_CIEOpU9qrqzixMvoFoFVEhBkFTIuB7Zoi9N6WErE';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== GAME CONFIG ====================
const CONFIG = {
    HOUSE_MARGIN: 0.06,
    BET_TIME: 60,
    DRAW_TIME: 18,
    RESULT_TIME: 7,
    GRID_SIZE: 80,
    DRAW_COUNT: 20,
    SIMULATION_TRIALS: 200
};

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

const PROMO_COUPONS = {
    'SPEED100': 100.00,
    'WELCOME50': 50.00,
    'BONUS20': 20.00
};

let gameState = {
    roundId: Math.floor(100000 + Math.random() * 900000),
    phase: 'BETTING',
    timer: CONFIG.BET_TIME,
    endTime: Date.now() + (CONFIG.BET_TIME * 1000),
    winningNumbers: [],
    activeBets: [],
    totalPool: 0,
    globalResults: []
};

// ==================== SUPABASE HELPERS ====================
async function getOrCreateUser(userId, name = 'Player', phone = '') {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        console.error('getOrCreateUser select error:', error.message);
        return null;
    }

    if (data) return data;

    // Create new user with 0 balance
    const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({
            user_id: userId,
            name: name,
            phone: phone,
            balance: 0.00
        })
        .select()
        .single();

    if (insertError) {
        console.error('getOrCreateUser insert error:', insertError.message);
        return null;
    }
    return newUser;
}

async function getBalance(userId) {
    const { data, error } = await supabase
        .from('users')
        .select('balance')
        .eq('user_id', userId)
        .maybeSingle();

    if (error || !data) return 0;
    return parseFloat(data.balance) || 0;
}

async function setBalance(userId, newBalance) {
    const { error } = await supabase
        .from('users')
        .update({
            balance: Number(newBalance.toFixed(2)),
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

    if (error) {
        console.error('setBalance error:', error.message);
        return false;
    }
    return true;
}

async function adjustBalance(userId, delta) {
    // Simple read-modify-write (good enough for moderate traffic)
    const current = await getBalance(userId);
    const next = current + delta;
    if (next < 0) return { success: false, balance: current };
    const ok = await setBalance(userId, next);
    return { success: ok, balance: next };
}

// ==================== RNG & GAME HELPERS ====================
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
    return Array.from(numbers);
}

function evaluatePoolPayout(drawnNumbers, bets) {
    let totalPayout = 0;
    const drawnSet = new Set(drawnNumbers);
    for (const bet of bets) {
        const hits = bet.numbers.filter(num => drawnSet.has(num)).length;
        const spot = bet.numbers.length;
        if (PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits] !== undefined) {
            totalPayout += bet.stake * PAYOUT_TABLE[spot][hits];
        }
    }
    return totalPayout;
}

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

function computeSmartDraw() {
    if (gameState.activeBets.length === 0) return generateRandomDraw();

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
        return compliantDraws[getSecureRandomInt(0, compliantDraws.length - 1)].draw;
    }
    return bestDraw;
}

// ==================== GAME LOOP ====================
async function gameLoop() {
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
                gameState.phase = 'RESULT';
                gameState.timer = CONFIG.RESULT_TIME;
                gameState.endTime = Date.now() + (CONFIG.RESULT_TIME * 1000);

                const drawnSet = new Set(gameState.winningNumbers);

                // Credit wins to Supabase
                for (const bet of gameState.activeBets) {
                    const hits = bet.numbers.filter(num => drawnSet.has(num)).length;
                    const spot = bet.numbers.length;

                    if (PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits]) {
                        const winAmount = bet.stake * PAYOUT_TABLE[spot][hits];
                        const result = await adjustBalance(bet.userId, winAmount);
                        if (result.success) {
                            io.to(bet.socketId).emit('balanceUpdate', { balance: result.balance });
                        }
                    }
                }

                gameState.globalResults.push({
                    id: gameState.roundId,
                    numbers: [...gameState.winningNumbers].sort((a, b) => a - b)
                });
                if (gameState.globalResults.length > 10) gameState.globalResults.shift();
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

    io.emit('gameStateUpdate', getBroadcastStatePayload());
}

setInterval(gameLoop, 1000);

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.emit('gameStateUpdate', getBroadcastStatePayload());

    socket.on('initUser', async (data) => {
        if (!data || !data.userId) return;
        socket.userId = data.userId;

        const user = await getOrCreateUser(data.userId, data.name || 'Player', data.phone || '');
        if (user) {
            socket.emit('balanceUpdate', { balance: parseFloat(user.balance) || 0 });
        }
    });

    socket.on('requestBalance', async (data) => {
        const uId = data?.userId || socket.userId;
        if (!uId) return;
        const balance = await getBalance(uId);
        socket.emit('balanceUpdate', { balance });
    });

    socket.on('placeBet', async (data) => {
        if (gameState.phase !== 'BETTING') {
            return socket.emit('betError', { message: "Betting phase closed!" });
        }

        const betAmount = parseFloat(data.bet || data.stake);
        const uId = data.userId || socket.userId;

        if (!uId || isNaN(betAmount) || betAmount <= 0) {
            return socket.emit('betError', { message: "Invalid bet." });
        }
        if (!data.numbers || !Array.isArray(data.numbers) || data.numbers.length === 0) {
            return socket.emit('betError', { message: "Invalid numbers." });
        }

        // Deduct from Supabase
        const result = await adjustBalance(uId, -betAmount);
        if (!result.success) {
            return socket.emit('betError', { message: "Insufficient account balance." });
        }

        const ticket = {
            ticketId: data.id || Date.now(),
            socketId: socket.id,
            userId: uId,
            numbers: data.numbers,
            stake: betAmount
        };

        gameState.activeBets.push(ticket);
        gameState.totalPool += betAmount;

        socket.emit('betSuccess', {
            message: "Ticket accepted!",
            ticket,
            newBalance: result.balance
        });
        socket.emit('balanceUpdate', { balance: result.balance });
        io.emit('gameStateUpdate', getBroadcastStatePayload());
    });

    // Coupon still works (credits immediately)
    socket.on('redeemCoupon', async (data) => {
        const uId = data.userId || socket.userId;
        if (!uId) return socket.emit('couponResult', { success: false, message: "User not found." });

        const code = (data.code || '').trim().toUpperCase();
        if (!PROMO_COUPONS[code]) {
            return socket.emit('couponResult', { success: false, message: "Invalid or expired coupon." });
        }

        // Simple one-time check could be improved later with a redeemed_coupons table
        const bonus = PROMO_COUPONS[code];
        const result = await adjustBalance(uId, bonus);
        if (result.success) {
            socket.emit('couponResult', {
                success: true,
                message: `🎉 Success! Received ${bonus} ETB bonus.`
            });
            socket.emit('balanceUpdate', { balance: result.balance });
        } else {
            socket.emit('couponResult', { success: false, message: "Failed to credit bonus." });
        }
    });

    // Keep these events so old frontends don't break, but they no longer auto-credit
    socket.on('submitDeposit', () => {
        socket.emit('depositError', { message: "Deposits are now manual. Submit via the landing page." });
    });

    socket.on('submitWithdrawal', () => {
        socket.emit('withdrawResponse', {
            success: false,
            message: "Withdrawals are now handled via the landing page (pending approval)."
        });
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// Health check
app.get('/', (req, res) => {
    res.send('Speed Games + Supabase balance engine running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
