import express from 'express';
import bodyParser from 'body-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();
// Twilio sends data as URL-encoded forms
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Gemini with the API Key from your Render Environment Variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// We specify the model here. "gemini-1.5-flash" is the current standard.
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 1. WEB HEALTH CHECK
// This confirms the server is awake when you visit the URL in a browser
app.get('/', (req, res) => {
    res.send('USAKO AI Receptionist is Online and Healthy.');
});

// 2. VOICE WEBHOOK (The "Front Door" for your Phone Number)
// This must be app.post to match Twilio's default setting
app.post('/voice', async (req, res) => {
    console.log("Incoming call detected...");
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        // The initial prompt to set the AI's personality
        const prompt = "You are the professional AI receptionist for USAKO. Greet the caller warmly, state that they have reached USAKO, and ask how you can assist them today.";
        
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // Twilio speaks the AI-generated text
        twiml.say(aiResponse);
        
        // Listen for the caller's response
        twiml.gather({
            input: 'speech',
            action: '/respond', // Send the caller's words to this route
            timeout: 3,
            enhanced: true
        });

    } catch (error) {
        console.error("AI Error:", error);
        twiml.say("Thank you for calling USAKO. I am having a moment of technical difficulty, but please tell me your name and why you are calling, and a human will get back to you.");
        twiml.record({ maxLength: 30 });
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// 3. RESPONSE HANDLER (Processes what the caller says)
app.post('/respond', async (req, res) => {
    const userSpeech = req.body.SpeechResult;
    console.log("Caller said:", userSpeech);
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        if (userSpeech) {
            const result = await model.generateContent(userSpeech);
            const aiReply = result.response.text();
            
            twiml.say(aiReply);
            // Continue the conversation
            twiml.gather({ input: 'speech', action: '/respond' });
        } else {
            twiml.say("I'm sorry, I didn't catch that. Could you say that again?");
            twiml.gather({ input: 'speech', action: '/respond' });
        }
    } catch (error) {
        console.error("Response Route AI Error:", error);
        twiml.say("I'm sorry, I lost my connection. Please try again later.");
        twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`USAKO Server listening on port ${PORT}`);
});
