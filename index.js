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

function buildLiveMs
