const { App, ExpressReceiver } = require('@slack/bolt');

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

let scoreboard = {};
let lastResetDate = todayStr();

function todayStr() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function checkReset() {
  const today = todayStr();
  if (today !== lastResetDate) { scoreboard = {}; lastResetDate = today; }
}

function getOrCreate(customer) {
  if (!scoreboard[customer]) scoreboard[customer] = { total: 0, spot: 0, contract: 0 };
  return scoreboard[customer];
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

function buildScoreboardMsg(newLoad, channelName) {
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const emoji = newLoad.type === 'spot' ? ':yellow_circle:' : ':large_green_circle:';
  const lines = sorted.map(([c, s]) => `• *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot)_${c === newLoad.customer ? ' ◀' : ''}`).join('\n');
  return [`${emoji} *New load logged* — *${newLoad.customer}* · ${newLoad.type.toUpperCase()} · #${channelName}`, '─'.repeat(40), lines, '─'.repeat(40), `*Total: ${totals.loads} loads today* · :large_green_circle: ${totals.contract} contract · :yellow_circle: ${totals.spot} spot · _${dateStr}_`].join('\n');
}

function buildFinalMsg() {
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1].total - a[1].total);
  const totals = sorted.reduce((acc, [, s]) => { acc.loads += s.total; acc.spot += s.spot; acc.contract += s.contract; return acc; }, { loads: 0, spot: 0, contract: 0 });
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
  const lines = sorted.map(([c, s], i) => `${i < 3 ? medals[i] : '•'} *${c}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_`).join('\n');
  return [`🏁 *FINAL LOAD COUNT — ${dateStr}*`, '─'.repeat(40), lines || '_No loads logged today_', '─'.repeat(40), `*Total: ${totals.loads} loads* · :large_green_circle: ${totals.contract} contract · :yellow_circle: ${totals.spot} spot`].join('\n');
}

const PORT = parseInt(process.env.PORT) || 8080;
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET, endpoints: '/slack/events' });
receiver.router.get('/', (req, res) => res.send('Load Tracker Bot running'));
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

app.message(async ({ message, client }) => {
  try {
    checkReset();
    const channelName = WATCHED_CHANNELS[message.channel];
    if (!channelName || message.subtype || !message.text) return;
    const load = parseLoad(message.text);
    if (!load) return;
    const entry = getOrCreate(load.customer);
    entry.total++; entry[load.type]++;
    console.log(`Load: ${load.customer} (${load.type}) from #${channelName}`);
    await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildScoreboardMsg(load, channelName), unfurl_links: false, unfurl_media: false });
    await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: load.type === 'spot' ? 'yellow_circle' : 'white_check_mark' });
  } catch (err) { console.error('Error:', err.message); }
});

app.command('/finalscore', async ({ ack, client }) => { await ack(); checkReset(); await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildFinalMsg() }); });
app.command('/loadscore', async ({ ack, client }) => { await ack(); checkReset(); await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildFinalMsg() }); });

(async () => { await app.start(PORT); console.log(`Load Tracker Bot running on port ${PORT}`); })();
