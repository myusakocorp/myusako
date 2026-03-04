import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Gemini - Using the '8b' model which is the most compatible
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });

// 1. WEB HEALTH CHECK (Confirms Render is working)
app.get('/', (req, res) => {
    res.send('USAKO AI Receptionist is Online and Healthy.');
});

// 2. VOICE WEBHOOK (The "Front Door" for your Phone Number)
app.post('/voice', async (req, res) => {
    console.log("Incoming call detected...");
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        // AI Instructions
        const prompt = "You are the professional AI receptionist for USAKO. Greet the caller warmly, state that they have reached USAKO, and ask how you can assist them today. Keep your response under 20 words.";
        
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        twiml.say(aiResponse);
        
        // Listen for the caller
        twiml.gather({
            input: 'speech',
            action: '/respond',
            timeout: 3,
            enhanced: true
        });

    } catch (error) {
        console.error("AI Error:", error);
        // This is the message you heard earlier—it means the code above failed.
        twiml.say("Thank you for calling USAKO. I am having a moment of technical difficulty, but please tell me your name and why you are calling, and a human will get back to you.");
        twiml.record({ maxLength: 30 });
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// 3. RESPONSE HANDLER (Conversation Loop)
app.post('/respond', async (req, res) => {
    const userSpeech = req.body.SpeechResult;
    console.log("Caller said:", userSpeech);
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        if (userSpeech) {
            const result = await model.generateContent(`The caller said: ${userSpeech}. Respond as the USAKO receptionist.`);
            const aiReply = result.response.text();
            
            twiml.say(aiReply);
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            twiml.say("I'm sorry, I didn't catch that. Could you say that again?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        twiml.say("I'm sorry, I lost my connection. One moment please.");
        twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`USAKO Server listening on port ${PORT}`);
});
