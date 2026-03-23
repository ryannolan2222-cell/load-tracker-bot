const { App } = require('@slack/bolt');

// ── Config ────────────────────────────────────────────────────
const WATCHED_CHANNELS = {
  'C0AMV6LJAMD': 'tender-call-out',
  'C0A746ZH6QG': 'tender-call-out-edi',
  'C0ACYJ1BT7U': 'red-flag'
};
const SCOREBOARD_CHANNEL = 'C09P0JSCWEP';

// Known customers → maps hashtag variations to display name
// Add more here as needed — all lowercase, no spaces
const CUSTOMER_MAP = {
  sysco:        'Sysco',
  kraftheinz:   'Kraft Heinz',
  kraft:        'Kraft Heinz',
  usfood:       'US Foods',
  usfoods:      'US Foods',
  publix:       'Publix',
  amazon:       'Amazon',
  walmart:      'Walmart',
  target:       'Target',
  chewy:        'Chewy',
  wayfair:      'Wayfair',
  homedepot:    'Home Depot',
  lowes:        "Lowe's",
  costco:       'Costco',
  samsclub:     "Sam's Club",
};

// ── In-memory scoreboard (resets at midnight) ─────────────────
let scoreboard = {};
let lastResetDate = todayStr();

function todayStr() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function checkReset() {
  const today = todayStr();
  if (today !== lastResetDate) {
    scoreboard = {};
    lastResetDate = today;
    console.log('Scoreboard reset for new day:', today);
  }
}

function getOrCreate(customer) {
  if (!scoreboard[customer]) {
    scoreboard[customer] = { total: 0, spot: 0, contract: 0 };
  }
  return scoreboard[customer];
}

// ── Parse hashtags from message ───────────────────────────────
function parseLoad(text) {
  if (!text) return null;

  const tags = (text.match(/#[\w]+/g) || []).map(t => t.slice(1).toLowerCase());
  if (tags.length === 0) return null;

  // Detect load type
  let type = null;
  if (tags.includes('spot')) type = 'spot';
  else if (tags.includes('contract')) type = 'contract';

  // Detect customer
  let customer = null;
  for (const tag of tags) {
    if (tag === 'spot' || tag === 'contract') continue;
    if (CUSTOMER_MAP[tag]) {
      customer = CUSTOMER_MAP[tag];
      break;
    }
    // If not in map, use the tag itself capitalized as the customer name
    if (tag.length > 1) {
      customer = tag.charAt(0).toUpperCase() + tag.slice(1);
      break;
    }
  }

  if (!customer || !type) return null;
  return { customer, type };
}

// ── Build scoreboard message ───────────────────────────────────
function buildScoreboardMsg(newLoad, channelName) {
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1].total - a[1].total);
  const totalLoads = sorted.reduce((sum, [, s]) => sum + s.total, 0);
  const totalSpot = sorted.reduce((sum, [, s]) => sum + s.spot, 0);
  const totalContract = sorted.reduce((sum, [, s]) => sum + s.contract, 0);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  const typeEmoji = newLoad.type === 'spot' ? ':yellow_circle:' : ':large_green_circle:';
  const typeLabel = newLoad.type.toUpperCase();

  const lines = sorted.map(([customer, s]) => {
    const marker = customer === newLoad.customer ? ' ◀' : '';
    return `• *${customer}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot)_${marker}`;
  }).join('\n');

  return [
    `${typeEmoji} *New load logged* — *${newLoad.customer}* · ${typeLabel} · #${channelName}`,
    `${'─'.repeat(40)}`,
    lines,
    `${'─'.repeat(40)}`,
    `*Total: ${totalLoads} loads today* · :large_green_circle: ${totalContract} contract · :yellow_circle: ${totalSpot} spot · _${dateStr}_`
  ].join('\n');
}

function buildFinalMsg() {
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1].total - a[1].total);
  const totalLoads = sorted.reduce((sum, [, s]) => sum + s.total, 0);
  const totalSpot = sorted.reduce((sum, [, s]) => sum + s.spot, 0);
  const totalContract = sorted.reduce((sum, [, s]) => sum + s.contract, 0);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];

  const lines = sorted.map(([customer, s], i) => {
    const medal = i < 3 ? medals[i] : '•';
    return `${medal} *${customer}* — ${s.total} load${s.total !== 1 ? 's' : ''} _(${s.spot} spot / ${s.contract} contract)_`;
  }).join('\n');

  return [
    `🏁 *FINAL LOAD COUNT — ${dateStr}*`,
    `${'─'.repeat(40)}`,
    lines || '_No loads logged today_',
    `${'─'.repeat(40)}`,
    `*Total: ${totalLoads} loads* · :large_green_circle: ${totalContract} contract · :yellow_circle: ${totalSpot} spot`
  ].join('\n');
}

// ── Slack App ─────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

// Listen for messages in watched channels
app.message(async ({ message, client }) => {
  try {
    checkReset();

    const channelName = WATCHED_CHANNELS[message.channel];
    if (!channelName) return; // not a watched channel
    if (message.subtype) return; // ignore edits, joins, etc.
    if (!message.text) return;

    const load = parseLoad(message.text);
    if (!load) return; // no valid hashtags found

    // Update scoreboard
    const entry = getOrCreate(load.customer);
    entry.total++;
    entry[load.type]++;

    console.log(`Load logged: ${load.customer} (${load.type}) from #${channelName}`);

    // Post to scoreboard channel
    await client.chat.postMessage({
      channel: SCOREBOARD_CHANNEL,
      text: buildScoreboardMsg(load, channelName),
      unfurl_links: false,
      unfurl_media: false,
    });

    // Add a checkmark reaction to the original message
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: load.type === 'spot' ? 'yellow_circle' : 'white_check_mark',
    });

  } catch (err) {
    console.error('Error handling message:', err);
  }
});

// Slash command: /finalscore — post end of day summary
app.command('/finalscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  await client.chat.postMessage({
    channel: SCOREBOARD_CHANNEL,
    text: buildFinalMsg(),
  });
});

// Slash command: /loadscore — post current standings on demand
app.command('/loadscore', async ({ ack, client }) => {
  await ack();
  checkReset();
  const sorted = Object.entries(scoreboard).sort((a, b) => b[1].total - a[1].total);
  if (sorted.length === 0) {
    await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: '_No loads logged yet today._' });
    return;
  }
  await client.chat.postMessage({ channel: SCOREBOARD_CHANNEL, text: buildFinalMsg() });
});

// Health check endpoint for Railway
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Load Tracker Bot running');
}).listen(process.env.PORT || 8080);

// Start
(async () => {
  await app.start(process.env.PORT || 8080);
  console.log('Load Tracker Bot is running');
})();
