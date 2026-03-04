import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Gemini 2.0 - The new 2026 stable standard
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use 'gemini-2.0-flash' to avoid the 404 error from retired 1.5 models
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.get('/', (req, res) => {
    res.send('USAKO AI Receptionist is Online.');
});

app.post('/voice', async (req, res) => {
    console.log("Incoming call detected...");
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        const prompt = "You are the professional AI receptionist for USAKO. Greet the caller warmly and ask how you can help. Keep it very brief.";
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        twiml.say(aiResponse);
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 3
        });

    } catch (error) {
        console.error("AI Brain Error:", error.message);
        twiml.say("Welcome to USAKO. I'm having a connection issue. Please leave your name and number.");
        twiml.record({ maxLength: 20 });
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/respond', async (req, res) => {
    const userSpeech = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        if (userSpeech) {
            const result = await model.generateContent(userSpeech);
            twiml.say(result.response.text());
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
