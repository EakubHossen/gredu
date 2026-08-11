const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token';
const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!PAGE_ACCESS_TOKEN || !GEMINI_API_KEY) {
    console.warn("WARNING: FACEBOOK_ACCESS_TOKEN or GEMINI_API_KEY is not set.");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const systemPrompt = "You are a helpful and highly natural, human-like AI assistant for 'The Great Education Hub', an educational consultancy helping students study in top UK universities (providing admission support, scholarships, and Tier 4 visa guidance). Follow these LANGUAGE RULES strictly: 1. If the user's first message is 'Hi' or 'Hello', reply in English. 2. If the user writes in English, reply in English. 3. If the user writes in Bengali script, reply in modern, natural, and conversational Bengali. Do NOT sound robotic. Talk like a friendly human consultant. 4. If the user writes in Banglish (Bengali words written in English letters), reply in natural Bengali script. Always be polite, professional, and concise.";

const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash'
});

// In-memory conversation history
const userSessions = new Map();

app.get('/', (req, res) => {
    res.send('GrEdu Facebook AI Bot is running!');
});

// Facebook Webhook Verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Handle incoming webhook events
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            // 1. Handle Messages
            if (entry.messaging) {
                for (const webhook_event of entry.messaging) {
                    if (webhook_event.message && !webhook_event.message.is_echo) {
                        const senderId = webhook_event.sender.id;
                        const messageText = webhook_event.message.text;
                        console.log(`[Message] from ${senderId}: ${messageText}`);
                        await handleMessage(senderId, messageText);
                    }
                }
            }
            
            // 2. Handle Comments (feed)
            if (entry.changes) {
                for (const change of entry.changes) {
                    if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
                        // Ignore comments made by the page itself
                        const pageId = entry.id;
                        if (change.value.from.id !== pageId) {
                            const commentId = change.value.comment_id;
                            const commentText = change.value.message;
                            const commenterId = change.value.from.id;
                            const commenterName = change.value.from.name;
                            
                            console.log(`[Comment] from ${commenterName}: ${commentText}`);
                            await handleComment(commentId, commentText, commenterName);
                        }
                    }
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

async function getGeminiResponse(userId, text) {
    try {
        if (!userSessions.has(userId)) {
            // Inject system prompt as the first message in the history
            userSessions.set(userId, [
                { role: 'user', parts: [{ text: "SYSTEM INSTRUCTION: " + systemPrompt }] },
                { role: 'model', parts: [{ text: "Understood. I will follow these instructions strictly." }] }
            ]);
        }
        const history = userSessions.get(userId);
        
        history.push({ role: 'user', parts: [{ text: text }] });
        
        const chat = model.startChat({
            history: history
        });

        const result = await chat.sendMessage(text);
        const responseText = result.response.text();
        
        history.push({ role: 'model', parts: [{ text: responseText }] });
        
        if (history.length > 10) {
            userSessions.set(userId, history.slice(history.length - 10));
        }

        return responseText;
    } catch (error) {
        console.error('Gemini API Error:', error);
        return "Sorry, I am unable to answer right now. Please try again later.";
    }
}

async function handleMessage(senderId, text) {
    const aiResponse = await getGeminiResponse(senderId, text);
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
            recipient: { id: senderId },
            message: { text: aiResponse },
            messaging_type: "RESPONSE"
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
    } catch (error) {
        console.error('Error sending message:', error.response?.data || error.message);
    }
}

async function handleComment(commentId, text, commenterName) {
    // We send a short private reply to their inbox
    const privateReplyText = `হ্যালো ${commenterName}, আপনার কমেন্টের জন্য ধন্যবাদ! "${text}" - এই বিষয়ে আমরা আপনাকে এখানে বিস্তারিত জানাতে পারি। আপনার কোনো প্রশ্ন থাকলে করতে পারেন।`;
    
    try {
        // Send Private Reply (Comment to Inbox)
        await axios.post(`https://graph.facebook.com/v19.0/${commentId}/private_replies`, {
            message: privateReplyText
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
        console.log('Private reply sent to commenter.');
        
        // Also reply to the comment publicly
        const publicReplyText = `ধন্যবাদ! আমরা আপনার ইনবক্সে একটি মেসেজ পাঠিয়েছি। দয়া করে চেক করুন।`;
        await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
            message: publicReplyText
        }, {
            params: { access_token: PAGE_ACCESS_TOKEN }
        });
        console.log('Public comment reply sent.');

    } catch (error) {
        console.error('Error handling comment:', error.response?.data || error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
