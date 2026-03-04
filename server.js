import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 1. HEALTH CHECK (What you see in the browser)
app.get('/', (req, res) => {
    res.send('USAKO AI Receptionist is Online and Healthy.');
});

// 2. VOICE WEBHOOK (What Twilio hits when someone calls)
// Changed to .post to fix your 404 error
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        const prompt = "You are the USAKO AI receptionist. Greet the caller warmly and ask how you can help them today.";
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // Tell Twilio to speak the AI's response
        twiml.say(aiResponse);
        
        // Keep the line open for the user to respond
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 3
        });

    } catch (error) {
        console.error("AI Error:", error);
        twiml.say("I'm sorry, I'm having trouble connecting to my brain right now. Please hold.");
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// 3. RESPONSE HANDLER (What happens after the user speaks)
app.post('/respond', async (req, res) => {
    const userSpeech = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();

    if (userSpeech) {
        const result = await model.generateContent(userSpeech);
        twiml.say(result.response.text());
        twiml.gather({ input: 'speech', action: '/respond' });
    } else {
        twiml.say("I didn't catch that. Could you repeat it?");
        twiml.gather({ input: 'speech', action: '/respond' });
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`USAKO Server listening on port ${PORT}`);
});
