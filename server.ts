import express from "express";
import { createServer as createViteServer } from "vite";
import twilio from "twilio";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import session from "express-session";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("usako_intranet.db");

// Initialize Database Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    email TEXT,
    needs TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    full_name TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    start TEXT,
    end TEXT,
    user_id INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT,
    from_number TEXT,
    to_number TEXT,
    status TEXT,
    duration INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS voicemails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, -- NULL for general voicemail
    from_number TEXT,
    duration INTEGER,
    audio_url TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS rover_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    start_time DATETIME,
    end_time DATETIME,
    status TEXT DEFAULT 'scheduled',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS rover_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    waypoints TEXT, -- JSON string
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS visit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT,
    cross_streets TEXT NOT NULL,
    requested_time TEXT NOT NULL,
    requested_date TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed a default user if none exists
const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
if (userCount.count === 0) {
  db.prepare("INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)").run(
    "staff", "usako2026", "admin", "USAKO Staff Member"
  );
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const PORT = 3000;

  app.set('trust proxy', 1); // trust first proxy
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request Logging Middleware
  app.use((req, res, next) => {
    const hasSession = !!(req.session as any)?.user;
    const hasHeader = !!req.headers['x-user-id'];
    console.log(`${req.method} ${req.url} - Session: ${hasSession} - Header: ${hasHeader}`);
    next();
  });

  app.use(session({
    secret: "usako-secret-key-2026",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { 
      secure: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // --- CORS for public API endpoints (client-facing page on myusako.org) ---
  app.use((req, res, next) => {
    const publicPaths = ["/api/rover/tracking", "/api/rover/visit-request", "/api/rover/visit-requests"];
    if (publicPaths.some(p => req.path.startsWith(p))) {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") return res.sendStatus(200);
    }
    next();
  });

  // --- Rover GPS Tracking (in-memory) ---
  let roverPosition: { lat: number; lng: number; updatedAt: string; trackedBy: string } | null = null;

  // --- Devin AI API Helper ---
  const DEVIN_API_BASE = "https://api.devin.ai";
  const DEVIN_API_KEY = process.env.DEVIN_API_KEY;

  // --- Gemini API Helper (for fast route generation) ---
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  async function generateWithGemini(prompt: string): Promise<string | null> {
    if (!GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not set - cannot generate route with AI");
      return null;
    }
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 1024,
              responseMimeType: "application/json"
            }
          })
        }
      );
      if (!res.ok) {
        const errText = await res.text();
        console.error("Gemini API error:", res.status, errText);
        return null;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return text || null;
    } catch (e) {
      console.error("Gemini API call error:", e);
      return null;
    }
  }

  // Track active Devin sessions per user for the phone simulator
  const activeDevinSessions = new Map<number, string>(); // userId -> sessionId

  const RECEPTIONIST_PROMPT = `You are a warm, professional virtual receptionist for United Solutions Assisting Kinder Ones (USAKO, pronounced Kind-er). You answer phone calls and help callers.

IMPORTANT RULES:
- Keep your responses brief and conversational (1-3 sentences max)
- Do NOT use markdown formatting, code blocks, or bullet points
- Do NOT attempt any coding, file editing, or technical tasks
- Simply respond as a friendly receptionist would on a phone call
- If you capture lead info (Name, Phone, Email, Needs), include a JSON-like block at the end: [LEAD: {"name": "...", "phone": "...", "email": "...", "needs": "..."}]
- Start the call with a warm greeting

Respond ONLY with plain text as if speaking on the phone. Your first message should be your greeting to the caller.`;

  async function createDevinSession(prompt: string): Promise<{ sessionId: string; url: string } | null> {
    if (!DEVIN_API_KEY) return null;
    try {
      const res = await fetch(`${DEVIN_API_BASE}/v1/sessions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEVIN_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt,
          max_acu_limit: 1,
          unlisted: true,
          title: "USAKO Phone Agent Session"
        })
      });
      if (!res.ok) {
        console.error("Devin session creation failed:", res.status, await res.text());
        return null;
      }
      const data = await res.json();
      console.log(`Devin session created: ${data.session_id}`);
      return { sessionId: data.session_id, url: data.url };
    } catch (e) {
      console.error("Devin session creation error:", e);
      return null;
    }
  }

  async function sendDevinMessage(sessionId: string, message: string): Promise<boolean> {
    if (!DEVIN_API_KEY) return false;
    try {
      const res = await fetch(`${DEVIN_API_BASE}/v1/sessions/${sessionId}/message`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEVIN_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message })
      });
      if (!res.ok) {
        console.error("Devin send message failed:", res.status, await res.text());
        return false;
      }
      return true;
    } catch (e) {
      console.error("Devin send message error:", e);
      return false;
    }
  }

  async function getDevinSessionMessages(sessionId: string): Promise<any[]> {
    if (!DEVIN_API_KEY) return [];
    try {
      const res = await fetch(`${DEVIN_API_BASE}/v1/sessions/${sessionId}`, {
        headers: {
          "Authorization": `Bearer ${DEVIN_API_KEY}`
        }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.messages || [];
    } catch (e) {
      console.error("Devin get messages error:", e);
      return [];
    }
  }

  async function pollDevinResponse(sessionId: string, knownMessageCount: number, timeoutMs: number = 60000): Promise<string> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const messages = await getDevinSessionMessages(sessionId);
      // Look for new messages beyond what we knew about
      if (messages.length > knownMessageCount) {
        // Get the latest message from Devin (not from user)
        for (let i = messages.length - 1; i >= knownMessageCount; i--) {
          const msg = messages[i];
          if (msg.role !== "user" && msg.message) {
            return msg.message;
          }
        }
      }
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    return "I apologize, I'm having trouble processing your request right now. Please try again or call back later.";
  }

  // --- Real-time Messaging (Socket.io) ---
  io.on("connection", (socket) => {
    console.log("A user connected to intranet messaging");
    
    socket.on("send_message", (data) => {
      const { sender_id, content } = data;
      db.prepare("INSERT INTO messages (sender_id, content) VALUES (?, ?)").run(sender_id, content);
      
      const sender = db.prepare("SELECT full_name FROM users WHERE id = ?").get(sender_id) as any;
      
      io.emit("receive_message", {
        id: Date.now(),
        sender_id,
        sender_name: sender?.full_name || "Unknown",
        content,
        timestamp: new Date().toISOString()
      });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  // --- Auth Middleware with Header Fallback ---
  const getAuthUser = (req: express.Request) => {
    const sessionUser = (req.session as any).user;
    if (sessionUser) return sessionUser;

    const userId = req.headers['x-user-id'];
    if (userId) {
      // Fallback for iframe cookie blocking: fetch user from DB by ID
      try {
        const user = db.prepare("SELECT id, username, role, full_name FROM users WHERE id = ?").get(userId) as any;
        return user;
      } catch (e) {
        return null;
      }
    }
    return null;
  };

  // --- Public Client Page (served at /visit) ---
  app.get("/visit", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>USAKO Community Rover - Request a Visit</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --emerald: #059669; --emerald-light: #d1fae5; --emerald-dark: #047857; --bg: #f5f2ed; --card: #ffffff; --text: #1a1a1a; --text-light: #6b7280; --border: rgba(0,0,0,0.08); }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .header { background: var(--card); border-bottom: 1px solid var(--border); padding: 1.5rem 2rem; text-align: center; }
    .header-inner { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: center; gap: 1rem; }
    .logo { width: 48px; height: 48px; background: var(--emerald-light); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .header h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
    .header h1 span { color: var(--emerald); }
    .header p { font-size: 0.75rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.1em; }
    .main { max-width: 1200px; margin: 2rem auto; padding: 0 1.5rem; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
    @media (max-width: 768px) { .main { grid-template-columns: 1fr; } }
    .card { background: var(--card); border-radius: 32px; border: 1px solid var(--border); padding: 2.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .card h2 { font-size: 1.5rem; font-weight: 300; font-style: italic; margin-bottom: 0.5rem; }
    .card .subtitle { font-size: 0.7rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2rem; }
    .form-group { margin-bottom: 1.25rem; }
    .form-group label { display: block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-light); margin-bottom: 0.5rem; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 1rem 1.25rem; border: 1px solid var(--border); border-radius: 16px; background: rgba(245,242,237,0.5); font-size: 0.95rem; font-family: inherit; color: var(--text); outline: none; transition: border-color 0.2s; }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { border-color: var(--emerald); }
    .form-group textarea { resize: vertical; min-height: 80px; }
    .time-slots { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1.25rem; }
    .time-slot { padding: 1rem; border: 2px solid var(--border); border-radius: 16px; text-align: center; cursor: pointer; transition: all 0.2s; background: rgba(245,242,237,0.3); }
    .time-slot:hover { border-color: var(--emerald); background: var(--emerald-light); }
    .time-slot.selected { border-color: var(--emerald); background: var(--emerald); color: white; }
    .time-slot .time { font-size: 1.1rem; font-weight: 700; }
    .time-slot .label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-top: 0.25rem; }
    .btn-submit { width: 100%; padding: 1rem; background: var(--emerald); color: white; border: none; border-radius: 16px; font-size: 1rem; font-weight: 700; cursor: pointer; transition: all 0.2s; margin-top: 0.5rem; }
    .btn-submit:hover { background: var(--emerald-dark); }
    .btn-submit:disabled { background: #9ca3af; cursor: not-allowed; }
    #map { width: 100%; height: 400px; border-radius: 20px; margin-top: 1rem; border: 1px solid var(--border); }
    .map-status { display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem; font-size: 0.8rem; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .status-dot.online { background: var(--emerald); animation: pulse 2s infinite; }
    .status-dot.offline { background: #ef4444; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .success-message { display: none; background: var(--emerald-light); border: 1px solid var(--emerald); border-radius: 16px; padding: 1.5rem; text-align: center; margin-top: 1rem; }
    .success-message.show { display: block; }
    .success-message h3 { color: var(--emerald-dark); font-size: 1.1rem; margin-bottom: 0.5rem; }
    .success-message p { color: var(--emerald-dark); font-size: 0.85rem; opacity: 0.8; }
    .error-message { display: none; background: #fef2f2; border: 1px solid #ef4444; border-radius: 16px; padding: 1rem; text-align: center; margin-top: 0.75rem; color: #dc2626; font-size: 0.85rem; }
    .error-message.show { display: block; }
    .footer { text-align: center; padding: 2rem; font-size: 0.7rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.1em; }
  </style>
</head>
<body>
  <div class="header"><div class="header-inner"><div class="logo">&#x1F49A;</div><div><h1>USAKO <span>Community Rover</span></h1><p>United Solutions Assisting Kinder Ones &bull; Sacramento, CA</p></div></div></div>
  <div class="main">
    <div class="card">
      <h2>Request a Visit</h2>
      <p class="subtitle">Schedule a community rover visit to your area</p>
      <form id="visitForm" onsubmit="submitVisitRequest(event)">
        <div class="form-group"><label>Your Name (Optional)</label><input type="text" id="clientName" placeholder="Enter your name"></div>
        <div class="form-group"><label>Select a Time Slot *</label></div>
        <div class="time-slots">
          <div class="time-slot" onclick="selectTime(this, '10:00 AM')"><div class="time">10:00 AM</div><div class="label">Morning</div></div>
          <div class="time-slot" onclick="selectTime(this, '11:30 AM')"><div class="time">11:30 AM</div><div class="label">Late Morning</div></div>
          <div class="time-slot" onclick="selectTime(this, '2:00 PM')"><div class="time">2:00 PM</div><div class="label">Afternoon</div></div>
          <div class="time-slot" onclick="selectTime(this, '3:30 PM')"><div class="time">3:30 PM</div><div class="label">Late Afternoon</div></div>
        </div>
        <input type="hidden" id="selectedTime" value="">
        <div class="form-group"><label>Cross Streets *</label><input type="text" id="crossStreets" placeholder="e.g. 16th St & J St" required></div>
        <div class="form-group"><label>Date *</label><input type="date" id="requestDate" required></div>
        <div class="form-group"><label>Additional Notes (Optional)</label><textarea id="notes" placeholder="Any additional details..."></textarea></div>
        <button type="submit" class="btn-submit" id="submitBtn">Submit Visit Request</button>
        <div class="success-message" id="successMsg"><h3>Visit Request Submitted!</h3><p>Thank you! Our rover team will include your location in the daily route planning.</p></div>
        <div class="error-message" id="errorMsg"></div>
      </form>
    </div>
    <div class="card">
      <h2>Live Rover Map</h2>
      <p class="subtitle">Real-time GPS tracking of the USAKO community rover</p>
      <div id="map"></div>
      <div class="map-status"><span class="status-dot" id="statusDot"></span><span id="statusText">Checking rover status...</span></div>
      <div class="map-status" id="lastUpdate" style="font-size:0.7rem;color:#9ca3af;margin-top:0.5rem;"></div>
    </div>
  </div>
  <div class="footer">&copy; 2026 USAKO &bull; United Solutions Assisting Kinder Ones &bull; Sacramento, CA</div>
  <script>
    let selectedTimeValue = "";
    function selectTime(el, time) { document.querySelectorAll(".time-slot").forEach(s => s.classList.remove("selected")); el.classList.add("selected"); selectedTimeValue = time; document.getElementById("selectedTime").value = time; }
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById("requestDate").value = tomorrow.toISOString().split("T")[0];
    document.getElementById("requestDate").min = tomorrow.toISOString().split("T")[0];

    async function submitVisitRequest(e) {
      e.preventDefault();
      const successMsg = document.getElementById("successMsg"), errorMsg = document.getElementById("errorMsg"), submitBtn = document.getElementById("submitBtn");
      successMsg.classList.remove("show"); errorMsg.classList.remove("show");
      if (!selectedTimeValue) { errorMsg.textContent = "Please select a time slot."; errorMsg.classList.add("show"); return; }
      const crossStreets = document.getElementById("crossStreets").value.trim();
      if (!crossStreets) { errorMsg.textContent = "Please enter the cross streets."; errorMsg.classList.add("show"); return; }
      submitBtn.disabled = true; submitBtn.textContent = "Submitting...";
      try {
        const res = await fetch("/api/rover/visit-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: document.getElementById("clientName").value.trim() || "Anonymous", cross_streets: crossStreets, requested_time: selectedTimeValue, requested_date: document.getElementById("requestDate").value, notes: document.getElementById("notes").value.trim() }) });
        const data = await res.json();
        if (data.success) { successMsg.classList.add("show"); document.getElementById("clientName").value = ""; document.getElementById("crossStreets").value = ""; document.getElementById("notes").value = ""; document.querySelectorAll(".time-slot").forEach(s => s.classList.remove("selected")); selectedTimeValue = ""; }
        else { errorMsg.textContent = data.error || "Failed to submit. Please try again."; errorMsg.classList.add("show"); }
      } catch (err) { errorMsg.textContent = "Unable to connect. Please try again later."; errorMsg.classList.add("show"); }
      finally { submitBtn.disabled = false; submitBtn.textContent = "Submit Visit Request"; }
    }

    const map = L.map("map").setView([38.5816, -121.4944], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    const roverIcon = L.divIcon({ className: "rover-marker", html: '<div style="background:#059669;width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;color:white;">&#x1F69B;</div>', iconSize: [36, 36], iconAnchor: [18, 18] });
    let roverMarker = null;
    async function updateRoverPosition() {
      const statusDot = document.getElementById("statusDot"), statusText = document.getElementById("statusText"), lastUpdate = document.getElementById("lastUpdate");
      try {
        const res = await fetch("/api/rover/tracking"); const data = await res.json();
        if (data.tracking) {
          statusDot.className = "status-dot online"; statusText.textContent = "Rover is active - tracked by " + data.trackedBy;
          lastUpdate.textContent = "Last update: " + new Date(data.updatedAt).toLocaleTimeString();
          const latlng = [data.lat, data.lng];
          if (roverMarker) { roverMarker.setLatLng(latlng); } else { roverMarker = L.marker(latlng, { icon: roverIcon }).addTo(map); roverMarker.bindPopup("<strong>USAKO Rover</strong><br>Tracked by: " + data.trackedBy); }
          map.setView(latlng, map.getZoom());
        } else {
          statusDot.className = "status-dot offline"; statusText.textContent = "Rover is currently offline";
          lastUpdate.textContent = "The rover will appear when tracking is enabled by staff.";
          if (roverMarker) { map.removeLayer(roverMarker); roverMarker = null; }
        }
      } catch (err) { statusDot.className = "status-dot offline"; statusText.textContent = "Unable to connect to tracking server"; lastUpdate.textContent = ""; }
    }
    updateRoverPosition(); setInterval(updateRoverPosition, 5000);
  <\/script>
</body>
</html>`);
  });

  // --- Auth Routes ---
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password) as any;
    if (user) {
      const { password, ...userWithoutPassword } = user;
      (req.session as any).user = userWithoutPassword;
      console.log(`User logged in: ${userWithoutPassword.username}, session ID: ${req.sessionID}`);
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.json({ success: false, message: "Invalid credentials" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if ((req.session as any).user) {
      res.json({ success: true, user: (req.session as any).user });
    } else {
      res.json({ success: false });
    }
  });

  // --- User Management Routes ---
  app.get("/api/users", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    if (currentUser.role === "admin") {
      const users = db.prepare("SELECT id, username, role, full_name FROM users").all();
      res.json(users);
    } else if (currentUser.role === "leader") {
      const users = db.prepare("SELECT id, username, role, full_name FROM users WHERE role = 'worker'").all();
      res.json(users);
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  app.post("/api/users", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser || currentUser.role !== "admin") {
      console.warn("Unauthorized user creation attempt by:", currentUser?.username || "Unknown (No Session/Header)");
      return res.status(403).json({ error: "Forbidden" });
    }

    const { username, password, role, full_name } = req.body;
    console.log(`Creating user: ${username} (${full_name}) as ${role}`);
    try {
      db.prepare("INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)").run(username, password, role, full_name);
      res.json({ success: true });
    } catch (e) {
      console.error("User creation error:", e);
      res.status(400).json({ error: "Username already exists" });
    }
  });

  app.put("/api/users/:id", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const { password, role, full_name } = req.body;
    const targetUser = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;

    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (currentUser.role === "admin") {
      // Admin can edit everything
      db.prepare("UPDATE users SET password = ?, role = ?, full_name = ? WHERE id = ?").run(password || targetUser.password, role || targetUser.role, full_name || targetUser.full_name, id);
      res.json({ success: true });
    } else if (currentUser.role === "leader" && targetUser.role === "worker") {
      // Leader can only reset worker passwords
      if (password) {
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(password, id);
        res.json({ success: true });
      } else {
        res.status(403).json({ error: "Leaders can only reset worker passwords" });
      }
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  app.delete("/api/users/:id", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser || currentUser.role !== "admin") return res.status(403).json({ error: "Forbidden" });

    const { id } = req.params;
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // --- Rover Routes ---
  app.get("/api/rover/schedule", (req, res) => {
    const schedule = db.prepare(`
      SELECT s.*, u.full_name as user_name 
      FROM rover_schedule s 
      JOIN users u ON s.user_id = u.id 
      ORDER BY start_time ASC
    `).all();
    res.json(schedule);
  });

  app.post("/api/rover/schedule", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const { title, start_time, end_time } = req.body;
    db.prepare("INSERT INTO rover_schedule (user_id, title, start_time, end_time) VALUES (?, ?, ?, ?)").run(currentUser.id, title, start_time, end_time);
    res.json({ success: true });
  });

  app.get("/api/rover/routes", (req, res) => {
    const routes = db.prepare(`
      SELECT r.*, u.full_name as user_name 
      FROM rover_routes r 
      JOIN users u ON r.user_id = u.id 
      ORDER BY created_at DESC
    `).all();
    res.json(routes);
  });

  app.post("/api/rover/routes", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const { name, waypoints } = req.body;
    db.prepare("INSERT INTO rover_routes (user_id, name, waypoints) VALUES (?, ?, ?)").run(currentUser.id, name, JSON.stringify(waypoints));
    res.json({ success: true });
  });

  // --- Default Route Fallback (curated Sacramento community locations) ---
  function getDefaultRoute(dateStr: string) {
    // Rotate through curated community locations based on the day
    const dayIndex = new Date().getDay(); // 0-6
    const locationSets = [
      [ // Set A
        { time: "10:00 AM", location: "Sacramento Youth Center / Cafe Paso, 4625 44th St, Del Paso Heights", reason: "Youth mentoring and violence prevention in high-need neighborhood" },
        { time: "11:30 AM", location: "Union Gospel Mission, 400 Bannon St, River District", reason: "Homeless services corridor with high demand for outreach" },
        { time: "2:00 PM", location: "Shakur Center, 3230 Broadway, Oak Park", reason: "Food distribution hub and community wellness check" },
        { time: "3:30 PM", location: "Meadowview Community Center, 3100 Meadowview Rd, South Sacramento", reason: "Underserved community with families needing resource connection" }
      ],
      [ // Set B
        { time: "10:00 AM", location: "Cesar Chavez Park, Sacramento", reason: "Community gathering space with homeless population needing services" },
        { time: "11:30 AM", location: "Sacramento Central Library, 828 I St", reason: "Community resource hub, high foot traffic for outreach" },
        { time: "2:00 PM", location: "Pannell Community Center, 2450 Meadowview Rd", reason: "After-school hours community engagement" },
        { time: "3:30 PM", location: "Hagginwood Park, 3271 Marysville Blvd, North Sacramento", reason: "Park outreach for underserved North Sacramento residents" }
      ],
      [ // Set C
        { time: "10:00 AM", location: "Loaves & Fishes, 1321 North C St", reason: "Major homeless services provider, morning outreach" },
        { time: "11:30 AM", location: "Sacramento Food Bank, 3333 3rd Ave", reason: "Food insecurity support and resource distribution" },
        { time: "2:00 PM", location: "South Sacramento Christian Center, 7710 Stockton Blvd", reason: "Community wellness check in Stockton Blvd corridor" },
        { time: "3:30 PM", location: "Robbie Waters Pocket-Greenhaven Library, 7335 Gloria Dr", reason: "Family resource connection in South Sacramento" }
      ]
    ];
    const stops = locationSets[dayIndex % locationSets.length];
    return {
      route_name: `Daily Route - ${dateStr} Community Outreach`,
      stops
    };
  }

  // --- AI-Generated Daily Route ---
  app.post("/api/rover/generate-daily-route", async (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    try {
      // Get tomorrow's date
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      // Get existing route requests to factor in
      const existingRoutes = db.prepare(
        "SELECT name, waypoints FROM rover_routes ORDER BY created_at DESC LIMIT 10"
      ).all() as { name: string; waypoints: string }[];
      const pastRequestsSummary = existingRoutes.length > 0
        ? existingRoutes.map((r: { name: string; waypoints: string }) => `${r.name}: ${r.waypoints}`).join("; ")
        : "No past requests";

      // Get existing scheduled tasks for tomorrow to check for appointments
      const tomorrowStart = new Date(tomorrow);
      tomorrowStart.setHours(0, 0, 0, 0);
      const tomorrowEnd = new Date(tomorrow);
      tomorrowEnd.setHours(23, 59, 59, 999);
      const appointments = db.prepare(
        "SELECT title, start_time, end_time FROM rover_schedule WHERE start_time >= ? AND start_time <= ?"
      ).all(tomorrowStart.toISOString(), tomorrowEnd.toISOString()) as { title: string; start_time: string; end_time: string }[];
      const appointmentsSummary = appointments.length > 0
        ? appointments.map((a: { title: string; start_time: string; end_time: string }) => `${a.title} at ${new Date(a.start_time).toLocaleTimeString()}`).join("; ")
        : "No pre-scheduled appointments";

      const routePrompt = `You are an AI route planner for USAKO (United Solutions Assisting Kinder Ones), a community outreach organization based in Sacramento, CA.

Your task: Create a 4-stop rover patrol route for ${dateStr} at these times:
- Stop 1: 10:00 AM
- Stop 2: 11:30 AM
- Stop 3: 2:00 PM
- Stop 4: 3:30 PM

RESEARCH INSTRUCTIONS:
Use ALL available local information to determine the best 4 stops. Consider:
1. Nextdoor - community reports, neighborhood concerns, events
2. Facebook - local Sacramento community groups, events, needs
3. X (Twitter) - local Sacramento trending topics, community alerts
4. Sacramento Bee (Sacbee) - local news, community events, incidents
5. Local news sources - KCRA, ABC10, FOX40 Sacramento coverage
6. Google Maps - high-traffic areas, community centers, parks, schools
7. Local law enforcement - Sacramento PD reports, community safety bulletins
8. Past route requests: ${pastRequestsSummary}

APPOINTMENT CHECK:
Pre-scheduled appointments for tomorrow: ${appointmentsSummary}
${appointments.length > 0 ? "IMPORTANT: If there are pre-scheduled appointments, incorporate those locations/times into the route instead of researching new stops for those time slots." : "No appointments found - research and determine all 4 stops based on community needs."}

RESPONSE FORMAT - You MUST respond with ONLY a JSON object, no other text:
{
  "route_name": "Daily Route - [short description]",
  "stops": [
    {"time": "10:00 AM", "location": "[specific Sacramento location]", "reason": "[brief reason based on research]"},
    {"time": "11:30 AM", "location": "[specific Sacramento location]", "reason": "[brief reason based on research]"},
    {"time": "2:00 PM", "location": "[specific Sacramento location]", "reason": "[brief reason based on research]"},
    {"time": "3:30 PM", "location": "[specific Sacramento location]", "reason": "[brief reason based on research]"}
  ]
}

Do NOT include any markdown, code blocks, or explanation. ONLY the JSON object.`;

      // Generate route using Gemini API (fast, synchronous) with fallback
      let routeData: { route_name: string; stops: { time: string; location: string; reason: string }[] };

      const geminiResponse = await generateWithGemini(routePrompt);
      if (geminiResponse) {
        try {
          // Try to extract JSON from the response
          const jsonMatch = geminiResponse.match(/\{[\s\S]*"stops"[\s\S]*\}/);
          if (jsonMatch) {
            routeData = JSON.parse(jsonMatch[0]);
          } else {
            // responseMimeType: "application/json" should return clean JSON
            routeData = JSON.parse(geminiResponse);
          }
          // Validate the parsed data has the expected structure
          if (!routeData.stops || !Array.isArray(routeData.stops) || routeData.stops.length !== 4) {
            throw new Error("Invalid route structure: expected 4 stops");
          }
        } catch (parseErr) {
          console.error("Failed to parse Gemini route response:", parseErr, "Raw:", geminiResponse);
          routeData = getDefaultRoute(dateStr);
        }
      } else {
        console.warn("Gemini API unavailable, using curated Sacramento community route");
        routeData = getDefaultRoute(dateStr);
      }

      // Save the route to rover_routes
      const waypoints = routeData.stops.map(s => `${s.time} - ${s.location} (${s.reason})`);
      db.prepare("INSERT INTO rover_routes (user_id, name, waypoints, status) VALUES (?, ?, ?, ?)").run(
        currentUser.id, routeData.route_name, JSON.stringify(waypoints), "scheduled"
      );

      // Save each stop as a scheduled task
      for (const stop of routeData.stops) {
        const [time, period] = stop.time.split(" ");
        const [hours, minutes] = time.split(":").map(Number);
        let hour24 = hours;
        if (period === "PM" && hours !== 12) hour24 += 12;
        if (period === "AM" && hours === 12) hour24 = 0;

        const startTime = new Date(tomorrow);
        startTime.setHours(hour24, minutes, 0, 0);
        const endTime = new Date(startTime);
        endTime.setHours(hour24 + 1, minutes, 0, 0);

        db.prepare("INSERT INTO rover_schedule (user_id, title, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)").run(
          currentUser.id, `${stop.location} - ${stop.reason}`, startTime.toISOString(), endTime.toISOString(), "scheduled"
        );
      }

      res.json({
        success: true,
        route: routeData,
        message: `Daily route generated for ${dateStr} with 4 stops`
      });
    } catch (error) {
      console.error("Generate daily route error:", error);
      res.status(500).json({ error: "Failed to generate daily route" });
    }
  });

  // --- Rover GPS Tracking Endpoints ---
  // Update rover position (from intranet users with tracking enabled)
  app.post("/api/rover/tracking", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required numbers" });
    }

    roverPosition = {
      lat,
      lng,
      updatedAt: new Date().toISOString(),
      trackedBy: currentUser.full_name || currentUser.username
    };
    res.json({ success: true });
  });

  // Stop tracking (clear position)
  app.delete("/api/rover/tracking", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });
    roverPosition = null;
    res.json({ success: true });
  });

  // Get current rover position (public - no auth required, for client page)
  app.get("/api/rover/tracking", (_req, res) => {
    if (roverPosition) {
      res.json({ tracking: true, ...roverPosition });
    } else {
      res.json({ tracking: false });
    }
  });

  // --- Visit Request Endpoints ---
  // Submit a visit request (public - from client-facing page)
  app.post("/api/rover/visit-request", (req, res) => {
    const { client_name, cross_streets, requested_time, requested_date, notes } = req.body;

    if (!cross_streets || !requested_time || !requested_date) {
      return res.status(400).json({ error: "cross_streets, requested_time, and requested_date are required" });
    }

    const validTimes = ["10:00 AM", "11:30 AM", "2:00 PM", "3:30 PM"];
    if (!validTimes.includes(requested_time)) {
      return res.status(400).json({ error: `requested_time must be one of: ${validTimes.join(", ")}` });
    }

    db.prepare(
      "INSERT INTO visit_requests (client_name, cross_streets, requested_time, requested_date, notes) VALUES (?, ?, ?, ?, ?)"
    ).run(client_name || "Anonymous", cross_streets, requested_time, requested_date, notes || null);

    res.json({ success: true, message: "Visit request submitted successfully" });
  });

  // Get all visit requests (for intranet users)
  app.get("/api/rover/visit-requests", (req, res) => {
    const requests = db.prepare(
      "SELECT * FROM visit_requests ORDER BY created_at DESC LIMIT 50"
    ).all();
    res.json(requests);
  });

  // --- Voicemail Routes ---
  app.get("/api/voicemail", (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    // Workers/Leaders/Admins can see their own and general (user_id IS NULL)
    const voicemails = db.prepare(`
      SELECT * FROM voicemails 
      WHERE user_id = ? OR user_id IS NULL 
      ORDER BY created_at DESC
    `).all(currentUser.id);
    res.json(voicemails);
  });

  // --- Calendar Routes ---
  app.get("/api/calendar", (req, res) => {
    const events = db.prepare("SELECT * FROM events").all();
    res.json(events);
  });

  app.post("/api/calendar", (req, res) => {
    const { title, start, end, user_id } = req.body;
    db.prepare("INSERT INTO events (title, start, end, user_id) VALUES (?, ?, ?, ?)").run(title, start, end, user_id);
    res.json({ success: true });
  });

  // --- Messaging History ---
  app.get("/api/messages", (req, res) => {
    const messages = db.prepare(`
      SELECT m.*, u.full_name as sender_name 
      FROM messages m 
      JOIN users u ON m.sender_id = u.id 
      ORDER BY timestamp ASC 
      LIMIT 100
    `).all();
    res.json(messages);
  });

  // --- Twilio Softphone Token ---
  app.get("/api/twilio/token", (req, res) => {
    const currentUser = getAuthUser(req);
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const apiSecret = process.env.TWILIO_API_SECRET;
    const appSid = process.env.TWILIO_TWIML_APP_SID;

    const missing = [];
    if (!accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!apiKey) missing.push("TWILIO_API_KEY");
    if (!apiSecret) missing.push("TWILIO_API_SECRET");
    if (!appSid) missing.push("TWILIO_TWIML_APP_SID");

    if (missing.length > 0) {
      console.error("Missing Twilio Credentials:", missing.join(", "));
      return res.status(500).json({ 
        error: "Twilio credentials missing", 
        details: missing 
      });
    }

    // Validation: API Key should start with 'SK'
    if (apiKey && !apiKey.startsWith('SK')) {
      const errorMsg = "TWILIO_API_KEY must be an API Key SID (starts with 'SK'), not your Account SID (starts with 'AC').";
      console.warn(errorMsg);
      return res.status(400).json({ 
        error: "Invalid Twilio API Key format", 
        details: [errorMsg] 
      });
    }

    // Validation: App SID should start with 'AP'
    if (appSid && !appSid.startsWith('AP')) {
      const errorMsg = "TWILIO_TWIML_APP_SID must be a TwiML App SID (starts with 'AP'), not your Account SID (starts with 'AC').";
      console.warn(errorMsg);
      return res.status(400).json({ 
        error: "Invalid TwiML App SID format", 
        details: [errorMsg] 
      });
    }

    // Validation: Account SID should start with 'AC'
    if (accountSid && !accountSid.startsWith('AC')) {
      const errorMsg = "TWILIO_ACCOUNT_SID must start with 'AC'.";
      console.warn(errorMsg);
      return res.status(400).json({ 
        error: "Invalid Account SID format", 
        details: [errorMsg] 
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // Create the token
    const identity = `staff_${Math.floor(Math.random() * 10000)}`;
    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600 // 1 hour
    });

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: appSid,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);
    const jwt = token.toJwt();
    
    console.log(`Generated Twilio Token for identity: ${token.identity}`);
    res.json({ token: jwt });
  });

  // --- Twilio Outbound Call Handler ---
  app.all("/api/twilio/outbound", (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { To } = req.body || req.query;

    console.log(`Twilio Voice Request: To=${To}, Method=${req.method}`);

    if (To) {
      // Dialing an external number
      const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER });
      dial.number(To);
      console.log(`Dialing: ${To} from ${process.env.TWILIO_PHONE_NUMBER}`);
    } else {
      // Default handling
      twiml.say("Welcome to the USAKO softphone system. No destination was provided.");
    }

    res.type("text/xml").send(twiml.toString());
  });

  // --- Existing Twilio/Gemini Logic ---
  // Track message counts per session for polling
  const sessionMessageCounts = new Map<string, number>();

  app.post("/api/chat", async (req, res) => {
    const { message, lane } = req.body;
    const currentUser = getAuthUser(req);
    const userId = currentUser?.id || 0;

    try {
      let sessionId = activeDevinSessions.get(userId);
      let responseText: string;

      if (message === "START_CALL" || !sessionId) {
        // Create a new Devin session for this call
        const session = await createDevinSession(RECEPTIONIST_PROMPT);
        if (!session) {
          return res.status(500).json({ error: "Failed to create Devin session. Check DEVIN_API_KEY." });
        }
        sessionId = session.sessionId;
        activeDevinSessions.set(userId, sessionId);
        sessionMessageCounts.set(sessionId, 0);

        // Poll for Devin's initial greeting response
        responseText = await pollDevinResponse(sessionId, 0, 90000);
        // Update known message count
        const msgs = await getDevinSessionMessages(sessionId);
        sessionMessageCounts.set(sessionId, msgs.length);
      } else {
        // Send message to existing session
        const knownCount = sessionMessageCounts.get(sessionId) || 0;
        const sent = await sendDevinMessage(sessionId, message);
        if (!sent) {
          return res.status(500).json({ error: "Failed to send message to Devin session." });
        }

        // Poll for Devin's response
        responseText = await pollDevinResponse(sessionId, knownCount, 60000);
        // Update known message count
        const msgs = await getDevinSessionMessages(sessionId);
        sessionMessageCounts.set(sessionId, msgs.length);
      }

      // Check for lead data in response
      const leadMatch = responseText.match(/\[LEAD: (.*?)\]/);
      if (leadMatch) {
        try {
          const leadData = JSON.parse(leadMatch[1]);
          db.prepare("INSERT INTO leads (name, phone, email, needs) VALUES (?, ?, ?, ?)").run(
            leadData.name, leadData.phone, leadData.email, leadData.needs
          );
        } catch (e) { console.error("Lead parse error:", e); }
      }

      const cleanText = responseText.replace(/\[LEAD: .*?\]/g, "").trim();
      // No TTS audio with Devin — text-only response
      res.json({ text: cleanText, audio: null, lane });
    } catch (error) {
      console.error("Chat error:", error);
      res.status(500).json({ error: "Chat error" });
    }
  });

  // Track Twilio voice call sessions
  const twilioCallSessions = new Map<string, string>(); // CallSid -> devinSessionId
  const twilioSessionMsgCounts = new Map<string, number>();

  app.post("/api/twilio/voice", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult, Digits, CallSid } = req.body;
    const greeting = "Thank you for calling United Solutions Assisting Kind-er Ones. How can I help you today?";

    if (!SpeechResult && !Digits) {
      const gather = twiml.gather({ input: ["speech", "dtmf"], numDigits: 1, action: "/api/twilio/voice", timeout: 5 });
      gather.say({ voice: "Polly.Amy" }, greeting);
    } else {
      const input = Digits || SpeechResult;
      try {
        let sessionId = twilioCallSessions.get(CallSid);
        if (!sessionId) {
          // Create a new Devin session for this Twilio call
          const session = await createDevinSession(
            `You are a warm receptionist for USAKO (United Solutions Assisting Kinder Ones, pronounced Kind-er). ` +
            `You are handling a live phone call. Keep responses brief (1-2 sentences). ` +
            `Do NOT use markdown or attempt coding tasks. Just speak naturally as a phone receptionist. ` +
            `The caller just said: ${input}`
          );
          if (session) {
            sessionId = session.sessionId;
            twilioCallSessions.set(CallSid, sessionId);
            twilioSessionMsgCounts.set(sessionId, 0);
          }
        } else {
          await sendDevinMessage(sessionId, `The caller said: ${input}`);
        }

        let text = "I didn't catch that. Could you repeat?";
        if (sessionId) {
          const knownCount = twilioSessionMsgCounts.get(sessionId) || 0;
          text = await pollDevinResponse(sessionId, knownCount, 30000);
          const msgs = await getDevinSessionMessages(sessionId);
          twilioSessionMsgCounts.set(sessionId, msgs.length);
        }

        const gather = twiml.gather({ input: ["speech", "dtmf"], action: "/api/twilio/voice" });
        gather.say({ voice: "Polly.Amy" }, text.replace(/Kinder/g, "Kind-er"));
      } catch (error) {
        console.error("Twilio voice error:", error);
        twiml.say("Connecting to operator...");
        twiml.dial("+18005550199");
      }
    }
    res.type("text/xml").send(twiml.toString());
  });

  app.get("/api/leads", (req, res) => {
    const leads = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
    res.json(leads);
  });

  app.get("/api/calls", (req, res) => {
    const calls = db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT 50").all();
    res.json(calls);
  });

  app.post("/api/calls/log", (req, res) => {
    const { direction, from_number, to_number, status, duration } = req.body;
    db.prepare("INSERT INTO calls (direction, from_number, to_number, status, duration) VALUES (?, ?, ?, ?, ?)")
      .run(direction, from_number, to_number, status, duration || 0);
    res.json({ success: true });
  });

  app.get("/api/config/status", (req, res) => {
    const currentUser = getAuthUser(req);
    let hasEmail = false;
    if (currentUser) {
      const userRow = db.prepare("SELECT username, password FROM users WHERE id = ?").get(currentUser.id) as any;
      hasEmail = !!(userRow && userRow.username && userRow.password);
    }

    const twilioConfigured = !!(
      process.env.TWILIO_ACCOUNT_SID && 
      process.env.TWILIO_API_KEY && 
      process.env.TWILIO_API_SECRET && 
      process.env.TWILIO_TWIML_APP_SID &&
      process.env.TWILIO_PHONE_NUMBER &&
      process.env.TWILIO_API_KEY.startsWith('SK')
    );

    res.json({
      email: hasEmail,
      twilio: twilioConfigured,
      devin: !!process.env.DEVIN_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY
    });
  });

  // --- Email Routes ---
  const getEmailConfig = (user: string, pass: string) => ({
    imap: {
      user: user,
      password: pass,
      host: "mail.privateemail.com",
      port: 993,
      tls: true,
      authTimeout: 10000,
      connTimeout: 10000
    },
    smtp: {
      host: "mail.privateemail.com",
      port: 465,
      secure: true,
      auth: {
        user: user,
        pass: pass
      }
    }
  });

  app.get("/api/email/inbox", async (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const userRow = db.prepare("SELECT username, password FROM users WHERE id = ?").get(currentUser.id) as any;
    if (!userRow) return res.status(404).json({ error: "User not found" });

    const user = userRow.username.includes("@") ? userRow.username : `${userRow.username}@myusako.org`;
    const pass = userRow.password;

    console.log(`Attempting IMAP connection for: ${user}`);
    try {
      const connection = await imaps.connect(getEmailConfig(user, pass));
      console.log("IMAP Connected successfully");
      await connection.openBox("INBOX");
      const searchCriteria = ["ALL"];
      const fetchOptions = {
        bodies: ["HEADER", "TEXT"],
        markSeen: false
      };

      const messages = await connection.search(searchCriteria, fetchOptions);
      console.log(`Found ${messages.length} messages`);
      
      const parsedMessages = await Promise.all(messages.map(async (item) => {
        const all = item.parts.find(part => part.which === "TEXT");
        const id = item.attributes.uid;
        const idHeader = "Imap-Id: " + id + "\r\n";
        const parsed = await simpleParser(idHeader + (all ? all.body : ""));
        return {
          id: id,
          subject: parsed.subject,
          from: parsed.from?.text,
          date: parsed.date,
          snippet: parsed.text?.substring(0, 100)
        };
      }));

      connection.end();
      res.json(parsedMessages.reverse().slice(0, 20));
    } catch (error: any) {
      console.error("IMAP Connection Error Detail:", error);
      res.status(500).json({ 
        error: "Failed to fetch emails", 
        details: error.message,
        code: error.code 
      });
    }
  });

  app.get("/api/email/message/:id", async (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const userRow = db.prepare("SELECT username, password FROM users WHERE id = ?").get(currentUser.id) as any;
    if (!userRow) return res.status(404).json({ error: "User not found" });

    const user = userRow.username.includes("@") ? userRow.username : `${userRow.username}@myusako.org`;
    const pass = userRow.password;

    try {
      const connection = await imaps.connect(getEmailConfig(user, pass));
      await connection.openBox("INBOX");
      const searchCriteria = [["UID", req.params.id]];
      const fetchOptions = {
        bodies: [""],
        markSeen: true
      };

      const messages = await connection.search(searchCriteria, fetchOptions);
      if (messages.length === 0) {
        connection.end();
        return res.status(404).json({ error: "Message not found" });
      }

      const all = messages[0].parts.find(part => part.which === "");
      const parsed = await simpleParser(all ? all.body : "");
      
      connection.end();
      res.json({
        id: req.params.id,
        subject: parsed.subject,
        from: parsed.from?.text,
        to: parsed.to?.text,
        date: parsed.date,
        html: parsed.html || parsed.textAsHtml,
        text: parsed.text
      });
    } catch (error) {
      console.error("IMAP Error:", error);
      res.status(500).json({ error: "Failed to fetch email content" });
    }
  });

  app.post("/api/email/send", async (req, res) => {
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

    const userRow = db.prepare("SELECT username, password FROM users WHERE id = ?").get(currentUser.id) as any;
    if (!userRow) return res.status(404).json({ error: "User not found" });

    const user = userRow.username.includes("@") ? userRow.username : `${userRow.username}@myusako.org`;
    const pass = userRow.password;

    const { to, subject, text } = req.body;
    console.log(`Attempting to send email to: ${to} from ${user}`);
    try {
      const transporter = nodemailer.createTransport(getEmailConfig(user, pass).smtp);
      const info = await transporter.sendMail({
        from: user,
        to,
        subject,
        text
      });
      console.log("Email sent successfully:", info.messageId);
      res.json({ success: true, messageId: info.messageId });
    } catch (error: any) {
      console.error("SMTP Error Detail:", error);
      res.status(500).json({ 
        error: "Failed to send email", 
        details: error.message,
        code: error.code 
      });
    }
  });

  // --- Vite / Static Serving ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "custom" });
    app.use(vite.middlewares);
    // SPA fallback: serve index.html for non-API, non-/visit routes
    app.use("*", async (req, res, next) => {
      if (req.originalUrl === "/visit" || req.originalUrl.startsWith("/api/")) return next();
      try {
        const url = req.originalUrl;
        let html = (await import("fs")).readFileSync(path.join(__dirname, "index.html"), "utf-8");
        html = await vite.transformIndexHtml(url, html);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (e) { next(e); }
    });
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      if (req.path === "/visit") return;
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Intranet Server running on http://localhost:${PORT}`);
  });
}

startServer();
