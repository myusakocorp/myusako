# Testing USAKO Intranet App

## Devin Secrets Needed
- `PERPLEXITY_API_KEY` — Required for the AI phone agent brain (Perplexity Sonar API)
- VPS SSH credentials (root@159.198.41.10) — For production deployment testing

## Local Dev Setup
1. Navigate to `/home/ubuntu/repos/myusako`
2. Ensure `.env` file exists with `PERPLEXITY_API_KEY`
3. Kill any existing processes on port 3000: `fuser -k 3000/tcp`
4. Start server: `npx tsx server.ts` (runs on http://localhost:3000)
5. The app serves both the API and the built frontend from the same Express server

## Important: Local Database vs Production
- The local SQLite database (`usako_intranet.db`) is separate from the VPS production database
- If the staff password was changed in production but not locally, you need to update it manually:
  ```
  node -e "const Database = require('better-sqlite3'); const db = new Database('usako_intranet.db'); db.prepare('UPDATE users SET password = ? WHERE username = ?').run('NEW_PASSWORD', 'staff'); console.log('Updated');"
  ```
- The default seed only runs when no users exist, so password changes in code won't auto-apply to existing DBs

## Login
- URL: http://localhost:3000 (local) or https://server1.myusako.org (production)
- Username: `staff`
- Password: stored as plaintext in the `users` table (by user's design choice)
- After login, you land on the Dashboard tab

## Testing the IVR Simulator
1. Click **"AI Phone System"** in the left sidebar
2. The **"AI Agent Simulator"** sub-tab is active by default
3. Click **"Start Call"** button — this sends `START_CALL` to `POST /api/chat`
4. The greeting should include: "United Solutions Assisting Kind-er Ones" and menu options 1-5, 0
5. To test specific agents, type the number in the input field and send:
   - `1` → Directory
   - `2` → Harmony (Client Services / Relief Rover)
   - `3` → River (Donations)
   - `4` → Hope (Operations)
   - `5` → Joy (General Info)
   - `0` → Operator
6. Each agent should introduce themselves by name and reference their specialty
7. Use **"RESET"** button (top right of simulator) to start a fresh call between agent tests
8. TTS auto-plays via browser SpeechSynthesis — voice profiles differ per agent (pitch, rate, preferred voices)

## Testing 211.org Community Resources
1. Start a call and press `2` to reach Harmony
2. Ask about community resources: "I need help finding food assistance"
3. When asked for location, say "Sacramento"
4. Harmony should reference 211 services and offer verbal or SMS delivery of info

## Testing the Mission Page
- Click **"Our Mission"** in the sidebar
- Should show organization name, U·S·A·K·O acronym, mission statement, hours, location, and Relief Rover R.E.A. section

## Key Verification Points
- Header shows agent name when routed (e.g., "AGENT HARMONY · BROWSER TTS")
- Each agent message has a "REPLAY VOICE" button for re-playing TTS
- Dashboard shows "Perplexity AI Brain: HEALTHY" in System Status
- Company name is spoken as "Kind-er" (phonetic) and "U S A K O" (spelled out) in TTS

## Production Deployment
- VPS: 159.198.41.10 (server1.myusako.org)
- App location on VPS: `/opt/usako-intranet`
- Process manager: PM2 (`pm2 restart all` after deploy)
- Use `sshpass` for non-interactive SSH: `sshpass -p 'PASSWORD' ssh root@159.198.41.10`
- After pulling changes: `npm run build && pm2 restart all`

## Common Issues
- Port 3000 already in use: Kill with `fuser -k 3000/tcp` (note: `lsof` may not be available)
- Local DB password mismatch: Update manually with better-sqlite3 as shown above
- TTS not playing: Browser may require user interaction first — click "TEST AUDIO" button
- Server exits silently: Check for port conflicts or missing env vars
