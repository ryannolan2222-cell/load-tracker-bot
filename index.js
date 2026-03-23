const { App, ExpressReceiver } = require('@slack/bolt');
const { Client } = require('pg');

const WATCHED_CHANNELS = {
  'C09P0JSCWEP': 'tender-call-out',
  'C0ACYJ1BT7U': 'tender-call-out-edi',
  'C0A746ZH6QG': 'red-flag'
};
const SCOREBOARD_CHANNEL = 'C0AMV6LJAMD';

const CUSTOMER_MAP = {
  sysco: 'Sysco', kraftheinz: 'Kraft Heinz', kraft: 'Kraft Heinz',
  usfood: 'US Foods', usfoods: 'US Foods', publix: 'Publix',
  amazon: 'Amazon', walmart: 'Walmart', target: 'Target',
  chewy: 'Chewy', wayfair: 'Wayfair', homedepot: 'Home Depot',
  lowes: "Lowe's", costco: 'Costco',
};

let daily = {};
let weekly = {};
let monthly = {};
let lastDay = todayStr();
let lastWeek = weekStr();
let lastMonth = monthStr();

function todayStr() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}
function weekStr() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split('T')[0];
}
function monthStr() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
function checkReset() {
  const today = todayStr();
  const week = weekStr();
  const month = monthStr();
  if (today !== lastDay) { daily = {}; lastDay = today; }
  if (week !== lastWeek) { weekly = {}; lastWeek = week; }
  if (month !== lastMonth) { monthly = {}; lastMonth = month; }
}
function addToBoard(board, customer, type) {
  if (!board[customer]) board[customer] = { total: 0, spot: 0, contract: 0 };
  board[customer].total++;
  board[customer][type]++;
}
function parseLoad(text) {
  if (!text) return null;
  const tags = (text.match(/#[\w]+/g) || []).map(t => t.slice(1).toLowerCase());
  if (!tags.length) return null;
  const isDelete = tags.includes('delete');
  let type = tags.includes('spot') ? 'spot' : tags.includes('contract') ? 'contract' : null;
  let customer = null;
  for (const tag of tags) {
    if (['spot', 'contract', 'delete'].includes(tag)) continue;
    customer = CUSTOMER_MAP[tag] || (tag.length > 1 ? tag.charAt(0).toUpperCase() + tag.slice(1) : null);
    if (customer) break;
  }
  if (!customer) return null;
  if (isDelete) return { customer, type: null, isDelete: true };
  if (!type) return null;
  return { customer, type, isDelete: false };
}
function toDbKey(dateStr) {
  const parts = dateStr.split('/');
  return `${parseInt(parts[0])}/${parseInt(parts[1])}/${parts[2]}`;
}
function parseDateArg(arg) {
  if (!arg || arg.length !== 6) return null;
  const mm = arg.slice(0, 2);
  const dd = arg.slice(2, 4);
  const yy = arg.slice(4, 6);
  const year = parseInt(yy) + 2000;
  const date = new Date(`${year}-${mm}-${dd}`);
  if (isNaN(date.getTime())) return null;
  return {
    dbKey: `${parseInt(mm)}/${parseInt(dd)}/${year}`,
    display: date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  };
}

function buildLiveMsg(board, newLoad, channelName) {
  const sorted = Object.entries(board).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const emoji = newLoad.type === 'spot' ? ':moneybag:' : ':receipt:';
  const lines = sorted.map(([c, s]) => `• *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_${c === newLoad.customer ? ' ◀' : ''}`).join('\n');
  return [`${emoji} *New load logged* — *${newLoad.customer}* · ${newLoad.type.toUpperCase()} · #${channelName}`, '─'.repeat(42), lines, '─'.repeat(42), `*Total: ${totals.loads} loads today* · :receipt: ${totals.contract} contract · :moneybag: ${totals.spot} spot · _${dateStr}_`].join('\n');
}
function buildSummaryFromRows(rows, label) {
  if (!rows.length) return `🏁 *${label}*\n${'─'.repeat(42)}\n_No loads recorded_`;
  const board = {};
  rows.forEach(r => {
    if (!board[r.customer]) board[r.customer] = { total: 0, spot: 0, contract: 0 };
    board[r.customer].total += parseInt(r.total);
    board[r.customer].spot += parseInt(r.spot);
    board[r.customer].contract += parseInt(r.contract);
  });
  const sorted = Object.entries(board).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
  const lines = sorted.map(([c, s], i) => `${i < 3 ? medals[i] : '•'} *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_`).join('\n');
  return [`🏁 *${label}*`, '─'.repeat(42), lines, '─'.repeat(42), `*Total: ${totals.loads} loads* · :receipt: ${totals.contract} contract · :moneybag: ${totals.spot} spot`].join('\n');
}
function buildCompareMsg(rowsA, dateA, rowsB, dateB) {
  const toBoard = (rows) => {
    const b = {};
    rows.forEach(r => {
      if (!b[r.customer]) b[r.customer] = { total: 0, spot: 0, contract: 0 };
      b[r.customer].total += parseInt(r.total);
      b[r.customer].spot += parseInt(r.spot);
      b[r.customer].contract += parseInt(r.contract);
    });
    return b;
  };
  const boardA = toBoard(rowsA);
  const boardB = toBoard(rowsB);
  const allCustomers = [...new Set([...Object.keys(boardA), ...Object.keys(boardB)])].sort();
  const totA = Object.values(boardA).reduce((s, v) => s + v.total, 0);
  const totB = Object.values(boardB).reduce((s, v) => s + v.total, 0);
  const lines = allCustomers.map(c => {
    const a = boardA[c] || { total: 0 };
    const b = boardB[c] || { total: 0 };
    const diff = b.total - a.total;
    const arrow = diff > 0 ? ` ▲${diff}` : diff < 0 ? ` ▼${Math.abs(diff)}` : ' ═';
    return `• *${c}* — ${a.total} vs ${b.total}${arrow}`;
  }).join('\n');
  const totalDiff = totB - totA;
  const totalArrow = totalDiff > 0 ? `▲${totalDiff}` : totalDiff < 0 ? `▼${Math.abs(totalDiff)}` : '═ same';
  return [`📊 *COMPARISON*`, `_${dateA.display}_ vs _${dateB.display}_`, '─'.repeat(42), lines || '_No data for either date_', '─'.repeat(42), `*Totals: ${totA} vs ${totB} loads* ${totalArrow}`].join('\n');
}
function buildRecordMsg(customer, period, newCount, previous, previousDate) {
  const periodLabels = { day: 'single day', week: 'single week', month: 'single month' };
  const periodEmojis = { day: '📅', week: '📆', month: '🗓️' };
  return [`🏆 *NEW RECORD — ${customer}!*`, `${periodEmojis[period]} Most loads in a ${periodLabels[period]}`, '─'.repeat(42), `*Previous best:* ${previous} loads _(set ${previousDate})_`, `*New record:* ${newCount} loads and counting`, '─'.repeat(42), `_Keep it up! 🚚_`].join('\n');
}

// ── Database ──────────────────────────────────────────────────
let db;
async function initDb() {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS load_log (
    id SERIAL PRIMARY KEY,
    customer TEXT NOT NULL,
    type TEXT NOT NULL,
    channel TEXT NOT NULL,
    date_str TEXT NOT NULL,
    week_str TEXT NOT NULL,
    month_str TEXT NOT NULL,
    logged_at TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS records (
    customer TEXT NOT NULL,
    period TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    achieved_date TEXT NOT NULL,
    PRIMARY KEY (customer, period)
  )`);
  await rebuildFromDb();
  console.log('Database ready');
}
async function rebuildFromDb() {
  const todayKey = toDbKey(todayStr());
  const dayRes = await db.query('SELECT customer, type FROM load_log WHERE date_str = $1', [todayKey]);
  daily = {};
  dayRes.rows.forEach(r => addToBoard(daily, r.customer, r.type));
  const weekRes = await db.query('SELECT customer, type FROM load_log WHERE week_str = $1', [weekStr()]);
  weekly = {};
  weekRes.rows.forEach(r => addToBoard(weekly, r.customer, r.type));
  const monthRes = await db.query('SELECT customer, type FROM load_log WHERE month_str = $1', [monthStr()]);
  monthly = {};
  monthRes.rows.forEach(r => addToBoard(monthly, r.customer, r.type));
  console.log(`Rebuilt — today: ${Object.values(daily).reduce((s,v)=>s+v.total,0)} loads`);
}
async function saveLoad(customer, type, channel) {
  const res = await db.query('INSERT INTO load_log (customer, type, channel, date_str, week_str, month_str) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [customer, type, channel, toDbKey(todayStr()), weekStr(), monthStr()]);
  return res.rows[0].id;
}
async function deleteLastLoad(customer) {
  const res = await db.query('SELECT id, type FROM load_log WHERE customer = $1 AND date_str = $2 ORDER BY logged_at DESC LIMIT 1', [customer, toDbKey(todayStr())]);
  if (!res.rows.length) return null;
  const { id, type } = res.rows[0];
  await db.query('DELETE FROM load_log WHERE id = $1', [id]);
  return type;
}
async function getLoadsForDate(dbKey) {
  const res = await db.query(`SELECT customer, COUNT(*) as total, SUM(CASE WHEN type='spot' THEN 1 ELSE 0 END) as spot, SUM(CASE WHEN type='contract' THEN 1 ELSE 0 END) as contract FROM load_log WHERE date_str = $1 GROUP BY customer`, [dbKey]);
  return res.rows;
}
async function getLoadsForWeek(ws) {
  const res = await db.query(`SELECT customer, COUNT(*) as total, SUM(CASE WHEN type='spot' THEN 1 ELSE 0 END) as spot, SUM(CASE WHEN type='contract' THEN 1 ELSE 0 END) as contract FROM load_log WHERE week_str = $1 GROUP BY customer`, [ws]);
  return res.rows;
}
async function getLoadsForMonth(ms) {
  const res = await db.query(`SELECT customer, COUNT(*) as total, SUM(CASE WHEN type='spot' THEN 1 ELSE 0 END) as spot, SUM(CASE WHEN type='contract' THEN 1 ELSE 0 END) as contract FROM load_log WHERE month_str = $1 GROUP BY customer`, [ms]);
  return res.rows;
}
async function checkAndUpdateRecord(customer, count, period) {
  const res = await db.query('SELECT record_count, achieved_date FROM records WHERE customer = $1 AND period = $2', [customer, period]);
  if (res.rows.length === 0) {
    await db.query('INSERT INTO records (customer, period, record_count, achieved_date) VALUES ($1, $2, $3, $4)', [customer, period, count, toDbKey(todayStr())]);
    return null;
  }
  const existing = res.rows[0];
  if (count > existing.record_count) {
    await db.query('UPDATE records SET record_count = $1, achieved_date = $2 WHERE customer = $3 AND period = $4', [count, toDbKey(todayStr()), customer, period]);
    return { previous: existing.record_count, previousDate: existing.achieved_date };
  }
  return null;
}

// ── App ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 8080;
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET, endpoints: '/slack/events' });
receiver.router.get('/', (req, res) => res.send('Load Tracker Bot running'));
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

app.message(async ({ message, client }) => {
  try {
    checkReset();
    const channelName = WATCHED_CHANNELS[message.channel];
    if (!channelName || message.subtype || !message.text) return;
    const parsed = parseLoad(message.text);
    if (!parsed) return;

    // Handle delete
    if (parsed.isDelete) {
      const deletedType = await deleteLastLoad(parsed.customer);
      if (!deletedType) {
        await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: `⚠️ No load found for *${parsed.customer}* today to delete.` });
        return;
      }
      await rebuildFromDb();
      const rows = await getLoadsForDate(toDbKey(todayStr()));
      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      await client.chat.postMessage({
        channel: SCOREBOARD_CHANNEL,
        text: [`🗑️ *Load deleted* — *${parsed.customer}* · ${deletedType.toUpperCase()} removed`, '─'.repeat(42), buildSummaryFromRows(rows, `UPDATED SCORE — ${dateStr.toUpperCase()}`)].join('\n')
      });
      await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'x' });
      return;
    }

    // Handle new load
    addToBoard(daily, parsed.customer, parsed.type);
    addToBoard(weekly, parsed.customer, parsed.type);
    addToBoard(monthly, parsed.customer, parsed.type);
    await saveLoad(parsed.customer, parsed.type, channelName);
    await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildLiveMsg(daily, parsed, channelName), unfurl_links: false, unfurl_media: false });
    await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: parsed.type === 'spot' ? 'moneybag' : 'receipt' });
    const dayCount = daily[parsed.customer].total;
    const weekCount = weekly[parsed.customer].total;
    const monthCount = monthly[parsed.customer].total;
    for (const [period, count] of [['day', dayCount], ['week', weekCount], ['month', monthCount]]) {
      const record = await checkAndUpdateRecord(parsed.customer, count, period);
      if (record) {
        await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildRecordMsg(parsed.customer, period, count, record.previous, record.previousDate), unfurl_links: false, unfurl_media: false });
      }
    }
  } catch (err) { console.error('Error:', err.message); }
});

app.command('/dayscore', async ({ ack, client }) => {
  await ack(); checkReset();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const rows = await getLoadsForDate(toDbKey(todayStr()));
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryFromRows(rows, `DAY SCORE — ${dateStr.toUpperCase()}`) });
});
app.command('/finalscore', async ({ ack, client }) => {
  await ack(); checkReset();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const rows = await getLoadsForDate(toDbKey(todayStr()));
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryFromRows(rows, `FINAL SCORE — ${dateStr.toUpperCase()}`) });
});
app.command('/weekscore', async ({ ack, client }) => {
  await ack(); checkReset();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay();
  now.setDate(now.getDate() - day + (day === 0 ? -6 : 1));
  const label = `WEEK OF ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase()}`;
  const rows = await getLoadsForWeek(weekStr());
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryFromRows(rows, label) });
});
app.command('/monthscore', async ({ ack, client }) => {
  await ack(); checkReset();
  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }).toUpperCase();
  const rows = await getLoadsForMonth(monthStr());
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryFromRows(rows, `${monthLabel} SCORE`) });
});
app.command('/score', async ({ ack, client, command }) => {
  await ack();
  const parsed = parseDateArg((command.text || '').trim());
  if (!parsed) { await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: '❌ Use format: `/score MMDDYY` — e.g. `/score 032326`' }); return; }
  const rows = await getLoadsForDate(parsed.dbKey);
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryFromRows(rows, parsed.display.toUpperCase()) });
});
app.command('/compare', async ({ ack, client, command }) => {
  await ack();
  const parts = (command.text || '').trim().split(/\s+/);
  if (parts.length !== 2) { await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: '❌ Use format: `/compare MMDDYY MMDDYY`' }); return; }
  const dateA = parseDateArg(parts[0]);
  const dateB = parseDateArg(parts[1]);
  if (!dateA || !dateB) { await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: '❌ Invalid dates. Use MMDDYY format.' }); return; }
  const [rowsA, rowsB] = await Promise.all([getLoadsForDate(dateA.dbKey), getLoadsForDate(dateB.dbKey)]);
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildCompareMsg(rowsA, dateA, rowsB, dateB) });
});
app.command('/halloffame', async ({ ack, client }) => {
  await ack();
  try {
    const res = await db.query('SELECT customer, period, record_count, achieved_date FROM records ORDER BY period, record_count DESC');
    const rows = res.rows;
    const fmt = (arr) => arr.length ? arr.map(r => `🥇 *${r.customer}* — ${r.record_count} load${r.record_count !== 1 ? 's' : ''} _(set ${r.achieved_date})_`).join('\n') : '_No records set yet_';
    const msg = ['🏆 *HALL OF FAME*', '─'.repeat(42), '📅 *Daily Records*', fmt(rows.filter(r => r.period === 'day')), '', '📆 *Weekly Records*', fmt(rows.filter(r => r.period === 'week')), '', '🗓️ *Monthly Records*', fmt(rows.filter(r => r.period === 'month')), '─'.repeat(42)].join('\n');
    await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: msg });
  } catch (err) { console.error('Error:', err.message); await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: '❌ Error fetching records.' }); }
});

(async () => {
  await initDb();
  await app.start(PORT);
  console.log(`Load Tracker Bot running on port ${PORT}`);
})();
