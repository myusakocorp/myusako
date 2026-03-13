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
    source TEXT DEFAULT '',
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
    "staff", "Dave&Doc2315", "admin", "USAKO Staff Member"
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

  app.use(session({
    secret: process.env.SESSION_SECRET || "usako-secret-key-2026",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { 
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // Request Logging Middleware (after session middleware so req.session is available)
  app.use((req, res, next) => {
    const hasSession = !!(req.session as any)?.user;
    console.log(`${req.method} ${req.url} - Session: ${hasSession}`);
    next();
  });

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

  // --- Perplexity AI API Helper (phone agent brain) ---
  const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
  const PERPLEXITY_API_BASE = "https://api.perplexity.ai";

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

  // Track conversation history per user for the phone simulator (Perplexity chat)
  const activeConversations = new Map<number, { role: string; content: string }[]>();

  const RECEPTIONIST_SYSTEM_PROMPT = `You are a warm, professional virtual receptionist for United Solutions Assisting Kinder Ones (USAKO, pronounced Kind-er). You answer phone calls and help callers.

IMPORTANT RULES:
- Keep your responses brief and conversational (1-3 sentences max)
- Do NOT use markdown formatting, code blocks, or bullet points
- Do NOT attempt any coding, file editing, or technical tasks
- Simply respond as a friendly receptionist would on a phone call
- If you capture lead info (Name, Phone, Email, Needs), include a JSON-like block at the end: [LEAD: {"name": "...", "phone": "...", "email": "...", "needs": "..."}]
- Start the call with a warm greeting

Respond ONLY with plain text as if speaking on the phone. Your first message should be your greeting to the caller.`;

  // --- IVR Agent System Prompts ---
  const IVR_GLOBAL_RULES = `IMPORTANT RULES FOR ALL RESPONSES:
- You are on a LIVE PHONE CALL. Speak naturally as if talking on the phone.
- Keep responses brief (1-3 sentences max unless providing specific information).
- Do NOT use markdown, bullet points, numbered lists, code blocks, or any formatting.
- Do NOT attempt coding, file editing, or technical tasks.
- Use simple, friendly language at a 7th-8th grade reading level.
- Sound calm, respectful, and non-judgmental.
- Ask one question at a time.
- Say "Kind-er" when pronouncing "Kinder" in the organization name.
- Never give medical, legal, or financial advice.
- If someone mentions immediate danger, self-harm, or violence, respond with calm empathy and advise them to contact 911 or a crisis hotline.
- If a caller becomes abusive, calmly say you want to help and invite a 30-second pause. If they cannot continue respectfully, tell them the recorded call will be sent to the support team for review within 24 hours, then end the call politely.
- When you cannot fully assist, politely capture: full name, best phone number, email address (if they have one), and a short description of what they need. Briefly repeat their information back. Say exactly: "I am sending your request, a team member will follow up with you soon." Do NOT mention any internal email addresses like help@myusako.org to the caller.
- If you capture contact/lead info, include at the very end of your response: [LEAD: {"name": "...", "phone": "...", "email": "...", "needs": "..."}]
- Hours of live phone agents: Monday through Friday, 8:00 AM to 5:00 PM Pacific Time.
- 24/7 automated information and donation collection is available.
- Address: 3600 Watt Avenue, Suite 101, Sacramento, California 95816.
- Website: www.myusako.org
- Always say the full name as "United Solutions Assisting Kind-er Ones". When saying USAKO, spell it out as "U S A K O".
- When a caller needs community resources (food, housing, shelter, counseling, healthcare, utilities, etc.), search 211.org for Sacramento County resources. Provide the specific program names, phone numbers, and addresses you find. Offer to share the information verbally on the call or via SMS text message if the caller provides a phone number. Say: "I can look that up for you. Would you like me to share the details over the phone, or would you prefer I text you the information?"`;

  const AGENT_PROMPTS: Record<string, string> = {
    operator: `You are a warm, professional female virtual receptionist (the Operator) for United Solutions Assisting Kind-er Ones (U S A K O).
${IVR_GLOBAL_RULES}
Your role as the Operator:
- Confirm why the person is calling.
- Decide which service area fits best: clients/Relief Rover, donations, operations, or general info.
- Either answer directly or guide them to the appropriate service.
- When unsure, gather contact information and arrange a team follow-up.
- Use the same tone and boundaries as the main greeting.`,

    harmony: `You are Harmony, a warm, professional, and very concerned virtual phone agent for United Solutions Assisting Kind-er Ones (U S A K O). You handle client and potential client calls.
${IVR_GLOBAL_RULES}
Your opening when first greeting a caller in this menu:
"Thank you for calling United Solutions Assisting Kind-er Ones. My name is Harmony. Are you calling about the Relief Rover, R.E.A., Rapid Emergency Assistance today?"
- If they say no: "Okay, thank you for letting me know. How can I help you today?"
- If they say yes: provide Relief Rover information.
- Start with empathy: "I am glad you reached out. I will do my best to guide you."
- Ask simple, respectful questions to understand what they need (food, housing, hygiene, documentation support, phone access, internet, etc.).

Relief Rover R.E.A. information:
The Relief Rover R.E.A. (Rapid Emergency Assistance) is a converted motorhome that drives to locations where unhoused neighbors are staying. It usually follows a route of four known community locations, stopping for about one hour at each stop. You can also schedule it to come to a specific location at least 24 hours in advance, at one of these times: 10:00 AM, 11:30 AM, 2:00 PM, or 3:30 PM. If there are no appointments, it follows its preplanned route.
While parked, it provides services in a climate-controlled environment, including: bicycle repair station, secured pet cages, cell phone charging station, two computer and print stations, government phone assistance signup, help with SNAP General Assistance and CalWORKs applications, harm reduction services, restroom access, paper bag lunch and drink, TV and seating area, free Wi-Fi, and sometimes pop-up donations while supplies last.

For scheduling: "We can request a Relief Rover stop at your location at least 24 hours in advance. I just need the day, time, and cross streets. Which day works for you, and which time: 10:00 AM, 11:30 AM, 2:00 PM, or 3:30 PM?"
After getting the day, time, and cross streets, optionally ask: "Would you like to leave a name, phone number, or email so we can send you a confirmation? That part is totally optional."

For needs beyond USAKO: search 211.org for Sacramento County community resources relevant to what the caller needs (food, housing, shelter, counseling, healthcare, utilities, etc.). Provide specific program names, phone numbers, and addresses found on 211.org. Say: "I found some resources that might help. Would you like me to share the details over the phone, or would you prefer I text you the information?" If they want a text, ask for their phone number and include the resource details in the lead capture.`,

    river: `You are River, a warm and professional virtual phone agent for United Solutions Assisting Kind-er Ones (U S A K O). You handle donation calls.
${IVR_GLOBAL_RULES}
Your opening when first greeting a caller in this menu:
"Thank you for calling United Solutions Assisting Kind-er Ones. My name is River. It sounds like you are interested in making a donation or getting information about donations, is that right?"
- If yes, thank them: "Thank you so much for wanting to support our mission. Your support helps us bring essential services directly to people living on the streets."

Donation types:
- Monetary donations: "You can make a monetary donation online through our website, through a secure Donations IVR over the phone, or by receiving a text link to donate from your mobile phone. You can choose a one-time gift or set up monthly support."
- Material or in-kind donations: "We also accept material donations, like supplies or goods that support our mobile outreach and the Relief Rover. Depending on the situation, donations can sometimes be picked up, dropped off, or mailed."
- Purpose: "Donations help support the Relief Rover R.E.A., including the motorhome conversion, operations, and the services we provide on the street."

Ask: "Which is easiest for you today: staying on the line to use our Donations IVR, getting a text link, or visiting our website?"
If they have questions or want a callback from staff, collect name, phone, and email.`,

    hope: `You are Hope, a warm, hopeful, and professional virtual phone agent for United Solutions Assisting Kind-er Ones (U S A K O). You handle operations calls.
${IVR_GLOBAL_RULES}
Your opening when first greeting a caller in this menu:
"Thank you for calling United Solutions Assisting Kind-er Ones. My name is Hope, and you have reached the Operations Team. How can I help you today?"

Internally classify call types (do not read aloud): Finance (vendor billing), Volunteering, Human Resources (job applications), Events, or other operations questions.

For volunteering:
"Thank you so much for your interest in volunteering with us. We truly appreciate it. Our volunteer process usually includes an application, an orientation, and any needed background checks. There is also a minimum age, and volunteers help with things like outreach support, events, and basic program assistance. You can start by visiting our volunteer sign-up page at www.myusako.org/volunteers/signup. If you would like, I can also text or email you that link."
Collect: name, phone, email, and brief area of interest.

For general operations questions:
1. Ask what department they are trying to reach and why.
2. Collect: name, phone, email, short description of their question or request.
3. Confirm details back to them.
4. Tell them a team member will return their call as soon as they can.`,

    joy: `You are Joy, a joyful, professional, and very concerned virtual phone agent for United Solutions Assisting Kind-er Ones (U S A K O). You handle general information calls.
${IVR_GLOBAL_RULES}
Your opening when first greeting a caller in this menu:
"Thank you for calling United Solutions Assisting Kind-er Ones. My name is Joy. How can I help you today?"

For basic organization info:
"Our general business hours are Monday through Friday, 8:00 AM to 5:00 PM Pacific Time. Our address is 3600 Watt Avenue, Suite 101, Sacramento, California 95816. You can also learn more about us at www.myusako.org."

For events and partnerships:
"I can share event details, including the date, time, location, cost if any, and how to register or attend. Which event are you asking about today?"
If information is not fully available, offer to collect contact details and send follow-up.

For potential partners or collaborators:
"Thank you for your interest in collaborating with us. May I get your name, organization, role, phone number, email address, and a short description of what you are looking for? I will share this with our team so the right person can follow up with you."`,

    directory: `You are a warm, professional virtual receptionist for United Solutions Assisting Kind-er Ones (U S A K O), handling the company directory.
${IVR_GLOBAL_RULES}
You said: "You have reached the company directory. If you know the name of the person or department you would like to reach, please say their name or enter their extension now. If you need help, press 0 to speak with the operator."
Help the caller find the right extension or person. If you cannot find a match, offer to transfer them to the operator.`
  };

  // Map IVR menu choices to agents
  function getAgentForChoice(choice: string): { agent: string; prompt: string } {
    const normalized = choice.trim().toLowerCase();
    if (normalized === "1" || normalized.includes("directory")) {
      return { agent: "directory", prompt: AGENT_PROMPTS.directory };
    } else if (normalized === "2" || normalized.includes("client") || normalized.includes("rover") || normalized.includes("relief")) {
      return { agent: "harmony", prompt: AGENT_PROMPTS.harmony };
    } else if (normalized === "3" || normalized.includes("donat")) {
      return { agent: "river", prompt: AGENT_PROMPTS.river };
    } else if (normalized === "4" || normalized.includes("operation") || normalized.includes("volunteer")) {
      return { agent: "hope", prompt: AGENT_PROMPTS.hope };
    } else if (normalized === "5" || normalized.includes("information") || normalized.includes("info") || normalized.includes("about")) {
      return { agent: "joy", prompt: AGENT_PROMPTS.joy };
    } else if (normalized === "0" || normalized.includes("operator") || normalized.includes("person") || normalized.includes("human") || normalized.includes("agent")) {
      return { agent: "operator", prompt: AGENT_PROMPTS.operator };
    }
    return { agent: "", prompt: "" };
  }

  // --- Perplexity Chat Completion (OpenAI-compatible) ---
  async function chatWithPerplexity(
    messages: { role: string; content: string }[],
    systemPrompt?: string
  ): Promise<string> {
    if (!PERPLEXITY_API_KEY) {
      console.error("PERPLEXITY_API_KEY not set");
      return "I apologize, the AI system is not configured. Please contact USAKO directly.";
    }
    try {
      const apiMessages = [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...messages
      ];
      const res = await fetch(`${PERPLEXITY_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "sonar",
          messages: apiMessages,
          max_tokens: 300,
          temperature: 0.7
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error("Perplexity API error:", res.status, errText);
        return "I'm having a brief technical issue. Could you please repeat that?";
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "I didn't catch that. Could you repeat?";
    } catch (e) {
      console.error("Perplexity API call error:", e);
      return "I'm experiencing a connection issue. Please hold or try again.";
    }
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

  // --- Auth Middleware (session-based only) ---
  const getAuthUser = (req: express.Request) => {
    const sessionUser = (req.session as any).user;
    return sessionUser || null;
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
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

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

  // --- Phone Simulator Chat (Perplexity AI with IVR menu flow) ---
  const simConversations = new Map<number, {
    state: 'menu' | 'conversation';
    agent: string;
    prompt: string;
    history: { role: string; content: string }[];
  }>();

  app.post("/api/chat", async (req, res) => {
    const { message } = req.body;
    const currentUser = getAuthUser(req);
    const userId = currentUser?.id || 0;

    try {
      if (message === "START_CALL") {
        // Start new IVR session - return menu greeting
        simConversations.set(userId, {
          state: 'menu',
          agent: 'menu',
          prompt: '',
          history: []
        });
        const menuText = `Thank you for calling United Solutions Assisting Kind-er Ones. Ready To HELP, right where YOU are, right NOW.\nThis call is recorded to help us make sure you receive the best service possible.\nIf you know your party's extension, you may dial it at any time.\nFor our menu options, please listen carefully:\nPress or Say 1 for a company directory.\nPress or Say 2 if you are a client or a potential client.\nPress or Say 3 if you would like to donate, or receive information about donations.\nPress or Say 4 if you need to reach the operations department.\nPress or Say 5 if you would like basic information about our organization.\nPress or Say 0 for the operator.`;
        res.json({ text: menuText, agent: 'menu' });
        return;
      }

      const session = simConversations.get(userId);

      if (!session || session.state === 'menu') {
        // Process menu selection
        const { agent, prompt } = getAgentForChoice(message);

        if (agent && prompt) {
          // Valid selection - get agent greeting
          const greetingText = await chatWithPerplexity(
            [{ role: "user", content: "A new caller just selected your menu option. Give your opening greeting exactly as specified in your instructions." }],
            prompt
          );

          simConversations.set(userId, {
            state: 'conversation',
            agent,
            prompt,
            history: [
              { role: "user", content: "A new caller just selected your menu option. Give your opening greeting exactly as specified in your instructions." },
              { role: "assistant", content: greetingText }
            ]
          });
          const cleanText = greetingText.replace(/\[LEAD:.*?\]/g, "").trim();
          res.json({ text: cleanText, agent });
        } else {
          // Invalid selection
          res.json({
            text: "I am sorry, I did not understand that selection. Press or Say 1 for directory, 2 for client services, 3 for donations, 4 for operations, 5 for general information, or 0 for the operator.",
            agent: 'menu'
          });
        }
        return;
      }

      // In conversation - continue with assigned agent
      session.history.push({ role: "user", content: `The caller said: ${message}` });
      const responseText = await chatWithPerplexity(session.history, session.prompt);
      session.history.push({ role: "assistant", content: responseText });

      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }
      simConversations.set(userId, session);

      // Check for lead data in response
      const leadMatch = responseText.match(/\[LEAD:\s*(\{.*?\})\]/);
      if (leadMatch) {
        try {
          const leadData = JSON.parse(leadMatch[1]);
          db.prepare("INSERT INTO leads (name, phone, email, needs, source) VALUES (?, ?, ?, ?, ?)").run(
            leadData.name || "", leadData.phone || "", leadData.email || "", leadData.needs || "", `Simulator - Agent: ${session.agent}`
          );
        } catch (e) { console.error("Lead parse error:", e); }
      }

      const cleanText = responseText.replace(/\[LEAD:.*?\]/g, "").trim();
      res.json({ text: cleanText, agent: session.agent });
    } catch (error) {
      console.error("Chat error:", error);
      res.status(500).json({ error: "Chat error" });
    }
  });

  // --- Twilio Voice Handler (Perplexity AI with Full IVR) ---
  // Track conversation state per Twilio call: agent assigned, conversation history, menu repeat count
  const twilioCallState = new Map<string, {
    agent: string;
    prompt: string;
    history: { role: string; content: string }[];
    menuRepeats: number;
  }>();

  const IVR_GREETING = `Thank you for calling United Solutions Assisting Kind-er Ones. Ready To HELP, right where YOU are, right NOW.
This call is recorded to help us make sure you receive the best service possible.
If you know your party's extension, you may dial it at any time.
For our menu options, please listen carefully:
Press or Say 1 for a company directory.
Press or Say 2 if you are a client or a potential client.
Press or Say 3 if you would like to donate, or receive information about donations.
Press or Say 4 if you need to reach the operations department.
Press or Say 5 if you would like basic information about our organization.
Press or Say 0 for the operator.`;

  // Main IVR entry point
  app.post("/api/twilio/voice", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult, Digits, CallSid } = req.body;

    console.log(`Twilio Voice: CallSid=${CallSid}, Digits=${Digits}, Speech=${SpeechResult}`);

    // First call - no input yet, play greeting menu
    if (!SpeechResult && !Digits) {
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: "/api/twilio/voice/menu",
        timeout: 6,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, IVR_GREETING);
      // If no input after greeting, repeat once then route to operator
      twiml.redirect("/api/twilio/voice/no-input");
    } else {
      // If somehow we get input on the main endpoint, treat as menu selection
      twiml.redirect({ method: "POST" }, "/api/twilio/voice/menu");
    }
    res.type("text/xml").send(twiml.toString());
  });

  // Handle no input - repeat menu once, then route to operator
  app.post("/api/twilio/voice/no-input", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { CallSid } = req.body;
    const state = twilioCallState.get(CallSid);
    const repeats = state?.menuRepeats || 0;

    if (repeats < 1) {
      // Store repeat count
      twilioCallState.set(CallSid, {
        agent: "",
        prompt: "",
        history: [],
        menuRepeats: repeats + 1
      });
      twiml.say({ voice: "Polly.Amy" }, "I did not hear a selection. Let me repeat the menu for you.");
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: "/api/twilio/voice/menu",
        timeout: 6,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, IVR_GREETING);
      twiml.redirect("/api/twilio/voice/no-input");
    } else {
      // After one repeat, route to operator
      twiml.say({ voice: "Polly.Amy" }, "Let me connect you with our operator.");
      twilioCallState.set(CallSid, {
        agent: "operator",
        prompt: AGENT_PROMPTS.operator,
        history: [],
        menuRepeats: 0
      });
      twiml.redirect({ method: "POST" }, "/api/twilio/voice/agent-greeting");
    }
    res.type("text/xml").send(twiml.toString());
  });

  // Handle menu selection (DTMF or speech)
  app.post("/api/twilio/voice/menu", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult, Digits, CallSid } = req.body;
    const input = Digits || SpeechResult || "";

    console.log(`IVR Menu Selection: CallSid=${CallSid}, input="${input}"`);

    const { agent, prompt } = getAgentForChoice(input);

    if (agent && prompt) {
      // Valid selection - set up agent state
      twilioCallState.set(CallSid, {
        agent,
        prompt,
        history: [],
        menuRepeats: 0
      });
      // Redirect to agent greeting
      twiml.redirect({ method: "POST" }, "/api/twilio/voice/agent-greeting");
    } else {
      // Invalid selection - ask again
      twiml.say({ voice: "Polly.Amy" }, "I am sorry, I did not understand that selection.");
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: "/api/twilio/voice/menu",
        timeout: 6,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" },
        "Press 1 for directory. Press 2 for client services. Press 3 for donations. Press 4 for operations. Press 5 for general information. Press 0 for the operator.");
      twiml.redirect("/api/twilio/voice/no-input");
    }
    res.type("text/xml").send(twiml.toString());
  });

  // Agent greeting - get the first AI response for the selected agent
  app.post("/api/twilio/voice/agent-greeting", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { CallSid } = req.body;
    const state = twilioCallState.get(CallSid);

    if (!state || !state.prompt) {
      // Fallback to operator
      twiml.say({ voice: "Polly.Amy" }, "Let me connect you with our operator. How can I help you today?");
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        action: "/api/twilio/voice/conversation",
        timeout: 8,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, "");
      return res.type("text/xml").send(twiml.toString());
    }

    try {
      // Get the agent's opening greeting from Perplexity
      const greetingText = await chatWithPerplexity(
        [{ role: "user", content: "A new caller just selected your menu option. Give your opening greeting exactly as specified in your instructions." }],
        state.prompt
      );

      // Store the full greeting exchange in history so conversation alternation is correct
      state.history.push({ role: "user", content: "A new caller just selected your menu option. Give your opening greeting exactly as specified in your instructions." });
      state.history.push({ role: "assistant", content: greetingText });
      twilioCallState.set(CallSid, state);

      // Play greeting and wait for caller response
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        action: "/api/twilio/voice/conversation",
        timeout: 8,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, greetingText.replace(/Kinder/g, "Kind-er").replace(/\[LEAD:.*?\]/g, ""));
    } catch (error) {
      console.error("Agent greeting error:", error);
      twiml.say({ voice: "Polly.Amy" }, "Thank you for calling United Solutions Assisting Kind-er Ones. How can I help you today?");
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        action: "/api/twilio/voice/conversation",
        timeout: 8,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, "");
    }
    res.type("text/xml").send(twiml.toString());
  });

  // Ongoing conversation with the selected agent
  app.post("/api/twilio/voice/conversation", async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult, Digits, CallSid } = req.body;
    const input = Digits || SpeechResult || "";

    console.log(`IVR Conversation: CallSid=${CallSid}, agent=${twilioCallState.get(CallSid)?.agent}, input="${input}"`);

    let state = twilioCallState.get(CallSid);
    if (!state) {
      // No state found, default to operator
      state = {
        agent: "operator",
        prompt: AGENT_PROMPTS.operator,
        history: [],
        menuRepeats: 0
      };
      twilioCallState.set(CallSid, state);
    }

    if (!input) {
      // No input - prompt again
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        action: "/api/twilio/voice/conversation",
        timeout: 8,
        speechTimeout: "auto"
      });
      gather.say({ voice: "Polly.Amy" }, "Are you still there? I am here to help whenever you are ready.");
      return res.type("text/xml").send(twiml.toString());
    }

    try {
      // Add caller input to history
      state.history.push({ role: "user", content: `The caller said: ${input}` });

      const text = await chatWithPerplexity(state.history, state.prompt);

      state.history.push({ role: "assistant", content: text });

      // Keep history manageable (last 20 messages)
      if (state.history.length > 20) {
        state.history = state.history.slice(-20);
      }
      twilioCallState.set(CallSid, state);

      // Check for lead info and extract it (don't speak it)
      const leadMatch = text.match(/\[LEAD:\s*(\{.*?\})\]/);
      if (leadMatch) {
        try {
          const leadData = JSON.parse(leadMatch[1]);
          console.log(`Lead captured from call ${CallSid}:`, leadData);
          // Save lead to database
          db.prepare("INSERT INTO leads (name, phone, email, needs, source) VALUES (?, ?, ?, ?, ?)")
            .run(leadData.name || "", leadData.phone || "", leadData.email || "", leadData.needs || "", `Phone call - Agent: ${state.agent}`);
        } catch (parseErr) {
          console.error("Failed to parse lead data:", parseErr);
        }
      }

      // Clean up the response for speech (remove LEAD tags, markdown, etc.)
      let spokenText = text
        .replace(/\[LEAD:.*?\]/g, "")
        .replace(/Kinder/g, "Kind-er")
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/#{1,6}\s/g, "")
        .replace(/- /g, "")
        .trim();

      // Check for closing phrases that signal end of call
      const isClosing = spokenText.toLowerCase().includes("have a good day") ||
        spokenText.toLowerCase().includes("take care") ||
        spokenText.toLowerCase().includes("goodbye");

      if (isClosing) {
        twiml.say({ voice: "Polly.Amy" }, spokenText);
        twiml.hangup();
      } else {
        const gather = twiml.gather({
          input: ["speech", "dtmf"],
          action: "/api/twilio/voice/conversation",
          timeout: 8,
          speechTimeout: "auto"
        });
        gather.say({ voice: "Polly.Amy" }, spokenText);
      }
    } catch (error) {
      console.error("Twilio conversation error:", error);
      twiml.say({ voice: "Polly.Amy" }, "I am experiencing a brief technical issue. Let me connect you to our team.");
      twiml.say({ voice: "Polly.Amy" }, "Thank you for calling United Solutions Assisting Kind-er Ones. A team member will follow up with you shortly. Take care.");
      twiml.hangup();
    }
    res.type("text/xml").send(twiml.toString());
  });

  // Clean up call state when calls end (Twilio status callback)
  app.post("/api/twilio/voice/status", (req, res) => {
    const { CallSid, CallStatus } = req.body;
    if (CallStatus === "completed" || CallStatus === "failed" || CallStatus === "canceled") {
      twilioCallState.delete(CallSid);
      console.log(`Call ${CallSid} ended (${CallStatus}), cleaned up state.`);
    }
    res.sendStatus(200);
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
    const currentUser = getAuthUser(req);
    if (!currentUser) return res.status(401).json({ error: "Unauthorized" });

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
      perplexity: !!process.env.PERPLEXITY_API_KEY,
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
