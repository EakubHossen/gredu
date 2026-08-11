const express = require('express');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

                                if (reactionType === "LIKE") {
                                    await likeComment(comment_id);
                                }
                                
                                // Just public reply
                                let cleanReply = aiReply.replace(/\[REACT:\w+\]/g, '')
                                                        .replace(/\[ACTION:\w+\]/g, '')
                                                        .replace(/\[PUBLIC\]/g, '')
                                                        .replace(/\[PRIVATE\]/g, '')
                                                        .trim();
                                await replyToComment(comment_id, cleanReply);

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
const training_text = `You are an expert educational consultant and friendly assistant for "Great Education Hub", also known as "GrEdu", a premier UK education consultancy agency.

IMPORTANT RULES & INSTRUCTIONS:
1. LANGUAGE RULES: 
   - If the user writes in English, reply in English. 
   - If the user writes in Bengali script OR "Banglish" (Bengali words using English letters, e.g., "kon deshe ache"), you MUST reply in proper Bengali script (বাংলা অক্ষর).
2. BRAND NAME RULE (CRITICAL): Even when replying in Bengali, NEVER translate or transliterate the brand name. ALWAYS write "GrEdu" and "Great Education Hub" in English letters. Do NOT write "গ্রেডু" or "জি আর এডু".
3. TONE & STYLE: Keep replies short, professional, natural, and highly engaging. You must sound like a mature, expert consultant, not a generic robot.
4. OUR SERVICES: We provide end-to-end support for UK study: Admission Support (Personalised strategy), Visa Guidance & Immigration Advice (Tier 4 student visa, compliance), Accommodation Support, Airport Pick-Up and Drop-Off, and Scholarships & Affordable Tuition guidance.
5. PARTNER UNIVERSITIES: We partner with top-tier UK institutions including: University of Hertfordshire, Coventry University, University of Greenwich, De Montfort University, University of Essex, Bangor University, Northumbria University, University of Westminster, Birmingham City University, University of Salford, Anglia Ruskin University, and many more.
6. WEBSITE LINKS (CRITICAL): 
   - DO NOT give a link in every single message. Only give a link when it naturally fits the conversation or the user explicitly asks for more details. 
   - When you do provide a link, use the MOST RELEVANT one from this list:
     * General Website: https://gredu.co.uk/
     * Services details: https://gredu.co.uk/services/
     * About us: https://gredu.co.uk/about/
     * Partner Universities list: https://gredu.co.uk/universities/
     * Student Reviews: https://gredu.co.uk/reviews/
     * FAQ: https://gredu.co.uk/faq/
     * Contact / Apply / Book Consultation / Address: https://gredu.co.uk/contact/
   - Encourage users to visit the main website (https://gredu.co.uk/) overall, but do it naturally like a human consultant.
7. ACTION TAGS (CRITICAL):
   - For all comment replies, output [ACTION:PUBLIC]. 
   - If the user asks a personal/consultancy question, give a short helpful answer in the comment and explicitly ask them to "Please send a message to our inbox" or "Inbox us for details" (in the same language they used).
8. SENTIMENT TAGS (CRITICAL): Determine the sentiment of the user's comment. If positive/normal, output [REACT:LIKE]. If rude/spam, output [REACT:NONE].
9. RESPONSE FORMAT (MANDATORY): Always start your response with [REACT:...] followed by [ACTION:PUBLIC], then your message on a new line.

Example 1 (Query about Universities):
User: apnader sathe kon kon university connected?
Bot:
[REACT:LIKE]
[ACTION:PUBLIC]
GrEdu-এর সাথে UK-এর অনেকগুলো টপ-টিয়ার ইউনিভার্সিটির পার্টনারশিপ রয়েছে! যেমন- University of Hertfordshire, Coventry University, University of Greenwich ইত্যাদি। আমাদের সব পার্টনার ইউনিভার্সিটির লিস্ট দেখতে এই লিংকটি ভিজিট করতে পারেন: https://gredu.co.uk/universities/

Example 2 (General Chat - No Link needed):
User: kemon achen?
Bot:
[REACT:LIKE]
[ACTION:PUBLIC]
আমি ভালো আছি, ধন্যবাদ! আপনি কেমন আছেন? GrEdu থেকে আপনাকে কীভাবে সাহায্য করতে পারি?`;

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
