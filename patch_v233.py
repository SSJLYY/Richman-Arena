# -*- coding: utf-8 -*-
# v2.33 patch: allied bots don't bid against teammates + team win achievement
src = open('server.js', encoding='utf-8').read().replace('\r\n', '\n')

# ── 1. 竞价链：当前最高出价者是队友 → 盟友 bot 停手 ──
old = """    const bidChain = () => {
      const cur = room.auction;
      if (!cur || cur.no !== a.no || p.bankrupt) return;"""
assert old in src, 'chain anchor'
src = src.replace(old, """    const bidChain = () => {
      const cur = room.auction;
      if (!cur || cur.no !== a.no || p.bankrupt) return;
      // 团队模式：当前最高出价者是队友 → 不与队友竞价
      if (room.settings.teamMode && cur.topBidder && room.players[cur.topBidder] &&
          room.players[cur.topBidder].team && room.players[cur.topBidder].team === p.team) return;""")

# 续链条件同样加队友守卫（避免继续排队竞价）
old = """      const now = room.auction;
      if (now && now.no === a.no && !p.bankrupt && now.topBidder !== p.id &&
          now.topBid + BID_STEP <= Math.min(maxBid, p.money)) {
        botAddTimer(room, bidChain, 1000 + Math.floor(Math.random() * 1800));"""
assert old in src, 'rechain anchor'
src = src.replace(old, """      const now = room.auction;
      const topIsTeammate = room.settings.teamMode && now.topBidder && room.players[now.topBidder] &&
        room.players[now.topBidder].team === p.team;
      if (now && now.no === a.no && !p.bankrupt && !topIsTeammate && now.topBidder !== p.id &&
          now.topBid + BID_STEP <= Math.min(maxBid, p.money)) {
        botAddTimer(room, bidChain, 1000 + Math.floor(Math.random() * 1800));""")

# ── 2. 团队胜利计入生涯 teamWins ──
old = """      s.propsBought = (s.propsBought || 0) + (p.propsBought || 0);"""
assert old in src, 'merge anchor'
src = src.replace(old, """      s.propsBought = (s.propsBought || 0) + (p.propsBought || 0);
      if (room.settings.teamMode && winnerId && alive.includes(id)) s.teamWins = (s.teamWins || 0) + 1;""")

# ── 3. getStats 下发 teamWins ──
old = """      jailed: stats[n].jailed || 0, propsBought: stats[n].propsBought || 0,"""
assert old in src, 'getStats anchor'
src = src.replace(old, """      jailed: stats[n].jailed || 0, propsBought: stats[n].propsBought || 0, teamWins: stats[n].teamWins || 0,""")

# ── 4. 版本 ──
old = "🎲 大富翁在线 v2.32 服务器已启动"
assert old in src, 'version anchor'
src = src.replace(old, "🎲 大富翁在线 v2.33 服务器已启动")

open('server.js', 'w', encoding='utf-8').write(src)
print('server v2.33 ok')

# ========== FRONTEND ==========
app = open('public/app.js', encoding='utf-8').read().replace('\r\n', '\n')

# 成就墙加第 9 枚：并肩作战
old = """    { icon: '🚔', name: '铁窗泪', desc: '入狱 3 次（也算成就）', got: mine && (mine.jailed || 0) >= 3 },"""
assert old in app, 'ach anchor'
app = app.replace(old, """    { icon: '🚔', name: '铁窗泪', desc: '入狱 3 次（也算成就）', got: mine && (mine.jailed || 0) >= 3 },
    { icon: '⚔️', name: '并肩作战', desc: '团队模式获胜 1 次', got: mine && (mine.teamWins || 0) >= 1 },""")

open('public/app.js', 'w', encoding='utf-8').write(app)
print('frontend v2.33 ok')
