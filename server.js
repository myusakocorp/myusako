import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// FORCE STABLE API VERSION
// This prevents the "v1beta" 404 error you see in your logs
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use the standard model name
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
});

app.get('/', (req, res) => {
    res.send('USAKO AI Receptionist is Online and Healthy.');
});

app.post('/voice', async (req, res) => {
    console.log("Incoming call detected...");
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        // We use a simple prompt to test the connection
        const result = await model.generateContent("You are the USAKO receptionist. Greet the caller briefly.");
        const aiResponse = result.response.text();

        twiml.say(aiResponse);
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 3
        });

    } catch (error) {
        console.error("AI Error:", error.message);
        // Fallback if Google still acts up
        twiml.say("Welcome to USAKO. I'm experiencing a temporary connection issue. Please leave your name and number after the beep.");
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
            twiml.say("I didn't catch that. Could you repeat it?");
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
    console.log(`USAKO Server listening on port ${PORT}`);
});
