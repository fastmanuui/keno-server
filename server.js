const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// Configure these in your hosting provider's environment settings.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://khdrauqyqzayrnrlhlgv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_KEY environment variable');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);


// ==================== EXISTING NUMBER GAME CONFIG ====================
const CONFIG = { HOUSE_MARGIN: 0.06, BET_TIME: 60, DRAW_TIME: 18, RESULT_TIME: 7,
  GRID_SIZE: 80, DRAW_COUNT: 20, SIMULATION_TRIALS: 200 };
const PAYOUT_TABLE = {
  1:{1:3.5}, 2:{1:1,2:10}, 3:{2:2,3:50}, 4:{2:1.5,3:10,4:80},
  5:{2:1,3:3,4:30,5:150}, 6:{3:2,4:15,5:60,6:500},
  7:{0:1,3:2,4:4,5:20,6:80,7:1000},
  8:{0:1,4:5,5:15,6:50,7:200,8:2000},
  9:{0:2,4:2,5:10,6:25,7:125,8:1000,9:5000},
  10:{0:2,5:5,6:30,7:100,8:300,9:2000,10:10000}
};
const PROMO_COUPONS = { SPEED100:100, WELCOME50:50, BONUS20:20 };
let gameState = { roundId:Math.floor(100000+Math.random()*900000), phase:'BETTING',
  timer:CONFIG.BET_TIME, endTime:Date.now()+CONFIG.BET_TIME*1000,
  winningNumbers:[], activeBets:[], totalPool:0, globalResults:[] };

async function getOrCreateUser(userId, name='Player', phone='') {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle();
  if (error) { console.error('getOrCreateUser select error:', error.message); return null; }
  if (data) return data;
  const { data:newUser, error:insertError } = await supabase.from('users')
    .insert({ user_id:userId, name, phone, balance:0 }).select().single();
  if (insertError) { console.error('getOrCreateUser insert error:', insertError.message); return null; }
  return newUser;
}
async function getBalance(userId) {
  const { data, error } = await supabase.from('users').select('balance').eq('user_id', userId).maybeSingle();
  if (error || !data) return 0;
  return Number(data.balance) || 0;
}

// IMPORTANT: all games now use the same atomic SQL balance function.
// No read-modify-write race; negative balances are rejected inside PostgreSQL.
async function adjustBalance(userId, delta) {
  const { data, error } = await supabase.rpc('hc2_adjust_balance', {
    p_user: String(userId), p_delta: Number(delta)
  });
  if (error) {
    console.error('hc2_adjust_balance RPC error:', error.message);
    return { success:false, balance:await getBalance(userId) };
  }
  if (data === null || data === undefined) return { success:false, balance:await getBalance(userId) };
  return { success:true, balance:Number(data) };
}

function getSecureRandomInt(min,max) {
  const range=max-min+1, bytesNeeded=Math.ceil(Math.log2(range)/8);
  const maxValid=Math.floor(Math.pow(256,bytesNeeded)/range)*range;
  let value;
  do { const b=crypto.randomBytes(bytesNeeded); value=b.readUIntBE(0,bytesNeeded); } while(value>=maxValid);
  return min+(value%range);
}
function generateRandomDraw() {
  const numbers=new Set(); while(numbers.size<CONFIG.DRAW_COUNT) numbers.add(getSecureRandomInt(1,CONFIG.GRID_SIZE));
  return Array.from(numbers);
}
function evaluatePoolPayout(drawnNumbers,bets) {
  let total=0; const drawn=new Set(drawnNumbers);
  for(const bet of bets) { const hits=bet.numbers.filter(n=>drawn.has(n)).length; const spot=bet.numbers.length;
    if(PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits]!==undefined) total+=bet.stake*PAYOUT_TABLE[spot][hits]; }
  return total;
}
function getBroadcastStatePayload() { return { phase:gameState.phase,timer:gameState.timer,roundId:gameState.roundId,
  totalPool:gameState.totalPool,endTime:gameState.endTime,drawnNumbers:gameState.winningNumbers,globalResults:gameState.globalResults }; }
function computeSmartDraw() {
  if(!gameState.activeBets.length) return generateRandomDraw();
  const max=gameState.totalPool*(1-CONFIG.HOUSE_MARGIN); let best=null,bestPayout=Infinity; const fitting=[];
  for(let i=0;i<CONFIG.SIMULATION_TRIALS;i++) { const draw=generateRandomDraw(); const payout=evaluatePoolPayout(draw,gameState.activeBets);
    if(payout<=max) fitting.push({draw,payout}); if(payout<bestPayout){bestPayout=payout;best=draw;} }
  return fitting.length ? fitting[getSecureRandomInt(0,fitting.length-1)].draw : best;
}
async function gameLoop() {
  gameState.timer--;
  if(gameState.timer<=0) switch(gameState.phase) {
    case 'BETTING': gameState.phase='DRAWING'; gameState.timer=CONFIG.DRAW_TIME;
      gameState.endTime=Date.now()+CONFIG.DRAW_TIME*1000; gameState.winningNumbers=computeSmartDraw(); break;
    case 'DRAWING': {
      gameState.phase='RESULT'; gameState.timer=CONFIG.RESULT_TIME; gameState.endTime=Date.now()+CONFIG.RESULT_TIME*1000;
      const drawn=new Set(gameState.winningNumbers);
      for(const bet of gameState.activeBets) { const hits=bet.numbers.filter(n=>drawn.has(n)).length; const spot=bet.numbers.length;
        if(PAYOUT_TABLE[spot] && PAYOUT_TABLE[spot][hits]) { const win=bet.stake*PAYOUT_TABLE[spot][hits];
          const result=await adjustBalance(bet.userId,win); if(result.success) io.to(bet.socketId).emit('balanceUpdate',{balance:result.balance}); } }
      gameState.globalResults.push({id:gameState.roundId,numbers:[...gameState.winningNumbers].sort((a,b)=>a-b)});
      if(gameState.globalResults.length>10) gameState.globalResults.shift(); break;
    }
    case 'RESULT': gameState.roundId=Math.floor(100000+Math.random()*900000); gameState.phase='BETTING';
      gameState.timer=CONFIG.BET_TIME; gameState.endTime=Date.now()+CONFIG.BET_TIME*1000;
      gameState.winningNumbers=[]; gameState.activeBets=[]; gameState.totalPool=0; break;
  }
  io.emit('gameStateUpdate',getBroadcastStatePayload());
}
let gameLoopRunning=false;
setInterval(async()=>{
  if(gameLoopRunning) return;
  gameLoopRunning=true;
  try { await gameLoop(); }
  catch(e) { console.error('gameLoop error:',e); }
  finally { gameLoopRunning=false; }
},1000);

io.on('connection', socket => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('gameStateUpdate',getBroadcastStatePayload());
  socket.on('initUser', async data => {
    if(!data || !data.userId) return;
    // Existing authentication flow retained as requested. Do not treat this client-supplied ID as secure authentication.
    socket.userId=String(data.userId);
    const user=await getOrCreateUser(socket.userId,data.name||'Player',data.phone||'');
    if(user) socket.emit('balanceUpdate',{balance:Number(user.balance)||0});
  });
  socket.on('requestBalance', async data => {
    const id=socket.userId; if(!id) return;
    socket.emit('balanceUpdate',{balance:await getBalance(id)});
  });
  socket.on('placeBet', async data => {
    try {
      if(gameState.phase!=='BETTING') return socket.emit('betError',{message:'Betting phase closed!'});
      const amount=Number(data?.bet ?? data?.stake);
      const id=socket.userId;
      if(!id || !Number.isFinite(amount) || amount<=0 || Math.round(amount*100)!==amount*100)
        return socket.emit('betError',{message:'Invalid bet.'});
      if(!Array.isArray(data?.numbers) || data.numbers.length<1 || data.numbers.length>10 ||
         !data.numbers.every(n=>Number.isInteger(n)&&n>=1&&n<=CONFIG.GRID_SIZE) ||
         new Set(data.numbers).size!==data.numbers.length)
        return socket.emit('betError',{message:'Choose 1–10 unique numbers from 1 to 80.'});
      const result=await adjustBalance(id,-amount);
      if(!result.success) return socket.emit('betError',{message:'Insufficient account balance.'});
      const ticket={ticketId:data.id||Date.now(),socketId:socket.id,userId:id,numbers:data.numbers,stake:amount};
      gameState.activeBets.push(ticket); gameState.totalPool+=amount;
      socket.emit('betSuccess',{message:'Ticket accepted!',ticket,newBalance:result.balance});
      socket.emit('balanceUpdate',{balance:result.balance}); io.emit('gameStateUpdate',getBroadcastStatePayload());
    } catch(e) { console.error('placeBet error:',e); socket.emit('betError',{message:'Bet failed. Please try again.'}); }
  });
  socket.on('redeemCoupon', async data => {
    const id=socket.userId;
    if(!id) return socket.emit('couponResult',{success:false,message:'User not found.'});
    const code=String(data?.code||'').trim().toUpperCase();
    if(!PROMO_COUPONS[code]) return socket.emit('couponResult',{success:false,message:'Invalid or expired coupon.'});
    const bonus=PROMO_COUPONS[code]; const result=await adjustBalance(id,bonus);
    if(result.success) { socket.emit('couponResult',{success:true,message:`🎉 Success! Received ${bonus} ETB bonus.`}); socket.emit('balanceUpdate',{balance:result.balance}); }
    else socket.emit('couponResult',{success:false,message:'Failed to credit bonus.'});
  });
  socket.on('submitDeposit',()=>socket.emit('depositError',{message:'Deposits are now manual. Submit via the landing page.'}));
  socket.on('submitWithdrawal',()=>socket.emit('withdrawResponse',{success:false,message:'Withdrawals are now handled via the landing page (pending approval).'}));
  socket.on('disconnect',()=>console.log(`Client disconnected: ${socket.id}`));
});
app.get('/',(req,res)=>res.send('Speed Games + Hit Coins 2 + Supabase balance engine running'));
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Server running on port ${PORT}`));


// =====================================================================
// HIT COINS 2 — merged into this same file (no separate hitcoins2.js needed)
// =====================================================================

const HC2 = {
  HOUSE_SHARE: 0.03, WINDOW_BETS: 50, CANDIDATES: 400,
  BET_AMOUNTS: [2,4,6,8,10,16,20,40,60,80,100,140,160,200,240,280,300,340,360,400,...Array.from({length:30},(_,i)=>420+i*20)]
};
const FRUITS=[['sevens.png',1],['stars.png',2],['bells.png',3],['watermelon.png',5],['grapes.png',5],['plum.png',6],['lemon.png',8],['orange.png',8],['cherries.png',16]];
const COINS=['mini.png','minor.png','major.png','grand.png','crown_coin.png','coin_1.png','coin_2.png','coin_5.png','coin_10.png','coin_15.png'];
const COIN_VALUES={'coin_1.png':1,'coin_2.png':2,'coin_5.png':5,'coin_10.png':10,'coin_15.png':15,'crown_coin.png':1,'mini.png':25,'minor.png':50,'major.png':150,'grand.png':1000};
const PAYOUTS={'sevens.png':50,'stars.png':30,'bells.png':20,'watermelon.png':16,'grapes.png':16,'plum.png':4,'lemon.png':4,'orange.png':4,'cherries.png':1};
const PAYLINES=[[[1,0],[1,1],[1,2]],[[0,0],[0,1],[0,2]],[[2,0],[2,1],[2,2]],[[0,0],[1,1],[2,2]],[[2,0],[1,1],[0,2]]];
const LANDING_MATH={bonusChance:0.02,singleCoinChance:0.03,middleReel:1,middleReelCoin:'crown_coin.png'};
const LANDING_COIN_WEIGHTS={'coin_1.png':1.5,'coin_2.png':1.3,'coin_5.png':1,'coin_10.png':0.8,'coin_15.png':0.5,'crown_coin.png':1.5,'mini.png':0.3,'minor.png':0.2,'major.png':0.1,'grand.png':0.01};
const COLLECT_MATH={leftCoinChance:0.09,rightCoinChance:0.07,newCollectorChance:0.10,maxCollectors:3};
const rnd=()=>crypto.randomInt(0,2**32)/2**32;
const rndInt=n=>crypto.randomInt(0,n);
function weighted(list,getW){const total=list.reduce((s,x)=>s+getW(x),0);let v=rnd()*total;for(const x of list){v-=getW(x);if(v<0)return x;}return list[list.length-1];}
const pickFruit=()=>weighted(FRUITS,e=>e[1])[0];
const pickCoin=w=>weighted(COINS,n=>w[n]||1);
const pickLandingCoin=reel=>reel===LANDING_MATH.middleReel?LANDING_MATH.middleReelCoin:pickCoin(LANDING_COIN_WEIGHTS);
const isCoin=n=>COINS.includes(n);
const round2=n=>Math.round(n*100)/100;
function makeGrid(allowBonus=true){const grid=Array.from({length:3},()=>Array(3).fill(null));const bonus=allowBonus&&rnd()<LANDING_MATH.bonusChance;for(let reel=0;reel<3;reel++){const coinRow=bonus?rndInt(3):(rnd()<LANDING_MATH.singleCoinChance?rndInt(3):-1);for(let row=0;row<3;row++)grid[row][reel]=row===coinRow?pickLandingCoin(reel):pickFruit();}return grid;}
function lineWins(grid){const wins=[];PAYLINES.forEach((line,index)=>{const names=line.map(([r,c])=>grid[r][c]);if(names.some(isCoin))return;const target=names.find(n=>n!=='sevens.png')||'sevens.png';if(!names.every(n=>n===target||n==='sevens.png'))return;if(PAYOUTS[target])wins.push({line:index,symbol:target,multiplier:PAYOUTS[target]});});return wins;}
function simulateBonus(grid){const landed=grid.flat().filter(isCoin);const landedValue=landed.reduce((s,n)=>s+(COIN_VALUES[n]||1),0);const collectors=[landedValue],spins=[];let respins=3;while(respins>0&&spins.length<500){const left=[null,null,null],right=[null,null,null];let coinSum=0,anyCoin=false;for(let i=0;i<3;i++){if(rnd()<COLLECT_MATH.leftCoinChance){const n=pickCoin(LANDING_COIN_WEIGHTS);left[i]={name:n,value:COIN_VALUES[n]};coinSum+=COIN_VALUES[n];anyCoin=true;}if(rnd()<COLLECT_MATH.rightCoinChance){const n=pickCoin(LANDING_COIN_WEIGHTS);right[i]={name:n,value:COIN_VALUES[n]};coinSum+=COIN_VALUES[n];anyCoin=true;}}const addCollector=collectors.length<COLLECT_MATH.maxCollectors&&rnd()<COLLECT_MATH.newCollectorChance;if(addCollector)collectors.push(0);for(let i=0;i<collectors.length;i++)collectors[i]=round2(collectors[i]+coinSum);spins.push({left,right,addCollector});respins=(anyCoin||addCollector)?3:respins-1;}return{landedValue,spins,collectors,multiplier:round2(collectors.reduce((s,v)=>s+v,0))};}
function makeCandidate(bet){const grid=makeGrid(true),wins=lineWins(grid),lineMult=wins.reduce((s,w)=>s+w.multiplier,0);const hasBonus=grid.flat().filter(isCoin).length>=3;const bonus=hasBonus?simulateBonus(grid):null;return{grid,wins,bonus,prize:round2(bet*(lineMult+(bonus?bonus.multiplier:0))) };}
function makeNoWin(){for(let i=0;i<200;i++){const grid=makeGrid(false);if(lineWins(grid).length===0&&grid.flat().filter(isCoin).length<3)return{grid,wins:[],bonus:null,prize:0};}return{grid:[['cherries.png','lemon.png','bells.png'],['lemon.png','plum.png','cherries.png'],['orange.png','bells.png','plum.png']],wins:[],bonus:null,prize:0};}
function createPool(supabase){let state={balance:0,house:0,window:[]};let queue=Promise.resolve();let loaded=false;
 async function load(){
   const{data,error}=await supabase.from('hc2_pool').select('*').eq('id',1).maybeSingle();
   if(error){console.error('[HC2] pool load error:',error.message);throw error;}
   if(!data) throw new Error('Missing hc2_pool row id=1. Run the SQL migration.');
   state={balance:Number(data.balance),house:Number(data.house),window:Array.isArray(data.bet_window)?data.bet_window:[]};
   if(!Number.isFinite(state.balance)||state.balance<0||!Number.isFinite(state.house)||state.house<0) throw new Error('Invalid HC2 pool values in database.');
   loaded=true;
 }
 async function save(){
   const{data,error}=await supabase.from('hc2_pool').update({balance:round2(state.balance),house:round2(state.house),bet_window:state.window,updated_at:new Date().toISOString()}).eq('id',1).select('id').maybeSingle();
   if(error) throw error;
   if(!data) throw new Error('HC2 pool row id=1 was not updated.');
 }

 const maxPrize=()=>round2(Math.min(state.window.reduce((s,x)=>s+Number(x||0),0),state.balance));
 function spin(userId,bet){const job=queue.then(async()=>{if(!loaded)await load();return doSpin(userId,bet);});queue=job.catch(()=>{});return job;}
 async function doSpin(userId,bet){
   const{data:afterBet,error}=await supabase.rpc('hc2_adjust_balance',{p_user:String(userId),p_delta:-bet});
   if(error) throw new Error('Balance debit failed: '+error.message);
   if(afterBet===null||afterBet===undefined) throw new Error('Insufficient account balance.');
   const before={balance:state.balance,house:state.house,window:[...state.window]};
   let prizeCredited=0;
   try {
     const toPool=round2(bet*(1-HC2.HOUSE_SHARE));
     state.house=round2(state.house+(bet-toPool));
     state.balance=round2(state.balance+toPool);
     state.window.push(toPool);
     while(state.window.length>HC2.WINDOW_BETS) state.window.shift();
     const max=maxPrize(),fitting=[];
     for(let i=0;i<HC2.CANDIDATES;i++){const c=makeCandidate(bet);if(c.prize<=max)fitting.push(c);}
     const result=fitting.length?fitting[rndInt(fitting.length)]:makeNoWin();
     let balanceNow=Number(afterBet);
     if(result.prize>0){
       const{data:afterWin,error:e2}=await supabase.rpc('hc2_adjust_balance',{p_user:String(userId),p_delta:result.prize});
       if(e2||afterWin===null||afterWin===undefined) throw new Error('Prize credit failed: '+(e2?.message||'balance function returned no balance'));
       prizeCredited=result.prize;
       balanceNow=Number(afterWin);
       state.balance=round2(state.balance-result.prize);
     }
     await save();
     const{error:logError}=await supabase.from('hc2_spins').insert({user_id:String(userId),bet,max_prize:max,payout:result.prize,pool_after:state.balance,result:{grid:result.grid,wins:result.wins,bonus:result.bonus}});
     if(logError) console.error('[HC2] spin log insert failed:',logError.message);
     return{result,maxPrize:max,balance:round2(balanceNow),pool:state.balance};
   } catch(err) {
     // Best-effort compensation. A true all-or-nothing guarantee requires moving the
     // entire spin/pool update into one PostgreSQL transaction/RPC.
     state=before;
     if(prizeCredited>0){
       const{error:reverseError}=await supabase.rpc('hc2_adjust_balance',{p_user:String(userId),p_delta:-prizeCredited});
       if(reverseError) console.error('[HC2] CRITICAL: failed to reverse prize during recovery:',reverseError.message);
     }
     const{error:refundError}=await supabase.rpc('hc2_adjust_balance',{p_user:String(userId),p_delta:bet});
     if(refundError) console.error('[HC2] CRITICAL: failed to refund spin bet:',refundError.message);
     try { await save(); } catch(saveError) { console.error('[HC2] CRITICAL: pool recovery save failed:',saveError.message); }
     throw err;
   }
 }
 return{load,spin};}
class UserError extends Error{}
function registerHitCoins2(io,supabase){const pool=createPool(supabase);pool.load().catch(()=>{});io.on('connection',socket=>{socket.on('hc2Spin',async data=>{const requestId=data&&data.requestId;let locked=false;try{const userId=socket.userId;const bet=Number(data&&data.bet);if(!userId)throw new UserError('Please reload the game.');if(!HC2.BET_AMOUNTS.includes(bet))throw new UserError('Invalid bet.');if(socket.hc2Busy)throw new UserError('Spin in progress.');socket.hc2Busy=true;locked=true;const out=await pool.spin(userId,bet);socket.emit('hc2SpinResult',{requestId,grid:out.result.grid,lineWins:out.result.wins,bonus:out.result.bonus,payout:out.result.prize,balance:out.balance});}catch(e){if(!(e instanceof UserError)&&e.message!=='Insufficient account balance.')console.error('[HC2] spin error:',e);const known=e instanceof UserError||e.message==='Insufficient account balance.';socket.emit('hc2Error',{requestId,message:known?e.message:'Spin failed. Please try again.'});}finally{if(locked)socket.hc2Busy=false;}});});}


// Register Hit Coins 2 on the same Socket.IO server and Supabase client.
// The existing initUser handler above assigns socket.userId.
registerHitCoins2(io, supabase);
