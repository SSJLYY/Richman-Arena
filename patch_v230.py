# -*- coding: utf-8 -*-
# v2.30 patch: achievements system (lifetime stats + badge wall)
src = open('server.js', encoding='utf-8').read().replace('\r\n', '\n')

# ── 1. createPlayer：本局追踪字段 ──
old = """    rentEarned: 0,         // 累计租金收入
    autoBuy: false,        // 落地自动购买（个人偏好）"""
assert old in src, 'player anchor'
src = src.replace(old, """    rentEarned: 0,         // 累计租金收入
    rollCount: 0,          // 本局掷骰次数
    timesJailed: 0,        // 本局入狱次数
    propsBought: 0,        // 本局购地次数
    autoBuy: false,        // 落地自动购买（个人偏好）""")

# ── 2. 掷骰计数 ──
old = """  room.landingStats[player.pos] = (room.landingStats[player.pos] || 0) + 1;"""
assert old in src, 'roll anchor'
src = src.replace(old, """  room.landingStats[player.pos] = (room.landingStats[player.pos] || 0) + 1;
  player.rollCount = (player.rollCount || 0) + 1;""")

# ── 3. 入狱计数（landOn 判决 + 机会卡）──
old = """    case 'gotojail':
      player.pos = 10;
      player.jailTurns = JAIL_MAX_TURNS;"""
assert old in src, 'gotojail anchor'
src = src.replace(old, """    case 'gotojail':
      player.pos = 10;
      player.jailTurns = JAIL_MAX_TURNS;
      player.timesJailed = (player.timesJailed || 0) + 1;""")

# ── 4. 购地计数（四处：人工购买 / 拍卖成交 / botTryBuy / 自动购买）──
old = """          player.money -= cell.price;
          cell.owner = player.id;
          cell.level = 0;
          cell.mortgaged = false;
          player.properties.push(cell.id);
          log(room, `🤖 ${player.name} 自动购买了 ${cell.name}（¥${cell.price}）`);"""
assert old in src, 'autobuy anchor'
src = src.replace(old, """          player.money -= cell.price;
          cell.owner = player.id;
          cell.level = 0;
          cell.mortgaged = false;
          player.properties.push(cell.id);
          player.propsBought = (player.propsBought || 0) + 1;
          log(room, `🤖 ${player.name} 自动购买了 ${cell.name}（¥${cell.price}）`);""")

old = """    winner.properties.push(cell.id);
    log(room, `🔨 ${winner.name} 以 ¥${a.topBid} 拍得「${cell.name}」！`);"""
assert old in src, 'auction anchor'
src = src.replace(old, """    winner.properties.push(cell.id);
    winner.propsBought = (winner.propsBought || 0) + 1;
    log(room, `🔨 ${winner.name} 以 ¥${a.topBid} 拍得「${cell.name}」！`);""")

old = """    cell.owner = bot.id;
    cell.level = 0;
    cell.mortgaged = false;
    bot.properties.push(cell.id);
    log(room, `🤖 ${bot.name} 购买了 ${cell.name}（¥${cell.price}）`);"""
assert old in src, 'botTryBuy anchor'
src = src.replace(old, """    cell.owner = bot.id;
    cell.level = 0;
    cell.mortgaged = false;
    bot.properties.push(cell.id);
    bot.propsBought = (bot.propsBought || 0) + 1;
    log(room, `🤖 ${bot.name} 购买了 ${cell.name}（¥${cell.price}）`);""")

# 人工购买（socket buy 处理器）
old = """    player.money -= cell.price;
    cell.owner = token;
    cell.level = 0;
    cell.mortgaged = false;
    player.properties.push(cell.id);
    log(room, `🏠 ${player.name} 购买了 ${cell.name}（¥${cell.price}）`);"""
assert old in src, 'human buy anchor'
src = src.replace(old, """    player.money -= cell.price;
    cell.owner = token;
    cell.level = 0;
    cell.mortgaged = false;
    player.properties.push(cell.id);
    player.propsBought = (player.propsBought || 0) + 1;
    log(room, `🏠 ${player.name} 购买了 ${cell.name}（¥${cell.price}）`);""")

# ── 5. concludeGame：生涯字段合并 ──
old = """    const s = stats[p.name] || (stats[p.name] = { games: 0, wins: 0, bestNet: 0 });
    s.games++;
    if (winnerId && id === winnerId) s.wins++;
    s.bestNet = Math.max(s.bestNet, playerNetWorth(room, id));"""
assert old in src, 'conclude anchor'
src = src.replace(old, """    const s = stats[p.name] || (stats[p.name] = { games: 0, wins: 0, bestNet: 0, rentEarned: 0, rolls: 0, jailed: 0, propsBought: 0 });
    s.games++;
    if (winnerId && id === winnerId) s.wins++;
    s.bestNet = Math.max(s.bestNet, playerNetWorth(room, id));
    s.rentEarned = (s.rentEarned || 0) + (p.rentEarned || 0);
    s.rolls = (s.rolls || 0) + (p.rollCount || 0);
    s.jailed = (s.jailed || 0) + (p.timesJailed || 0);
    s.propsBought = (s.propsBought || 0) + (p.propsBought || 0);""")

# ── 6. getStats：下发生涯字段 ──
old = """    const mine = n && stats[n] ? { name: n, games: stats[n].games, wins: stats[n].wins, bestNet: stats[n].bestNet } : null;"""
assert old in src, 'getStats anchor'
src = src.replace(old, """    const mine = n && stats[n] ? {
      name: n, games: stats[n].games, wins: stats[n].wins, bestNet: stats[n].bestNet,
      rentEarned: stats[n].rentEarned || 0, rolls: stats[n].rolls || 0,
      jailed: stats[n].jailed || 0, propsBought: stats[n].propsBought || 0,
    } : null;""")

# ── 7. topStats 也带上（排行榜悬浮用，可选）──
old = """    .map(([name, s]) => ({ name, games: s.games, wins: s.wins, bestNet: s.bestNet }))"""
assert old in src, 'topStats anchor'
src = src.replace(old, """    .map(([name, s]) => ({ name, games: s.games, wins: s.wins, bestNet: s.bestNet, rentEarned: s.rentEarned || 0 }))""")

# ── 8. 版本 ──
old = "🎲 大富翁在线 v2.29 服务器已启动"
assert old in src, 'version anchor'
src = src.replace(old, "🎲 大富翁在线 v2.30 服务器已启动")

open('server.js', 'w', encoding='utf-8').write(src)
print('server v2.30 ok')

# ========== FRONTEND ==========
app = open('public/app.js', encoding='utf-8').read().replace('\r\n', '\n')

# ── 徽章墙：生涯成就（点亮/未解锁）──
old = """  // 生涯徽章
  if (els.myStatsLine) {
    const badges = [];
    if (mine) {
      if (mine.wins >= 1) badges.push('🥇 首胜达成');
      if (mine.wins >= 5) badges.push('🏆 五胜上将');
      if (mine.games >= 10) badges.push('🎖 十局常客');
      if (mine.bestNet >= 50000) badges.push('💰 家财万贯');
    }
    const base = mine ? `📊 我的战绩（${escapeHtml(mine.name)}）：${mine.wins} 胜 / ${mine.games} 局${mine.bestNet ? ' · 巅峰净资产 ¥' + mine.bestNet.toLocaleString() : ''}` : '';
    els.myStatsLine.innerHTML = base + (badges.length ? `<br><span style="font-size:11.5px;">${badges.join('　')}</span>` : '');
  }"""
assert old in app, 'badges anchor'
app = app.replace(old, """  // 成就墙（8 枚：点亮 / 未解锁）
  const ACHIEVEMENTS = [
    { icon: '🥇', name: '首胜', desc: '赢下第一局', got: mine && mine.wins >= 1 },
    { icon: '🏆', name: '五胜上将', desc: '累计 5 胜', got: mine && mine.wins >= 5 },
    { icon: '🎖', name: '十局常客', desc: '累计 10 局', got: mine && mine.games >= 10 },
    { icon: '💰', name: '家财万贯', desc: '巅峰净资产 ¥50,000', got: mine && mine.bestNet >= 50000 },
    { icon: '🏦', name: '收租达人', desc: '生涯收租 ¥20,000', got: mine && (mine.rentEarned || 0) >= 20000 },
    { icon: '🎲', name: '骰子狂人', desc: '生涯掷骰 200 次', got: mine && (mine.rolls || 0) >= 200 },
    { icon: '🏗', name: '圈地运动', desc: '生涯购地 15 块', got: mine && (mine.propsBought || 0) >= 15 },
    { icon: '🚔', name: '铁窗泪', desc: '入狱 3 次（也算成就）', got: mine && (mine.jailed || 0) >= 3 },
  ];
  if (els.myStatsLine) {
    const base = mine ? `📊 我的战绩（${escapeHtml(mine.name)}）：${mine.wins} 胜 / ${mine.games} 局${mine.bestNet ? ' · 巅峰净资产 ¥' + mine.bestNet.toLocaleString() : ''}` : '输入昵称开始你的第一局，生涯成就将永久记录';
    const wall = `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${ACHIEVEMENTS.map(a => `
      <span class="ach ${a.got ? 'got' : 'locked'}" title="${a.name}：${a.desc}">${a.icon}<i>${a.name}</i></span>`).join('')}</div>`;
    els.myStatsLine.innerHTML = (base ? base + '<br>' : '') + wall;
  }""")

open('public/app.js', 'w', encoding='utf-8').write(app)

# CSS
css = open('public/style.css', encoding='utf-8').read()
css += """

/* v2.30: achievement wall */
.ach {
  display: inline-flex; align-items: center; gap: 3px;
  border-radius: 999px; padding: 2px 8px 2px 5px;
  font-size: 11px; font-style: normal;
}
.ach i { font-style: normal; }
.ach.got { background: linear-gradient(135deg, rgba(255, 215, 79, 0.22), rgba(255, 171, 64, 0.3)); color: var(--text-primary); border: 1px solid rgba(255, 213, 79, 0.6); }
.ach.locked { background: var(--bg-board); color: var(--text-tertiary); border: 1px solid var(--border-dark); opacity: 0.65; filter: grayscale(0.8); }
"""
open('public/style.css', 'w', encoding='utf-8').write(css)
print('frontend v2.30 ok')
