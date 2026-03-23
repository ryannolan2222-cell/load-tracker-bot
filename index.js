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
  const
