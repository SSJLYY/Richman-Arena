/* ============================================================
   Monopoly Online - Game Server (v2.2 Enhanced)
   - Token-based identity (refresh-proof reconnect)
   - AI Bot players (single player friendly)
   - v2.2: fixed hotel rent (was 0), GO double-pay, creditor
     inheritance on bankruptcy; classic jail (try doubles or
     pay bail), full-group x2 base rent, per-group build cost,
     120s turn timeout, round counter, per-cell rent in state
   - Health check endpoint & idle room cleanup
   - v2.18: utility rent NaN fix (dice passed as sum), turn deadlock
     after debt-timeout bankruptcy, jail kills double-roll bonus,
     host-only start/reset, min auction bid step, bot bail -> jackpot
   ============================================================ */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 8081;

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    // Prevent stale frontend code (root cause of "buttons do nothing")
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

// ============================================================
// GAME CONSTANTS & DATA
// ============================================================
const MAP_SIZE = 40;
const INIT_MONEY = 15000;
const GO_SALARY = 2000;
const JAIL_FINE = 1000;
const JAIL_MAX_TURNS = 3;
const TAX_AMOUNT = 2000;
const LUXURY_TAX = 1000;
const MORTGAGE_RATE = 0.5;
const UNMORTGAGE_FEE = 1.1;
const TURN_TIMEOUT = 120000; // 2 min without action -> auto end turn

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];
const PLAYER_AVATARS = ['🧑', '👩', '👨', '👴', '👵', '🧒', '👦', '👧', '🦸', '🦹', '🧙', '🧚', '🧛', '🧜', '🧝', '🧞'];
const BOT_NAMES = ['机器人阿福', '机器人贝贝', '机器人旺财', '机器人来福', '机器人豆豆', '机器人球球', '机器人布丁'];

// rents: [空地, 1房, 2房, 3房, 4房, 🏨酒店]（空地且集齐全组时 ×2）
// houseCost: 每升一级的建造费（铁路/公用事业不可建造）
const GROUP_INFO = {
  brown:    { name: '棕色系', color: '#8B4513', houseCost: 500,  rents: [100, 500, 1500, 4500, 6250, 7500] },
  lightblue:{ name: '浅蓝系', color: '#5DADE2', houseCost: 500,  rents: [200, 600, 1800, 5000, 7000, 9000] },
  pink:     { name: '粉色系', color: '#EC407A', houseCost: 1000, rents: [300, 900, 2700, 6000, 9000, 11000] },
  orange:   { name: '橙色系', color: '#E67E22', houseCost: 1000, rents: [400, 1000, 3000, 7000, 9500, 12000] },
  red:      { name: '红色系', color: '#E74C3C', houseCost: 1500, rents: [500, 1500, 4500, 8000, 11000, 13500] },
  yellow:   { name: '黄色系', color: '#F1C40F', houseCost: 1500, rents: [600, 1800, 5000, 9000, 12000, 14500] },
  green:    { name: '绿色系', color: '#27AE60', houseCost: 2000, rents: [700, 2000, 5500, 9500, 13000, 16000] },
  darkblue: { name: '深蓝系', color: '#2C3E50', houseCost: 2000, rents: [800, 2000, 6000, 10000, 15000, 18000] },
  railroad: { name: '铁路',    color: '#7F8C8D', houseCost: 0,    rents: [250, 500, 1000, 2000] },
  utility:  { name: '公用事业', color: '#8E44AD', houseCost: 0,   rents: [] },
};

const BOARD_TEMPLATE = [
  {id:0, type:'go',        name:'起点',       group:null,       price:0,   pos:{r:10,c:10}},
  {id:1, type:'city',      name:'地中海大道', group:'brown',    price:600, pos:{r:10,c:9}},
  {id:2, type:'chest',     name:'基金',       group:null,       price:0,   pos:{r:10,c:8}},
  {id:3, type:'city',      name:'波罗的海大道',group:'brown',   price:600, pos:{r:10,c:7}},
  {id:4, type:'tax',       name:'所得税',     group:null,       price:0,   pos:{r:10,c:6}},
  {id:5, type:'railroad',  name:'雷丁铁路',   group:'railroad', price:2000,pos:{r:10,c:5}},
  {id:6, type:'city',      name:'东方大道',   group:'lightblue',price:1000,pos:{r:10,c:4}},
  {id:7, type:'chance',    name:'机会',       group:null,       price:0,   pos:{r:10,c:3}},
  {id:8, type:'city',      name:'佛蒙特大道', group:'lightblue',price:1000,pos:{r:10,c:2}},
  {id:9, type:'city',      name:'康涅狄格大道',group:'lightblue',price:1200,pos:{r:10,c:1}},
  {id:10,type:'jail',      name:'监狱/参观',  group:null,       price:0,   pos:{r:10,c:0}},
  {id:11,type:'city',      name:'圣查尔斯广场',group:'pink',    price:1400,pos:{r:9,c:0}},
  {id:12,type:'utility',   name:'电力公司',   group:'utility',  price:1500,pos:{r:8,c:0}},
  {id:13,type:'city',      name:'州政府大道', group:'pink',     price:1400,pos:{r:7,c:0}},
  {id:14,type:'city',      name:'弗吉尼亚大道',group:'pink',    price:1600,pos:{r:6,c:0}},
  {id:15,type:'railroad',  name:'宾夕法尼亚铁路',group:'railroad',price:2000,pos:{r:5,c:0}},
  {id:16,type:'city',      name:'圣詹姆斯广场',group:'orange',  price:1800,pos:{r:4,c:0}},
  {id:17,type:'chest',     name:'基金',       group:null,       price:0,   pos:{r:3,c:0}},
  {id:18,type:'city',      name:'田纳西大道', group:'orange',   price:1800,pos:{r:2,c:0}},
  {id:19,type:'city',      name:'纽约大道',   group:'orange',   price:2000,pos:{r:1,c:0}},
  {id:20,type:'parking',   name:'免费停车场', group:null,       price:0,   pos:{r:0,c:0}},
  {id:21,type:'city',      name:'肯塔基大道', group:'red',      price:2200,pos:{r:0,c:1}},
  {id:22,type:'chance',    name:'机会',       group:null,       price:0,   pos:{r:0,c:2}},
  {id:23,type:'city',      name:'印第安纳大道',group:'red',    price:2200,pos:{r:0,c:3}},
  {id:24,type:'city',      name:'伊利诺伊大道',group:'red',    price:2400,pos:{r:0,c:4}},
  {id:25,type:'railroad',  name:'B&O铁路',    group:'railroad', price:2000,pos:{r:0,c:5}},
  {id:26,type:'city',      name:'大西洋大道', group:'yellow',   price:2600,pos:{r:0,c:6}},
  {id:27,type:'city',      name:'文托诺大道', group:'yellow',   price:2600,pos:{r:0,c:7}},
  {id:28,type:'utility',   name:'水务公司',   group:'utility',  price:1500,pos:{r:0,c:8}},
  {id:29,type:'city',      name:'马文花园',   group:'yellow',   price:2800,pos:{r:0,c:9}},
  {id:30,type:'gotojail',  name:'去监狱',     group:null,       price:0,   pos:{r:0,c:10}},
  {id:31,type:'city',      name:'太平洋大道', group:'green',    price:3000,pos:{r:1,c:10}},
  {id:32,type:'city',      name:'北卡罗来纳大道',group:'green',price:3000,pos:{r:2,c:10}},
  {id:33,type:'chest',     name:'基金',       group:null,       price:0,   pos:{r:3,c:10}},
  {id:34,type:'city',      name:'宾夕法尼亚大道',group:'green', price:3200,pos:{r:4,c:10}},
  {id:35,type:'railroad',  name:'短程铁路',   group:'railroad', price:2000,pos:{r:5,c:10}},
  {id:36,type:'chance',    name:'机会',       group:null,       price:0,   pos:{r:6,c:10}},
  {id:37,type:'city',      name:'公园大道',   group:'darkblue', price:3500,pos:{r:7,c:10}},
  {id:38,type:'tax',       name:'豪华税',     group:null,       price:0,   pos:{r:8,c:10}},
  {id:39,type:'city',      name:'华尔街',     group:'darkblue', price:4000,pos:{r:9,c:10}},
];

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// 中国城市版：仅替换地名，结构与平衡与经典版完全一致
const CHINA_NAMES = {
  1: '兰州', 3: '贵阳', 6: '南宁', 8: '太原', 9: '石家庄',
  11: '长春', 13: '哈尔滨', 14: '呼和浩特',
  16: '郑州', 18: '长沙', 19: '合肥',
  21: '大连', 23: '青岛', 24: '济南',
  26: '温州', 27: '宁波', 29: '无锡',
  31: '沈阳', 32: '武汉', 34: '西安',
  37: '南京', 39: '北京',
  5: '北京南站', 15: '上海虹桥站', 25: '广州南站', 35: '成都东站',
  12: '国家电网', 28: '中国水务',
};
const WULIN_NAMES = {
  1: '丐帮', 3: '少林', 6: '峨眉', 8: '华山', 9: '武当',
  11: '崆峒', 13: '昆仑', 14: '青城',
  16: '明教', 18: '日月神教', 19: '逍遥派',
  21: '大理', 23: '桃花岛', 24: '古墓派',
  26: '星宿海', 27: '灵鹫宫', 29: '侠客岛',
  31: '血刀门', 32: '五毒教', 34: '神龙教',
  37: '移花宫', 39: '魔教总坛',
  5: '江南镖局', 15: '漕运码头', 25: '塞北马场', 35: '万里镖行',
  12: '铸剑山庄', 28: '药王谷',
};
const scalePrice = (p) => Math.max(100, Math.round((p * 0.6) / 100) * 100);
const MAPS = {
  classic: { name: '经典版', cells: BOARD_TEMPLATE, rentMul: 1, houseMul: 1 },
  china: { name: '中国城市版', cells: BOARD_TEMPLATE.map(c => CHINA_NAMES[c.id] ? { ...c, name: CHINA_NAMES[c.id] } : c), rentMul: 1, houseMul: 1 },
  // 武林风云版：经济全面六折，配合回合上限就是 20 分钟快速局
  wulin: {
    name: '武林风云版',
    cells: BOARD_TEMPLATE.map(c => {
      const base = CHINA_NAMES[c.id] ? { ...c, name: WULIN_NAMES[c.id] || c.name, price: c.price ? scalePrice(c.price) : 0 } : c;
      if (c.id === 36) return { ...base, type: 'casino', name: '赌坊', chance: undefined }; // 武林图专属：赌坊
      return base;
    }),
    rentMul: 0.6, houseMul: 0.6,
  },
};

// ============================================================
// CARD DECKS
// action(p, r) returns optional { teleport: true, ... } to
// indicate position was set directly (re-resolve landing)
// ============================================================
const CHANCE_CARDS = [
  {text:'前进到起点，领取工资¥2000', action:(p)=>{p.pos=0;p.money+=GO_SALARY;}},
  {text:'前进到伊利诺伊大道', action:(p)=>{p.pos=24;return{teleport:true};}},
  {text:'前进到圣查尔斯广场', action:(p)=>{p.pos=11;return{teleport:true};}},
  {text:'前进到电力公司，租金10倍', action:(p)=>{p.pos=12;return{teleport:true,utilityX10:true};}},
  {text:'前进到最近的铁路，租金2倍', action:(p,r)=>{p.pos=nearestOf(r,p.pos,'railroad');return{teleport:true,railX2:true};}},
  {text:'银行支付你股息 ¥500', action:(p)=>{p.money+=500;}},
  {text:'因公务外出，获得 ¥1000', action:(p)=>{p.money+=1000;}},
  {text:'中奖！获得 ¥1500', action:(p)=>{p.money+=1500;}},
  {text:'支付医院费 ¥1000', action:(p)=>{p.money-=1000;}},
  {text:'支付学费 ¥1500', action:(p)=>{p.money-=1500;}},
  {text:'直接去监狱，不经过起点', action:(p)=>{p.pos=10;p.jailTurns=JAIL_MAX_TURNS;return{teleport:true,jailed:true};}},
  {text:'出狱免费卡', action:(p)=>{p.jailFreeCards=(p.jailFreeCards||0)+1;}},
  {text:'修缮房屋，每栋¥250，每酒店¥1000', action:(p,r)=>{let cost=0;r.board.forEach(c=>{if(c.owner===p.id&&c.type==='city'){cost+=c.level>=5?1000:250*c.level;}});p.money-=cost;}},
  {text:'后退3格', action:(p)=>{p.pos=(p.pos-3+MAP_SIZE)%MAP_SIZE;return{teleport:true,backwards:true};}},
];

const CHEST_CARDS = [
  {text:'银行出错，获利 ¥2000', action:(p)=>{p.money+=2000;}},
  {text:'医生费 ¥500', action:(p)=>{p.money-=500;}},
  {text:'出售股票获利 ¥450', action:(p)=>{p.money+=450;}},
  {text:'继承遗产 ¥1000', action:(p)=>{p.money+=1000;}},
  {text:'生日收礼，每人给你 ¥500', action:(p,r)=>{let g=0;r.order.forEach(id=>{const o=r.players[id];if(o&&o.id!==p.id&&!o.bankrupt){const amt=Math.min(500,o.money);o.money-=amt;g+=amt;}});p.money+=g;}},
  {text:'人寿保险到期 ¥1000', action:(p)=>{p.money+=1000;}},
  {text:'支付医院费 ¥1000', action:(p)=>{p.money-=1000;}},
  {text:'支付学费 ¥1500', action:(p)=>{p.money-=1500;}},
  {text:'收到咨询费 ¥2500', action:(p)=>{p.money+=2500;}},
  {text:'维修房屋，每栋¥400，每酒店¥1150', action:(p,r)=>{let cost=0;r.board.forEach(c=>{if(c.owner===p.id&&c.type==='city'){cost+=c.level>=5?1150:400*c.level;}});p.money-=cost;}},
  {text:'你中了二等奖 ¥100', action:(p)=>{p.money+=100;}},
  {text:'出狱免费卡', action:(p)=>{p.jailFreeCards=(p.jailFreeCards||0)+1;}},
  {text:'前进到起点', action:(p)=>{p.pos=0;p.money+=GO_SALARY;}},
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function nearestOf(room, fromPos, type) {
  for (let i = 1; i <= MAP_SIZE; i++) {
    const id = (fromPos + i) % MAP_SIZE;
    if (room.board[id].group === type) return id;
  }
  return fromPos;
}

// ============================================================
// ROOM & PLAYER MANAGEMENT
// ============================================================
const rooms = {};
const socketToken = {}; // socket.id -> player token

function createRoom(id, mapId = 'classic') {
  return {
    id,
    mapId: MAPS[mapId] ? mapId : 'classic',
    hostToken: null,
    players: {},          // token -> player
    order: [],            // [token]
    turnIndex: 0,
    started: false,
    ended: false,
    board: deepClone(MAPS[mapId] ? MAPS[mapId].cells : BOARD_TEMPLATE),
    rentMul: MAPS[mapId] ? (MAPS[mapId].rentMul || 1) : 1,
    houseMul: MAPS[mapId] ? (MAPS[mapId].houseMul || 1) : 1,
    dice: null,
    diceAnim: false,
    doubleCount: 0,
    currentRolled: false,  // 真人已掷骰、处于购买决策阶段（结束回合才交棒）
    roundCount: 1,
    startedAt: null,       // 开局时间（start 时设置）
    turnStartedAt: Date.now(),
    auction: null,         // 当前拍卖 {no,cellId,topBid,topBidder,startedAt,endsAt}
    auctionNo: 0,
    debt: null,
    maxRounds: 0,          // 回合上限（0=不限），到时按净资产定胜负
    winnerToken: null,
    proposal: null,        // AI→真人的购地提案 {seq,from,to,cellId,price,expiresAt}
    proposalSeq: 0,
    settings: { startMoney: 15000, jackpotOn: true, auctionOn: true, turnTimeoutMs: 120000 },
    nwHistory: [],         // 每轮净资产快照 [{r, v:{token:net}}]
    bank: { houses: 32, hotels: 12 },  // 银行房源（经典规则）
    landingStats: {},      // 掷骰到访次数 {cellId: count}
    replay: [],            // 每轮棋盘快照（对局回放用）
    maxRent: null,         // 本局最大单笔租金 {amount,from,to,cell}
    password: null,        // 房间密码（null = 公开）
    trade: null,           // 待确认交易 {seq,from,to,giveMoney,giveProps,getMoney,getProps,expiresAt}
    tradeSeq: 0,
    lastCard: null,        // 最近抽的卡 {type,text,by,ts}（前端弹卡展示）            // 筹钱期 {seq,playerId,amount,creditorId,reason,deadline}
    debtSeq: 0,
    jackpot: 0,            // 停车场奖池（税+保释金）
    logs: [],
    chats: [],
    chanceDeck: shuffle([...CHANCE_CARDS]),
    chestDeck: shuffle([...CHEST_CARDS]),
    chanceIdx: 0,
    chestIdx: 0,
    lastActive: Date.now(),
    botTimers: [],
  };
}

function createPlayer(name, token, { isBot = false, avatar } = {}) {
  return {
    id: token, name, money: INIT_MONEY, pos: 0,
    jailTurns: 0, bankrupt: false, properties: [],
    jailFreeCards: 0,
    rentEarned: 0,         // 累计租金收入
    autoBuy: false,        // 落地自动购买（个人偏好）
    rentPaid: 0,           // 累计租金支出
    avatar: avatar || PLAYER_AVATARS[Math.floor(Math.random() * PLAYER_AVATARS.length)],
    isBot,
    delegated: false,      // 托管中：AI 代打（真人玩家功能）
    origName: null,        // 被机器人接管前的原名（重连收回用）
    origAvatar: null,
    connected: true, // 创建即在线；掉线由 leaveRoom/disconnect 置 false
    disconnAt: 0,
  };
}

function log(room, msg) {
  room.logs.push({ text: msg, ts: Date.now() });
  if (room.logs.length > 100) room.logs.shift();
  room.lastActive = Date.now();
}

// 建筑拆回银行（level 归零）
function bankReturn(room, cell) {
  if (!room.bank || !cell || cell.level <= 0) return;
  if (cell.level >= 5) room.bank.hotels += 1;
  else room.bank.houses += cell.level;
  cell.level = 0;
}

// 执行一笔已确认的交易
function executeTrade(room, t) {
  const from = room.players[t.from];
  const to = room.players[t.to];
  if (!from || !to) return false;
  from.money -= t.giveMoney; to.money += t.giveMoney;
  to.money -= t.getMoney; from.money += t.getMoney;
  t.giveProps.forEach(id => {
    const c = room.board[id];
    if (!c) return;
    c.owner = t.to;
    from.properties = from.properties.filter(x => x !== id);
    to.properties.push(id);
  });
  t.getProps.forEach(id => {
    const c = room.board[id];
    if (!c) return;
    c.owner = t.from;
    to.properties = to.properties.filter(x => x !== id);
    from.properties.push(id);
  });
  log(room, `🤝 ${from.name} 与 ${to.name} 完成交易`);
  settleDebtIfPossible(room);
  return true;
}

// bot 评估交易提议：收到价值 ≥ 给出价值 × 阈值 才接受
function botEvaluateTrade(room, bot, t) {
  const lvl = bot.botLevel || 'normal';
  const thresh = lvl === 'easy' ? 1.5 : lvl === 'hard' ? 0.95 : 1.15;
  const propVal = (id) => {
    const c = room.board[id];
    if (!c) return 0;
    let v = c.price;
    const total = room.board.filter(x => x.group === c.group && x.type === 'city').length;
    if (c.type === 'city' && c.group && total > 0 && countOwnedInGroup(room, bot.id, c.group) === total - 1) {
      v *= 1.6; // 差一块成套 → 志在必得
    }
    return v;
  };
  const received = (t.giveMoney || 0) + (t.giveProps || []).reduce((s, id) => s + propVal(id), 0);
  const given = (t.getMoney || 0) + (t.getProps || []).reduce((s, id) => s + propVal(id), 0);
  if (bot.money - (t.getMoney || 0) < 300) return false; // 现金缓冲
  return received >= given * thresh;
}

// 每轮棋盘快照（对局回放）：紧凑数组 + 该帧日志长度
function pushReplaySnapshot(room) {
  const cells = room.board.map(c => [c.owner || 0, c.level || 0, c.mortgaged ? 1 : 0]);
  const players = {};
  room.order.forEach(id => {
    const p = room.players[id];
    if (!p) return;
    players[id] = [p.pos, p.money, p.bankrupt ? 1 : 0];
  });
  room.replay.push({ r: room.roundCount, c: cells, p: players, lg: room.logs.length });
  if (room.replay.length > 80) room.replay.shift();
}

function playerNetWorth(room, playerId) {
  const p = room.players[playerId];
  if (!p) return 0;
  return p.money + (p.properties || []).reduce((s, id) => s + (room.board[id]?.price || 0), 0);
}

function concludeGame(room, alive, winnerId, reasonText) {
  room.ended = true;
  room.winnerToken = winnerId || null;
  if (winnerId) {
    log(room, `🎉 游戏结束！${room.players[winnerId].name} 获胜！${reasonText || ''}`);
    if (room.players[winnerId].isBot) botSay(room, room.players[winnerId], 'win', 0.7);
  } else {
    log(room, '游戏结束，平局！');
  }
  // 战绩持久化（真人玩家）
  room.order.forEach(id => {
    const p = room.players[id];
    if (!p || p.isBot) return;
    const s = stats[p.name] || (stats[p.name] = { games: 0, wins: 0, bestNet: 0 });
    s.games++;
    if (winnerId && id === winnerId) s.wins++;
    s.bestNet = Math.max(s.bestNet, playerNetWorth(room, id));
  });
  saveStats();
  // 历史对局档案（保留最近 20 条）
  recentGames.push({
    date: new Date().toISOString(),
    map: room.mapId,
    rounds: room.roundCount,
    winner: winnerId ? (room.players[winnerId] ? room.players[winnerId].name : null) : null,
    reason: reasonText || '淘汰制',
    players: room.order.map(id => { const p = room.players[id]; return p ? p.name : '?'; }),
  });
  if (recentGames.length > 20) recentGames = recentGames.slice(-20);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(recentGames));
  } catch (e) {}
  clearBotTimers(room);
  io.emit('roomList', roomList());
}

function checkEnd(room) {
  const alive = room.order.filter(id => !room.players[id]?.bankrupt);
  if (alive.length <= 1 && room.started) {
    concludeGame(room, alive, alive.length === 1 ? alive[0] : null);
  }
}

// 回合上限：到时净资产最高者获胜
function checkRoundLimit(room) {
  if (!room.started || room.ended || !room.maxRounds) return;
  if (room.roundCount <= room.maxRounds) return;
  const alive = room.order.filter(id => !room.players[id]?.bankrupt);
  if (!alive.length) { concludeGame(room, alive, null); return; }
  const best = alive.slice().sort((a, b) => playerNetWorth(room, b) - playerNetWorth(room, a))[0];
  concludeGame(room, alive, best, `（${room.maxRounds} 回合上限已到，净资产最高者获胜）`);
}

function getPublicState(room) {
  return {
    id: room.id,
    hostToken: room.hostToken,
    players: room.players,
    order: room.order,
    turnIndex: room.turnIndex,
    started: room.started,
    ended: room.ended,
    // per-cell computed rent (utility owned -> -1 sentinel: dice-based)
    board: room.board.map(c => ({
      ...c,
      rent: (!c.owner || c.mortgaged) ? 0 : (c.group === 'utility' ? -1 : calcRent(room, c.id, 7)),
    })),
    dice: room.dice,
    diceAnim: room.diceAnim,
    currentRolled: room.currentRolled,
    auction: room.auction ? {
      no: room.auction.no, cellId: room.auction.cellId,
      topBid: room.auction.topBid, topBidder: room.auction.topBidder,
      initiator: room.auction.initiator,
      bids: room.auction.bids.slice(-5),
      endsAt: room.auction.endsAt,
    } : null,
    jackpot: room.jackpot,
    maxRounds: room.maxRounds,
    winnerToken: room.winnerToken,
    settings: room.settings,
    groups: GROUP_INFO, // 色系租金/建造费单一数据源，前端不再硬编码
    mapId: room.mapId,
    mapName: MAPS[room.mapId] ? MAPS[room.mapId].name : '经典版',
    rentMul: room.rentMul || 1,
    houseMul: room.houseMul || 1,
    nwHistory: room.nwHistory.slice(-100),
    bank: room.bank,
    maxRent: room.maxRent,
    startedAt: room.startedAt,
    lastRentPaid: room.lastRentPaid,
    landingStats: room.landingStats,
    replay: room.replay,
    trade: room.trade ? {
      seq: room.trade.seq, from: room.trade.from, to: room.trade.to,
      giveMoney: room.trade.giveMoney, getMoney: room.trade.getMoney,
      giveProps: room.trade.giveProps, getProps: room.trade.getProps,
      expiresAt: room.trade.expiresAt,
    } : null,
    proposal: room.proposal ? {
      seq: room.proposal.seq, from: room.proposal.from, to: room.proposal.to,
      cellId: room.proposal.cellId, price: room.proposal.price, expiresAt: room.proposal.expiresAt,
    } : null,
    lastCard: room.lastCard,
    spectatorCount: (() => {
      const socks = io.sockets.adapter.rooms.get(room.id);
      const humans = room.order.filter(t => {
        const p = room.players[t];
        return p && !p.isBot && p.connected;
      }).length;
      return Math.max(0, (socks ? socks.size : 0) - humans);
    })(),
    debt: room.debt ? {
      playerId: room.debt.playerId, amount: room.debt.amount,
      creditorId: room.debt.creditorId, reason: room.debt.reason,
      deadline: room.debt.deadline,
    } : null,
    roundCount: room.roundCount,
    turnStartedAt: room.turnStartedAt,
    turnTimeoutMs: (room.settings && room.settings.turnTimeoutMs) || TURN_TIMEOUT,
    logs: room.logs.slice(-50),
    chats: room.chats.slice(-50),
  };
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (room) { io.to(roomId).emit('state', getPublicState(room)); queueSave(); }
}

function roomList() {
  return Object.values(rooms).map(r => {
    const sockCount = io.sockets.adapter.rooms.get(r.id)?.size || 0;
    const humans = r.order.filter(t => {
      const p = r.players[t];
      return p && !p.isBot && p.connected;
    }).length;
    return {
      id: r.id,
      playerCount: r.order.length,
      started: r.started,
      ended: r.ended,
      spectators: Math.max(0, sockCount - humans),
      mapName: MAPS[r.mapId] ? MAPS[r.mapId].name : '经典版',
      locked: !!r.password,
    };
  });
}

// ── 简单速率限制（防聊天/出价刷屏）──
const rateLimit = {};
function allowRate(socket, key, max, windowMs) {
  const now = Date.now();
  const k = socket.id + ':' + key;
  const e = rateLimit[k] || (rateLimit[k] = { n: 0, ts: now });
  if (now - e.ts > windowMs) { e.n = 0; e.ts = now; }
  e.n++;
  return e.n <= max;
}

// ============================================================
// GAME LOGIC HELPERS
// ============================================================
function nextTurn(room) {
  room.doubleCount = 0;
  room.currentRolled = false;
  let tries = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.order.length;
    tries++;
  } while (room.players[room.order[room.turnIndex]]?.bankrupt && tries < room.order.length * 2);
  if (room.turnIndex === 0) {
    room.roundCount++;
    // 每轮净资产快照
    const snap = { r: room.roundCount - 1, v: {} };
    room.order.forEach(id => {
      const p = room.players[id];
      if (p && !p.bankrupt) snap.v[id] = playerNetWorth(room, id);
    });
    room.nwHistory.push(snap);
    if (room.nwHistory.length > 200) room.nwHistory.shift();
    pushReplaySnapshot(room);
    checkRoundLimit(room);
  }
  room.turnStartedAt = Date.now();
}

function currentPlayer(room) {
  const pid = room.order[room.turnIndex];
  return pid ? room.players[pid] : null;
}

function countOwnedInGroup(room, playerId, group) {
  return room.board.filter(c => c.owner === playerId && c.group === group).length;
}

function houseCostOf(room, cell) {
  const base = (GROUP_INFO[cell.group] && GROUP_INFO[cell.group].houseCost) || 0;
  return Math.floor(base * (room.houseMul || 1));
}

function ownsFullGroup(room, playerId, group) {
  if (!group || group === 'railroad' || group === 'utility') return false;
  const total = BOARD_TEMPLATE.filter(c => c.group === group).length;
  return countOwnedInGroup(room, playerId, group) === total;
}

function calcRent(room, cellId, dice = null, { railX2 = false, utilityX10 = false } = {}) {
  const cell = room.board[cellId];
  const g = cell.group;
  if (!g || cell.owner == null || cell.mortgaged) return 0;
  const rentMul = room.rentMul || 1;
  if (g === 'railroad') {
    const n = countOwnedInGroup(room, cell.owner, 'railroad');
    let rent = GROUP_INFO.railroad.rents[Math.max(1, n) - 1];
    if (railX2) rent *= 2;
    return Math.round(rent * rentMul);
  }
  if (g === 'utility') {
    if (!dice) return 0;
    if (utilityX10) return dice * 100; // "租金10倍"卡
    const n = countOwnedInGroup(room, cell.owner, 'utility');
    return Math.round(dice * (n === 2 ? 100 : 40) * rentMul);
  }
  // city: 6级租金表（0空地 .. 5酒店）；空地且集齐全组 → 基础租金×2
  const info = GROUP_INFO[g];
  if (!info) return 0;
  let rent = info.rents[Math.min(cell.level, 5)];
  if (cell.level === 0 && ownsFullGroup(room, cell.owner, g)) rent *= 2;
  return Math.round(rent * rentMul);
}

function canBuild(room, playerId, cell) {
  if (cell.type !== 'city' || cell.owner !== playerId || cell.mortgaged) return false;
  const group = cell.group;
  if (!ownsFullGroup(room, playerId, group)) return false;
  const minLevel = Math.min(...room.board.filter(c => c.group === group).map(c => c.level));
  return cell.level === minLevel && cell.level < 5;
}

function canSell(room, playerId, cell) {
  if (cell.type !== 'city' || cell.owner !== playerId || cell.level <= 0) return false;
  const group = cell.group;
  const maxLevel = Math.max(...room.board.filter(c => c.group === group).map(c => c.level));
  return cell.level >= maxLevel;
}

function handleBankruptcy(room, player, creditorId = null) {
  if (player.bankrupt) return;
  if (room.debt && room.debt.playerId === player.id) room.debt = null;
  const creditor = creditorId ? room.players[creditorId] : null;
  if (creditor && !creditor.bankrupt) {
    // 债主继承：现金 + 全部地产（保留建筑与抵押状态）
    creditor.money += player.money;
    player.properties.forEach(id => {
      const c = room.board[id];
      if (c) c.owner = creditorId;
    });
    creditor.properties.push(...player.properties);
    log(room, `💀 ${player.name} 破产！现金与地产全部移交给 ${creditor.name}`);
  } else {
    room.board.forEach(c => {
      if (c.owner === player.id) { c.owner = null; c.mortgaged = false; bankReturn(room, c); }
    });
    log(room, `💀 ${player.name} 破产！地产归还银行`);
  }
  player.money = 0;
  player.bankrupt = true;
  player.properties = [];
  if (player.isBot) botSay(room, player, 'bankrupt', 0.6);
  checkEnd(room);
}

const DEBT_MS = 30000; // 筹钱期时长

function charge(room, player, amount, reason, creditorId = null) {
  if (amount <= 0) return true;
  if (player.money >= amount) {
    player.money -= amount;
    if (reason === 'rent') {
      player.rentPaid = (player.rentPaid || 0) + amount;
      if (creditorId && room.players[creditorId]) room.players[creditorId].rentEarned = (room.players[creditorId].rentEarned || 0) + amount;
    }
    if (creditorId && room.players[creditorId]) room.players[creditorId].money += amount;
    return true;
  }
  // 无力支付 → 进入 30 秒筹钱期（紧急卖楼/抵押），到期未筹齐才破产
  const label = reason === 'rent' ? '租金' : reason === 'tax' ? '税款' : '费用';
  const seq = (room.debtSeq = (room.debtSeq || 0) + 1);
  room.debt = {
    seq, playerId: player.id, amount,
    creditorId: creditorId || null, reason,
    deadline: Date.now() + DEBT_MS,
  };
  log(room, `💸 ${player.name} 无力支付${label} ¥${amount}！进入 30 秒筹钱期…`);
  if (player.isBot || player.delegated) botAddTimer(room, () => botSettleDebt(room), 600);
  botAddTimer(room, () => {
    if (room.debt && room.debt.seq === seq) botSettleDebt(room);
  }, DEBT_MS + 100);
  return false;
}

// 欠款可付则立即结算（税款入奖池）
function settleDebtIfPossible(room) {
  const d = room.debt;
  if (!d) return false;
  const p = room.players[d.playerId];
  if (!p || p.bankrupt) { room.debt = null; return false; }
  if (p.money < d.amount) return false;
  p.money -= d.amount;
  const creditor = d.creditorId ? room.players[d.creditorId] : null;
  if (d.reason === 'rent') p.rentPaid = (p.rentPaid || 0) + d.amount;
  if (creditor && !creditor.bankrupt) {
    creditor.money += d.amount;
    if (d.reason === 'rent') creditor.rentEarned = (creditor.rentEarned || 0) + d.amount;
    log(room, `✅ ${p.name} 支付欠款 ¥${d.amount} 给 ${creditor.name}`);
  } else if (d.reason === 'tax') {
    room.jackpot += d.amount;
    log(room, `✅ ${p.name} 缴清税款 ¥${d.amount}（入奖池）`);
  } else {
    log(room, `✅ ${p.name} 支付欠款 ¥${d.amount}`);
  }
  room.debt = null;
  return true;
}

// AI/超时清算：紧急卖楼 → 抵押 → 仍不够则破产
function botSettleDebt(room) {
  const d = room.debt;
  if (!d) return;
  const p = room.players[d.playerId];
  if (!p || p.bankrupt) { room.debt = null; return; }
  while (p.money < d.amount) {
    const sellable = p.properties.map(id => room.board[id]).filter(c => c && canSell(room, p.id, c));
    if (!sellable.length) break;
    const c = sellable[0];
    const refund = Math.floor(houseCostOf(room, c) / 2);
    if (c.level >= 5) room.bank.hotels += 1;
    else room.bank.houses += 1;
    c.level--;
    p.money += refund;
    log(room, `🔨 ${p.name} 紧急出售 ${c.name} 建筑（+¥${refund}）`);
  }
  while (p.money < d.amount) {
    const mortgageable = p.properties
      .map(id => room.board[id])
      .filter(c => c && c.owner === p.id && !c.mortgaged && (c.type !== 'city' || c.level === 0))
      .sort((a, b) => a.price - b.price);
    if (!mortgageable.length) break;
    const c = mortgageable[0];
    c.mortgaged = true;
    const val = Math.floor(c.price * MORTGAGE_RATE);
    p.money += val;
    log(room, `🏦 ${p.name} 紧急抵押 ${c.name}（+¥${val}）`);
  }
  if (!settleDebtIfPossible(room)) {
    log(room, `💀 ${p.name} 筹钱失败！`);
    room.debt = null;
    handleBankruptcy(room, p, d.creditorId);
    // 破产者若仍是当前回合玩家，必须交棒，否则整局卡死（多人局）
    if (!room.ended && currentPlayer(room)?.id === p.id) nextTurn(room);
  }
  broadcast(room.id);
  scheduleAIIfAny(room);
}

// ------------------------------------------------------------
// Unified landing logic (used by normal move and teleport cards)
// ------------------------------------------------------------
function landOn(room, player, dice, opts = {}) {
  const cell = room.board[player.pos];

  switch (cell.type) {
    case 'go':
      // 经过/停在起点的工资已在 movePlayer 的路途结算中发放，避免双倍
      log(room, `🏁 ${player.name} 正好停在起点！`);
      break;

    case 'city':
    case 'railroad':
    case 'utility': {
      if (cell.owner && cell.owner !== player.id) {
        const owner = room.players[cell.owner];
        if (owner && !owner.bankrupt && !cell.mortgaged) {
          const rent = calcRent(room, cell.id, dice, opts);
          log(room, `💸 ${player.name} 向 ${owner.name} 支付 ${cell.name} 过路费 ¥${rent}`);
          if (player.isBot) botSay(room, player, 'rentPay', 0.25);
          else if (owner.isBot) botSay(room, owner, 'rentGet', 0.2);
          if (!room.maxRent || rent > room.maxRent.amount) {
            room.maxRent = { amount: rent, from: player.name, to: owner.name, cell: cell.name };
          }
          room.lastRentPaid = { cellId: cell.id, amount: rent, ts: Date.now() };
          cell.incomeEarned = (cell.incomeEarned || 0) + rent;
          charge(room, player, rent, 'rent', cell.owner);
        }
      } else if (!cell.owner && !player.bankrupt) {
        // 无主地产：机器人/托管玩家按 AI 策略立即购买；真人开了自动购买也直接买
        if (player.isBot || player.delegated) {
          botTryBuy(room, player);
        } else if (player.autoBuy && player.money >= cell.price + 200) {
          player.money -= cell.price;
          cell.owner = player.id;
          cell.level = 0;
          cell.mortgaged = false;
          player.properties.push(cell.id);
          log(room, `🤖 ${player.name} 自动购买了 ${cell.name}（¥${cell.price}）`);
        }
      }
      break;
    }

    case 'tax': {
      const tax = player.pos === 4 ? TAX_AMOUNT : LUXURY_TAX;
      log(room, `🏛️ ${player.name} 缴纳 ${cell.name} ¥${Math.min(tax, player.money)}`);
      if (charge(room, player, tax, 'tax') && room.settings.jackpotOn) room.jackpot += tax;
      break;
    }

    case 'gotojail':
      player.pos = 10;
      player.jailTurns = JAIL_MAX_TURNS;
      room.doubleCount = 0;
      log(room, `🚔 ${player.name} 被送进监狱！`);
      if (player.isBot) botSay(room, player, 'jail', 0.5);
      break;

    case 'jail':
      log(room, `🔒 ${player.name} 参观监狱`);
      break;

    case 'chance': {
      const card = room.chanceDeck[room.chanceIdx];
      room.chanceIdx = (room.chanceIdx + 1) % room.chanceDeck.length;
      log(room, `🃏 ${player.name} 抽到机会：${card.text}`);
      room.lastCard = { type: 'chance', text: card.text, by: player.name, ts: Date.now() };
      const ret = card.action(player, room) || {};
      if (ret.jailed) { broadcast(room.id); return; }
      if (ret.teleport) {
        landOn(room, player, dice, ret);
      }
      if (player.money < 0) handleBankruptcy(room, player);
      break;
    }

    case 'chest': {
      const card = room.chestDeck[room.chestIdx];
      room.chestIdx = (room.chestIdx + 1) % room.chestDeck.length;
      log(room, `📦 ${player.name} 抽到基金：${card.text}`);
      room.lastCard = { type: 'chest', text: card.text, by: player.name, ts: Date.now() };
      card.action(player, room);
      if (player.money < 0) handleBankruptcy(room, player);
      break;
    }

    case 'casino': {
      const stake = Math.round(600 * (room.rentMul || 1));
      const win = Math.random() < 0.5;
      const amount = Math.min(stake, Math.max(0, player.money));
      player.money += win ? amount : -amount;
      log(room, `🎰 ${player.name} 在赌坊${win ? '赢了' : '输了'} ¥${amount}${amount === 0 ? '（身无分文，庄家免单）' : ''}`);
      if (player.isBot) botSay(room, player, win ? 'rentGet' : 'rentPay', 0.3);
      break;
    }

    case 'parking':
      if (room.jackpot > 0) {
        player.money += room.jackpot;
        log(room, `🎁 ${player.name} 踩中停车场，赢走奖池 ¥${room.jackpot}！`);
        room.jackpot = 0;
      } else {
        log(room, `🅿️ ${player.name} 在免费停车场休息`);
      }
      break;
  }
}

function movePlayer(room, player, step, isDouble, dice) {
  const oldPos = player.pos;
  player.pos = (player.pos + step) % MAP_SIZE;
  if (player.pos < oldPos && oldPos !== 0) {
    player.money += GO_SALARY;
    log(room, `💰 ${player.name} 经过起点，获得 ¥${GO_SALARY}`);
  }
  room.landingStats[player.pos] = (room.landingStats[player.pos] || 0) + 1;
  landOn(room, player, dice);
  if (player.bankrupt) { nextTurn(room); return; }

  // 本回合落地入狱（踩"去监狱"或入狱卡）→ 回合立即结束，不享受双数额外回合
  if (player.jailTurns > 0) {
    if (player.isBot || player.delegated) nextTurn(room);
    else room.currentRolled = true; // 真人保留"结束回合"确认权
    return;
  }

  if (isDouble && room.started && !room.ended) {
    room.doubleCount++;
    if (room.doubleCount >= 3) {
      log(room, `🚔 ${player.name} 连续3次双数，直接入狱！`);
      player.pos = 10;
      player.jailTurns = JAIL_MAX_TURNS;
      room.doubleCount = 0;
      nextTurn(room);
    } else {
      log(room, `🎯 ${player.name} 掷出双数，获得额外回合！`);
      // same player rolls again - keep turnIndex
    }
    return;
  }
  // 非双数：真人停留决策阶段（可购买/结束回合），AI 直接交棒
  if (player.isBot || player.delegated) {
    nextTurn(room);
  } else {
    room.currentRolled = true;
  }
}

// 掷骰并移动（人类玩家通用路径）
function rollAndMove(room, player) {
  room.diceAnim = true;
  const d1 = Math.floor(Math.random() * 6) + 1;
  const d2 = Math.floor(Math.random() * 6) + 1;
  const step = d1 + d2;
  const isDouble = d1 === d2;
  room.dice = [d1, d2];
  log(room, `${player.name} 掷出 ${d1}+${d2}=${step}${isDouble ? ' 🎯双数！' : ''}`);
  broadcast(room.id);

  setTimeout(() => {
    if (!rooms[room.id] || rooms[room.id] !== room) return;
    room.diceAnim = false;
    movePlayer(room, player, step, isDouble, d1 + d2);
    if (!player.bankrupt && player.delegated) {
      // 托管：由 AI 收尾（盖房/再掷/结束回合）
      aiAfterMove(room, player);
    } else {
      broadcast(room.id);
      scheduleAIIfAny(room);
    }
  }, 900);
}

// 经典监狱规则：掷骰试双数（双数出狱并移动；第三次失败强制付罚款出狱）
function tryRollJail(room, player) {
  room.diceAnim = true;
  const d1 = Math.floor(Math.random() * 6) + 1;
  const d2 = Math.floor(Math.random() * 6) + 1;
  room.dice = [d1, d2];
  log(room, `🎲 ${player.name}（狱中）掷出 ${d1}+${d2}${d1 === d2 ? ' 双数！' : ''}`);
  broadcast(room.id);

  setTimeout(() => {
    if (!rooms[room.id] || rooms[room.id] !== room) return;
    room.diceAnim = false;
    if (d1 === d2) {
      player.jailTurns = 0;
      log(room, `🎉 ${player.name} 掷出双数，出狱！`);
      player.pos = (player.pos + d1 + d2) % MAP_SIZE;
      landOn(room, player, d1 + d2);
      // 狱中双数不再奖励额外回合；真人保留购买决策权
      if (!player.bankrupt) {
        if (player.isBot || player.delegated) nextTurn(room);
        else room.currentRolled = true;
      }
    } else {
      player.jailTurns--;
      if (player.jailTurns <= 0) {
        log(room, `⚖️ ${player.name} 三次未掷出双数，支付 ¥${JAIL_FINE} 强制出狱`);
        if (player.money >= JAIL_FINE) {
          player.money -= JAIL_FINE;
          player.pos = (player.pos + d1 + d2) % MAP_SIZE;
          landOn(room, player, d1 + d2);
          if (room.settings.jackpotOn) room.jackpot += JAIL_FINE;
          if (!player.bankrupt) {
            if (player.isBot || player.delegated) nextTurn(room);
            else room.currentRolled = true;
          }
        } else {
          handleBankruptcy(room, player);
          nextTurn(room);
        }
      } else {
        log(room, `🔒 ${player.name} 未掷出双数，继续服刑（剩 ${player.jailTurns} 回合）`);
        nextTurn(room);
      }
    }
    broadcast(room.id);
    scheduleAIIfAny(room);
  }, 900);
}

// ============================================================
// AUCTION（放弃购买的地块进入限时拍卖，价高者得）
// ============================================================
const AUCTION_MS = 20000;
const AUCTION_MAX_MS = 60000;
const BID_STEP = 100;

function startAuction(room, cellId, initiatorName) {
  if (room.auction) { log(room, `🔨 已有拍卖进行中，${room.board[cellId].name} 暂不拍卖`); return; }
  const cell = room.board[cellId];
  if (!cell || cell.owner || !['city', 'railroad', 'utility'].includes(cell.type)) return;
  room.auctionNo = (room.auctionNo || 0) + 1;
  room.auction = {
    no: room.auctionNo,
    cellId,
    topBid: 0,
    topBidder: null,
    initiator: initiatorName,
    bids: [],
    chains: {},
    startedAt: Date.now(),
    endsAt: Date.now() + AUCTION_MS,
  };
  log(room, `🔨 ${initiatorName} 放弃购买，「${cell.name}」进入拍卖！出价最高者得（¥${BID_STEP} 起）`);
  const talker = room.order.map(t => room.players[t]).find(p => p && p.isBot && !p.bankrupt);
  if (talker) botSay(room, talker, 'auction', 0.3);
  broadcast(room.id);
  scheduleBotBids(room);
  scheduleAuctionResolve(room);
}

function scheduleAuctionResolve(room) {
  if (!room.auction) return;
  const wait = Math.max(100, room.auction.endsAt - Date.now());
  botAddTimer(room, () => resolveAuction(room), wait);
}

// AI 对地块的估值上限
function auctionValue(room, player, cell) {
  let factor = 0.9;
  if (cell.type === 'city') {
    const owned = room.board.filter(c => c.group === cell.group && c.owner === player.id).length;
    const total = room.board.filter(c => c.group === cell.group).length;
    factor = owned > 0 ? 1.3 : 0.85;
    if (owned === total - 1) factor = 1.6; // 差这块成套，志在必得
    // 预判竞争：别的玩家只差这块就能成套 → 他们会疯抢，机器人也愿意抬价阻击
    if (owned < total - 1) {
      const rivalThreat = room.board.some(c => {
        if (c.group !== cell.group || c.type !== 'city' || c.owner === player.id || !c.owner) return false;
        const o = room.players[c.owner];
        if (!o || o.bankrupt) return false;
        return countOwnedInGroup(room, o.id, cell.group) === total - 1;
      });
      if (rivalThreat) factor = Math.max(factor, 1.25);
    }
  } else if (cell.type === 'railroad') {
    factor = 1.15;
  }
  return Math.min(Math.floor(cell.price * factor), Math.max(0, player.money - 500));
}

function scheduleBotBids(room) {
  const a = room.auction;
  if (!a) return;
  room.order.forEach(pid => {
    const p = room.players[pid];
    if (!p || p.bankrupt || (!p.isBot && !p.delegated)) return;
    if (a.chains[pid]) return; // 每场拍卖每个 AI 只挂一条出价链
    a.chains[pid] = true;
    const maxBid = auctionValue(room, p, room.board[a.cellId]);
    const bidChain = () => {
      const cur = room.auction;
      if (!cur || cur.no !== a.no || p.bankrupt) return;
      const step = BID_STEP * (1 + Math.floor(Math.random() * 3));
      const next = cur.topBid === 0
        ? Math.max(BID_STEP, Math.floor(room.board[a.cellId].price * 0.3))
        : cur.topBid + step;
      if (next <= maxBid && next <= p.money && cur.topBidder !== p.id) {
        placeBid(room, p, next);
      }
      const now = room.auction;
      if (now && now.no === a.no && !p.bankrupt && now.topBidder !== p.id &&
          now.topBid + BID_STEP <= Math.min(maxBid, p.money)) {
        botAddTimer(room, bidChain, 1000 + Math.floor(Math.random() * 1800));
      }
    };
    botAddTimer(room, bidChain, 800 + Math.floor(Math.random() * 2000));
  });
}

function placeBid(room, player, amount) {
  const a = room.auction;
  if (!a) return false;
  amount = Math.floor(Number(amount) || 0);
  const minBid = a.topBid === 0 ? BID_STEP : a.topBid + BID_STEP; // 必须整步加价，防止 1 元加价拖延
  if (player.bankrupt || amount < minBid || amount > player.money) return false;
  a.topBid = amount;
  a.topBidder = player.id;
  a.bids.push({ name: player.name, amount, ts: Date.now() });
  if (a.bids.length > 8) a.bids.shift();
  // 最后 5 秒内有人加价 → 顺延 5 秒（防狙击，总时长封顶）
  const now = Date.now();
  if (a.endsAt - now < 5000 && now + 5000 - a.startedAt < AUCTION_MAX_MS) {
    a.endsAt = now + 5000;
    scheduleAuctionResolve(room);
  }
  log(room, `🔨 ${player.name} 出价 ¥${amount}`);
  broadcast(room.id);
  scheduleBotBids(room);
  return true;
}

function resolveAuction(room) {
  const a = room.auction;
  if (!a) return;
  room.auction = null;
  const cell = room.board[a.cellId];
  const winner = a.topBidder ? room.players[a.topBidder] : null;
  if (winner && !winner.bankrupt && a.topBid > 0 && winner.money >= a.topBid) {
    winner.money -= a.topBid;
    cell.owner = winner.id;
    cell.level = 0;
    cell.mortgaged = false;
    winner.properties.push(cell.id);
    log(room, `🔨 ${winner.name} 以 ¥${a.topBid} 拍得「${cell.name}」！`);
    room.lastRentPaid = { cellId: cell.id, amount: a.topBid, ts: Date.now() };
    if (winner.isBot) botSay(room, winner, 'winAuc', 0.4);
  } else {
    log(room, `🔨 「${cell.name}」无人出价，流拍`);
  }
  broadcast(room.id);
  scheduleAIIfAny(room);
}

// 真人结束回合：踩着无主地块 = 放弃购买 → 拍卖，然后交棒
function endHumanTurn(room, player) {
  if (room.debt && room.debt.playerId === player.id) return; // 欠款未清不能跑（含回合超时路径）
  const cell = room.board[player.pos];
  if (cell && !cell.owner && ['city', 'railroad', 'utility'].includes(cell.type)) {
    if (room.settings.auctionOn) startAuction(room, cell.id, player.name);
  }
  nextTurn(room);
  broadcast(room.id);
  scheduleAIIfAny(room);
}

// ============================================================
// 战绩持久化（大厅排行榜）
// ============================================================
const DATA_DIR = path.resolve(__dirname, process.env.MONOPOLY_DATA_DIR || 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
let lastBackupDay = '';
function backupData() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackupDay) return;
  lastBackupDay = day;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    ['rooms.json', 'stats.json'].forEach(f => {
      const fp = path.join(DATA_DIR, f);
      if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(BACKUP_DIR, day + '-' + f));
    });
    fs.readdirSync(BACKUP_DIR)
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(7)
      .forEach(x => { try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch (e) {} });
  } catch (e) {}
}
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
let saveTimer = null;
function saveRoomsNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    Object.values(rooms).forEach(r => {
      out[r.id] = {
        id: r.id, hostToken: r.hostToken, players: r.players, order: r.order,
        turnIndex: r.turnIndex, started: r.started, ended: r.ended,
        board: r.board, dice: r.dice, currentRolled: r.currentRolled,
        roundCount: r.roundCount, turnStartedAt: r.turnStartedAt,
        jackpot: r.jackpot, maxRounds: r.maxRounds || 0, winnerToken: r.winnerToken || null,
        settings: r.settings, nwHistory: r.nwHistory.slice(-100), bank: r.bank, maxRent: r.maxRent || null, mapId: r.mapId || 'classic', landingStats: r.landingStats || {}, startedAt: r.startedAt || null, rentMul: r.rentMul || 1, houseMul: r.houseMul || 1, replay: r.replay || [],
        logs: r.logs.slice(-60), chats: r.chats.slice(-60),
        chanceOrder: r.chanceDeck.map(c => CHANCE_CARDS.indexOf(c)),
        chestOrder: r.chestDeck.map(c => CHEST_CARDS.indexOf(c)),
        chanceIdx: r.chanceIdx, chestIdx: r.chestIdx,
      };
    });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(out));
  } catch (e) {}
}
function queueSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRoomsNow(); }, 2000);
}
function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    Object.values(raw).forEach(s => {
      if (!s || !s.id || !Array.isArray(s.order)) return;
      const room = createRoom(s.id);
      room.hostToken = s.hostToken || null;
      room.players = s.players || {};
      room.order = s.order;
      room.turnIndex = s.turnIndex || 0;
      room.started = !!s.started;
      room.ended = !!s.ended;
      room.board = Array.isArray(s.board) ? s.board : room.board;
      room.dice = s.dice || null;
      room.currentRolled = !!s.currentRolled;
      room.roundCount = s.roundCount || 1;
      room.turnStartedAt = s.turnStartedAt || Date.now();
      room.jackpot = s.jackpot || 0;
      room.maxRounds = s.maxRounds || 0;
      room.winnerToken = s.winnerToken || null;
      if (s.settings && typeof s.settings === 'object') room.settings = { ...room.settings, ...s.settings };
      if (s.bank && typeof s.bank === 'object') room.bank = { houses: s.bank.houses ?? 32, hotels: s.bank.hotels ?? 12 };
      room.mapId = MAPS[s.mapId] ? s.mapId : 'classic';
      room.landingStats = s.landingStats && typeof s.landingStats === 'object' ? s.landingStats : {};
      room.startedAt = s.startedAt || null;
      room.replay = Array.isArray(s.replay) ? s.replay : [];
      room.rentMul = typeof s.rentMul === 'number' ? s.rentMul : 1;
      room.houseMul = typeof s.houseMul === 'number' ? s.houseMul : 1;
      room.maxRent = s.maxRent || null;
      room.nwHistory = Array.isArray(s.nwHistory) ? s.nwHistory : [];
      room.logs = Array.isArray(s.logs) ? s.logs : [];
      room.chats = Array.isArray(s.chats) ? s.chats : [];
      room.chanceDeck = (s.chanceOrder || []).map(i => CHANCE_CARDS[i]).filter(Boolean);
      if (!room.chanceDeck.length) room.chanceDeck = shuffle([...CHANCE_CARDS]);
      room.chestDeck = (s.chestOrder || []).map(i => CHEST_CARDS[i]).filter(Boolean);
      if (!room.chestDeck.length) room.chestDeck = shuffle([...CHEST_CARDS]);
      room.chanceIdx = s.chanceIdx || 0;
      room.chestIdx = s.chestIdx || 0;
      // 服务器重启后所有真人 socket 已断，重连自动恢复在线
      Object.values(room.players).forEach(p => { if (p && !p.isBot) p.connected = false; });
      rooms[room.id] = room;
      if (room.started && !room.ended) scheduleAIIfAny(room, 5000);
    });
    if (Object.keys(raw || {}).length) console.log(`[load] 恢复 ${Object.keys(raw).length} 个房间`);
  } catch (e) {}
}
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = {};
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
let recentGames = [];
try { recentGames = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { recentGames = []; }
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { stats = {}; }
function saveStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(recentGames));
  } catch (e) {}
}
function topStats(n = 10) {
  return Object.entries(stats)
    .map(([name, s]) => ({ name, games: s.games, wins: s.wins, bestNet: s.bestNet }))
    .sort((a, b) => b.wins - a.wins || b.bestNet - a.bestNet)
    .slice(0, n);
}

// ============================================================
// BOT AI
// ============================================================
function botAddTimer(room, fn, delay) {
  const t = setTimeout(() => {
    if (!rooms[room.id] || rooms[room.id] !== room) return;
    room.botTimers = room.botTimers.filter(x => x !== t);
    fn();
  }, delay);
  room.botTimers.push(t);
}

function clearBotTimers(room) {
  room.botTimers.forEach(clearTimeout);
  room.botTimers = [];
}

function botTryBuy(room, bot) {
  const cell = room.board[bot.pos];
  if ((cell.type !== 'city' && cell.type !== 'railroad' && cell.type !== 'utility') || cell.owner) return;
  const lvl = bot.botLevel || 'normal';
  if (lvl === 'easy' && Math.random() < 0.35) return; // 简单：经常犯懒不买
  // keep a cash buffer; grab the last one of a group aggressively
  const wantsGroupCompletion = cell.type === 'city' &&
    room.board.some(c => c.group === cell.group && c.owner === bot.id);
  let buffer = wantsGroupCompletion ? 200 : 800;
  if (lvl === 'easy') buffer = wantsGroupCompletion ? 800 : 1800;
  else if (lvl === 'hard') buffer = 300;
  if (bot.money - cell.price >= buffer) {
    bot.money -= cell.price;
    cell.owner = bot.id;
    cell.level = 0;
    cell.mortgaged = false;
    bot.properties.push(cell.id);
    log(room, `🤖 ${bot.name} 购买了 ${cell.name}（¥${cell.price}）`);
    botSay(room, bot, ownsFullGroup(room, bot.id, cell.group) ? 'setDone' : 'buy', 0.3);
  } else {
    if (room.settings.auctionOn) startAuction(room, cell.id, bot.name);
  }
}

function botBuildStep(room, bot) {
  const lvl = bot.botLevel || 'normal';
  const maxLevel = lvl === 'easy' ? 2 : 5;                 // 简单：最多盖到 2 级
  const cashBuffer = lvl === 'easy' ? 4000 : lvl === 'hard' ? 1500 : 2500;
  const candidates = bot.properties
    .map(id => room.board[id])
    .filter(c => c && canBuild(room, bot.id, c) && GROUP_INFO[c.group])
    .filter(c => c.level < maxLevel)
    .filter(c => bot.money - houseCostOf(room, c) >= cashBuffer)
    .filter(c => (c.level < 4 ? room.bank.houses > 0 : room.bank.hotels > 0));
  if (candidates.length > 0) {
    const cell = candidates[0];
    const cost = houseCostOf(room, cell);
    bot.money -= cost;
    if (cell.level < 4) room.bank.houses -= 1;
    else { room.bank.hotels -= 1; room.bank.houses += 4; }
    cell.level++;
    log(room, `🤖 ${bot.name} 在 ${cell.name} ${cell.level >= 5 ? '建成酒店' : '建造第 ' + cell.level + ' 栋房'}（¥${cost}）`);
    return true;
  }
  return false;
}

// ── 机器人台词（拟人感）──
const BOT_LINES = {
  buy:      ['这地我要了！', '便宜，收了。', '这块地段有潜力。', '买了不亏。'],
  build:    ['盖楼盖楼～', '再盖一栋，租金翻倍！', '这里迟早是黄金地段。'],
  rentPay:  ['肉疼……', '下次绕着走。', '这是抢钱吧！'],
  rentGet:  ['过路过路，留下买路财。', '谢谢惠顾～', '嘿嘿，躺赚。'],
  jail:     ['警察叔叔，我错了。', '行吧，进去蹲会儿。', '里面挺好的，清静。'],
  setDone:  ['集齐啦！哈哈哈！', '成套成套～', '这一片都是我的了。'],
  propose:  ['卖吗卖吗？', '这价钱够意思了吧。', '我可是很有诚意的。'],
  deal:     ['成交！嘿嘿。', '合作愉快～', '早卖早享受。'],
  auction:  ['这块地我要定了！', '都别跟我抢！', '让我看看值多少…', '加价！加价！'],
  winAuc:   ['拍到手了！', '物有所值。', '嘿嘿，又添一块。'],
  refuse:   ['这个价钱可不行。', '不卖不卖。', '再想想吧。', '亏本买卖我不做。'],
  win:      ['承让承让。', '基本操作，都坐好。'],
  bankrupt: ['我还会回来的！', '……下次一定。'],
};

function botSay(room, bot, type, chance = 0.35) {
  const lines = BOT_LINES[type];
  if (!lines || !bot || !bot.isBot || bot.bankrupt) return;
  if (Math.random() > chance) return;
  room.chats.push({ from: bot.name, text: lines[Math.floor(Math.random() * lines.length)], ts: Date.now() });
  if (room.chats.length > 150) room.chats.shift();
}

// ── 机器人赎回抵押地产（简单难度不赎回）──
function botMaybeUnmortgage(room, bot) {
  if ((bot.botLevel || 'normal') === 'easy') return;
  if (!bot.properties || !bot.properties.length) return;
  const candidates = bot.properties
    .map(id => room.board[id])
    .filter(c => c && c.owner === bot.id && c.mortgaged)
    .sort((a, b) => a.price - b.price);
  candidates.forEach(c => {
    const cost = Math.floor(c.price * MORTGAGE_RATE * UNMORTGAGE_FEE);
    const keep = (bot.botLevel === 'hard') ? 2500 : 5000;
    if (bot.money - cost >= keep) {
      bot.money -= cost;
      c.mortgaged = false;
      log(room, `🤖 ${bot.name} 赎回 ${c.name}（¥${cost}）`);
    }
  });
}

// ── AI 主动求购：集齐一套只差这块时，向人类地主出价 ──
function maybeBotProposeTrade(room, player) {
  if (!room.started || room.ended || room.proposal || room.auction || room.debt) return;
  if (!player || player.bankrupt || (!player.isBot && !player.delegated)) return;
  if (!player.isBot && !player.connected) return; // 掉线托管中不向别人提案
  const lvl = player.botLevel || 'normal';
  const chance = lvl === 'easy' ? 0.08 : lvl === 'normal' ? 0.2 : 0.35;
  if (Math.random() > chance) return;

  const candidates = room.board.filter(c => {
    if (c.type !== 'city' || !c.group || !c.owner || c.owner === player.id) return false;
    if (c.level > 0) return false; // 带建筑的不提案
    if (c.proposedTo && c.proposedTo[player.id]) return false;
    const owner = room.players[c.owner];
    if (!owner || owner.isBot || owner.bankrupt || !owner.connected) return false;
    const total = room.board.filter(x => x.group === c.group && x.type === 'city').length;
    return countOwnedInGroup(room, player.id, c.group) === total - 1;
  });
  if (!candidates.length) return;

  const cell = candidates[Math.floor(Math.random() * candidates.length)];
  const factor = lvl === 'hard' ? 1.5 + Math.random() * 0.3 : 1.2 + Math.random() * 0.4;
  const price = Math.ceil(cell.price * factor / 100) * 100;
  if (player.money - price < 1500) return; // 保留现金缓冲
  const seq = ++room.proposalSeq;
  room.proposal = { seq, from: player.id, to: cell.owner, cellId: cell.id, price, expiresAt: Date.now() + 15000 };
  if (!cell.proposedTo) cell.proposedTo = {};
  cell.proposedTo[player.id] = true;
  const owner = room.players[cell.owner];
  log(room, `🤝 ${player.name} 出价 ¥${price} 求购 ${owner.name} 的「${cell.name}」`);
  botSay(room, player, 'propose', 0.8);
  broadcast(room.id);
  botAddTimer(room, () => {
    if (room.proposal && room.proposal.seq === seq) {
      log(room, `⌛ 提议超时，${player.name} 收回了出价`);
      room.proposal = null;
      broadcast(room.id);
    }
  }, 15000);
}

function botRoll(room, bot) {
  if (!rooms[room.id] || room.ended || !room.started) return;
  if (room.diceAnim || room.currentRolled) return;
  if (currentPlayer(room)?.id !== bot.id) return;

  // jail decisions: use card > pay bail (if rich) > try doubles
  if (bot.jailTurns > 0) {
    if (bot.jailFreeCards > 0) {
      bot.jailFreeCards--;
      bot.jailTurns = 0;
      log(room, `🤖 ${bot.name} 使用出狱免费卡`);
      // falls through to a normal roll below
    } else if (bot.money >= JAIL_FINE + (bot.botLevel === 'easy' ? Number.MAX_SAFE_INTEGER : bot.botLevel === 'hard' ? 1000 : 3000)) {
      bot.money -= JAIL_FINE;
      bot.jailTurns = 0;
      if (room.settings.jackpotOn) room.jackpot += JAIL_FINE;
      log(room, `🤖 ${bot.name} 支付 ¥${JAIL_FINE} 保释出狱（入奖池）`);
      // falls through
    } else {
      tryRollJail(room, bot);
      return;
    }
  }

  room.diceAnim = true;
  const d1 = Math.floor(Math.random() * 6) + 1;
  const d2 = Math.floor(Math.random() * 6) + 1;
  const step = d1 + d2;
  const isDouble = d1 === d2;
  room.dice = [d1, d2];
  log(room, `${bot.name} 掷出 ${d1}+${d2}=${step}${isDouble ? ' 🎯双数！' : ''}`);
  broadcast(room.id);

  botAddTimer(room, () => {
    room.diceAnim = false;
    movePlayer(room, bot, step, isDouble, d1 + d2);
    // 移动后：盖房 →（双数再掷 | 结束回合）→ 调度下一位
    botAddTimer(room, () => aiAfterMove(room, bot), 1000);
  }, 900);
}

// 真人退出/长时间掉线 → 机器人接管席位（保留资产，重连可收回）
function takeOverByBot(room, player, reason = '退出') {
  if (player.isBot || player.bankrupt) return;
  player.origName = player.origName || player.name;
  player.origAvatar = player.origAvatar || player.avatar;
  player.isBot = true;
  player.delegated = false;
  player.connected = true; // 机器人视为常在线
  player.avatar = '🤖';
  player.name = (player.origName + 'bot').slice(0, 16);
  log(room, `🤖 ${player.origName} ${reason}，机器人接管其席位与资产`);
  room.chats.push({ from: '系统', text: `🤖 机器人接管了 ${player.origName} 的席位`, ts: Date.now() });
}

// ── AI 调度：机器人 或 托管中的真人，轮到谁就替谁行动 ──
function scheduleAIIfAny(room, delay = 1000) {
  if (!rooms[room.id] || !room.started || room.ended) return;
  const cur = currentPlayer(room);
  if (!cur || cur.bankrupt || (!cur.isBot && !cur.delegated)) return;
  if (room.currentRolled) {
    // 决策阶段：托管玩家由 AI 盖房并交棒（不重掷）
    botAddTimer(room, () => {
      const p = currentPlayer(room);
      if (!p || p.id !== cur.id || p.bankrupt) return;
      botBuildStep(room, p);
      nextTurn(room);
      broadcast(room.id);
      scheduleAIIfAny(room);
    }, 700);
    return;
  }
  if (room.diceAnim) {
    // 骰子动画中，稍后重试，避免吞掉调度
    botAddTimer(room, () => scheduleAIIfAny(room, delay), 700);
    return;
  }
  botAddTimer(room, () => botRoll(room, cur), delay);
}

// AI 移动后的收尾：盖房 →（双数再掷 | 结束回合）→ 调度下一位
function aiAfterMove(room, player) {
  botBuildStep(room, player);
  botMaybeUnmortgage(room, player);
  maybeBotProposeTrade(room, player);
  const again = room.started && !room.ended && currentPlayer(room)?.id === player.id &&
    room.doubleCount > 0 && !player.bankrupt;
  broadcast(room.id);
  if (again) {
    botAddTimer(room, () => botRoll(room, player), 900);
  } else if (room.started && !room.ended && currentPlayer(room)?.id === player.id && !player.bankrupt) {
    nextTurn(room);
    broadcast(room.id);
    scheduleAIIfAny(room);
  } else {
    scheduleAIIfAny(room);
  }
}

const BOT_LEVELS = ['easy', 'normal', 'hard'];
const BOT_LEVEL_TAG = { easy: '（简单）', normal: '（普通）', hard: '（困难）' };

function addBot(room, difficulty) {
  if (room.started) return false;
  if (room.order.length >= 8) return false;
  const level = BOT_LEVELS.includes(difficulty) ? difficulty : 'normal';
  const usedNames = room.order.map(id => room.players[id]?.name);
  const name = BOT_NAMES.find(n => !usedNames.includes(n)) || `机器人${Date.now() % 1000}`;
  const token = 'bot_' + Math.random().toString(36).slice(2, 10);
  room.players[token] = createPlayer(name, token, { isBot: true, avatar: '🤖' });
  room.players[token].botLevel = level;
  room.order.push(token);
  room.chats.push({ from: '系统', text: `${name}${BOT_LEVEL_TAG[level]} 加入了房间`, ts: Date.now() });
  log(room, `🤖 ${name}${BOT_LEVEL_TAG[level]} 加入了房间`);
  return true;
}

// ============================================================
// SOCKET.IO EVENTS
// ============================================================
io.on('connection', (socket) => {
  const safeEmit = (event, ...args) => { try { socket.emit(event, ...args); } catch (e) {} };

  socket.on('getRooms', () => { safeEmit('roomList', roomList()); });

  socket.on('join', ({ roomId, name, avatar, token, password }) => {
    if (!allowRate(socket, 'join', 6, 60000)) return safeEmit('msg', '操作过于频繁，稍后再试');
    if (!roomId || !name) return;
    roomId = String(roomId).slice(0, 24).trim() || 'room1';
    if (!rooms[roomId] && Object.keys(rooms).length >= 100) {
      return safeEmit('msg', '服务器房间数已达上限，请稍后再试');
    }
    name = String(name).slice(0, 16).trim() || ('玩家' + Math.floor(Math.random() * 1000));
    if (!token || typeof token !== 'string' || token.length < 6 || token.startsWith('bot_')) {
      token = 'u' + Math.random().toString(36).slice(2, 12);
    }
    // Switching rooms: fully leave the previous one first
    if (socket.roomId && socket.roomId !== roomId) {
      leaveRoom(socket, '切换房间');
    }
    socketToken[socket.id] = token;
    socket.join(roomId);
    socket.roomId = roomId;

    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    // 密码房：已持有席位的玩家（重连/刷新）豁免，新来者必须携带正确密码
    if (room.password && !room.players[token]) {
      if (String(password || '') !== room.password) {
        return safeEmit('msg', '🔒 该房间已设密码，请向房主索取后重新加入');
      }
    }

    let player = room.players[token];
    if (player) {
      // RECONNECT: keep identity, rebind socket
      player.connected = true;
      player.disconnAt = 0;
      if (player.isBot && player.origName) {
        // 席位曾被机器人接管 → 收回控制权
        player.isBot = false;
        player.delegated = false;
        player.name = (name || player.origName).slice(0, 16);
        player.avatar = (avatar && PLAYER_AVATARS.includes(avatar)) ? avatar : (player.origAvatar || player.avatar);
        player.origName = null;
        player.origAvatar = null;
        log(room, `🎮 ${player.name} 回来了，收回被机器人代打的席位`);
        room.chats.push({ from: '系统', text: `🎮 ${player.name} 收回了控制权`, ts: Date.now() });
      } else {
        if (player.delegated) {
          player.delegated = false;
          log(room, `🎮 ${player.name} 重连，自动解除托管`);
        }
        player.name = (name || player.name).slice(0, 16);
        if (avatar && PLAYER_AVATARS.includes(avatar)) player.avatar = avatar;
        log(room, `👋 ${player.name} 重新连接`);
      }
      if (!room.order.includes(token)) room.order.push(token);
      if (!room.hostToken) room.hostToken = token;
      safeEmit('joined', { roomId, token });
      broadcast(roomId);
      return;
    }

    if (room.started) {
      safeEmit('msg', '游戏已开始，只能观战');
      safeEmit('joined', { roomId, token, spectator: true });
      broadcast(roomId);
      return;
    }
    if (room.order.length >= 8) { safeEmit('msg', '房间已满（最多8人）'); return; }

    player = createPlayer(name, token);
    if (avatar && PLAYER_AVATARS.includes(avatar)) player.avatar = avatar;
    room.players[token] = player;
    if (!room.hostToken) room.hostToken = token;
    room.order.push(token);
    room.chats.push({ from: '系统', text: `${name} 加入了房间`, ts: Date.now() });
    log(room, `${name} 加入了房间`);
    safeEmit('joined', { roomId, token });
    broadcast(roomId);
    io.emit('roomList', roomList());
  });

  socket.on('addBot', ({ difficulty } = {}) => {
    const room = rooms[socket.roomId];
    if (!room || room.started || room.ended) return;
    const token = socketToken[socket.id];
    if (room.hostToken !== token) return safeEmit('msg', '只有房主可以添加机器人');
    if (room.order.length >= 8) return safeEmit('msg', '房间已满（最多8人）');
    if (!addBot(room, difficulty)) return;
    broadcast(room.id);
    io.emit('roomList', roomList());
  });

  socket.on('kickBot', ({ token: wanted } = {}) => {
    const room = rooms[socket.roomId];
    if (!room || room.started) return;
    const token = socketToken[socket.id];
    if (room.hostToken !== token) return safeEmit('msg', '只有房主可以移除机器人');
    const botToken = (wanted && room.players[wanted] && room.players[wanted].isBot)
      ? wanted
      : [...room.order].reverse().find(t => room.players[t]?.isBot);
    if (!botToken) return safeEmit('msg', '没有机器人可移除');
    log(room, `🤖 ${room.players[botToken].name} 离开了房间`);
    delete room.players[botToken];
    room.order = room.order.filter(t => t !== botToken);
    broadcast(room.id);
    io.emit('roomList', roomList());
  });

  socket.on('start', () => {
    if (!allowRate(socket, 'start', 3, 60000)) return safeEmit('msg', '操作过于频繁，稍后再试');
    const room = rooms[socket.roomId];
    if (!room || room.started || room.ended) return;
    if (room.hostToken !== socketToken[socket.id]) return safeEmit('msg', '只有房主可以开始游戏');
    if (room.order.length < 2) return safeEmit('msg', '至少需要2名玩家（可添加机器人）');
    room.started = true;
    room.turnIndex = 0;
    room.roundCount = 1;
    room.startedAt = Date.now();
    pushReplaySnapshot(room);
    if (room.settings.randomFirst) {
      shuffle(room.order);
      log(room, '🔀 随机先手：' + room.order.map(t => room.players[t]?.name).join(' → '));
    }
    // 应用房间设置：起始资金
    room.order.forEach(id => {
      const p = room.players[id];
      if (p) p.money = room.settings.startMoney;
    });
    // 初始净资产快照
    room.nwHistory = [{ r: 0, v: {} }];
    room.order.forEach(id => {
      const p = room.players[id];
      if (p && !p.bankrupt) room.nwHistory[0].v[id] = playerNetWorth(room, id);
    });
    room.turnStartedAt = Date.now();
    log(room, '🎲 游戏开始！');
    room.chats.push({ from: '系统', text: '游戏开始！', ts: Date.now() });
    broadcast(room.id);
    scheduleAIIfAny(room, 1200);
  });

  socket.on('roll', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended || room.diceAnim) return;
    const player = currentPlayer(room);
    const token = socketToken[socket.id];
    if (!player || player.id !== token || player.isBot || player.delegated) return;
    if (room.currentRolled) return; // 已掷骰，处于购买决策阶段

    if (player.jailTurns > 0) {
      // 出狱卡优先自动使用
      if (player.jailFreeCards > 0) {
        player.jailFreeCards--;
        player.jailTurns = 0;
        log(room, `🗝️ ${player.name} 使用出狱免费卡`);
      } else {
        tryRollJail(room, player);
        return;
      }
    }
    rollAndMove(room, player);
  });

  socket.on('payBail', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended || room.diceAnim) return;
    const player = currentPlayer(room);
    const token = socketToken[socket.id];
    if (!player || player.id !== token || player.isBot || player.delegated) return;
    if (player.jailTurns <= 0 || player.money < JAIL_FINE) return;
    player.money -= JAIL_FINE;
    player.jailTurns = 0;
    if (room.settings.jackpotOn) room.jackpot += JAIL_FINE;
    log(room, `💰 ${player.name} 支付 ¥${JAIL_FINE} 保释出狱（入奖池）`);
    rollAndMove(room, player);
  });

  socket.on('buy', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended || room.diceAnim) return;
    const token = socketToken[socket.id];
    const player = currentPlayer(room);
    if (!player || player.id !== token || player.isBot || player.delegated) return;
    const cell = room.board[player.pos];
    if ((cell.type !== 'city' && cell.type !== 'railroad' && cell.type !== 'utility') || cell.owner || player.money < cell.price) return;

    player.money -= cell.price;
    cell.owner = token;
    cell.level = 0;
    cell.mortgaged = false;
    player.properties.push(cell.id);
    log(room, `🏠 ${player.name} 购买了 ${cell.name}（¥${cell.price}）`);
    broadcast(room.id);
  });

  // 建造/出售/抵押/赎回：地产所有者可在游戏进行中随时操作（无需轮到自己）
  socket.on('build', ({ cellId, action }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.bankrupt || player.delegated) return;
    const cell = room.board[cellId];
    if (!cell || cell.owner !== token) return;

    if (action === 'build') {
      if (!canBuild(room, token, cell)) return;
      const cost = houseCostOf(room, cell);
      if (player.money < cost) return safeEmit('msg', `建造需 ¥${cost}，资金不足`) ;
      if (cell.level < 4) {
        if (room.bank.houses < 1) return safeEmit('msg', '🏦 银行房源不足，没有房子可卖了');
        room.bank.houses -= 1;
      } else {
        if (room.bank.hotels < 1) return safeEmit('msg', '🏦 银行酒店已售罄');
        room.bank.hotels -= 1;
        room.bank.houses += 4; // 4 栋房归还银行
      }
      player.money -= cost;
      cell.level++;
      log(room, `🏗️ ${player.name} 在 ${cell.name} ${cell.level >= 5 ? '建成酒店' : '建造第 ' + cell.level + ' 栋房'}（¥${cost}）`);
    } else if (action === 'sell') {
      if (!canSell(room, token, cell)) return;
      const refund = Math.floor(houseCostOf(room, cell) / 2);
      player.money += refund;
      if (cell.level >= 5) room.bank.hotels += 1;
      else room.bank.houses += 1;
      cell.level--;
      log(room, `🔨 ${player.name} 出售 ${cell.name} 一级建筑（退款 ¥${refund}）`);
    }
    settleDebtIfPossible(room);
    broadcast(room.id);
  });

  socket.on('mortgage', ({ cellId }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.bankrupt || player.delegated) return;
    const cell = room.board[cellId];
    if (!cell || cell.owner !== token || cell.mortgaged) return;
    if (cell.type === 'city' && cell.level > 0) return safeEmit('msg', '需先出售该地产上的建筑才能抵押');

    cell.mortgaged = true;
    const val = Math.floor(cell.price * MORTGAGE_RATE);
    player.money += val;
    log(room, `🏦 ${player.name} 抵押 ${cell.name} 获得 ¥${val}（赎回需 ¥${Math.floor(val * UNMORTGAGE_FEE)}）`);
    settleDebtIfPossible(room);
    broadcast(room.id);
  });

  socket.on('unmortgage', ({ cellId }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.bankrupt || player.delegated) return;
    const cell = room.board[cellId];
    if (!cell || cell.owner !== token || !cell.mortgaged) return;

    const cost = Math.floor(cell.price * MORTGAGE_RATE * UNMORTGAGE_FEE);
    if (player.money < cost) return safeEmit('msg', `赎回需 ¥${cost}，资金不足`);
    cell.mortgaged = false;
    player.money -= cost;
    log(room, `🔓 ${player.name} 赎回 ${cell.name} 支付 ¥${cost}`);
    settleDebtIfPossible(room);
    broadcast(room.id);
  });

  socket.on('trade', ({ targetId, giveMoney, getMoney, giveProps, getProps }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended) return;
    const token = socketToken[socket.id];
    const from = room.players[token];
    const to = room.players[targetId];
    if (!from || !to || from.bankrupt || to.bankrupt || from.delegated) return;
    giveMoney = Math.max(0, Math.floor(giveMoney || 0));
    getMoney = Math.max(0, Math.floor(getMoney || 0));
    giveProps = Array.isArray(giveProps) ? giveProps.map(Number).filter(Number.isInteger) : [];
    getProps = Array.isArray(getProps) ? getProps.map(Number).filter(Number.isInteger) : [];

    if (from.money < giveMoney || to.money < getMoney) return;
    if (giveProps.some(id => !from.properties.includes(id))) return;
    if (getProps.some(id => !to.properties.includes(id))) return;
    // 经典规则：带建筑的土地必须先卖掉建筑才能交易
    if (giveProps.some(id => room.board[id] && room.board[id].level > 0)) return safeEmit('msg', '有建筑的土地不能交易，请先出售建筑');
    if (getProps.some(id => room.board[id] && room.board[id].level > 0)) return safeEmit('msg', '对方有建筑的土地不能交易');
    if (!giveMoney && !getMoney && !giveProps.length && !getProps.length) return;
    if (room.debt && (room.debt.playerId === token || room.debt.playerId === targetId)) {
      return safeEmit('msg', '筹钱期间不能交易');
    }

    // 目标是机器人：AI 直接估值回应
    if (to.isBot) {
      const seq = ++room.tradeSeq;
      const t = { seq, from: token, to: targetId, giveMoney, getMoney, giveProps, getProps };
      log(room, `🤝 ${from.name} 向 ${to.name} 发起交易提议`);
      broadcast(room.id);
      botAddTimer(room, () => {
        if (rooms[room.id] !== room || room.trade) return;
        const bot = room.players[t.to];
        if (!bot || bot.bankrupt) return;
        const ok = botEvaluateTrade(room, bot, t);
        if (ok) {
          executeTrade(room, t);
          botSay(room, bot, 'deal', 0.6);
        } else {
          log(room, `❌ ${bot.name} 拒绝了交易提议`);
          botSay(room, bot, 'refuse', 0.5);
        }
        broadcast(room.id);
      }, 900 + Math.floor(Math.random() * 1200));
      return;
    }

    // 提议 → 对方确认后才执行（防止单方面转移资产）
    const seq = ++room.tradeSeq;
    room.trade = { seq, from: token, to: targetId, giveMoney, getMoney, giveProps, getProps, expiresAt: Date.now() + 30000 };
    log(room, `🤝 ${from.name} 向 ${to.name} 发起交易提议（30 秒内回应）`);
    broadcast(room.id);
    botAddTimer(room, () => {
      if (room.trade && room.trade.seq === seq) {
        log(room, '⌛ 交易提议超时，已取消');
        room.trade = null;
        broadcast(room.id);
      }
    }, 30000);
  });

  // 回应交易提议
  socket.on('tradeResp', ({ seq, accept }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.trade || room.trade.seq !== Number(seq)) return;
    const token = socketToken[socket.id];
    if (token !== room.trade.to) return;
    const t = room.trade;
    room.trade = null;
    const from = room.players[t.from];
    const to = room.players[t.to];
    if (!accept || !from || !to || from.bankrupt || to.bankrupt) {
      if (from && to) log(room, `❌ ${to.name} 拒绝了 ${from.name} 的交易提议`);
    } else if (
      from.money < t.giveMoney || to.money < t.getMoney ||
      !t.giveProps.every(id => from.properties.includes(id)) ||
      !t.getProps.every(id => to.properties.includes(id)) ||
      t.giveProps.some(id => room.board[id] && room.board[id].level > 0) ||
      t.getProps.some(id => room.board[id] && room.board[id].level > 0)
    ) {
      log(room, '❌ 交易条件已发生变化，自动取消');
    } else {
      executeTrade(room, t);
    }
    broadcast(room.id);
  });

  socket.on('endTurn', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended || room.diceAnim) return;
    const token = socketToken[socket.id];
    const player = currentPlayer(room);
    if (!player || player.id !== token || player.isBot || player.delegated) return;
    if (!room.currentRolled) return; // 未掷骰不能跳过回合
    if (room.debt && room.debt.playerId === token) return; // 欠款未清不能跑
    endHumanTurn(room, player);
  });

  // 拍卖出价
  socket.on('auctionBid', ({ amount }) => {
    if (!allowRate(socket, 'bid', 12, 10000)) return safeEmit('msg', '出价太频繁，稍后再试');
    const room = rooms[socket.roomId];
    if (!room || !room.auction || room.ended) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.bankrupt) return;
    placeBid(room, player, Number(amount));
  });

  // 大厅排行榜
  socket.on('getStats', ({ name } = {}) => {
    const n = String(name || '').slice(0, 16);
    const mine = n && stats[n] ? { name: n, games: stats[n].games, wins: stats[n].wins, bestNet: stats[n].bestNet } : null;
    safeEmit('stats', { top: topStats(), mine, recent: recentGames.slice(-8).reverse() });
  });

  // ---- 测试钩子（仅 MONOPOLY_TEST=1 时生效）----
  socket.on('testHook', ({ op, pos, cellId, amount, n }) => {
    if (process.env.MONOPOLY_TEST !== '1') return;
    const room = rooms[socket.roomId];
    if (!room) return;
    const token = socketToken[socket.id];
    if (op === 'teleport') {
      const p = room.players[token];
      if (p) p.pos = pos;
    } else if (op === 'resolve') {
      const p = currentPlayer(room);
      if (p) { p.pos = pos; landOn(room, p, 7); room.currentRolled = true; }
    } else if (op === 'auction') {
      startAuction(room, cellId, 'TEST');
    } else if (op === 'jackpot') {
      room.jackpot = amount;
    } else if (op === 'setMoney') {
      const p = room.players[token];
      if (p) p.money = amount;
    } else if (op === 'save') {
      saveRoomsNow();
    } else if (op === 'setMax') {
      room.maxRounds = Number(n) || 0;
    } else if (op === 'setRounds') {
      room.roundCount = Number(n) || 1;
    } else if (op === 'lastCard') {
      room.lastCard = { type: 'chance', text: 'TEST卡', by: 'TEST', ts: Date.now() };
    } else if (op === 'addBotSide') {
      const bt = 'bot_side_' + Math.random().toString(36).slice(2, 7);
      room.players[bt] = createPlayer('机器人商人', bt, { isBot: true, avatar: '🤖' });
      room.players[bt].botLevel = 'normal';
      // 不加入 order —— 永远轮不到它行动，保证测试确定性
    } else if (op === 'setOwner') {
      const c = room.board[cellId];
      const np = room.players[token];
      if (c && np) {
        if (c.owner && room.players[c.owner]) {
          room.players[c.owner].properties = room.players[c.owner].properties.filter(x => x !== cellId);
        }
        c.owner = token; c.level = 0; c.mortgaged = false;
        if (!np.properties.includes(cellId)) np.properties.push(cellId);
      }
    } else if (op === 'setBank') {
      const v = Number(n);
      if (Number.isFinite(v)) room.bank.houses = Math.max(0, Math.min(64, v));
    } else if (op === 'landAs') {
      const p = room.players[token];
      if (p && !p.bankrupt) {
        p.pos = pos;
        try { landOn(room, p, 7); } catch (e) { log(room, String('DBG-ERR: ' + e.message)); }
      }
    } else if (op === 'setLevel') {
      const c = room.board[cellId];
      if (c) c.level = Math.max(0, Math.min(5, Number(n) || 0));
    } else if (op === 'addBotForce') {
      const bt = 'bot_force_' + Math.random().toString(36).slice(2, 7);
      room.players[bt] = createPlayer('机器人测试', bt, { isBot: true, avatar: '🤖' });
      room.players[bt].botLevel = 'hard';
      room.players[bt].bankrupt = true; // 不参与行动，保证测试确定性
      room.order.push(bt);
    } else if (op === 'mkproposal') {
      const bt = room.order.find(t => room.players[t]?.isBot && t !== token);
      const seller = room.players[token];
      const cell = room.board[cellId];
      if (bt && seller && cell && cell.owner === token) {
        const seq = ++room.proposalSeq;
        room.proposal = { seq, from: bt, to: token, cellId, price: Math.max(100, Number(amount) || 1000), expiresAt: Date.now() + 15000 };
      }
    }
    if (room.debt) settleDebtIfPossible(room);
    broadcast(room.id);
  });

  // 房间设置（房主，开局前）：起始资金/奖池开关/拍卖开关
  socket.on('setSettings', ({ startMoney, jackpotOn, auctionOn, map, randomFirst, turnTimeoutMs, password }) => {
    const room = rooms[socket.roomId];
    if (!room || room.started || room.ended) return;
    const token = socketToken[socket.id];
    if (room.hostToken !== token) return safeEmit('msg', '只有房主可以修改房间设置');
    if (startMoney !== undefined) {
      const sm = Number(startMoney);
      if ([8000, 10000, 15000, 20000, 30000].includes(sm)) room.settings.startMoney = sm;
    }
    if (typeof jackpotOn === 'boolean') room.settings.jackpotOn = jackpotOn;
    if (typeof auctionOn === 'boolean') room.settings.auctionOn = auctionOn;
    if (typeof randomFirst === 'boolean') room.settings.randomFirst = randomFirst;
    if (password !== undefined) {
      const pwd = String(password).trim().slice(0, 12);
      if (pwd === '') {
        room.password = null;
        log(room, '🔓 房主取消了房间密码');
      } else if (/^[A-Za-z0-9]{4,12}$/.test(pwd)) {
        room.password = pwd;
        log(room, '🔒 房主设置了房间密码');
      } else {
        return safeEmit('msg', '密码需为 4~12 位字母或数字');
      }
    }
    if (turnTimeoutMs !== undefined && [30000, 60000, 120000].includes(Number(turnTimeoutMs))) room.settings.turnTimeoutMs = Number(turnTimeoutMs);
    if (map !== undefined && MAPS[String(map)] && room.mapId !== String(map)) {
      room.mapId = String(map);
      room.board = deepClone(MAPS[room.mapId].cells);
      room.rentMul = MAPS[room.mapId].rentMul || 1;
      room.houseMul = MAPS[room.mapId].houseMul || 1;
    }
    log(room, `⚙️ 房主更新设置：${MAPS[room.mapId].name} · 起始 ¥${room.settings.startMoney} · 奖池${room.settings.jackpotOn ? '开' : '关'} · 拍卖${room.settings.auctionOn ? '开' : '关'}${room.settings.randomFirst ? ' · 随机先手' : ''}`);
    broadcast(room.id);
  });

  // 回合上限设置（房主，开局前）
  socket.on('setMaxRounds', ({ value }) => {
    const room = rooms[socket.roomId];
    if (!room || room.started || room.ended) return;
    const token = socketToken[socket.id];
    if (room.hostToken !== token) return safeEmit('msg', '只有房主可以设置回合上限');
    const v = Number(value);
    if (![0, 20, 30, 50, 80].includes(v)) return;
    room.maxRounds = v;
    log(room, v > 0 ? `⏱ 房主设置回合上限：${v} 回合（到时按净资产定胜负）` : '⏱ 回合上限：不限');
    broadcast(room.id);
  });

  // 回应 AI 购地提案
  socket.on('proposalResp', ({ seq, accept }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.proposal || room.proposal.seq !== Number(seq)) return;
    const token = socketToken[socket.id];
    const prop = room.proposal;
    if (token !== prop.to) return;
    const bot = room.players[prop.from];
    const seller = room.players[token];
    const cell = room.board[prop.cellId];
    room.proposal = null;
    if (!accept || !bot || !seller || seller.bankrupt || !cell || cell.owner !== token || bot.money < prop.price) {
      if (seller) log(room, `❌ ${seller.name} 拒绝了 ${bot ? bot.name : '对方'} 的出价`);
    } else {
      bot.money -= prop.price;
      seller.money += prop.price;
      cell.owner = bot.id;
      seller.properties = seller.properties.filter(x => x !== prop.cellId);
      bot.properties.push(prop.cellId);
      log(room, `🤝 ${seller.name} 以 ¥${prop.price} 把「${cell.name}」卖给了 ${bot.name}`);
      botSay(room, bot, 'deal', 0.7);
    }
    broadcast(room.id);
    scheduleAIIfAny(room);
  });

  // 自动购买开关（个人偏好，随时可切）
  socket.on('setAutoBuy', ({ on }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.isBot) return;
    player.autoBuy = !!on;
    log(room, `🛒 ${player.name} ${on ? '开启' : '关闭'}了自动购买`);
    broadcast(room.id);
  });

  // 托管开关：开启后 AI 替该玩家行动（掷骰/买地/盖房/保释/结束回合）
  socket.on('toggleDelegation', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || room.ended) return;
    const token = socketToken[socket.id];
    const player = room.players[token];
    if (!player || player.bankrupt || player.isBot) return;
    player.delegated = !player.delegated;
    log(room, player.delegated
      ? `🕹 ${player.name} 开启托管，由 AI 代打`
      : `🎮 ${player.name} 取消托管，恢复手动操作`);
    broadcast(room.id);
    // 若正好轮到该玩家且未在动画中，立即让 AI 接手
    if (player.delegated && currentPlayer(room)?.id === token && !room.diceAnim) {
      scheduleAIIfAny(room, 600);
    }
  });

  socket.on('chat', (text) => {
    if (!allowRate(socket, 'chat', 5, 10000)) return safeEmit('msg', '说话太快啦，歇一下');
    const room = rooms[socket.roomId];
    if (!room || !text || typeof text !== 'string' || text.length > 300) return;
    const token = socketToken[socket.id];
    const name = room.players[token]?.name || socket.playerName || '观众';
    room.chats.push({ from: name, text: text.trim(), ts: Date.now() });
    if (room.chats.length > 150) room.chats.shift();
    broadcast(room.id);
  });

  socket.on('reset', () => {
    if (!allowRate(socket, 'reset', 2, 60000)) return safeEmit('msg', '重置太频繁，稍后再试');
    const room = rooms[socket.roomId];
    if (!room) return;
    // 对局进行中仅房主可重置（结束后/开局前任意玩家均可，方便结算面板"开始新局"）
    if (room.started && !room.ended && room.hostToken !== socketToken[socket.id]) {
      return safeEmit('msg', '对局进行中，只有房主可以重置房间');
    }
    const roomId = socket.roomId;
    clearBotTimers(room);
    // keep all players (bots included) for a new round
    const oldPlayers = room.order.map(t => room.players[t]).filter(Boolean);
    rooms[roomId] = createRoom(roomId, room.mapId);
    const newRoom = rooms[roomId];
    oldPlayers.forEach(p => {
      const np = createPlayer(p.name, p.id, { isBot: p.isBot, avatar: p.avatar });
      newRoom.players[p.id] = np;
      newRoom.order.push(p.id);
    });
    newRoom.hostToken = room.hostToken && newRoom.players[room.hostToken] ? room.hostToken : newRoom.order[0] || null;
    log(newRoom, '🔄 房间已重置，开始新一局！');
    newRoom.chats.push({ from: '系统', text: '房间已重置，准备开始新一局！', ts: Date.now() });
    broadcast(roomId);
    io.emit('roomList', roomList());
  });

  socket.on('leave', () => {
    leaveRoom(socket, '离开了游戏');
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, '断开连接', true);
  });
});

function leaveRoom(socket, reason, graceful = false) {
  const roomId = socket.roomId;
  const token = socketToken[socket.id];
  delete socketToken[socket.id];
  if (roomId) socket.leave(roomId);
  socket.roomId = null;
  if (!roomId) return;
  const room = rooms[roomId];
  if (!room || !token || !room.players[token]) return;

  const player = room.players[token];
  if (player.isBot) return;

  if (!room.started) {
    // lobby: remove completely
    log(room, `👋 ${player.name} ${reason}`);
    room.chats.push({ from: '系统', text: `${player.name} ${reason}`, ts: Date.now() });
    delete room.players[token];
    room.order = room.order.filter(t => t !== token);
    if (room.hostToken === token) {
      room.hostToken = room.order.find(t => !room.players[t]?.isBot) || room.order[0] || null;
    }
  } else if (graceful) {
    // 掉线：立即自动托管（AI 代打），5 分钟未归才正式交给机器人
    player.connected = false;
    player.disconnAt = Date.now();
    player.delegated = true;
    log(room, `⚠️ ${player.name} ${reason}，已自动托管（重连即恢复手动）`);
    room.chats.push({ from: '系统', text: `⚠️ ${player.name} 掉线，AI 暂时代打`, ts: Date.now() });
    // 若正好轮到该玩家，让 AI 立刻接手
    if (!room.diceAnim && currentPlayer(room)?.id === token) scheduleAIIfAny(room, 800);
    setTimeout(() => {
      const r = rooms[roomId];
      if (!r || r !== room) return;
      const p = r.players[token];
      if (p && !p.connected && !p.bankrupt && !p.isBot) {
        takeOverByBot(r, p, '长时间掉线');
        broadcast(roomId);
        scheduleAIIfAny(room, 800);
        io.emit('roomList', roomList());
      }
    }, 5 * 60 * 1000);
  } else {
    // 主动退出：机器人立即接管席位与资产（重进房间可收回）
    player.connected = false;
    takeOverByBot(room, player, reason);
    if (!room.diceAnim && currentPlayer(room)?.id === token) scheduleAIIfAny(room, 800);
  }

  if (room.order.length === 0) {
    clearBotTimers(room);
    delete rooms[roomId];
  } else {
    // No connected human left: drop lobby rooms immediately, keep started
    // rooms for reconnects (they expire via the 60s timeout / cleanup task)
    const hasHuman = room.order.some(t => {
      const p = room.players[t];
      return p && !p.isBot && p.connected;
    });
    if (!hasHuman && !room.started) {
      clearBotTimers(room);
      delete rooms[roomId];
    } else {
      if (room.started) checkEnd(room);
      broadcast(roomId);
      scheduleAIIfAny(room, 900);
    }
  }
  io.emit('roomList', roomList());
}

// ============================================================
// HEALTH CHECK, TURN TIMEOUT & IDLE ROOM CLEANUP
// ============================================================
app.get('/stats', (req, res) => {
  let onlineHumans = 0, onlineBots = 0, playing = 0;
  Object.values(rooms).forEach(r => {
    r.order.forEach(t => {
      const p = r.players[t];
      if (!p) return;
      if (p.isBot) { if (!p.bankrupt) onlineBots++; }
      else if (p.connected) onlineHumans++;
    });
    if (r.started && !r.ended) playing++;
  });
  res.json({
    status: 'ok',
    rooms: Object.keys(rooms).length,
    playing,
    humans: onlineHumans,
    bots: onlineBots,
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    uptimeSec: Math.round(process.uptime()),
    ts: Date.now(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), rooms: Object.keys(rooms).length, ts: Date.now() });
});

setInterval(() => {
  const now = Date.now();
  backupData();
  Object.keys(rateLimit).forEach(k => { if (now - rateLimit[k].ts > 60000) delete rateLimit[k]; });
  Object.values(rooms).forEach(room => {
    // 1) turn timeout: a connected human idling too long loses the turn
    if (room.started && !room.ended && !room.diceAnim && room.order.length > 0) {
      const cur = currentPlayer(room);
      if (cur && !cur.isBot && !cur.bankrupt && cur.connected &&
          now - (room.turnStartedAt || 0) > ((room.settings && room.settings.turnTimeoutMs) || TURN_TIMEOUT)) {
        log(room, `⏰ ${cur.name} 操作超时，自动结束回合`);
        endHumanTurn(room, cur);
      }
    }
    // 2) idle room cleanup
    const hasConnectedHuman = room.order.some(t => {
      const p = room.players[t];
      return p && !p.isBot && p.connected;
    });
    const idle = now - room.lastActive > 30 * 60 * 1000;
    if (!hasConnectedHuman && (idle || room.ended)) {
      clearBotTimers(room);
      delete rooms[room.id];
    }
  });
}, 10000);

// ============================================================
// START SERVER
// ============================================================
loadRooms();
setInterval(saveRoomsNow, 10000);

// 优雅退出：停服/重启前确保数据落盘
function gracefulShutdown() {
  try { saveRoomsNow(); saveStats(); } catch (e) {}
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.listen(PORT, () => {
   console.log(`[${new Date().toLocaleString()}] 🎲 大富翁在线 v2.29 服务器已启动 → http://0.0.0.0:${PORT}`);
});
