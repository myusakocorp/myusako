import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.0-flash"; // Using the stable 2.0 Flash

const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    const model = genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: "You are the professional AI receptionist for USAKO. Be warm, concise, and helpful. Do not use bolding or markdown.",
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
        twiml.say("Welcome to USAKO. We are experiencing technical difficulties.");
        twiml.hangup();
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
            twiml.say("I'm sorry, I didn't catch that.");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        twiml.hangup();
        sessions.delete(callSid);
    }
    res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
