import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import twilio from 'twilio';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const GoogleGenerativeAI = require('@google/generative-ai');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/**
 * THE ULTIMATE FIX FOR NODE V22:
 * We bypass all variable naming conflicts by calling the property directly.
 */
const genAI = new GoogleGenerativeAI.GoogleGenAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-1.5-flash"; 

const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    try {
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            systemInstruction: "You are a professional receptionist for USAKO. Be warm and concise. Speak naturally. Do not use markdown, bolding, or asterisks.",
        });

        const chat = model.startChat();
        sessions.set(callSid, chat);

        const result = await chat.sendMessage("Greet the caller briefly and ask how you can help.");
        const responseText = result.response.text().replace(/[*_#]/g, '');
        
        twiml.say(responseText);
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 5,
            enhanced: true
        });
    } catch (error) {
        console.error("AI Error:", error);
        twiml.say("Welcome to USAKO. We are currently experiencing heavy call volume. Please leave a message after the tone.");
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
        console.error("Chat Error:", error);
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
