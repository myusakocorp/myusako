// Browser SpeechSynthesis TTS utility — no external API keys needed
interface VoiceConfig {
  gender: 'female' | 'male';
  pitch: number;
  rate: number;
}

// Distinct voice profiles per agent persona
const AGENT_VOICES: Record<string, VoiceConfig> = {
  menu:      { gender: 'female', pitch: 1.0,  rate: 0.92 },
  harmony:   { gender: 'female', pitch: 1.08, rate: 0.88 }, // warm, concerned
  river:     { gender: 'male',   pitch: 0.85, rate: 0.94 }, // male, professional
  hope:      { gender: 'female', pitch: 1.04, rate: 0.93 }, // hopeful, clear
  joy:       { gender: 'female', pitch: 1.15, rate: 0.98 }, // joyful, bright
  operator:  { gender: 'female', pitch: 1.0,  rate: 0.92 },
  directory: { gender: 'female', pitch: 1.0,  rate: 0.95 },
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

function pickVoice(gender: 'female' | 'male'): SpeechSynthesisVoice | null {
  const voices = loadVoices();
  if (voices.length === 0) return null;

  const enVoices = voices.filter(v => v.lang.startsWith('en'));

  if (gender === 'male') {
    // Prefer known male voice names
    const malePatterns = ['David', 'James', 'Daniel', 'Mark', 'Guy', 'Male', 'Aaron', 'Reed'];
    for (const pat of malePatterns) {
      const match = enVoices.find(v => v.name.includes(pat));
      if (match) return match;
    }
    // Fallback: pick one that doesn't match common female names
    const femalePatterns = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Susan', 'Female', 'Fiona', 'Moira'];
    const nonFemale = enVoices.find(v => !femalePatterns.some(fp => v.name.includes(fp)));
    if (nonFemale) return nonFemale;
  } else {
    // Prefer known female voice names
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

    const voice = pickVoice(config.gender);
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
