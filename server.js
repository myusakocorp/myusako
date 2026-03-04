import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const app = express();
// Render uses process.env.PORT, default to 10000
const port = process.env.PORT || 10000;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(bodyParser.urlencoded({ extended: false }));

/**
 * Helper to fix pronunciation for the AI Voice
 */
const fixPronunciation = (text) => {
  return text.replace(/Kinder/g, 'Kind-er');
};

/**
 * Main Webhook for Twilio Calls
 */
app.post('/twilio/voice', async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  const callerSpeech = req.body.SpeechResult || '';
  const digits = req.body.Digits || '';

  // 1. SYSTEM PROMPT: The "Brain" of USAKO
  const systemPrompt = `
    You are a warm, professional virtual receptionist for "United Solutions Assisting Kinder Ones" (USAKO).
    Mission: Provide person-centered support to unhoused neighbors.
    Rules: 
    - Use simple, friendly language.
    - Be calm and non-judgmental.
    - Keep answers brief (1-2 sentences).
    - If you need to follow up, say: "I am sending your request, a team member will follow up with you soon." 
    - NEVER mention the email "help@myusako.org" to the caller.
  `;

  try {
    // Determine the "Lane" or "Persona" based on input
    let agentPersona = "General Operator";
    
    if (digits === '2' || callerSpeech.toLowerCase().includes('client')) {
      agentPersona = "Harmony (Client Services). You are very concerned and empathetic.";
    } else if (digits === '3' || callerSpeech.toLowerCase().includes('donate')) {
      agentPersona = "River (Donations). You are professional and appreciative.";
    } else if (digits === '4' || callerSpeech.toLowerCase().includes('operations')) {
      agentPersona = "Hope (Operations). You are clear and helpful.";
    } else if (digits === '5' || callerSpeech.toLowerCase().includes('information')) {
      agentPersona = "Joy (General Info). You are joyful and bright.";
    }

    let aiReply = "";

    if (!callerSpeech && !digits) {
      // INITIAL GREETING
      aiReply = "Thank you for calling United Solutions Assisting Kinder Ones – Ready To HELP, right where YOU are, right NOW. This call is recorded. For menu options: Say 1 for directory, 2 for client services, 3 for donations, 4 for operations, 5 for info, or 0 for the operator.";
    } else {
      // GENERATE AI RESPONSE
      const prompt = `${systemPrompt}\nActing as: ${agentPersona}\nCaller said: "${callerSpeech || 'Selected option ' + digits}"`;
      const result = await model.generateContent(prompt);
      aiReply = result.response.text();
    }

    // Apply the Kind-er pronunciation fix
    const vocalResponse = fixPronunciation(aiReply);

    // Speak to the caller
    twiml.say(vocalResponse);

    // Listen for the next response
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/twilio/voice',
      timeout: 3,
      speechTimeout: 'auto'
    });

  } catch (error) {
    console.error("Error:", error);
    twiml.say("I'm sorry, I'm having a technical moment. Please hold while I try to reconnect.");
    twiml.redirect('/twilio/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Health check for Render
app.get('/', (_req, res) => {
  res.send('USAKO AI Receptionist is Online and Healthy.');
});

// Start Server on 0.0.0.0 to ensure Render binding
app.listen(port, '0.0.0.0', () => {
  console.log(`USAKO Server listening on port ${port}`);

});
