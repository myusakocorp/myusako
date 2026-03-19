// Browser SpeechSynthesis TTS utility — no external API keys needed
interface VoiceConfig {
  gender: 'female' | 'male';
  pitch: number;
  rate: number;
  lang: string; // BCP-47 language tag for accent selection (e.g. 'en-IN', 'en-GB')
  preferredVoices: string[]; // Preferred voice name patterns (first match wins)
}

// Distinct voice profiles per agent persona — each agent has a unique accent
const AGENT_VOICES: Record<string, VoiceConfig> = {
  // Main menu / default — neutral American female
  menu:      { gender: 'female', pitch: 1.0,  rate: 0.92, lang: 'en-US', preferredVoices: ['Samantha', 'Google US English', 'Microsoft Zira', 'Zira'] },

  // Harmony (Client Services) — Female, warm & concerned, Indian accent
  harmony:   { gender: 'female', pitch: 1.05, rate: 0.88, lang: 'en-IN', preferredVoices: ['Google \u0939\u093F\u0928\u094D\u0926\u0940', 'Rishi', 'Veena', 'Lekha', 'en-IN', 'en_IN'] },

  // River (Donations) — Male, professional & welcoming, Jamaican accent
  // No native Jamaican voice in browsers; use en-GB male with Caribbean-esque deep pitch & relaxed rate
  river:     { gender: 'male',   pitch: 0.72, rate: 0.84, lang: 'en-GB', preferredVoices: ['Daniel', 'Google UK English Male', 'Microsoft George', 'George', 'James'] },

  // Hope (Operations) — Female, hopeful & clear, American Southern twang
  hope:      { gender: 'female', pitch: 0.95, rate: 0.78, lang: 'en-US', preferredVoices: ['Moira', 'Google US English', 'Microsoft Zira', 'Samantha'] },

  // Joy (General Info) — Female, joyful & bright, British accent
  joy:       { gender: 'female', pitch: 1.25, rate: 0.98, lang: 'en-GB', preferredVoices: ['Kate', 'Google UK English Female', 'Microsoft Hazel', 'Fiona', 'Serena', 'Martha'] },

  // Operator / Directory — neutral
  operator:  { gender: 'female', pitch: 1.0,  rate: 0.92, lang: 'en-US', preferredVoices: ['Samantha', 'Google US English', 'Microsoft Zira', 'Zira'] },
  directory: { gender: 'female', pitch: 1.0,  rate: 0.95, lang: 'en-US', preferredVoices: ['Samantha', 'Google US English', 'Microsoft Zira', 'Zira'] },
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

  // Get voices matching the agent's target locale (e.g. en-IN, en-GB, en-US)
  const localeVoices = voices.filter(v => v.lang === config.lang || v.lang.replace('_', '-') === config.lang);
  // Broader English fallback
  const enVoices = voices.filter(v => v.lang.startsWith('en'));

  // 1. Try preferred voice names within the target locale first
  for (const pat of config.preferredVoices) {
    const match = localeVoices.find(v => v.name.includes(pat));
    if (match) return match;
  }

  // 2. Try preferred voice names across all English voices
  for (const pat of config.preferredVoices) {
    const match = enVoices.find(v => v.name.includes(pat));
    if (match) return match;
  }

  // 3. Try any voice in the target locale matching gender
  if (config.gender === 'male') {
    const femalePatterns = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Susan', 'Female', 'Fiona', 'Moira', 'Tessa', 'Kate', 'Serena', 'Martha', 'Hazel'];
    const maleInLocale = localeVoices.find(v => !femalePatterns.some(fp => v.name.includes(fp)));
    if (maleInLocale) return maleInLocale;
    // Fall back to any male English voice
    const malePatterns = ['David', 'James', 'Daniel', 'Mark', 'Guy', 'Male', 'Aaron', 'Reed', 'George', 'Rishi'];
    for (const pat of malePatterns) {
      const match = enVoices.find(v => v.name.includes(pat));
      if (match) return match;
    }
  } else {
    // Try any female voice in the target locale
    if (localeVoices.length > 0) return localeVoices[0];
    // Fall back to any female English voice
    const femalePatterns = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Susan', 'Female', 'Fiona', 'Moira', 'Tessa', 'Kate', 'Serena'];
    for (const pat of femalePatterns) {
      const match = enVoices.find(v => v.name.includes(pat));
      if (match) return match;
    }
  }

  // 4. Any voice in the target locale
  if (localeVoices.length > 0) return localeVoices[0];

  // 5. Ultimate fallback: any English voice
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
    // Set the utterance lang to the agent's locale for accent hint
    utterance.lang = config.lang;

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
