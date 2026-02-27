/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Phone, 
  User, 
  Heart, 
  Settings, 
  Info, 
  MessageSquare, 
  Send, 
  ArrowLeft,
  Clock,
  MapPin,
  Globe,
  CheckCircle2,
  Volume2,
  PlayCircle,
  Mic,
  MicOff
} from 'lucide-react';
import { INITIAL_MENU, AGENT_PROMPTS } from './constants/prompts';
import { getChatResponse, generateAudio } from './services/geminiService';
import { addWavHeader } from './utils/audioUtils';

type Message = {
  role: 'user' | 'model';
  text: string;
  agent?: string;
};

type AgentKey = keyof typeof AGENT_PROMPTS;

const AGENT_VOICES: Record<string, 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr'> = {
  HARMONY: 'Kore',
  RIVER: 'Zephyr',
  HOPE: 'Fenrir',
  JOY: 'Puck',
  OPERATOR: 'Kore',
  System: 'Kore'
};

// Speech Recognition setup
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

if (recognition) {
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'simulator' | 'leads'>('home');
  const [currentAgent, setCurrentAgent] = useState<AgentKey | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [leads, setLeads] = useState<any[]>([]);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (!recognition) return;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInputValue(transcript);
      // Auto-submit after a short delay to feel like a real call
      setTimeout(() => {
        const submitBtn = document.getElementById('submit-btn');
        submitBtn?.click();
      }, 500);
    };
    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };
  }, []);

  const toggleListening = () => {
    if (isListening) {
      recognition?.stop();
    } else {
      try {
        recognition?.start();
      } catch (e) {
        console.error("Failed to start recognition:", e);
      }
    }
  };

  const playText = async (text: string, agent: string) => {
    setIsAudioLoading(true);
    try {
      const voice = AGENT_VOICES[agent] || 'Kore';
      // Phonetic replacement for better pronunciation
      const phoneticText = text.replace(/Kinder/gi, 'Kind-er');
      const base64 = await generateAudio(phoneticText, voice);
      if (base64) {
        const wavBase64 = addWavHeader(base64);
        const audioUrl = `data:audio/wav;base64,${wavBase64}`;
        
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = audioUrl;
          audioRef.current.load();
          await audioRef.current.play();
        } else {
          const audio = new Audio(audioUrl);
          audioRef.current = audio;
          await audio.play();
        }
      }
    } catch (error) {
      console.error("Audio generation or playback error:", error);
    } finally {
      setIsAudioLoading(false);
    }
  };

  const testAudio = () => {
    playText("Hello, this is a test of the USAKO virtual receptionist audio system. If you can hear this, your sound is working correctly.", "System");
  };

  const startCall = async () => {
    setActiveTab('simulator');
    setCurrentAgent(null);
    const initialMsg: Message = {
      role: 'model',
      text: INITIAL_MENU,
      agent: 'System'
    };
    setMessages([initialMsg]);
    // Small delay to ensure UI is ready
    setTimeout(() => playText(INITIAL_MENU, 'System'), 500);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim()) return;

    const userText = inputValue.trim();
    setInputValue('');
    
    const newUserMessage: Message = { role: 'user', text: userText };
    setMessages(prev => [...prev, newUserMessage]);

    // Simple menu routing logic
    if (currentAgent === null) {
      let nextAgent: AgentKey | null = null;
      let responseText = "";
      
      const option = userText.toLowerCase();
      
      const isOne = option.includes('1') || option.includes('one') || option.includes('directory');
      const isTwo = option.includes('2') || option.includes('two') || option.includes('client');
      const isThree = option.includes('3') || option.includes('three') || option.includes('donate') || option.includes('donation');
      const isFour = option.includes('4') || option.includes('four') || option.includes('operation');
      const isFive = option.includes('5') || option.includes('five') || option.includes('information') || option.includes('info');
      const isZero = option.includes('0') || option.includes('zero') || option.includes('operator');

      if (isOne) {
        nextAgent = 'OPERATOR';
        responseText = "You’ve reached the company directory. If you know the name of the person or department you’d like to reach, please enter their extension now. If you need help, press 0 to speak with the operator.";
      } else if (isTwo) {
        nextAgent = 'HARMONY';
        responseText = "Thank you for calling United Solutions Assisting Kinder Ones. My name is Harmony. Are you calling about the Relief Rover – R.E.A., Rapid Emergency Assistance today?";
      } else if (isThree) {
        nextAgent = 'RIVER';
        responseText = "Thank you for calling United Solutions Assisting Kinder Ones. My name is River. It sounds like you’re interested in making a donation or getting information about donations, is that right?";
      } else if (isFour) {
        nextAgent = 'HOPE';
        responseText = "Thank you for calling United Solutions Assisting Kinder Ones. My name is Hope, and you’ve reached the Operations Team. How can I help you today?";
      } else if (isFive) {
        nextAgent = 'JOY';
        responseText = "Thank you for calling United Solutions Assisting Kinder Ones. My name is Joy. How can I help you today?";
      } else if (isZero) {
        nextAgent = 'OPERATOR';
        responseText = "Hello, this is the operator. How can I assist you today?";
      }

      if (nextAgent) {
        setCurrentAgent(nextAgent);
        addAgentMessage(responseText, nextAgent);
        playText(responseText, nextAgent);
      } else {
        const errorText = "I'm sorry, I didn't quite catch that. Please press or say a number from 0 to 5.";
        addAgentMessage(errorText, 'System');
        playText(errorText, 'System');
      }
      return;
    }

    // Agent conversation logic using Gemini
    setIsTyping(true);
    try {
      const history = messages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));
      history.push({ role: 'user', parts: [{ text: userText }] });

      const response = await getChatResponse(AGENT_PROMPTS[currentAgent], history);
      
      // Check if response contains lead info (simulated)
      if (response.toLowerCase().includes('follow up') || response.toLowerCase().includes('shared your information')) {
        setLeads(prev => [...prev, {
          id: Date.now(),
          agent: currentAgent,
          timestamp: new Date().toLocaleString(),
          summary: "Contact request captured during call."
        }]);
      }

      setMessages(prev => [...prev, { role: 'model', text: response, agent: currentAgent }]);
      playText(response, currentAgent);
    } catch (error) {
      console.error(error);
      const errorText = "I'm sorry, I'm having trouble processing that. Can you repeat it?";
      addAgentMessage(errorText, currentAgent);
      playText(errorText, currentAgent);
    } finally {
      setIsTyping(false);
    }
  };

  const addAgentMessage = (text: string, agent: string) => {
    setMessages(prev => [...prev, { role: 'model', text, agent }]);
  };

  const resetCall = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setCurrentAgent(null);
    setMessages([{
      role: 'model',
      text: INITIAL_MENU,
      agent: 'System'
    }]);
    playText(INITIAL_MENU, 'System');
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="bg-white border-b border-black/5 px-6 py-4 flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-olive rounded-full flex items-center justify-center text-white">
            <Heart size={20} />
          </div>
          <div>
            <h1 className="text-xl font-serif font-bold leading-tight">USAKO</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-60">Virtual Receptionist</p>
          </div>
        </div>
        <div className="flex gap-6">
          <button 
            onClick={() => setActiveTab('home')}
            className={`text-sm font-medium transition-colors ${activeTab === 'home' ? 'text-brand-olive' : 'text-brand-ink/40 hover:text-brand-ink'}`}
          >
            Mission
          </button>
          <button 
            onClick={() => setActiveTab('simulator')}
            className={`text-sm font-medium transition-colors ${activeTab === 'simulator' ? 'text-brand-olive' : 'text-brand-ink/40 hover:text-brand-ink'}`}
          >
            Simulator
          </button>
          <button 
            onClick={() => setActiveTab('leads')}
            className={`text-sm font-medium transition-colors ${activeTab === 'leads' ? 'text-brand-olive' : 'text-brand-ink/40 hover:text-brand-ink'}`}
          >
            Leads
          </button>
        </div>
      </nav>

      <main className="flex-1 max-w-5xl mx-auto w-full p-6">
        <AnimatePresence mode="wait">
          {activeTab === 'home' && (
            <motion.div 
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-12 py-12"
            >
              <div className="max-w-2xl">
                <h2 className="text-5xl font-serif mb-6 leading-tight">
                  Meeting people right where they are, <span className="italic">right now.</span>
                </h2>
                <p className="text-lg text-brand-ink/70 leading-relaxed mb-8">
                  United Solutions Assisting Kinder Ones (USAKO) provides immediate, person-centered support to our unhoused neighbors by delivering essential resources directly to the streets.
                </p>
                <div className="flex flex-col sm:flex-row gap-4">
                  <button 
                    onClick={startCall}
                    className="bg-brand-olive text-white px-8 py-4 rounded-full font-medium flex items-center justify-center gap-3 hover:bg-opacity-90 transition-all shadow-lg hover:shadow-xl"
                  >
                    <Phone size={20} />
                    Start IVR Simulation
                  </button>
                  <button 
                    onClick={testAudio}
                    disabled={isAudioLoading}
                    className="bg-white text-brand-olive border border-brand-olive/20 px-8 py-4 rounded-full font-medium flex items-center justify-center gap-3 hover:bg-brand-cream transition-all shadow-sm disabled:opacity-50"
                  >
                    <Volume2 size={20} className={isAudioLoading ? 'animate-pulse' : ''} />
                    {isAudioLoading ? 'Loading Audio...' : 'Test Audio System'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5">
                  <div className="w-12 h-12 bg-brand-cream rounded-2xl flex items-center justify-center text-brand-olive mb-6">
                    <Clock size={24} />
                  </div>
                  <h3 className="text-xl font-serif mb-3">Live Support</h3>
                  <p className="text-sm text-brand-ink/60">Monday–Friday, 8:00 AM to 5:00 PM PST. Automated support available 24/7.</p>
                </div>
                <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5">
                  <div className="w-12 h-12 bg-brand-cream rounded-2xl flex items-center justify-center text-brand-olive mb-6">
                    <MapPin size={24} />
                  </div>
                  <h3 className="text-xl font-serif mb-3">Location</h3>
                  <p className="text-sm text-brand-ink/60">3600 Watt Ave, Suite 101, Sacramento, CA 95816. Serving the local community.</p>
                </div>
                <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5">
                  <div className="w-12 h-12 bg-brand-cream rounded-2xl flex items-center justify-center text-brand-olive mb-6">
                    <Globe size={24} />
                  </div>
                  <h3 className="text-xl font-serif mb-3">Resources</h3>
                  <p className="text-sm text-brand-ink/60">Connected with 211 services for housing, food, and health referrals.</p>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'simulator' && (
            <motion.div 
              key="simulator"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="h-[calc(100vh-180px)] flex flex-col bg-white rounded-[32px] shadow-xl border border-black/5 overflow-hidden"
            >
              {/* Simulator Header */}
              <div className="bg-brand-olive text-white p-6 flex justify-between items-center">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
                    {currentAgent ? <User size={24} /> : <Phone size={24} />}
                  </div>
                  <div>
                    <h3 className="font-serif text-lg">{currentAgent ? `Agent: ${currentAgent}` : 'Main Menu'}</h3>
                    <p className="text-xs opacity-70">Active Call Session</p>
                  </div>
                </div>
                <button 
                  onClick={resetCall}
                  className="text-xs uppercase tracking-widest bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full transition-colors"
                >
                  Reset Call
                </button>
              </div>

              {/* Chat Area */}
              <div 
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-6 space-y-4 bg-brand-cream/30"
              >
                {messages.map((msg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-agent'}>
                        <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                      </div>
                      {msg.role === 'model' && (
                        <button 
                          onClick={() => playText(msg.text, msg.agent || 'System')}
                          className="p-2 text-brand-olive/40 hover:text-brand-olive transition-colors"
                          title="Replay Audio"
                        >
                          <PlayCircle size={18} />
                        </button>
                      )}
                    </div>
                    {msg.agent && (
                      <span className="text-[10px] uppercase tracking-tighter opacity-40 mt-1 px-2">
                        {msg.agent}
                      </span>
                    )}
                  </motion.div>
                ))}
                {isTyping && (
                  <div className="flex gap-1 p-2">
                    <div className="w-1.5 h-1.5 bg-brand-olive/40 rounded-full animate-bounce" />
                    <div className="w-1.5 h-1.5 bg-brand-olive/40 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="w-1.5 h-1.5 bg-brand-olive/40 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                )}
              </div>

              {/* Input Area */}
              <form 
                onSubmit={handleSendMessage}
                className="p-6 bg-white border-t border-black/5 flex gap-4"
              >
                <button
                  type="button"
                  onClick={toggleListening}
                  className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${
                    isListening 
                      ? 'bg-red-500 text-white animate-pulse' 
                      : 'bg-brand-cream text-brand-olive hover:bg-brand-olive/10'
                  }`}
                  title={isListening ? 'Stop Listening' : 'Speak Response'}
                >
                  {isListening ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
                <input 
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={isListening ? "Listening..." : "Type your response or speak..."}
                  className="flex-1 bg-brand-cream/50 border-none rounded-2xl px-6 py-4 text-sm focus:ring-2 focus:ring-brand-olive/20 outline-none"
                />
                <button 
                  id="submit-btn"
                  type="submit"
                  disabled={!inputValue.trim() || isTyping}
                  className="w-14 h-14 bg-brand-olive text-white rounded-2xl flex items-center justify-center hover:bg-opacity-90 transition-all disabled:opacity-50"
                >
                  <Send size={20} />
                </button>
              </form>
            </motion.div>
          )}

          {activeTab === 'leads' && (
            <motion.div 
              key="leads"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-serif">Captured Leads</h2>
                  <p className="text-brand-ink/50">Simulated follow-up requests from the IVR system.</p>
                </div>
                <div className="text-xs font-mono bg-brand-olive/10 text-brand-olive px-3 py-1 rounded-full">
                  {leads.length} TOTAL
                </div>
              </div>

              {leads.length === 0 ? (
                <div className="bg-white rounded-[32px] p-12 text-center border border-dashed border-brand-ink/20">
                  <div className="w-16 h-16 bg-brand-cream rounded-full flex items-center justify-center text-brand-ink/20 mx-auto mb-4">
                    <MessageSquare size={32} />
                  </div>
                  <p className="text-brand-ink/40">No leads captured yet. Try the simulator to generate follow-up requests.</p>
                </div>
              ) : (
                <div className="grid gap-4">
                  {leads.map((lead) => (
                    <motion.div 
                      key={lead.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-white p-6 rounded-2xl shadow-sm border border-black/5 flex justify-between items-center"
                    >
                      <div className="flex gap-4 items-center">
                        <div className="w-10 h-10 bg-brand-cream rounded-full flex items-center justify-center text-brand-olive">
                          <CheckCircle2 size={20} />
                        </div>
                        <div>
                          <h4 className="font-medium text-sm">Follow-up Request</h4>
                          <p className="text-xs text-brand-ink/50">Agent: {lead.agent} • {lead.timestamp}</p>
                        </div>
                      </div>
                      <div className="text-xs font-medium text-brand-olive bg-brand-olive/5 px-4 py-2 rounded-full">
                        Sent to help@myusako.org
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-black/5 p-8 mt-12">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 opacity-40">
            <Heart size={14} />
            <span className="text-[10px] uppercase tracking-widest">United Solutions Assisting Kinder Ones</span>
          </div>
          <div className="flex gap-8 text-[10px] uppercase tracking-widest opacity-40">
            <a href="#" className="hover:text-brand-ink transition-colors">Privacy</a>
            <a href="#" className="hover:text-brand-ink transition-colors">Terms</a>
            <a href="#" className="hover:text-brand-ink transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
