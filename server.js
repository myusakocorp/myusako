import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenAI } from "@google/genai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize the 2026 SDK and the stable Flash model
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = "gemini-2.5-flash";

// Simple in-memory store for conversation history (Use Redis for production)
const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    // Initialize a fresh chat session for this caller
    const chat = ai.models.startChat({
        model: MODEL_NAME,
        systemInstruction: "You are the professional AI receptionist for USAKO. Be warm, concise, and helpful. Do not use bolding or markdown in your speech.",
    });
    
    sessions.set(callSid, chat);

    try {
        const result = await chat.sendMessage("Greet the caller and ask how you can help.");
        
        twiml.say(result.text);
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 5,
            enhanced: true // Uses higher quality speech-to-text
        });

    } catch (error) {
        console.error("AI Error:", error);
        twiml.say("Welcome to USAKO. We're having technical difficulties. Please leave a message.");
        twiml.record({ maxLength: 30 });
    }

    res.type('text/xml').send(twiml.toString());
});

app.post('/respond', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult;
    const chat = sessions.get(callSid);

    try {
        if (userSpeech && chat) {
            // sendMessage maintains the history automatically
            const result = await chat.sendMessage(userSpeech);
            twiml.say(result.text);
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            // If they didn't say anything, prompt them again
            twiml.say("I'm sorry, I didn't catch that. Could you repeat it?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        console.error("Response Error:", error);
        twiml.hangup();
        sessions.delete(callSid); // Clean up memory
    }

    res.type('text/xml').send(twiml.toString());
});

// Cleanup session when call ends
app.post('/status', (req, res) => {
    if (req.body.CallStatus === 'completed') {
        sessions.delete(req.body.CallSid);
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`USAKO Server active on port ${PORT}`));
