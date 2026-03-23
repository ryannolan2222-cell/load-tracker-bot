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
  let type = tags.includes('spot') ? 'spot' : tags.includes('contract') ? 'contract' : null;
  let customer = null;
  for (const tag of tags) {
    if (tag === 'spot' || tag === 'contract') continue;
    customer = CUSTOMER_MAP[tag] || (tag.length > 1 ? tag.charAt(0).toUpperCase() + tag.slice(1) : null);
    if (customer) break;
  }
  if (!customer || !type) return null;
  return { customer, type };
}

function buildLiveMsg(board, newLoad, channelName) {
  const sorted = Object.entries(board).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const emoji = newLoad.type === 'spot' ? ':moneybag:' : ':receipt:';
  const lines = sorted.map(([c, s]) => `• *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_${c === newLoad.customer ? ' ◀' : ''}`).join('\n');
  return [`${emoji} *New load logged* — *${newLoad.customer}* · ${newLoad.type.toUpperCase()} · #${channelName}`, '─'.repeat(42), lines, '─'.repeat(42), `*Total: ${totals.loads} loads today* · :receipt: ${totals.contract} contract · :moneybag: ${totals.spot} spot · _${dateStr}_`].join('\n');
}

function buildSummaryMsg(board, label) {
  const sorted = Object.entries(board).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
  const lines = sorted.map(([c, s], i) => `${i < 3 ? medals[i] : '•'} *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_`).join('\n');
  return [`🏁 *${label}*`, '─'.repeat(42), lines || '_No loads logged_', '─'.repeat(42), `*Total: ${totals.loads} loads* · :receipt: ${totals.contract} contract · :moneybag: ${totals.spot} spot`].join('\n');
}

// ── Database ──────────────────────────────────────────────────
let db;

async function initDb() {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS records (
      customer TEXT NOT NULL,
      period TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      achieved_date TEXT NOT NULL,
      PRIMARY KEY (customer, period)
    )
  `);
  console.log('Database connected and ready');
}

async function checkAndUpdateRecord(customer, count, period) {
  const res = await db.query('SELECT record_count, achieved_date FROM records WHERE customer = $1 AND period = $2', [customer, period]);
  if (res.rows.length === 0) {
    await db.query('INSERT INTO records (customer, period, record_count, achieved_date) VALUES ($1, $2, $3, $4)', [customer, period, count, todayStr()]);
    return null;
  }
  const existing = res.rows[0];
  if (count > existing.record_count) {
    await db.query('UPDATE records SET record_count = $1, achieved_date = $2 WHERE customer = $3 AND period = $4', [count, todayStr(), customer, period]);
    return { previous: existing.record_count, previousDate: existing.achieved_date };
  }
  return null;
}

function buildRecordMsg(customer, period, newCount, previous, previousDate) {
  const periodLabels = { day: 'single day', week: 'single week', month: 'single month' };
  const periodEmojis = { day: '📅', week: '📆', month: '🗓️' };
  return [
    `🏆 *NEW RECORD — ${customer}!*`,
    `${periodEmojis[period]} Most loads in a ${periodLabels[period]}`,
    '─'.repeat(42),
    `*Previous best:* ${previous} loads _(set ${previousDate})_`,
    `*New record:* ${newCount} loads and counting today`,
    '─'.repeat(42),
    `_Keep it up! 🚚_`
  ].join('\n');
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

    addToBoard(daily, parsed.customer, parsed.type);
    addToBoard(weekly, parsed.customer, parsed.type);
    addToBoard(monthly, parsed.customer, parsed.type);

    const dayCount = daily[parsed.customer].total;
    const weekCount = weekly[parsed.customer].total;
    const monthCount = monthly[parsed.customer].total;

    // Post live scoreboard
    await client.chat.postMessage({
      channel: SCOREBOARD_CHANNEL,
      text: buildLiveMsg(daily, parsed, channelName),
      unfurl_links: false, unfurl_media: false
    });

    // React to original message
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: parsed.type === 'spot' ? 'moneybag' : 'receipt'
    });

    // Check records
    const dayRecord = await checkAndUpdateRecord(parsed.customer, dayCount, 'day');
    const weekRecord = await checkAndUpdateRecord(parsed.customer, weekCount, 'week');
    const monthRecord = await checkAndUpdateRecord(parsed.customer, monthCount, 'month');

    for (const [period, record] of [['day', dayRecord], ['week', weekRecord], ['month', monthRecord]]) {
      if (record) {
        const count = period === 'day' ? dayCount : period === 'week' ? weekCount : monthCount;
        await client.chat.postMessage({
          channel: SCOREBOARD_CHANNEL,
          text: buildRecordMsg(parsed.customer, period, count, record.previous, record.previousDate),
          unfurl_links: false, unfurl_media: false
        });
      }
    }

  } catch (err) { console.error('Error:', err.message); }
});

app.command('/dayscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryMsg(daily, `DAY SCORE — ${dateStr.toUpperCase()}`) });
});

app.command('/finalscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryMsg(daily, `FINAL SCORE — ${dateStr.toUpperCase()}`) });
});

app.command('/weekscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay();
  now.setDate(now.getDate() - day + (day === 0 ? -6 : 1));
  const label = `WEEK OF ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase()}`;
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryMsg(weekly, label) });
});

app.command('/monthscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }).toUpperCase();
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildSummaryMsg(monthly, `${monthLabel} SCORE`) });
});

(async () => {
  await initDb();
  await app.start(PORT);
  console.log(`Load Tracker Bot running on port ${PORT}`);
})();
