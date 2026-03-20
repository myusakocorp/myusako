import React, { useState, useEffect, useRef } from "react";
import { 
  Phone, Users, Heart, Settings, LayoutDashboard, MessageSquare, 
  ExternalLink, Activity, Send, Mic, MicOff, Play, Loader2, 
  Calendar as CalendarIcon, Video, Mail, LogOut, User, Lock, 
  CheckCircle2, Clock, MapPin, Globe, PhoneCall, PhoneOff, 
  Volume2, VolumeX, Hash, Shield, Truck, CassetteTape, Plus, Trash2, Edit2, Save, X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { speakText, stopSpeech, testAudio, isSpeechSupported, previewAgentVoice, AGENT_VOICE_INFO, getResolvedVoiceName, getAvailableVoices } from "./utils/speechUtils";
import DOMPurify from "dompurify";
import { io, Socket } from "socket.io-client";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { Device } from "@twilio/voice-sdk";

// --- Types ---
interface Lead {
  id: number;
  name: string;
  phone: string;
  email: string;
  needs: string;
  created_at: string;
}

interface Message {
  id?: number;
  role?: "user" | "agent"; // For simulator
  sender_id?: number; // For intranet chat
  sender_name?: string;
  text?: string; // For simulator
  content?: string; // For intranet chat
  audio?: string;
  timestamp?: string;
}

interface UserData {
  id: number;
  username: string;
  role: string;
  full_name: string;
}

// --- App Component ---
export default function App() {
  const [user, setUser] = useState<UserData | null>(null);
  const [activeTab, setActiveTab] = useState<"dashboard" | "mission" | "messaging" | "calendar" | "video" | "phone" | "mail" | "rover" | "voicemail" | "user-management" | "setup">("dashboard");
  const [phoneSubTab, setPhoneSubTab] = useState<"simulator" | "softphone">("simulator");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(true);

  // Email State
  const [emails, setEmails] = useState<any[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<any>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [composeData, setComposeData] = useState({ to: "", subject: "", text: "" });

  // Config Status
  const [configStatus, setConfigStatus] = useState<any>({ email: false, twilio: false, gemini: false });

  // Auth State
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  // Messaging State
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const socketRef = useRef<Socket | null>(null);

  // Phone Simulator State
  const [simMessages, setSimMessages] = useState<Message[]>([]);
  const [simInput, setSimInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [currentAgent, setCurrentAgent] = useState<string>("menu");
  const [audioTestPassed, setAudioTestPassed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const simEndRef = useRef<HTMLDivElement | null>(null);

  // Softphone State
  const [device, setDevice] = useState<Device | null>(null);
  const [call, setCall] = useState<any>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [callStatus, setCallStatus] = useState("Disconnected");
  const [isMuted, setIsMuted] = useState(false);
  const [callHistory, setCallHistory] = useState<any[]>([]);

  // Calendar State
  const [events, setEvents] = useState<any[]>([]);

  // User Management State
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "worker", full_name: "" });

  // Rover State
  const [roverSchedule, setRoverSchedule] = useState<any[]>([]);
  const [roverRoutes, setRoverRoutes] = useState<any[]>([]);
  const [newRoverTask, setNewRoverTask] = useState({ title: "", start_time: "", end_time: "" });
  const [newRoute, setNewRoute] = useState({ name: "", waypoints: "" });
  const [generatingRoute, setGeneratingRoute] = useState(false);
  const [generatedRouteResult, setGeneratedRouteResult] = useState<any>(null);

  // Voicemail State
  const [voicemails, setVoicemails] = useState<any[]>([]);

  // Rover Tracking State
  const [isTracking, setIsTracking] = useState(false);
  const trackingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchIdRef = useRef<number | null>(null);

  // --- API Helper ---
  // Build a clean base URL stripping any embedded credentials (needed for tunnel deploys)
  const getBaseUrl = () => {
    const loc = window.location;
    return `${loc.protocol}//${loc.host}`;
  };

  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const headers: any = {
      ...(options.headers || {}),
    };
    // Use full URL to avoid issues with embedded credentials in the page URL
    const fullUrl = url.startsWith("/") ? `${getBaseUrl()}${url}` : url;
    return fetch(fullUrl, { ...options, headers, credentials: "same-origin" });
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch(`${getBaseUrl()}/api/auth/me`, { credentials: "same-origin" });
        const data = await res.json();
        if (data.success) {
          setUser(data.user);
        }
      } catch (e) { console.error(e); }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    if (user) {
      fetchLeads();
      fetchMessages();
      fetchEvents();
      fetchCallHistory();
      fetchEmails();
      fetchConfigStatus();
      fetchUsers();
      fetchRoverData();
      fetchVoicemails();
      
      // Initialize Socket
      socketRef.current = io();
      socketRef.current.on("receive_message", (msg: Message) => {
        setChatMessages(prev => [...prev, msg]);
      });

      return () => {
        socketRef.current?.disconnect();
      };
    }
  }, [user]);

  useEffect(() => {
    simEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [simMessages]);

  // --- Softphone Logic ---
  const initSoftphone = async () => {
    try {
      const res = await apiFetch("/api/twilio/token");
      const data = await res.json();
      
      if (!res.ok) {
        setCallStatus(`Error: ${data.error || 'Failed to get token'}`);
        if (data.details) console.error("Missing keys:", data.details);
        return;
      }

      const { token } = data;
      
      const newDevice = new Device(token, {
        codecPreferences: ["opus" as any, "pcmu" as any],
      });

      newDevice.on("registered", () => setCallStatus("Ready"));
      newDevice.on("error", (error) => {
        console.error("Twilio Device Error:", error);
        setCallStatus("Error");
      });

      newDevice.on("incoming", (incomingCall) => {
        setCall(incomingCall);
        setCallStatus("Incoming Call");
        
        incomingCall.on("disconnect", () => {
          setCallStatus("Ready");
          setCall(null);
          fetchCallHistory();
        });
      });

      await newDevice.register();
      setDevice(newDevice);
    } catch (err) {
      console.error("Failed to init softphone:", err);
      setCallStatus("Failed to connect");
    }
  };

  const makeCall = async () => {
    if (!device || !phoneNumber) return;
    const params = { To: phoneNumber };
    const newCall = await device.connect({ params });
    
    newCall.on("accept", () => {
      setCallStatus("In Call");
      logCall("outbound", phoneNumber, "completed");
    });
    
    newCall.on("disconnect", () => {
      setCallStatus("Ready");
      setCall(null);
      fetchCallHistory();
    });
    
    setCall(newCall);
  };

  const acceptCall = () => {
    if (call) {
      call.accept();
      setCallStatus("In Call");
      logCall("inbound", call.parameters.From || "Unknown", "completed");
    }
  };

  const logCall = async (direction: string, number: string, status: string) => {
    try {
      await apiFetch("/api/calls/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          from_number: direction === "inbound" ? number : "USAKO Office",
          to_number: direction === "outbound" ? number : "Softphone",
          status,
          duration: 0
        })
      });
    } catch (e) { console.error("Failed to log call:", e); }
  };

  const fetchCallHistory = async () => {
    try {
      const res = await apiFetch("/api/calls");
      const data = await res.json();
      setCallHistory(data);
    } catch (e) { console.error(e); }
  };

  const fetchEmails = async () => {
    setEmailLoading(true);
    try {
      const res = await apiFetch("/api/email/inbox");
      const data = await res.json();
      if (Array.isArray(data)) {
        setEmails(data);
      } else {
        console.error("Expected array for emails, got:", data);
        // Only alert if it's not a config error, we'll show that in the setup tab
        if (data.error && !data.error.includes("configured")) {
          alert(`Email Error: ${data.error}${data.details ? ` (${data.details})` : ""}`);
        }
        setEmails([]);
      }
    } catch (e) { 
      console.error(e);
      setEmails([]);
    } finally { setEmailLoading(false); }
  };

  const fetchConfigStatus = async () => {
    try {
      const res = await apiFetch("/api/config/status");
      const data = await res.json();
      setConfigStatus(data);
    } catch (e) { console.error(e); }
  };

  const fetchUsers = async () => {
    if (!user || user.role === "worker") return;
    try {
      const res = await apiFetch("/api/users");
      const data = await res.json();
      if (Array.isArray(data)) setAllUsers(data);
    } catch (e) { console.error(e); }
  };

  const fetchRoverData = async () => {
    try {
      const [schedRes, routeRes] = await Promise.all([
        apiFetch("/api/rover/schedule"),
        apiFetch("/api/rover/routes")
      ]);
      setRoverSchedule(await schedRes.json());
      setRoverRoutes(await routeRes.json());
    } catch (e) { console.error(e); }
  };

  const fetchVoicemails = async () => {
    try {
      const res = await apiFetch("/api/voicemail");
      const data = await res.json();
      if (Array.isArray(data)) setVoicemails(data);
    } catch (e) { console.error(e); }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUser)
      });
      const data = await res.json();
      if (res.ok) {
        setNewUser({ username: "", password: "", role: "worker", full_name: "" });
        fetchUsers();
        alert("User created successfully!");
      } else {
        alert(`Failed to create user: ${data.error || "Unknown error"}`);
      }
    } catch (e) { 
      console.error(e);
      alert("An error occurred while creating the user.");
    }
  };

  const handleUpdateUser = async (id: number, data: any) => {
    try {
      const res = await apiFetch(`/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const resData = await res.json();
      if (res.ok) {
        setEditingUser(null);
        fetchUsers();
        alert("User updated successfully!");
      } else {
        alert(`Failed to update user: ${resData.error || "Unknown error"}`);
      }
    } catch (e) { 
      console.error(e);
      alert("An error occurred while updating the user.");
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (!confirm("Are you sure you want to delete this user?")) return;
    try {
      const res = await apiFetch(`/api/users/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        fetchUsers();
        alert("User deleted successfully!");
      } else {
        alert(`Failed to delete user: ${data.error || "Unknown error"}`);
      }
    } catch (e) { 
      console.error(e);
      alert("An error occurred while deleting the user.");
    }
  };

  const handleScheduleRover = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch("/api/rover/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newRoverTask)
      });
      if (res.ok) {
        setNewRoverTask({ title: "", start_time: "", end_time: "" });
        fetchRoverData();
      }
    } catch (e) { console.error(e); }
  };

  const handleCreateRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch("/api/rover/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newRoute, waypoints: newRoute.waypoints.split(",").map(w => w.trim()) })
      });
      if (res.ok) {
        setNewRoute({ name: "", waypoints: "" });
        fetchRoverData();
      }
    } catch (e) { console.error(e); }
  };

  const generateDailyRoute = async () => {
    setGeneratingRoute(true);
    setGeneratedRouteResult(null);
    try {
      const res = await apiFetch("/api/rover/generate-daily-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (data.success) {
        setGeneratedRouteResult(data.route);
        fetchRoverData();
      } else {
        alert(`Failed to generate route: ${data.error || "Unknown error"}`);
      }
    } catch (e) {
      console.error(e);
      alert("An error occurred while generating the daily route.");
    } finally {
      setGeneratingRoute(false);
    }
  };

  const fetchEmailContent = async (id: string) => {
    setEmailLoading(true);
    try {
      const res = await apiFetch(`/api/email/message/${id}`);
      const data = await res.json();
      setSelectedEmail(data);
    } catch (e) { console.error(e); } finally { setEmailLoading(false); }
  };

  const sendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(composeData),
      });
      const data = await res.json();
      if (data.success) {
        setIsComposing(false);
        setComposeData({ to: "", subject: "", text: "" });
        alert("Email sent successfully");
        fetchEmails();
      } else {
        alert(`Failed to send email: ${data.error}${data.details ? ` (${data.details})` : ""}`);
      }
    } catch (e) { 
      console.error(e);
      alert("An unexpected error occurred while sending email.");
    }
  };

  const hangUp = () => {
    if (call) {
      call.disconnect();
      setCall(null);
      setCallStatus("Ready");
    }
  };

  const toggleMute = () => {
    if (call) {
      const muted = !isMuted;
      call.mute(muted);
      setIsMuted(muted);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.success) {
        setUser(data.user);
        setAuthError("");
      } else {
        setAuthError("Invalid username or password");
      }
    } catch (err) {
      setAuthError("Connection failed");
    }
  };

  const handleLogout = async () => {
    try {
      const res = await apiFetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        setUser(null);
        setActiveTab("dashboard");
      }
    } catch (e) { console.error(e); }
  };

  const fetchLeads = async () => {
    try {
      const res = await apiFetch("/api/leads");
      const data = await res.json();
      setLeads(data);
    } catch (e) { console.error(e); } finally { setLoadingLeads(false); }
  };

  const fetchMessages = async () => {
    try {
      const res = await apiFetch("/api/messages");
      const data = await res.json();
      setChatMessages(data);
    } catch (e) { console.error(e); }
  };

  const fetchEvents = async () => {
    try {
      const res = await apiFetch("/api/calendar");
      const data = await res.json();
      setEvents(data);
    } catch (e) { console.error(e); }
  };

  const sendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !user) return;
    socketRef.current?.emit("send_message", {
      sender_id: user.id,
      content: chatInput
    });
    setChatInput("");
  };

  // --- Phone Simulator Logic (IVR menu flow + SpeechSynthesis TTS) ---
  const startSimulation = async () => {
    setSimMessages([]);
    setCurrentAgent("menu");
    setIsProcessing(true);
    stopSpeech();
    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "START_CALL" }),
      });
      const data = await res.json();
      setCurrentAgent(data.agent || "menu");
      setSimMessages([{ role: "agent", text: data.text }]);
      // Auto-play TTS after a short delay for UI to render
      setTimeout(() => {
        speakText(data.text, data.agent || "menu").catch(console.error);
      }, 500);
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  const sendSimMessage = async (text: string) => {
    if (!text.trim() || isProcessing) return;
    stopSpeech();
    setSimMessages(prev => [...prev, { role: "user", text }]);
    setSimInput("");
    setIsProcessing(true);
    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      const agent = data.agent || currentAgent;
      setCurrentAgent(agent);
      setSimMessages(prev => [...prev, { role: "agent", text: data.text }]);
      // Auto-play TTS
      setIsAudioLoading(true);
      speakText(data.text, agent).catch(console.error).finally(() => setIsAudioLoading(false));
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  const replayMessage = (text: string, agent: string) => {
    stopSpeech();
    speakText(text, agent).catch(console.error);
  };

  const handleTestAudio = async () => {
    try {
      await testAudio();
      setAudioTestPassed(true);
    } catch (e) {
      console.error("Audio test failed:", e);
      alert("Audio test failed. Please check your browser settings and speaker volume.");
    }
  };

  const toggleListening = () => {
    if (!('webkitSpeechRecognition' in window)) return;
    if (isListening) { setIsListening(false); return; }
    const recognition = new (window as any).webkitSpeechRecognition();
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (e: any) => sendSimMessage(e.results[0][0].transcript);
    recognition.start();
  };

  // --- Rover GPS Tracking ---
  const startTracking = () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    setIsTracking(true);

    const sendPosition = (position: GeolocationPosition) => {
      apiFetch("/api/rover/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        })
      }).catch(e => console.error("Tracking update failed:", e));
    };

    // Get initial position immediately
    navigator.geolocation.getCurrentPosition(sendPosition, (err) => {
      console.error("Geolocation error:", err);
      alert("Unable to access your location. Please allow location access.");
      setIsTracking(false);
    });

    // Watch position for real-time updates
    const watchId = navigator.geolocation.watchPosition(sendPosition, (err) => {
      console.error("Geolocation watch error:", err);
    }, { enableHighAccuracy: true, maximumAge: 5000 });
    watchIdRef.current = watchId;

    // Also send periodic updates every 10 seconds as a fallback
    const intervalId = setInterval(() => {
      navigator.geolocation.getCurrentPosition(sendPosition);
    }, 10000);
    trackingIntervalRef.current = intervalId;
  };

  const stopTracking = async () => {
    setIsTracking(false);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (trackingIntervalRef.current) {
      clearInterval(trackingIntervalRef.current);
      trackingIntervalRef.current = null;
    }
    // Clear position on server
    try {
      await apiFetch("/api/rover/tracking", { method: "DELETE" });
    } catch (e) { console.error(e); }
  };

  // --- Render Login ---
  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-zinc-900 border border-zinc-800 p-10 rounded-3xl shadow-2xl"
        >
          <div className="text-center mb-10">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6 text-emerald-500">
              <Lock size={32} />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">USAKO Intranet</h1>
            <p className="text-zinc-500 text-sm">Secured Staff Portal</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Username</label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" size={18} />
                <input 
                  type="text" 
                  value={username}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                  placeholder="Enter staff username"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Password</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" size={18} />
                <input 
                  type="password" 
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                  placeholder="••••••••"
                />
              </div>
            </div>

            {authError && <p className="text-red-500 text-xs text-center">{authError}</p>}

            <button className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-600/20">
              Login to Intranet
            </button>
          </form>

          <div className="mt-8 pt-8 border-t border-zinc-800 text-center">
            <p className="text-zinc-600 text-[10px] uppercase tracking-widest">
              Authorized Personnel Only • Sacramento, CA
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  // --- Render Main App ---
  return (
    <div className="min-h-screen bg-[#f5f2ed] text-[#1a1a1a] flex font-serif">
      <audio ref={audioRef} hidden />
      
      {/* Sidebar */}
      <aside className="w-72 bg-[#1a1a1a] text-white flex flex-col sticky top-0 h-screen">
        <div className="p-8 flex items-center gap-3 border-b border-white/5">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white">
            <Heart size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold">USAKO</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-50">Staff Intranet</p>
          </div>
        </div>

        <nav className="flex-1 p-6 space-y-2 overflow-y-auto">
          <SidebarItem active={activeTab === "dashboard"} onClick={() => setActiveTab("dashboard")} icon={<LayoutDashboard size={18} />} label="Dashboard" />
          <SidebarItem active={activeTab === "mission"} onClick={() => setActiveTab("mission")} icon={<Heart size={18} />} label="Our Mission" />
          <SidebarItem active={activeTab === "messaging"} onClick={() => setActiveTab("messaging")} icon={<MessageSquare size={18} />} label="Staff Chat" />
          <SidebarItem active={activeTab === "calendar"} onClick={() => setActiveTab("calendar")} icon={<CalendarIcon size={18} />} label="Scheduling" />
          <SidebarItem active={activeTab === "video"} onClick={() => setActiveTab("video")} icon={<Video size={18} />} label="Conferencing" />
          <SidebarItem active={activeTab === "phone"} onClick={() => setActiveTab("phone")} icon={<Phone size={18} />} label="AI Phone System" />
          <SidebarItem active={activeTab === "mail"} onClick={() => setActiveTab("mail")} icon={<Mail size={18} />} label="IMAP Email" />
          <SidebarItem active={activeTab === "rover"} onClick={() => setActiveTab("rover")} icon={<Truck size={18} />} label="Rover" />
          <SidebarItem active={activeTab === "voicemail"} onClick={() => setActiveTab("voicemail")} icon={<CassetteTape size={18} />} label="Voicemail" />
          {(user?.role === "admin" || user?.role === "leader") && (
            <SidebarItem active={activeTab === "user-management"} onClick={() => setActiveTab("user-management")} icon={<Shield size={18} />} label="User Mgmt" />
          )}
          <SidebarItem active={activeTab === "setup"} onClick={() => setActiveTab("setup")} icon={<Settings size={18} />} label="System Config" />
        </nav>

        <div className="p-6 border-t border-white/5 bg-white/5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 bg-zinc-800 rounded-full flex items-center justify-center text-xs">
              {user.full_name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold truncate">{user.full_name}</p>
              <p className="text-[10px] opacity-50 uppercase">{user.role}</p>
            </div>
          </div>
          <button 
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 py-2 text-xs opacity-50 hover:opacity-100 transition-opacity"
          >
            <LogOut size={14} /> Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-20 bg-white/50 backdrop-blur-md border-b border-black/5 px-10 flex items-center justify-between sticky top-0 z-40">
          <h2 className="text-xl font-light italic capitalize">{activeTab.replace("-", " ")}</h2>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-xs opacity-50">
              <Globe size={14} /> Sacramento, CA
            </div>
            <div className="h-8 w-px bg-black/5" />
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-600">
              <Activity size={14} className="animate-pulse" /> System Online
            </div>
          </div>
        </header>

        <div className="p-10 flex-1">
          <AnimatePresence mode="wait">
            {activeTab === "dashboard" && (
              <motion.div key="dashboard" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-10">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <StatCard label="Total Leads" value={leads.length} icon={<Users size={20} />} />
                  <StatCard label="Active Calls" value="0" icon={<Phone size={20} />} />
                  <StatCard label="Staff Online" value="1" icon={<Activity size={20} />} />
                  <StatCard label="Uptime" value="99.9%" icon={<Globe size={20} />} />
                </div>

                {/* Rover Tracking Button */}
                <div className="bg-white rounded-[40px] shadow-sm border border-black/5 p-6 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isTracking ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}`}>
                      <MapPin size={24} />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm">Rover GPS Tracking</h3>
                      <p className="text-[10px] opacity-50">
                        {isTracking ? 'Broadcasting your location — clients can see you on the live map' : 'Click to share your GPS position for live rover tracking'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={isTracking ? stopTracking : startTracking}
                    className={`px-8 py-3 rounded-2xl font-bold text-sm transition-all ${
                      isTracking
                        ? 'bg-red-500 text-white hover:bg-red-600 animate-pulse'
                        : 'bg-emerald-600 text-white hover:bg-emerald-500'
                    }`}
                  >
                    {isTracking ? 'Stop Tracking' : 'Start Tracking'}
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                  <div className="bg-white rounded-[40px] shadow-sm border border-black/5 overflow-hidden">
                    <div className="p-8 border-b border-black/5 flex justify-between items-center">
                      <h3 className="text-xl font-light italic">Recent Leads</h3>
                      <button onClick={fetchLeads} className="text-[10px] uppercase tracking-widest opacity-50 hover:opacity-100">Refresh</button>
                    </div>
                    <div className="p-0">
                      <table className="w-full text-left">
                        <thead className="bg-[#f5f2ed]/50 text-[10px] uppercase tracking-widest opacity-50">
                          <tr>
                            <th className="px-8 py-4">Name</th>
                            <th className="px-8 py-4">Needs</th>
                            <th className="px-8 py-4">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leads.slice(0, 5).map(lead => (
                            <tr key={lead.id} className="border-b border-black/5 hover:bg-black/5 transition-colors">
                              <td className="px-8 py-5 text-sm font-medium">{lead.name}</td>
                              <td className="px-8 py-5 text-xs opacity-70 truncate max-w-[150px]">{lead.needs}</td>
                              <td className="px-8 py-5 text-[10px] opacity-50">{new Date(lead.created_at).toLocaleDateString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="bg-white rounded-[40px] shadow-sm border border-black/5 p-8 space-y-6">
                    <h3 className="text-xl font-light italic">System Status</h3>
                    <div className="space-y-4">
                      <StatusItem label="Perplexity AI Brain" status="Healthy" />
                      <StatusItem label="Twilio Telephony" status="Connected" />
                      <StatusItem label="Render Cloud Hosting" status="Active" />
                      <StatusItem label="GitHub Integration" status="Synced" />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "messaging" && (
              <motion.div key="messaging" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="h-[calc(100vh-200px)] flex flex-col bg-white rounded-[40px] shadow-sm border border-black/5 overflow-hidden">
                <div className="flex-1 overflow-y-auto p-10 space-y-6">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex flex-col ${msg.sender_id === user.id ? "items-end" : "items-start"}`}>
                      <div className="flex items-center gap-2 mb-1 px-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest opacity-50">{msg.sender_name}</span>
                        <span className="text-[9px] opacity-30">{new Date(msg.timestamp!).toLocaleTimeString()}</span>
                      </div>
                      <div className={`max-w-[70%] p-4 rounded-2xl ${msg.sender_id === user.id ? "bg-emerald-600 text-white rounded-tr-none" : "bg-[#f5f2ed] rounded-tl-none"}`}>
                        <p className="text-sm">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <form onSubmit={sendChatMessage} className="p-8 border-t border-black/5 bg-[#f5f2ed]/30 flex gap-4">
                  <input 
                    type="text" 
                    value={chatInput}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setChatInput(e.target.value)}
                    placeholder="Type a message to staff..."
                    className="flex-1 bg-white rounded-full px-8 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 border border-black/5"
                  />
                  <button className="w-14 h-14 bg-emerald-600 text-white rounded-full flex items-center justify-center hover:bg-emerald-500 transition-colors shadow-lg shadow-emerald-600/20">
                    <Send size={20} />
                  </button>
                </form>
              </motion.div>
            )}

            {activeTab === "calendar" && (
              <motion.div key="calendar" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="bg-white p-10 rounded-[40px] shadow-sm border border-black/5">
                {/* @ts-ignore */}
                <FullCalendar
                  plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                  initialView="dayGridMonth"
                  headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
                  events={events}
                  height="70vh"
                />
              </motion.div>
            )}

            {activeTab === "video" && (
              <motion.div key="video" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="h-[calc(100vh-200px)] bg-black rounded-[40px] shadow-sm border border-black/5 overflow-hidden relative">
                <iframe 
                  src={`https://meet.jit.si/USAKO-Staff-Room-${user.id}`} 
                  className="w-full h-full border-none"
                  allow="camera; microphone; fullscreen; display-capture; autoplay"
                />
                <div className="absolute top-6 left-6 bg-emerald-600 text-white px-4 py-2 rounded-full text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 shadow-xl">
                  <Video size={12} /> Secure Video Bridge
                </div>
              </motion.div>
            )}

            {activeTab === "mission" && (
              <motion.div key="mission" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="max-w-4xl mx-auto space-y-10">
                <div className="bg-white p-12 rounded-[48px] shadow-sm border border-black/5 text-center space-y-8">
                  <div className="w-20 h-20 bg-[#5A5A40]/10 rounded-full flex items-center justify-center mx-auto">
                    <Heart size={40} className="text-[#5A5A40]" />
                  </div>
                  <div className="space-y-4">
                    <h2 className="text-4xl font-light italic text-[#5A5A40]">United Solutions Assisting Kinder Ones</h2>
                    <p className="text-sm uppercase tracking-[0.3em] opacity-50">U &bull; S &bull; A &bull; K &bull; O</p>
                  </div>
                  <div className="max-w-2xl mx-auto">
                    <p className="text-lg leading-relaxed italic opacity-80">
                      "To provide immediate, person-centered support to our unhoused neighbors by delivering essential resources directly to the streets. We believe in meeting people right where they are, serving them right now, and honoring their humanity rightly through consistent, barrier-free care."
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="bg-white p-8 rounded-[40px] shadow-sm border border-black/5 text-center space-y-4">
                    <Clock size={28} className="mx-auto text-[#5A5A40]" />
                    <h3 className="font-bold text-sm">Hours of Operation</h3>
                    <div className="text-sm opacity-70 space-y-1">
                      <p>Monday - Friday</p>
                      <p className="font-bold">8:00 AM - 5:00 PM PST</p>
                      <p className="text-xs mt-2 opacity-50">24/7 automated info &amp; donations</p>
                    </div>
                  </div>

                  <div className="bg-white p-8 rounded-[40px] shadow-sm border border-black/5 text-center space-y-4">
                    <MapPin size={28} className="mx-auto text-[#5A5A40]" />
                    <h3 className="font-bold text-sm">Our Location</h3>
                    <div className="text-sm opacity-70 space-y-1">
                      <p>3600 Watt Avenue</p>
                      <p>Suite 101</p>
                      <p>Sacramento, California 95816</p>
                    </div>
                  </div>

                  <div className="bg-white p-8 rounded-[40px] shadow-sm border border-black/5 text-center space-y-4">
                    <Globe size={28} className="mx-auto text-[#5A5A40]" />
                    <h3 className="font-bold text-sm">Connect With Us</h3>
                    <div className="text-sm opacity-70 space-y-1">
                      <p><a href="https://www.myusako.org" target="_blank" rel="noreferrer" className="underline hover:text-[#5A5A40]">www.myusako.org</a></p>
                      <p>+1 (855) 528-9741</p>
                      <p className="text-xs mt-2 opacity-50">Relief Rover R.E.A. Service</p>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-10 rounded-[48px] shadow-sm border border-black/5 space-y-6">
                  <h3 className="text-2xl font-light italic text-center">Relief Rover R.E.A.</h3>
                  <p className="text-center text-sm opacity-50 uppercase tracking-widest">Rapid Emergency Assistance</p>
                  <p className="text-sm leading-relaxed opacity-80 max-w-2xl mx-auto text-center">
                    The Relief Rover R.E.A. is a converted motorhome that drives to locations where unhoused neighbors are staying. It provides services in a climate-controlled environment including: bicycle repair, secured pet cages, cell phone charging, computer and print stations, government phone signup, SNAP and CalWORKs application help, harm reduction services, restroom access, lunch and drink, TV and seating, free Wi-Fi, and pop-up donations.
                  </p>
                  <div className="flex justify-center gap-4 flex-wrap">
                    <span className="px-4 py-2 bg-[#5A5A40]/10 rounded-full text-xs font-bold">10:00 AM</span>
                    <span className="px-4 py-2 bg-[#5A5A40]/10 rounded-full text-xs font-bold">11:30 AM</span>
                    <span className="px-4 py-2 bg-[#5A5A40]/10 rounded-full text-xs font-bold">2:00 PM</span>
                    <span className="px-4 py-2 bg-[#5A5A40]/10 rounded-full text-xs font-bold">3:30 PM</span>
                  </div>
                  <p className="text-center text-xs opacity-50">Schedule a visit at least 24 hours in advance. Only day, time, and cross streets required.</p>
                </div>
              </motion.div>
            )}

            {activeTab === "phone" && (
              <motion.div key="phone" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="max-w-4xl mx-auto h-[calc(100vh-200px)] flex flex-col bg-white rounded-[40px] shadow-sm border border-black/5 overflow-hidden">
                <div className="flex border-b border-black/5">
                  <button 
                    onClick={() => setPhoneSubTab("simulator")}
                    className={`flex-1 py-4 text-[10px] uppercase tracking-widest font-bold transition-colors ${phoneSubTab === "simulator" ? "bg-[#5A5A40] text-white" : "hover:bg-black/5"}`}
                  >
                    AI Agent Simulator
                  </button>
                  <button 
                    onClick={() => setPhoneSubTab("softphone")}
                    className={`flex-1 py-4 text-[10px] uppercase tracking-widest font-bold transition-colors ${phoneSubTab === "softphone" ? "bg-[#5A5A40] text-white" : "hover:bg-black/5"}`}
                  >
                    VOIP Softphone
                  </button>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col">
                  {phoneSubTab === "simulator" ? (
                    <>
                      <div className="p-6 border-b border-black/5 flex items-center justify-between bg-[#5A5A40]/5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-[#5A5A40] rounded-full flex items-center justify-center text-white">
                            <Phone size={14} />
                          </div>
                          <div>
                            <h3 className="text-sm font-bold tracking-tight">IVR Simulator</h3>
                            <p className="text-[10px] uppercase tracking-widest opacity-50">
                              {currentAgent === "menu" ? "Main Menu" : `Agent: ${currentAgent.charAt(0).toUpperCase() + currentAgent.slice(1)}`}
                              {" "}• Browser TTS
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {isSpeechSupported() && (
                            <button onClick={handleTestAudio} className={`text-[10px] uppercase tracking-widest px-3 py-1 rounded-full border transition-all ${audioTestPassed ? "border-emerald-500 text-emerald-600 bg-emerald-50" : "border-[#5A5A40]/30 hover:border-[#5A5A40] opacity-60 hover:opacity-100"}`}>
                              <span className="flex items-center gap-1"><Volume2 size={10} /> {audioTestPassed ? "Audio OK" : "Test Audio"}</span>
                            </button>
                          )}
                          <button onClick={() => { stopSpeech(); startSimulation(); }} className="text-[10px] uppercase tracking-widest opacity-50 hover:opacity-100">Reset</button>
                        </div>
                      </div>
                      {/* Voice Sample Preview Panel */}
                      {isSpeechSupported() && simMessages.length === 0 && (
                        <div className="px-6 py-4 border-b border-black/5 bg-[#f5f2ed]/50">
                          <p className="text-[10px] uppercase tracking-widest opacity-50 mb-3">Preview Agent Voices</p>
                          <div className="grid grid-cols-2 gap-2">
                            {AGENT_VOICE_INFO.map((info) => (
                              <button
                                key={info.agent}
                                onClick={() => { stopSpeech(); previewAgentVoice(info.agent); }}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[#5A5A40]/20 hover:border-[#5A5A40]/60 hover:bg-[#5A5A40]/5 transition-all text-left group"
                              >
                                <div className="w-6 h-6 rounded-full bg-[#5A5A40]/10 group-hover:bg-[#5A5A40]/20 flex items-center justify-center flex-shrink-0">
                                  <Volume2 size={10} className="text-[#5A5A40]" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold truncate">{info.label}</p>
                                  <p className="text-[9px] opacity-50 truncate">{info.role} • {info.accent}</p>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex-1 overflow-y-auto p-10 space-y-6">
                        {simMessages.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center space-y-8 opacity-40">
                            <Phone size={64} strokeWidth={1} />
                            <div className="space-y-3">
                              <p className="text-lg font-light italic">United Solutions Assisting Kinder Ones</p>
                              <p className="text-xs opacity-60">IVR Phone System Simulator with Voice</p>
                            </div>
                            <button onClick={startSimulation} className="px-10 py-4 bg-[#5A5A40] text-white rounded-full font-medium shadow-xl hover:shadow-2xl transition-all">
                              Start Call
                            </button>
                          </div>
                        ) : (
                          simMessages.map((msg, i) => (
                            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                              <div className={`max-w-[80%] p-5 rounded-3xl ${msg.role === "user" ? "bg-[#5A5A40] text-white rounded-tr-none" : "bg-[#f5f2ed] rounded-tl-none border border-black/5"}`}>
                                <p className="text-sm leading-relaxed whitespace-pre-line">{msg.text}</p>
                                {msg.role === "agent" && (
                                  <button 
                                    onClick={() => replayMessage(msg.text, currentAgent)} 
                                    className="mt-3 text-[10px] uppercase tracking-widest flex items-center gap-2 opacity-50 hover:opacity-100 transition-opacity"
                                  >
                                    <Play size={10} /> Replay Voice
                                  </button>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                        {isProcessing && <div className="flex justify-start"><div className="bg-[#f5f2ed] p-5 rounded-3xl rounded-tl-none border border-black/5"><Loader2 size={16} className="animate-spin opacity-30" /></div></div>}
                        <div ref={simEndRef} />
                      </div>
                      <div className="p-8 border-t border-black/5 bg-white">
                        <form onSubmit={(e) => { e.preventDefault(); sendSimMessage(simInput); }} className="flex gap-4">
                          <button type="button" onClick={toggleListening} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isListening ? "bg-red-500 text-white animate-pulse" : "bg-[#f5f2ed] text-[#5A5A40]"}`}>
                            {isListening ? <MicOff size={20} /> : <Mic size={20} />}
                          </button>
                          <input 
                            type="text" 
                            value={isListening ? "Listening..." : simInput} 
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSimInput(e.target.value)} 
                            placeholder={currentAgent === "menu" ? "Type 1-5, 0, or speak your selection..." : "Type your response to the agent..."} 
                            className="flex-1 bg-[#f5f2ed] rounded-full px-8 text-sm focus:outline-none" 
                            disabled={isListening}
                          />
                          <button type="submit" disabled={isListening || isProcessing} className="w-14 h-14 bg-[#5A5A40] text-white rounded-full flex items-center justify-center shadow-lg disabled:opacity-50"><Send size={20} /></button>
                        </form>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-10 bg-[#f5f2ed]/30 overflow-y-auto">
                      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-10">
                        {/* Dialer Card */}
                        <div className="bg-white rounded-[48px] shadow-2xl border border-black/5 p-10 flex flex-col items-center space-y-8">
                          <div className="text-center">
                            <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 transition-colors ${callStatus === "In Call" ? "bg-emerald-500 text-white animate-pulse" : callStatus === "Incoming Call" ? "bg-orange-500 text-white animate-bounce" : "bg-zinc-100 text-zinc-400"}`}>
                              {callStatus === "Incoming Call" ? <Phone size={32} /> : <PhoneCall size={32} />}
                            </div>
                            <h3 className="text-xl font-bold">{callStatus}</h3>
                            <p className="text-[10px] uppercase tracking-widest opacity-50">Twilio VOIP Bridge</p>
                          </div>

                          {!device ? (
                            <button 
                              onClick={initSoftphone}
                              className="w-full py-4 bg-[#5A5A40] text-white rounded-2xl font-bold shadow-lg"
                            >
                              Initialize Softphone
                            </button>
                          ) : (
                            <div className="w-full space-y-6">
                              <div className="relative">
                                <Hash className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-300" size={18} />
                                <input 
                                  type="tel" 
                                  value={phoneNumber}
                                  onChange={(e) => setPhoneNumber(e.target.value)}
                                  placeholder="+1 (555) 000-0000"
                                  className="w-full bg-zinc-50 border border-zinc-100 rounded-2xl py-4 pl-12 pr-4 text-center text-lg font-mono focus:outline-none focus:border-[#5A5A40]"
                                />
                              </div>

                              <div className="grid grid-cols-3 gap-4">
                                {[1,2,3,4,5,6,7,8,9,'*',0,'#'].map(num => (
                                  <button 
                                    key={num}
                                    onClick={() => setPhoneNumber(prev => prev + String(num))}
                                    className="h-14 bg-zinc-50 hover:bg-zinc-100 rounded-xl flex items-center justify-center text-lg font-medium transition-colors"
                                  >
                                    {num}
                                  </button>
                                ))}
                              </div>

                              <div className="flex gap-4">
                                {callStatus === "Incoming Call" ? (
                                  <>
                                    <button 
                                      onClick={acceptCall}
                                      className="flex-1 py-4 bg-emerald-500 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-lg shadow-emerald-500/20"
                                    >
                                      <PhoneCall size={18} /> Accept
                                    </button>
                                    <button 
                                      onClick={hangUp}
                                      className="flex-1 py-4 bg-red-500 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-lg shadow-red-500/20"
                                    >
                                      <PhoneOff size={18} /> Reject
                                    </button>
                                  </>
                                ) : callStatus === "In Call" ? (
                                  <>
                                    <button 
                                      onClick={toggleMute}
                                      className={`flex-1 py-4 rounded-2xl flex items-center justify-center gap-2 font-bold transition-colors ${isMuted ? "bg-orange-100 text-orange-600" : "bg-zinc-100 text-zinc-600"}`}
                                    >
                                      {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />} {isMuted ? "Unmute" : "Mute"}
                                    </button>
                                    <button 
                                      onClick={hangUp}
                                      className="flex-1 py-4 bg-red-500 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-lg shadow-red-500/20"
                                    >
                                      <PhoneOff size={18} /> End
                                    </button>
                                  </>
                                ) : (
                                  <button 
                                    onClick={makeCall}
                                    disabled={!phoneNumber}
                                    className="w-full py-4 bg-emerald-600 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                                  >
                                    <PhoneCall size={18} /> Call Number
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Call History Card */}
                        <div className="bg-white rounded-[48px] shadow-sm border border-black/5 p-8 flex flex-col">
                          <div className="flex items-center justify-between mb-8">
                            <h3 className="text-xl font-light italic">Call History</h3>
                            <button onClick={fetchCallHistory} className="text-[10px] uppercase tracking-widest opacity-50 hover:opacity-100">Refresh</button>
                          </div>
                          <div className="flex-1 overflow-y-auto space-y-4 pr-2">
                            {callHistory.length === 0 ? (
                              <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
                                <Clock size={48} strokeWidth={1} className="mb-4" />
                                <p className="text-xs uppercase tracking-widest">No recent calls</p>
                              </div>
                            ) : (
                              callHistory.map(call => (
                                <div key={call.id} className="flex items-center justify-between p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5">
                                  <div className="flex items-center gap-4">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${call.direction === 'inbound' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                      {call.direction === 'inbound' ? <PhoneCall size={16} /> : <Phone size={16} />}
                                    </div>
                                    <div>
                                      <p className="text-sm font-bold">{call.direction === 'inbound' ? call.from_number : call.to_number}</p>
                                      <p className="text-[10px] uppercase tracking-widest opacity-50">{call.direction} • {new Date(call.created_at).toLocaleTimeString()}</p>
                                    </div>
                                  </div>
                                  <span className="text-[10px] font-mono opacity-50">{new Date(call.created_at).toLocaleDateString()}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === "mail" && (
              <motion.div key="mail" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="h-[calc(100vh-200px)] flex bg-white rounded-[40px] shadow-sm border border-black/5 overflow-hidden">
                {/* Inbox List */}
                <div className="w-1/3 border-r border-black/5 flex flex-col">
                  <div className="p-6 border-b border-black/5 flex justify-between items-center bg-[#f5f2ed]/30">
                    <h3 className="text-lg font-light italic">Inbox</h3>
                    <button 
                      onClick={() => { setIsComposing(true); setSelectedEmail(null); }}
                      className="p-2 bg-emerald-600 text-white rounded-full hover:bg-emerald-500 transition-colors"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {emailLoading && (!emails || !emails.length) ? (
                      <div className="p-10 text-center opacity-30"><Loader2 className="animate-spin mx-auto" /></div>
                    ) : (
                      Array.isArray(emails) && emails.map((email) => (
                        <button
                          key={email.id}
                          onClick={() => { fetchEmailContent(email.id); setIsComposing(false); }}
                          className={`w-full p-6 text-left border-b border-black/5 hover:bg-[#f5f2ed]/50 transition-colors ${selectedEmail?.id === email.id ? "bg-[#f5f2ed]" : ""}`}
                        >
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs font-bold truncate max-w-[150px]">{email.from}</span>
                            <span className="text-[9px] opacity-50">{new Date(email.date).toLocaleDateString()}</span>
                          </div>
                          <p className="text-sm font-medium truncate mb-1">{email.subject}</p>
                          <p className="text-[10px] opacity-50 truncate">{email.snippet}</p>
                        </button>
                      ))
                    )}
                    {Array.isArray(emails) && emails.length === 0 && !emailLoading && (
                      <div className="p-10 text-center opacity-30">No emails found</div>
                    )}
                  </div>
                </div>

                {/* Email Content / Compose */}
                <div className="flex-1 flex flex-col bg-[#f5f2ed]/10">
                  {isComposing ? (
                    <form onSubmit={sendEmail} className="flex-1 flex flex-col p-10 space-y-6">
                      <h3 className="text-2xl font-light italic mb-4">Compose Message</h3>
                      <div className="space-y-4">
                        <input 
                          type="email" 
                          placeholder="To" 
                          required
                          value={composeData.to}
                          onChange={(e) => setComposeData({...composeData, to: e.target.value})}
                          className="w-full bg-white border border-black/5 rounded-xl px-6 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                        />
                        <input 
                          type="text" 
                          placeholder="Subject" 
                          required
                          value={composeData.subject}
                          onChange={(e) => setComposeData({...composeData, subject: e.target.value})}
                          className="w-full bg-white border border-black/5 rounded-xl px-6 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                        />
                        <textarea 
                          placeholder="Message body..." 
                          required
                          rows={12}
                          value={composeData.text}
                          onChange={(e) => setComposeData({...composeData, text: e.target.value})}
                          className="w-full bg-white border border-black/5 rounded-xl px-6 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 resize-none"
                        />
                      </div>
                      <div className="flex justify-end gap-4">
                        <button 
                          type="button"
                          onClick={() => setIsComposing(false)}
                          className="px-8 py-4 text-sm opacity-50 hover:opacity-100"
                        >
                          Cancel
                        </button>
                        <button 
                          type="submit"
                          className="px-10 py-4 bg-emerald-600 text-white rounded-full font-bold shadow-lg shadow-emerald-600/20 hover:bg-emerald-500 transition-all"
                        >
                          Send Email
                        </button>
                      </div>
                    </form>
                  ) : selectedEmail ? (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      <div className="p-10 border-b border-black/5 bg-white">
                        <h3 className="text-2xl font-light italic mb-6">{selectedEmail.subject}</h3>
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-[#5A5A40] rounded-full flex items-center justify-center text-white text-xs">
                              {selectedEmail.from?.charAt(0)}
                            </div>
                            <div>
                              <p className="text-sm font-bold">{selectedEmail.from}</p>
                              <p className="text-[10px] opacity-50">To: {selectedEmail.to}</p>
                            </div>
                          </div>
                          <span className="text-xs opacity-50">{new Date(selectedEmail.date).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto p-10 bg-white">
                        <div 
                          className="prose prose-sm max-w-none text-sm leading-relaxed"
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedEmail.html || selectedEmail.text || '') }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center opacity-20 text-center space-y-6">
                      <Mail size={80} strokeWidth={1} />
                      <p className="text-lg font-light italic">Select an email to read or start a new one</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === "rover" && (
              <motion.div key="rover" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-10">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                  <div className="bg-white p-10 rounded-[48px] shadow-sm border border-black/5 space-y-8">
                    <h3 className="text-2xl font-light italic">Schedule Rover</h3>
                    <form onSubmit={handleScheduleRover} className="space-y-4">
                      <input 
                        type="text" 
                        placeholder="Task Title" 
                        className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                        value={newRoverTask.title}
                        onChange={e => setNewRoverTask({...newRoverTask, title: e.target.value})}
                        required
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <input 
                          type="datetime-local" 
                          className="p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newRoverTask.start_time}
                          onChange={e => setNewRoverTask({...newRoverTask, start_time: e.target.value})}
                          required
                        />
                        <input 
                          type="datetime-local" 
                          className="p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newRoverTask.end_time}
                          onChange={e => setNewRoverTask({...newRoverTask, end_time: e.target.value})}
                          required
                        />
                      </div>
                      <button type="submit" className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-bold hover:bg-emerald-500 transition-all">
                        Schedule Task
                      </button>
                    </form>
                    <div className="space-y-4">
                      <h4 className="font-bold text-sm opacity-50">Upcoming Tasks</h4>
                      {roverSchedule.map(task => (
                        <div key={task.id} className="p-4 bg-[#f5f2ed]/30 rounded-2xl border border-black/5 flex justify-between items-center">
                          <div>
                            <p className="font-bold text-sm">{task.title}</p>
                            <p className="text-[10px] opacity-50">{new Date(task.start_time).toLocaleString()} - {new Date(task.end_time).toLocaleTimeString()}</p>
                          </div>
                          <span className="text-[10px] uppercase font-bold text-emerald-600">{task.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white p-10 rounded-[48px] shadow-sm border border-black/5 space-y-8">
                    <h3 className="text-2xl font-light italic">Rover Routes</h3>

                    {/* AI Daily Route Generator */}
                    <div className="p-6 bg-gradient-to-br from-emerald-50 to-[#f5f2ed]/50 rounded-3xl border border-emerald-200 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-bold text-sm">AI Daily Route Planner</h4>
                          <p className="text-[10px] opacity-60 mt-1">
                            Generate a 4-stop route for tomorrow (10:00 AM, 11:30 AM, 2:00 PM, 3:30 PM) using local intel from Nextdoor, Facebook, X, Sacbee, local news, Google Maps, and law enforcement data.
                          </p>
                        </div>
                      </div>
                      <button 
                        onClick={generateDailyRoute} 
                        disabled={generatingRoute}
                        className={`w-full py-4 rounded-2xl font-bold transition-all ${
                          generatingRoute 
                            ? "bg-emerald-300 text-white cursor-wait" 
                            : "bg-emerald-600 text-white hover:bg-emerald-500"
                        }`}
                      >
                        {generatingRoute ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                            AI is researching local Sacramento sources...
                          </span>
                        ) : (
                          "Generate Tomorrow's Daily Route"
                        )}
                      </button>

                      {generatedRouteResult && (
                        <div className="mt-4 p-4 bg-white rounded-2xl border border-emerald-200 space-y-3">
                          <p className="font-bold text-sm text-emerald-700">{generatedRouteResult.route_name}</p>
                          {generatedRouteResult.stops.map((stop: { time: string; location: string; reason: string }, i: number) => (
                            <div key={i} className="flex gap-3 items-start p-3 bg-emerald-50/50 rounded-xl">
                              <span className="px-2 py-1 bg-emerald-600 text-white rounded-lg text-[10px] font-bold whitespace-nowrap">{stop.time}</span>
                              <div>
                                <p className="text-sm font-medium">{stop.location}</p>
                                <p className="text-[10px] opacity-60">{stop.reason}</p>
                              </div>
                            </div>
                          ))}
                          <p className="text-[9px] opacity-40 italic text-center">Route and schedule saved. Powered by Gemini AI.</p>
                        </div>
                      )}
                    </div>

                    <form onSubmit={handleCreateRoute} className="space-y-4">
                      <input 
                        type="text" 
                        placeholder="Route Name" 
                        className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                        value={newRoute.name}
                        onChange={e => setNewRoute({...newRoute, name: e.target.value})}
                        required
                      />
                      <textarea 
                        placeholder="Waypoints (comma separated)" 
                        className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5 h-32"
                        value={newRoute.waypoints}
                        onChange={e => setNewRoute({...newRoute, waypoints: e.target.value})}
                        required
                      />
                      <button type="submit" className="w-full py-4 bg-[#5A5A40] text-white rounded-2xl font-bold hover:opacity-90 transition-all">
                        Request Route Change
                      </button>
                    </form>
                    <div className="space-y-4">
                      <h4 className="font-bold text-sm opacity-50">Recent Requests</h4>
                      {roverRoutes.map(route => (
                        <div key={route.id} className="p-4 bg-[#f5f2ed]/30 rounded-2xl border border-black/5">
                          <p className="font-bold text-sm">{route.name}</p>
                          <p className="text-[10px] opacity-50 mb-2">Requested by: {route.user_name}</p>
                          <div className="flex gap-2 flex-wrap">
                            {JSON.parse(route.waypoints).map((wp: string, i: number) => (
                              <span key={i} className="px-2 py-1 bg-white rounded-lg text-[9px] border border-black/5">{wp}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "voicemail" && (
              <motion.div key="voicemail" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="max-w-4xl mx-auto">
                <div className="bg-white p-12 rounded-[48px] shadow-sm border border-black/5 space-y-10">
                  <div className="flex justify-between items-center">
                    <h2 className="text-3xl font-light italic">Voicemail Center</h2>
                    <div className="flex gap-4">
                      <span className="px-4 py-2 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">Personal</span>
                      <span className="px-4 py-2 bg-amber-100 text-amber-700 rounded-full text-xs font-bold">General</span>
                    </div>
                  </div>
                  <div className="space-y-4">
                    {voicemails.length === 0 ? (
                      <div className="p-20 text-center opacity-20 italic">No voicemails found</div>
                    ) : (
                      voicemails.map(vm => (
                        <div key={vm.id} className="p-6 bg-[#f5f2ed]/30 rounded-3xl border border-black/5 flex items-center justify-between">
                          <div className="flex items-center gap-6">
                            <div className={`w-3 h-3 rounded-full ${vm.is_read ? "bg-black/10" : "bg-emerald-500 animate-pulse"}`} />
                            <div>
                              <p className="font-bold text-lg">{vm.from_number}</p>
                              <p className="text-xs opacity-50">{new Date(vm.created_at).toLocaleString()} • {vm.duration}s</p>
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <button className="p-4 bg-white rounded-2xl border border-black/5 hover:bg-black/5 transition-colors">
                              <Play size={20} />
                            </button>
                            <button className="p-4 bg-white rounded-2xl border border-black/5 hover:text-red-600 transition-colors">
                              <Trash2 size={20} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "user-management" && (
              <motion.div key="users" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-10">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                  {user?.role === "admin" && (
                    <div className="lg:col-span-1 bg-white p-10 rounded-[48px] shadow-sm border border-black/5 space-y-8">
                      <h3 className="text-2xl font-light italic">Create User</h3>
                      <form onSubmit={handleCreateUser} className="space-y-4">
                        <input 
                          type="text" 
                          placeholder="Full Name" 
                          className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newUser.full_name}
                          onChange={e => setNewUser({...newUser, full_name: e.target.value})}
                          required
                        />
                        <input 
                          type="text" 
                          placeholder="Username" 
                          className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newUser.username}
                          onChange={e => setNewUser({...newUser, username: e.target.value})}
                          required
                        />
                        <input 
                          type="password" 
                          placeholder="Password" 
                          className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newUser.password}
                          onChange={e => setNewUser({...newUser, password: e.target.value})}
                          required
                        />
                        <select 
                          className="w-full p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5"
                          value={newUser.role}
                          onChange={e => setNewUser({...newUser, role: e.target.value})}
                        >
                          <option value="worker">Worker</option>
                          <option value="leader">Leader</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button type="submit" className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-bold hover:bg-emerald-500 transition-all">
                          Add User
                        </button>
                      </form>
                    </div>
                  )}

                  <div className={`${user?.role === "admin" ? "lg:col-span-2" : "lg:col-span-3"} bg-white p-10 rounded-[48px] shadow-sm border border-black/5 space-y-8`}>
                    <h3 className="text-2xl font-light italic">Manage Users</h3>
                    <div className="space-y-4">
                      {allUsers.map(u => (
                        <div key={u.id} className="p-6 bg-[#f5f2ed]/30 rounded-3xl border border-black/5 flex items-center justify-between">
                          {editingUser?.id === u.id ? (
                            <div className="flex-1 flex gap-4">
                              <input 
                                type="text" 
                                className="flex-1 p-2 bg-white rounded-lg border border-black/5"
                                value={editingUser.full_name}
                                onChange={e => setEditingUser({...editingUser, full_name: e.target.value})}
                              />
                              <input 
                                type="password" 
                                placeholder="New Password"
                                className="flex-1 p-2 bg-white rounded-lg border border-black/5"
                                onChange={e => setEditingUser({...editingUser, password: e.target.value})}
                              />
                              <button onClick={() => handleUpdateUser(u.id, editingUser)} className="p-2 bg-emerald-600 text-white rounded-lg">
                                <Save size={16} />
                              </button>
                              <button onClick={() => setEditingUser(null)} className="p-2 bg-red-600 text-white rounded-lg">
                                <X size={16} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <div>
                                <p className="font-bold text-lg">{u.full_name}</p>
                                <p className="text-xs opacity-50">@{u.username} • <span className="uppercase font-bold text-emerald-600">{u.role}</span></p>
                              </div>
                              <div className="flex gap-2">
                                <button 
                                  onClick={() => setEditingUser(u)}
                                  className="p-3 bg-white rounded-xl border border-black/5 hover:bg-black/5 transition-colors"
                                >
                                  <Edit2 size={18} />
                                </button>
                                {user?.role === "admin" && (
                                  <button 
                                    onClick={() => handleDeleteUser(u.id)}
                                    className="p-3 bg-white rounded-xl border border-black/5 hover:text-red-600 transition-colors"
                                  >
                                    <Trash2 size={18} />
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
            {activeTab === "setup" && (
              <motion.div key="setup" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="max-w-3xl mx-auto space-y-10">
                <div className="bg-white p-12 rounded-[48px] shadow-sm border border-black/5 space-y-10">
                  <h2 className="text-3xl font-light italic">Infrastructure Configuration</h2>
                  <div className="space-y-6">
                    <ConfigCard 
                      title="IMAP/SMTP Email" 
                      description="Handles myusako.org email services." 
                      status={configStatus.email ? "Connected" : "Missing Credentials"} 
                      isError={!configStatus.email}
                    />
                    <ConfigCard 
                      title="Twilio Telephony" 
                      description="Handles real-time voice calls and SMS." 
                      status={configStatus.twilio ? "Connected" : "Missing Credentials"} 
                      isError={!configStatus.twilio}
                    />
                    <ConfigCard 
                      title="Perplexity AI (Phone Agent)" 
                      description="AI brain for phone agent conversational logic." 
                      status={configStatus.perplexity ? "Active" : "Inactive"} 
                      isError={!configStatus.perplexity}
                    />
                    <ConfigCard 
                      title="Gemini AI (Route Planner)" 
                      description="Powers AI-generated daily rover routes." 
                      status={configStatus.gemini ? "Active" : "Inactive - Using Fallback Routes"} 
                      isError={!configStatus.gemini}
                    />
                    <ConfigCard title="Render Cloud" description="Hosting the intranet and AI agent." status="Online" />
                  </div>
                  
                  {!configStatus.email && (
                    <div className="p-6 bg-amber-50 border border-amber-200 rounded-2xl text-amber-800 text-sm">
                      <p className="font-bold mb-2">Action Required: Email Setup</p>
                      <p>Your intranet <strong>Username</strong> and <strong>Password</strong> are used to connect to your <code>@myusako.org</code> email account.</p>
                      <p className="mt-2">Ensure your username is either your full email address or your email prefix (e.g., <code>staff</code> for <code>staff@myusako.org</code>).</p>
                    </div>
                  )}

                  {!configStatus.twilio && (
                    <div className="p-6 bg-amber-50 border border-amber-200 rounded-2xl text-amber-800 text-sm">
                      <p className="font-bold mb-2">Action Required: Twilio Setup</p>
                      <p>To enable the softphone and AI agent, please configure the following secrets in the AI Studio sidebar:</p>
                      <ul className="list-disc list-inside mt-2 space-y-1">
                        <li><code>TWILIO_ACCOUNT_SID</code> (starts with <code>AC</code>)</li>
                        <li><code>TWILIO_API_KEY</code> (starts with <code>SK</code>)</li>
                        <li><code>TWILIO_API_SECRET</code> (your API Key Secret)</li>
                        <li><code>TWILIO_TWIML_APP_SID</code> (starts with <code>AP</code>)</li>
                        <li><code>TWILIO_PHONE_NUMBER</code> (e.g., <code>+1234567890</code>)</li>
                      </ul>
                      <p className="mt-4 font-bold">Voice URL for TwiML App:</p>
                      <code className="block p-2 bg-black/5 rounded mt-1 text-[10px] break-all">
                        {window.location.origin}/api/twilio/outbound
                      </code>
                      <p className="mt-2 italic">Note: Create a TwiML App in Twilio Console and set the Voice URL to the address above.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// --- Helper Components ---
function SidebarItem({ icon, label, active, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl transition-all ${active ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20" : "text-white/50 hover:text-white hover:bg-white/5"}`}
    >
      {icon}
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

function StatCard({ label, value, icon }: any) {
  return (
    <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] uppercase tracking-widest opacity-50">{label}</p>
        <div className="opacity-20">{icon}</div>
      </div>
      <h2 className="text-4xl font-light">{value}</h2>
    </div>
  );
}

function StatusItem({ label, status }: any) {
  return (
    <div className="flex items-center justify-between p-4 bg-[#f5f2ed]/50 rounded-2xl border border-black/5">
      <span className="text-sm opacity-70">{label}</span>
      <span className="text-[10px] uppercase tracking-widest font-bold text-emerald-600 flex items-center gap-2">
        <CheckCircle2 size={12} /> {status}
      </span>
    </div>
  );
}

function ConfigCard({ title, description, status, isError }: any) {
  return (
    <div className="p-6 bg-[#f5f2ed] rounded-3xl border border-black/5 flex items-center justify-between">
      <div>
        <h4 className="text-sm font-bold mb-1">{title}</h4>
        <p className="text-xs opacity-50">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isError ? "bg-red-500 animate-pulse" : "bg-emerald-500"}`} />
        <span className={`text-[10px] uppercase tracking-widest font-bold ${isError ? "text-red-600" : "text-emerald-600"}`}>{status}</span>
      </div>
    </div>
  );
}
