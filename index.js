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
                                let cleanReply = aiReply.replace(/\[REACT:\w+\]/g, '')
                                                        .replace(/\[ACTION:\w+\]/g, '')
                                                        .replace(/\[PUBLIC\]/g, '')
                                                        .replace(/\[PRIVATE\]/g, '')
                                                        .trim(); 

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

                        console.log(`💬 Received a new comment: "${message}" from sender: ${sender_id}`);

                        if (sender_id && sender_id !== page_id) {
                            try {
                                
                                let history = commentSessions.get(sender_id) || [];
                                history.push(`User: ${message}`);
                                if (history.length > 4) history.shift();

                                let aiReply = await getGeminiResponse(history.join("\n"), null);
                                console.log("🤖 AI Generated Comment Reply:", aiReply);
                                
                                let reactionType = "NONE";
                                if (aiReply.includes('[REACT:LIKE]')) reactionType = "LIKE";
                                
                                let actionType = "PUBLIC";
                                if (aiReply.includes('[ACTION:PRIVATE]')) actionType = "PRIVATE";

                                if (reactionType === "LIKE") {
                                    await likeComment(comment_id);
                                }
                                
                                if (actionType === "PRIVATE") {
                                    let publicText = "Thank you! We have sent a message to your inbox.";
                                    let privateText = "Hello! Regarding your comment...";
                                    
                                    const pubMatch = aiReply.match(/\[PUBLIC\]([\s\S]*?)\[PRIVATE\]/);
                                    if (pubMatch) publicText = pubMatch[1].trim();
                                    
                                    const privMatch = aiReply.match(/\[PRIVATE\]([\s\S]*)/);
                                    if (privMatch) privateText = privMatch[1].trim();
                                    
                                    // Reply publicly and privately
                                    await replyToComment(comment_id, publicText);
                                    await sendPrivateReply(comment_id, privateText);
                                } else {
                                    // Just public reply
                                    let cleanReply = aiReply.replace(/\[REACT:\w+\]/g, '').replace(/\[ACTION:\w+\]/g, '').trim();
                                    await replyToComment(comment_id, cleanReply);
                                }

                                history.push(`Bot: Replied to comment`);
                                commentSessions.set(sender_id, history);
                                
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
const training_text = `You are an expert educational consultant and friendly assistant for "Great Education Hub (GrEdu)", a premier education consultancy agency.
IMPORTANT RULES:
1. LANGUAGE RULES: If the user writes in English, reply in English. If they write in Bengali script, reply in Bengali script. CRITICAL: If they write in "Banglish" (Bengali words using English letters, e.g., "kon deshe ache", "ki koro"), you MUST reply in proper Bengali script (বাংলা অক্ষর). Do NOT reply in English or Banglish.
2. Keep your replies short, natural, and highly engaging.
3. Core Services: We guide students to top UK universities, provide personalized admission strategies, help with scholarships, offer Tier 4 student visa guidance, and assist with accommodation. 
4. Contact/Consultation Link: ALWAYS provide this link (https://gredu.co.uk/contact/) if a user asks for contact info, location, booking a consultation, applying, or showing strong interest.
5. CRITICAL ACTION DECISION: You must decide whether to reply to a comment PUBLICLY or PRIVATELY.
- If it's a generic question (e.g., "What are your services?", "How to contact you?"), output [ACTION:PUBLIC].
- If it's a personal/consultancy question (e.g., "I have 3.5 GPA, can I apply?", "Need help with visa"), output [ACTION:PRIVATE].
6. You MUST determine the sentiment of the user's comment. If positive/normal, output [REACT:LIKE]. If rude/spam, output [REACT:NONE].
7. FORMAT YOUR RESPONSE EXACTLY LIKE ONE OF THESE EXAMPLES:

Example 1 (Public Reply):
[REACT:LIKE]
[ACTION:PUBLIC]
Thank you for reaching out! You can find more information or contact us here: https://gredu.co.uk/contact/

Example 2 (Private Reply):
[REACT:LIKE]
[ACTION:PRIVATE]
[PUBLIC] Thank you for your interest! We have sent a detailed message to your inbox.
[PRIVATE] Hello! Regarding your query, yes you can apply with a 3.5 GPA. You can also book a consultation here: https://gredu.co.uk/contact/`;

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

async function sendPrivateReply(comment_id, text) {
    const url = `https://graph.facebook.com/v20.0/${comment_id}/private_replies?access_token=${PAGE_ACCESS_TOKEN}`;
    const payload = { message: { text: text } };
    try { 
        const res = await httpsPost(url, payload); 
        if (res.error) console.error("❌ Private Reply API Error:", res.error);
        else console.log("✅ Private Reply Sent Successfully!");
    } catch (e) {
        console.error("❌ Private Reply Catch Error:", e);
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
