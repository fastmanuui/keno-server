const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Basic HTTP health check endpoint for Render
app.get('/', (req, res) => {
    res.send('Speed Games Betting Engine & Socket Server Running');
});

// ==========================================
// 1. GAME CONFIGURATION & STATE
// ==========================================
const CONFIG = {
    HOUSE_MARGIN: 0.06,      // 6% target house profit (94% RTP)
    BET_TIME: 60,            // Seconds players can bet
    DRAW_TIME: 18,           // Seconds for draw animation
    RESULT_TIME: 7,          // Seconds to view final results
    GRID_SIZE: 80,           // Keno 80-number grid
    DRAW_COUNT: 20,          // 20 numbers drawn per round
    SIMULATION_TRIALS: 200   // Candidate combinations tested for risk
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

// In-Memory Database for active user balances & redemptions
const usersDB = new Map();

// Active Admin Deposit Configuration (Fetched by frontend modal)
const adminDepositConfig = {
    accountNumber: "+251945754766",
    accountHolder: "Speed Games Official Admin"
};

// Active Promo Coupons
const PROMO_COUPONS = {
    'SPEED100': 100.00,
    'WELCOME50': 50.00,
    'BONUS20': 20.00
};

let gameState = {
    roundId: Math.floor(100000 + Math.random() * 900000),
    phase: 'BETTING', // 'BETTING', 'DRAWING', 'RESULT'
    timer: CONFIG.BET_TIME,
    endTime: Date.now() + (CONFIG.BET_TIME * 1000),
    winningNumbers: [],
    activeBets: [],
    totalPool: 0,
    globalResults: []
};

// ==========================================
// 2. HELPER UTILITIES & CRYPTO RNG
// ==========================================

function getOrCreateUser(userId, name = 'Player', phone = '') {
    if (!usersDB.has(userId)) {
        usersDB.set(userId, {
            id: userId,
            name: name,
            phone: phone,
            balance: 50.00, // Starting bonus balance for testing
            redeemedCoupons: new Set(),
            transactions: []
        });
    }
    return usersDB.get(userId);
}

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
            const multiplier = PAYOUT_TABLE[spot][hits];
            totalPayout += (bet.stake * multiplier);
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
                gameState.phase = 'RESULT';
                gameState.timer = CONFIG.RESULT_TIME;
                gameState.endTime = Date.now() + (CONFIG.RESULT_TIME * 1000);
                
                const drawnSet = new Set(gameState.winningNumbers);

                // Pay out winning tickets to user balances
                for (const bet of gameState.activeBets) {
                    const hits = bet.numbers.filter(num => drawnSet.has(num)).length;
                    const spot = bet.numbers.length;

                    if (PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits]) {
                        const winAmount = bet.stake * PAYOUT_TABLE[spot][hits];
                        const user = usersDB.get(bet.userId);
                        if (user) {
                            user.balance += winAmount;
                            io.to(bet.socketId).emit('balanceUpdate', { balance: user.balance });
                        }
                    }
                }

                // Push to global result history
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

    io.emit('gameStateUpdate', getBroadcastStatePayload());
}

setInterval(gameLoop, 1000);

// ==========================================
// 5. WEBSOCKET HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.emit('gameStateUpdate', getBroadcastStatePayload());
    // Send admin deposit account configuration to client on connection
    socket.emit('adminDepositInfo', adminDepositConfig);

    // Initialize/Sync User State
    socket.on('initUser', (data) => {
        if (!data || !data.userId) return;
        
        socket.userId = data.userId;
        const user = getOrCreateUser(data.userId, data.name, data.phone);
        
        socket.emit('balanceUpdate', { balance: user.balance });
    });

    socket.on('requestBalance', (data) => {
        const uId = data?.userId || socket.userId;
        if (uId && usersDB.has(uId)) {
            socket.emit('balanceUpdate', { balance: usersDB.get(uId).balance });
        }
    });

    // Handle Keno Ticket Bet Placement
    socket.on('placeBet', (data) => {
        if (gameState.phase !== 'BETTING') {
            return socket.emit('betError', { message: "Betting phase closed!" });
        }

        const betAmount = parseFloat(data.bet || data.stake);
        const uId = data.userId || socket.userId;
        const user = usersDB.get(uId);

        if (!user || user.balance < betAmount) {
            return socket.emit('betError', { message: "Insufficient account balance." });
        }

        if (!data.numbers || !Array.isArray(data.numbers) || data.numbers.length === 0 || isNaN(betAmount) || betAmount <= 0) {
            return socket.emit('betError', { message: "Invalid bet payload." });
        }

        // Deduct balance instantly
        user.balance -= betAmount;
        socket.emit('balanceUpdate', { balance: user.balance });

        const ticket = {
            ticketId: data.id || Date.now(),
            socketId: socket.id,
            userId: uId,
            numbers: data.numbers,
            stake: betAmount
        };

        gameState.activeBets.push(ticket);
        gameState.totalPool += ticket.stake;

        socket.emit('betSuccess', { message: "Ticket accepted!", ticket, newBalance: user.balance });
        io.emit('gameStateUpdate', getBroadcastStatePayload());
    });

    // Handle Telebirr Deposit Verification SMS Submission
    socket.on('submitDeposit', (data) => {
        const uId = data.userId || socket.userId;
        const user = usersDB.get(uId);

        if (!user) {
            return socket.emit('depositError', { message: "User session not found." });
        }

        const amount = parseFloat(data.amount);
        if (isNaN(amount) || amount <= 0) {
            return socket.emit('depositError', { message: "Invalid deposit amount." });
        }

        // Process deposit & credit balance
        user.balance += amount;
        user.transactions.push({
            id: Date.now(),
            type: 'DEPOSIT',
            amount: amount,
            sms: data.smsText,
            timestamp: new Date()
        });

        console.log(`[DEPOSIT CONFIRMED] User: ${uId} | Added: ${amount} ETB | New Balance: ${user.balance} ETB`);

        socket.emit('depositSuccess', {
            message: `Deposit of ${amount} ETB successfully processed!`,
            balance: user.balance
        });
        socket.emit('balanceUpdate', { balance: user.balance });
    });

    // Handle Withdrawal Request Sent to Admin
    socket.on('submitWithdrawal', (data) => {
        const uId = data.userId || socket.userId;
        const user = usersDB.get(uId);

        if (!user) {
            return socket.emit('withdrawResponse', { success: false, message: "User session not found." });
        }

        const amount = parseFloat(data.amount);
        if (isNaN(amount) || amount < 100) {
            return socket.emit('withdrawResponse', { success: false, message: "Minimum withdrawal is 100 ETB." });
        }

        if (user.balance < amount) {
            return socket.emit('withdrawResponse', { success: false, message: "Insufficient balance." });
        }

        // Deduct balance for withdrawal
        user.balance -= amount;
        user.transactions.push({
            id: Date.now(),
            type: 'WITHDRAWAL',
            bank: data.bank,
            accountNumber: data.accountNumber,
            receiverName: data.receiverName,
            amount: amount,
            status: 'PENDING',
            timestamp: new Date()
        });

        console.log(`[WITHDRAWAL REQUEST] User: ${uId} | Bank: ${data.bank} | Acc: ${data.accountNumber} | Name: ${data.receiverName} | Amount: ${amount} ETB`);

        socket.emit('withdrawResponse', {
            success: true,
            message: `Withdrawal request of ${amount} ETB sent to admin successfully!`,
            amount: amount
        });
        socket.emit('balanceUpdate', { balance: user.balance });
    });

    // Handle Promo Coupon Redemption
    socket.on('redeemCoupon', (data) => {
        const uId = data.userId || socket.userId;
        const user = usersDB.get(uId);

        if (!user) {
            return socket.emit('couponResult', { success: false, message: "User session error." });
        }

        const code = (data.code || '').trim().toUpperCase();

        if (!PROMO_COUPONS[code]) {
            return socket.emit('couponResult', { success: false, message: "Invalid or expired coupon code." });
        }

        if (user.redeemedCoupons.has(code)) {
            return socket.emit('couponResult', { success: false, message: "You have already redeemed this coupon!" });
        }

        const bonusAmount = PROMO_COUPONS[code];
        user.balance += bonusAmount;
        user.redeemedCoupons.add(code);

        socket.emit('couponResult', {
            success: true,
            message: `🎉 Success! Received ${bonusAmount} ETB bonus credit.`
        });
        socket.emit('balanceUpdate', { balance: user.balance });
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Speed Games Engine running on port ${PORT}`);
});
