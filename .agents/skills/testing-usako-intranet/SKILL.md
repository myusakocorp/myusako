# Testing USAKO Intranet App

## Overview
The USAKO Intranet is a React + Express app deployed on a Namecheap VPS. The public-facing site (myusako.org) is on Namecheap shared hosting.

## Devin Secrets Needed
- `PERPLEXITY_API_KEY` — Perplexity Sonar API key for the AI phone agent brain
- VPS SSH credentials (root@159.198.41.10, port 22) — for deployment
- cPanel credentials (myusxbab) — for updating files on myusako.org shared hosting
- Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID) — for phone/softphone features

## Architecture
- **Intranet App (VPS)**: https://server1.myusako.org — React frontend + Express backend, managed by PM2
  - App location: `/opt/usako-intranet`
  - Process manager: PM2 (`pm2 restart all`, `pm2 status`, `pm2 logs`)
  - Reverse proxy: Nginx
  - SSL: Let's Encrypt (certbot)
- **Public Site (Shared Hosting)**: https://myusako.org — Static HTML on Namecheap shared hosting
  - cPanel access: `https://myusako.org:2083`
  - File location: `/public_html/`
  - Key files: `index.html` (main site), `event-grid.html` (rover visit request page)

## Testing the Intranet

### Login
- URL: https://server1.myusako.org
- Credentials: `staff` / password stored in secrets
- After login, you land on the Dashboard

### Rover Schedule Form
- Navigate: Sidebar → "Rover" tab
- The form has 3 fields: Date picker, Cross Streets text input, Time Slot buttons (10:00 AM, 11:30 AM, 2:00 PM, 3:30 PM)
- Submit via "Schedule Visit" button
- Verify: New entry appears in "Scheduled Visits" list below with cross streets, time slot, and SCHEDULED status
- Backend: POST /api/rover/schedule stores title, start_time, end_time, cross_streets, time_slot

### Event-Grid Page (Public)
- URL: https://myusako.org/event-grid.html
- This page has `API_BASE` variable pointing to `https://server1.myusako.org`
- If you see "unable to connect to server", check that API_BASE is set correctly and VPS CORS allows the origin
- The form submits to `/api/rover/visit-request` on the VPS
- The map uses Leaflet/OpenStreetMap centered on Sacramento

### IVR Simulator
- Navigate: Sidebar → "AI Phone System" → IVR Simulator tab
- Click "Start Call" to begin
- Menu options 1-5, 0 route to different agents (Harmony, River, Hope, Joy, Operator)
- Each agent has distinct voice profile via browser SpeechSynthesis

## Deployment to VPS

Use non-interactive SSH:
```bash
sshpass -p 'PASSWORD' ssh -o StrictHostKeyChecking=no root@159.198.41.10 "cd /opt/usako-intranet && git fetch origin && git merge origin/BRANCH --no-edit && npm run build && pm2 restart all"
```

Do NOT use interactive SSH sessions for file editing.

## Updating Files on Shared Hosting (myusako.org)

Use cPanel UAPI with basic auth:

### Read a file:
```bash
curl -sk -u "CPANEL_USER:CPANEL_PASS" "https://myusako.org:2083/execute/Fileman/get_file_content?dir=%2Fpublic_html&file=FILENAME"
```

### Write a file:
Use Python with urllib to POST to `/execute/Fileman/save_file_content` with basic auth.
The response will have `status: 1` on success.

## Common Issues
- **event-grid.html "unable to connect"**: Check that `API_BASE` in the file points to `https://server1.myusako.org`, not empty string
- **Softphone "credentials missing"**: Ensure TWILIO_API_KEY, TWILIO_API_SECRET, and TWILIO_TWIML_APP_SID are set in `/opt/usako-intranet/.env` on the VPS
- **PM2 not starting after deploy**: Check `pm2 logs` for errors. Common cause is missing .env variables.
- **404 on VPS**: Ensure `npm run build` was run after code changes (builds to `dist/` folder served by Express)
