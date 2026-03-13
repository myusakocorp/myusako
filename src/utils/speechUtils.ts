// Browser SpeechSynthesis TTS utility — no external API keys needed
interface VoiceConfig {
  gender: 'female' | 'male';
  pitch: number;
  rate: number;
  preferredVoices: string[]; // Preferred voice name patterns (first match wins)
}

// Distinct voice profiles per agent persona
const AGENT_VOICES: Record<string, VoiceConfig> = {
  menu:      { gender: 'female', pitch: 1.0,  rate: 0.92, preferredVoices: ['Samantha', 'Karen', 'Zira'] },
  harmony:   { gender: 'female', pitch: 1.02, rate: 0.85, preferredVoices: ['Samantha', 'Karen', 'Zira'] },       // warm and concerned — low rate for empathy, soft pitch
  river:     { gender: 'male',   pitch: 0.78, rate: 0.91, preferredVoices: ['Daniel', 'David', 'James', 'Guy'] }, // male, professional and welcoming — deep pitch
  hope:      { gender: 'female', pitch: 1.06, rate: 0.82, preferredVoices: ['Moira', 'Fiona', 'Tessa'] },         // hopeful and clear, southern twang — slower drawl, different voice
  joy:       { gender: 'female', pitch: 1.20, rate: 0.96, preferredVoices: ['Victoria', 'Tessa', 'Susan'] },      // joyful, bright, down to earth — highest pitch, upbeat rate
  operator:  { gender: 'female', pitch: 1.0,  rate: 0.92, preferredVoices: ['Samantha', 'Karen', 'Zira'] },
  directory: { gender: 'female', pitch: 1.0,  rate: 0.95, preferredVoices: ['Samantha', 'Karen', 'Zira'] },
};

let cachedVoices: SpeechSynthesisVoice[] = [];

function loadVoices(): SpeechSynthesisVoice[] {
  if (cachedVoices.length > 0) return cachedVoices;
  cachedVoices = window.speechSynthesis.getVoices();
  return cachedVoices;
}

// Ensure voices are loaded (they load asynchronously in some browsers)
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
  // Trigger initial load
  loadVoices();
}

function pickVoice(config: VoiceConfig): SpeechSynthesisVoice | null {
  const voices = loadVoices();
  if (voices.length === 0) return null;

  const enVoices = voices.filter(v => v.lang.startsWith('en'));

  // First: try agent-specific preferred voices (gives each agent a distinct sound)
  for (const pat of config.preferredVoices) {
    const match = enVoices.find(v => v.name.includes(pat));
    if (match) return match;
  }

  // Second: fall back to gender-based selection
  if (config.gender === 'male') {
    const malePatterns = ['David', 'James', 'Daniel', 'Mark', 'Guy', 'Male', 'Aaron', 'Reed'];
    for (const pat of malePatterns) {
      const match = enVoices.find(v => v.name.includes(pat));
      if (match) return match;
    }
    const femalePatterns = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Susan', 'Female', 'Fiona', 'Moira'];
    const nonFemale = enVoices.find(v => !femalePatterns.some(fp => v.name.includes(fp)));
    if (nonFemale) return nonFemale;
  } else {
    const femalePatterns = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Susan', 'Female', 'Fiona', 'Moira', 'Tessa'];
    for (const pat of femalePatterns) {
      const match = enVoices.find(v => v.name.includes(pat));
      if (match) return match;
    }
  }

  // Ultimate fallback: any English voice
  return enVoices[0] || voices[0] || null;
}

export function speakText(text: string, agent: string = 'menu'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('SpeechSynthesis not supported'));
      return;
    }

    // Stop any current speech
    window.speechSynthesis.cancel();

    // Phonetic replacements for natural pronunciation
    const phoneticText = text
      .replace(/Kinder/gi, 'Kinnder')
      .replace(/USAKO/g, 'U S A K O')
      .replace(/usako/gi, 'U S A K O');

    const utterance = new SpeechSynthesisUtterance(phoneticText);
    const config = AGENT_VOICES[agent] || AGENT_VOICES.menu;

    const voice = pickVoice(config);
    if (voice) utterance.voice = voice;

    utterance.pitch = config.pitch;
    utterance.rate = config.rate;
    utterance.lang = 'en-US';

    utterance.onend = () => resolve();
    utterance.onerror = (e) => {
      // Cancelled is not a real error
      if (e.error === 'canceled' || e.error === 'interrupted') {
        resolve();
      } else {
        reject(e);
      }
    };

    // Chrome bug workaround: long text can pause mid-speech
    // Keep speech alive with a periodic resume
    const keepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      } else {
        clearInterval(keepAlive);
      }
    }, 10000);

    utterance.addEventListener('end', () => clearInterval(keepAlive));

    window.speechSynthesis.speak(utterance);
  });
}

export function stopSpeech(): void {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export function testAudio(): Promise<void> {
  return speakText(
    'Audio system test successful. You can hear me clearly. The United Solutions Assisting Kinnder Ones phone system is ready.',
    'menu'
  );
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
