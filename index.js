const express = require('express');
const https = require('https');
const { runAutoPoster } = require('./engine');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const recentImageIds = []; 
const messageSessions = new Map(); 
const commentSessions = new Map(); 

app.get('/', (req, res) => {
    res.status(200).send("Server is awake!");
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

function downloadAudioBase64(urlStr) {
    return new Promise((resolve, reject) => {
        https.get(urlStr, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, (res2) => {
                    const chunks = [];
                    res2.on('data', (chunk) => chunks.push(chunk));
                    res2.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
                }).on('error', reject);
            } else {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
            }
        }).on('error', reject);
    });
}

function httpsPost(url, data, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                let parsedBody = body;
                try { parsedBody = JSON.parse(body); } catch(e) {}
                resolve(parsedBody);
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

app.get('/setup', async (req, res) => {
    try {
        const url = `https://graph.facebook.com/v20.0/me/subscribed_apps?access_token=${PAGE_ACCESS_TOKEN}`;
        const payload = { subscribed_fields: "messages,messaging_postbacks,feed" };
        const response = await httpsPost(url, payload);
        res.status(200).send(`<h1>✅ Setup Complete!</h1><p>Facebook API Response: ${JSON.stringify(response)}</p>`);
    } catch (e) {
        res.status(500).send(`<h1>❌ Error:</h1><p>${e.toString()}</p>`);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            if (entry.messaging) {
                const webhook_event = entry.messaging[0];
                const sender_psid = webhook_event.sender.id;

                if (webhook_event.message) {
                    let userMessage = webhook_event.message.text;
                    let audioBase64 = null;

                    if (webhook_event.message.attachments) {
                        for (const attachment of webhook_event.message.attachments) {
                            if (attachment.type === 'audio') {
                                try { audioBase64 = await downloadAudioBase64(attachment.payload.url); } catch(e) {}
                                break;
                            }
                        }
                    }

                    if (userMessage || audioBase64) {
                        try {
                            if (userMessage && userMessage.toLowerCase() === 'post now') {
                                await sendMessageToFacebook(sender_psid, "Fetching a stunning 2.5K Nature masterpiece from Google Drive/Unsplash... Please wait 15 seconds!");
                                await runAutoPoster('image');
                            } else {
                                let history = messageSessions.get(sender_psid) || [];
                                history.push(`User: ${userMessage || '[Audio Message]'}`);
                                if (history.length > 6) history.shift();

                                let aiReply = await getGeminiResponse(history.join("\n"), audioBase64);
                                let cleanReply = aiReply.replace(/\[REACT:\w+\]/g, '').trim(); 

                                history.push(`Bot: ${cleanReply}`);
                                messageSessions.set(sender_psid, history);

                                if (cleanReply) await sendMessageToFacebook(sender_psid, cleanReply);
                            }
                        } catch (e) { console.error(e); }
                    }
                }
            }

            if (entry.changes) {
                for (const change of entry.changes) {
                    if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
                        const comment_id = change.value.comment_id;
                        const message = change.value.message;
                        const sender_id = change.value.from ? change.value.from.id : null;
                        const page_id = entry.id;

                        if (sender_id && sender_id !== page_id) {
                            try {
                                console.log("💬 Received a new comment:", message);
                                
                                let history = commentSessions.get(sender_id) || [];
                                history.push(`User: ${message}`);
                                if (history.length > 4) history.shift();

                                let aiReply = await getGeminiResponse(history.join("\n"), null);
                                console.log("🤖 AI Generated Comment Reply:", aiReply);
                                
                                let reactionType = "NONE";
                                if (aiReply.includes('[REACT:LIKE]')) reactionType = "LIKE";
                                
                                let cleanReply = aiReply.replace(/\[REACT:\w+\]/g, '').trim();

                                history.push(`Bot: ${cleanReply}`);
                                commentSessions.set(sender_id, history);
                                
                                if (reactionType === "LIKE") {
                                    await likeComment(comment_id);
                                }
                                
                                if (cleanReply) {
                                    let taggedReply = `@[${sender_id}] ${cleanReply}`;
                                    await replyToComment(comment_id, taggedReply);
                                }
                            } catch (e) {
                                console.error("❌ Error generating comment reply:", e);
                            }
                        }
                    }
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// 🌟 Bot Memory / System Instructions
const systemPrompt = "You are a helpful and highly natural, human-like AI assistant for 'The Great Education Hub', an educational consultancy helping students study in top UK universities (providing admission support, scholarships, and Tier 4 visa guidance). Follow these LANGUAGE RULES strictly: 1. If the user's first message is 'Hi' or 'Hello', reply in English. 2. If the user writes in English, reply in English. 3. If the user writes in Bengali script, reply in modern, natural, and conversational Bengali. Do NOT sound robotic. Talk like a friendly human consultant. 4. If the user writes in Banglish (Bengali words written in English letters), reply in natural Bengali script. Always be polite, professional, and concise.";

// Fetch and log available models to diagnose 404 errors
if (GEMINI_API_KEY) {
    axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`)
        .then(response => {
            console.log("=========================================");
            console.log("AVAILABLE GEMINI MODELS FOR YOUR API KEY:");
            const modelNames = response.data.models.map(m => m.name);
            console.log(modelNames.join(", "));
            console.log("=========================================");
        })
        .catch(err => {
            console.error("Failed to fetch available models:", JSON.stringify(err.response?.data || err.message));
        });
}

// In-memory conversation history
const userSessions = new Map(); 

const training_text = `You are an expert educational consultant and friendly assistant for "Great Education Hub (GrEdu)", a premier education consultancy agency.
IMPORTANT RULES:
1. You should reply in the language the user uses (English or Bengali). If they speak Bengali (Bangla), reply in polite, natural Bengali.
2. Keep your replies short, natural, and highly engaging (2-3 sentences maximum).
3. Core Services: We guide students to top UK universities, provide personalized admission strategies, help with scholarships, offer Tier 4 student visa guidance, and assist with accommodation. 
4. If they ask for deep consultation, suggest they book a "Free Consultation" with our experts.
5. You are provided with the user's recent conversation history. Read the history to understand context, but ONLY output the response for the LAST user message.
6. CRITICAL: You must determine the sentiment of the user's LAST comment to decide if we should LIKE it.
If it is positive, normal, or a regular inquiry, output the tag [REACT:LIKE].
If it is negative, spam, or rude, output the tag [REACT:NONE].
You MUST format your entire response exactly like this:
[REACT:LIKE] Your reply text here
OR
[REACT:NONE] Your reply text here`;

async function getGeminiResponse(text, audioBase64) {
    if (!GEMINI_API_KEY) return "System error: API Key missing!";
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    
    let partsArray = [];
    if (text) partsArray.push({ text: text });
    else if (audioBase64) partsArray.push({ text: "The user sent an audio message." });

    if (audioBase64) {
        partsArray.push({ inlineData: { mimeType: "audio/mp4", data: audioBase64 } });
    }

    const payload = {
        systemInstruction: { parts: [{ text: training_text }] },
        contents: [{ parts: partsArray }]
    };

    try {
        const data = await httpsPost(url, payload);
        if (data.candidates && data.candidates.length > 0) {
            return data.candidates[0].content.parts[0].text;
        }
        return "[REACT:LIKE] I am unable to answer right now, please try again later.";
    } catch (error) {
        return "[REACT:LIKE] Sorry, we are facing some technical issues.";
    }
}

async function sendMessageToFacebook(sender_psid, text) {
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const payload = { recipient: { id: sender_psid }, message: { text: text } };
    await httpsPost(url, payload);
}

// 🌟 Facebook Graph API - Like Comment
async function likeComment(comment_id) {
    const url = `https://graph.facebook.com/v20.0/${comment_id}/likes?access_token=${PAGE_ACCESS_TOKEN}`;
    try { 
        const res = await httpsPost(url, {}); 
        if (res.error) console.error("❌ Comment Like API Error:", res.error);
        else console.log(`✅ Liked comment ${comment_id}`);
    } catch (e) {
        console.error("❌ Comment Like Catch Error:", e);
    }
}

async function replyToComment(comment_id, text) {
    const url = `https://graph.facebook.com/v20.0/${comment_id}/comments?access_token=${PAGE_ACCESS_TOKEN}`;
    const payload = { message: text };
    try { 
        const res = await httpsPost(url, payload); 
        if (res.error) console.error("❌ Comment Reply API Error:", res.error);
        else console.log("✅ Comment Reply Success");
    } catch (e) {
        console.error("❌ Comment Reply Catch Error:", e);
    }
}

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// ==========================================
// ⏰ Auto-Posting Schedule (USA/Europe Targeted)
// Target: UTC 1, 13, 19 
// UTC 13:00 = 9:00 AM EST (US Morning) -> Video
// UTC 19:00 = 3:00 PM EST (US Afternoon) -> Image
// UTC 01:00 = 9:00 PM EST (US Night) -> Image
// ==========================================
const targetHoursUTC = [1, 13, 19];

setInterval(async () => {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    
    if (targetHoursUTC.includes(currentHour) && currentMinute === 0) {
        console.log(`⏰ Target Time (${currentHour}:00 UTC) reached! Running Auto-Poster...`);
        const type = (currentHour === 13) ? 'video' : 'image';
        await runAutoPoster(type);
    }
}, 60 * 1000);
