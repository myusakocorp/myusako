import express from 'express';
import bodyParser from 'body-parser';
import * as GoogleAI from '@google/generative-ai';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Robust constructor selection for Node v22 ESM
const GoogleGenAI = GoogleAI.GoogleGenAI || (GoogleAI.default && GoogleAI.default.GoogleGenAI);
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-1.5-flash"; // Using 1.5-flash for maximum stability/quota

const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    try {
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            systemInstruction: "You are a professional receptionist for USAKO. Be warm and concise. Do not use markdown or asterisks.",
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
        console.error("Voice Error:", error);
        twiml.say("Welcome to USAKO. We are currently experiencing technical difficulties, but please leave a message.");
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
