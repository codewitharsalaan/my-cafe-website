# Noir & Bean – cafe website with backend, order tracking and admin

1. Install Node.js (LTS) from nodejs.org
2. Open this folder in VS Code, then in the terminal:
       npm install express better-sqlite3
3. Open `.env` and set ADMIN_PASSWORD (8+ characters). Admin stays locked until you change it.
4. Start:
       npm start
5. Website: http://localhost:3000   Admin: http://localhost:3000/admin

## What customers see
After placing an order they land on a tracking page (/track.html?t=...) with:
live status, estimated time countdown, and a time log. It refreshes by itself.

## What you do in Admin
New order -> pick "Arrives in / Ready in" minutes -> Accept order
Then: +5 / +10 min if delayed -> Mark ready / Out for delivery -> complete.

## Upgrading from the first version
Replace: server.js, db.js, public/index.html, public/admin.html, public/style.css
Add:     public/track.html
Keep:    .env and cafe.db (the old database upgrades itself on first start)

## Optional settings (.env)
DEFAULT_PREP_MINUTES=20   default ETA if none is chosen
DB_PATH=/path/cafe.db     where the database file lives (use a persistent disk on a host)
TRUST_PROXY=1             set on a host/proxy so each customer is counted separately
