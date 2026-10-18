# Snakes and Ladders backend

A memory-only Socket.IO server for private local-network games with 2–8 players. Keep this repository beside `snake-ladder`.

## Run

Install with `npm ci`. For combined frontend/backend startup, run `npm run local` from the frontend repository. It prints the computer/phone URLs and configures permitted origins, including the computer hostname.

Standalone startup: `npm start` (default port 3500). `PORT` overrides the port. `FRONTEND_ORIGINS` accepts comma-separated frontend origins; otherwise localhost and detected IPv4 origins on port 3000 are allowed.

## Operations

`GET /health` returns uncached JSON status, uptimeSeconds, rooms and connections. Logs are newline-separated JSON with time, level, event and relevant non-secret context. Resume tokens, payloads and socket addresses are omitted. Expected request failures return actionable messages; internal failures return a generic error.

Known game actions are limited to 30 per connection and 150 per address per 10 seconds, including invalid requests. Rate-limit replies include retryAfterMs. Budgets expire automatically; reconnecting does not reset the address budget. Only the first denial in a window is logged. Messages are capped at 16 KiB. These limits do not provide network-level denial-of-service protection.

SIGINT/SIGTERM close the server and release timers. Restarting clears all rooms. Disconnected players can resume within two minutes while the same server is running; expiry forfeits their slot. Rematches require unanimous votes from at least two remaining connected players.

## Tests

`npm test` runs rule and limiter unit tests. In the sibling frontend, `npm run test:backend` adds real Socket.IO recovery, operational and LAN-helper checks; `npm run test:multiplayer` checks four-player synchronization. Network checks require local ports.

The frontend `README.md` and `DESIGN.md` document the full event protocol. Accessibility work, device testing and internet hosting are outside the current scope.
