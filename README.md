# Load Tracker Bot

Watches #tender-call-out, #tender-call-out-edi, and #red-flag for messages
tagged with customer hashtags and #spot or #contract. Posts live scoreboard
updates to #load-scoreboard.

## How your team uses it

Post in any watched channel with hashtags:

  FW: Load Tender 4821 - Reefer  #sysco #spot
  FW: Outbound Tampa to Atlanta  #kraftheinz #contract
  Load tender from Publix WH     #publix #contract

The bot will:
- React to the message with ✅ (contract) or 🟡 (spot)
- Post an updated scoreboard to #load-scoreboard instantly

## Adding customers

Edit the CUSTOMER_MAP in index.js. The key is the hashtag (lowercase, no spaces),
the value is the display name:

  mycompany: 'My Company Name',

Any unknown hashtag that isn't "spot" or "contract" will be auto-capitalized
and used as the customer name — so #newcustomer works without any code changes.

## Slash commands

  /loadscore   — post current standings to #load-scoreboard
  /finalscore  — post end-of-day final summary

## Environment variables required in Railway

  SLACK_BOT_TOKEN      = xoxb-...
  SLACK_SIGNING_SECRET = (from Slack app Basic Information page)

## Deployment on Railway

1. Go to railway.app and sign up free
2. Click New Project → Deploy from GitHub repo
   OR: New Project → Empty Project → drag this folder
3. Add environment variables (see above)
4. Copy the Railway public URL
5. In Slack app settings → Event Subscriptions → paste URL + /slack/events
6. Re-invite the bot to each channel: /invite @Load Tracker Bot
