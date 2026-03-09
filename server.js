import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import twilio from 'twilio';
import { createRequire } from 'module';

// Standard ESM fix for libraries that struggle with named exports
const require = createRequire(import.meta.url);
const { GoogleGenAI } = require('@google/generative-ai');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize the SDK using the required class
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.0-flash";

const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    const model = genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: "You are the professional AI receptionist for USAKO. Be warm, concise, and helpful. No markdown or bolding.",
    });

    const chat = model.startChat();
    sessions.set(callSid, chat);

    try {
        const result = await chat.sendMessage("Greet the caller and ask how you can help.");
        twiml.say(result.response.text());
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 5,
            enhanced: true
        });
    } catch (error) {
        console.error("AI Error:", error);
        twiml.say("Welcome to USAKO. We are having technical difficulties. Please leave a message.");
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
            const result = await chat.sendMessage(userSpeech);
            const responseText = result.response.text().replace(/[*_#]/g, ''); 
            twiml.say(responseText);
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            twiml.say("I'm sorry, I didn't catch that. Could you repeat it?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        console.error("Response Error:", error);
        twiml.hangup();
        sessions.delete(callSid);
    }

    res.type('text/xml').send(twiml.toString());
});

app.post('/status', (req, res) => {
    if (req.body.CallStatus === 'completed') {
        sessions.delete(req.body.CallSid);
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`USAKO Server active on port ${PORT}`);
});
