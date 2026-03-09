import express from 'express';
import bodyParser from 'body-parser';
import pkg from '@google/generative-ai';
const { GoogleGenAI } = pkg;
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize the SDK
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.0-flash";

// In-memory store for chat sessions
const sessions = new Map();

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    // Initialize the model with system instructions
    const model = genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: "You are the professional AI receptionist for USAKO. Be warm, concise, and helpful. Do not use any markdown formatting, bolding, or asterisks in your speech.",
    });

    const chat = model.startChat();
    sessions.set(callSid, chat);

    try {
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
        twiml.say("Welcome to USAKO. We are currently experiencing technical difficulties, but please leave a message after the tone.");
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
            // Clean any potential markdown from the AI response
            const responseText = result.response.text().replace(/[*_#]/g, ''); 
            
            twiml.say(responseText);
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            twiml.say("I'm sorry, I didn't catch that. Could you please repeat it?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        console.error("Response Error:", error);
        twiml.hangup();
        sessions.delete(callSid);
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
app.listen(PORT, () => console.log(`USAKO AI Server active on port ${PORT}`));
