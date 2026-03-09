import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// We'll initialize these inside an async setup to handle the import correctly
let genAI;
let MODEL_NAME = "gemini-2.0-flash";
const sessions = new Map();

async function initializeAI() {
    // This dynamic import is the fix for the "not a constructor" error
    const { GoogleGenAI } = await import('@google/generative-ai');
    genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    console.log("AI Model Initialized");
}

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;

    try {
        if (!genAI) await initializeAI();

        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            systemInstruction: "You are a professional receptionist. Be warm and concise. No markdown.",
        });

        const chat = model.startChat();
        sessions.set(callSid, chat);

        const result = await chat.sendMessage("Greet the caller and ask how you can help.");
        twiml.say(result.response.text());
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 5,
            enhanced: true
        });
    } catch (error) {
        console.error("Voice Error:", error);
        twiml.say("We are experiencing technical difficulties. Please try again later.");
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
            twiml.say("I didn't catch that. Could you repeat it?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        twiml.hangup();
        sessions.delete(callSid);
    }
    res.type('text/xml').send(twiml.toString());
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server listening on port ${PORT}`);
    try {
        await initializeAI();
    } catch (err) {
        console.error("Failed to initialize AI on startup:", err);
    }
});
