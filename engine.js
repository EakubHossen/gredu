const { google } = require('googleapis');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
require('dotenv').config();

const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const FOLDERS = {
    imagePending: process.env.DRIVE_FOLDER_ID_IMAGE_PENDING,
    imagePosted: process.env.DRIVE_FOLDER_ID_IMAGE_POSTED,
    videoPending: process.env.DRIVE_FOLDER_ID_VIDEO_PENDING,
    videoPosted: process.env.DRIVE_FOLDER_ID_VIDEO_POSTED
};

const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

async function getFiles(folderId) {
    const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType)',
        orderBy: 'createdTime asc'
    });
    return res.data.files;
}

async function moveFile(fileId, oldParent, newParent) {
    await drive.files.update({
        fileId: fileId,
        addParents: newParent,
        removeParents: oldParent,
        fields: 'id, parents'
    });
}

async function generateCaption(type) {
    if (!GEMINI_API_KEY) return `Check out our latest ${type}! 🌿✨ #Nature #Beautiful #NaturePhotography #Landscape #Earth`;
    
    const prompt = `Write a short, engaging Facebook caption for a premium nature ${type}. Include a question to drive comments. 
IMPORTANT RULES:
- Use emojis.
- Include exactly 20 to 25 highly relevant and popular nature, travel, and photography hashtags to rank the post (e.g., #NaturePhotography #Wanderlust #EarthFocus).
- DO NOT use the page name or #TheNatureInsight as a hashtag.`;
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    
    try {
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        return res.data.candidates[0].content.parts[0].text.trim();
    } catch (e) {
        console.error('Gemini error:', e.message);
        return `Amazing new ${type}! 😍 #Trending #Nature #Beautiful #NaturePhotography #Landscape #Earth`;
    }
}

async function uploadToFacebook(fileId, isVideo, mimeType) {
    try {
        console.log(`Downloading ${isVideo ? 'Video' : 'Image'} from Google Drive...`);
        
        const res = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'stream' });
        const caption = await generateCaption(isVideo ? 'video' : 'image');
        
        const form = new FormData();
        form.append('access_token', PAGE_ACCESS_TOKEN);
        form.append(isVideo ? 'description' : 'message', caption);
        form.append('source', res.data, {
            filename: isVideo ? 'video.mp4' : 'image.jpg',
            contentType: mimeType
        });

        const url = `https://graph.facebook.com/v20.0/me/${isVideo ? 'videos' : 'photos'}`;
        
        console.log(`Uploading to Facebook Graph API...`);
        const fbRes = await axios.post(url, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });
        
        console.log(`✅ Upload Success! Post ID:`, fbRes.data.id || fbRes.data.post_id);
        return true;
    } catch (e) {
        console.error('❌ Upload Error:', e.response ? e.response.data : e.message);
        return false;
    }
}

async function fallbackToUnsplash() {
    try {
        console.log(`🔍 Fetching a breathtaking image from Unsplash...`);
        const searchQuery = "nature switzerland landscape";
        let unsplashUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(searchQuery)}&orientation=landscape&order_by=relevant&per_page=1&client_id=${UNSPLASH_ACCESS_KEY}`;
        
        let unsplashData = await axios.get(unsplashUrl);
        if (!unsplashData.data || !unsplashData.data.results || unsplashData.data.results.length === 0) {
            console.error("❌ No Unsplash results");
            return;
        }

        const photo = unsplashData.data.results[0];
        const imageUrl = photo.urls.raw + "&w=2560&q=80&fm=jpg";
        const caption = await generateCaption('image');

        const fbUrl = `https://graph.facebook.com/v20.0/me/photos?access_token=${PAGE_ACCESS_TOKEN}`;
        const fbPayload = { url: imageUrl, message: caption };
        
        console.log(`Uploading Unsplash image to Facebook...`);
        const fbRes = await axios.post(fbUrl, fbPayload);
        console.log("✅ Unsplash Auto-Post Success:", fbRes.data);
    } catch (e) {
        console.error("❌ Unsplash Error:", e.response ? e.response.data : e.message);
    }
}

async function runAutoPoster(preferredType = 'image') {
    try {
        console.log(`--- Starting Auto-Poster Engine (Target: ${preferredType}) ---`);
        
        if (preferredType === 'video') {
            // 1. Check Videos (if folder ID is provided)
            if (FOLDERS.videoPending) {
                const videos = await getFiles(FOLDERS.videoPending);
                if (videos && videos.length > 0) {
                    console.log('Found video:', videos[0].name);
                    const success = await uploadToFacebook(videos[0].id, true, videos[0].mimeType);
                    if (success) {
                        await moveFile(videos[0].id, FOLDERS.videoPending, FOLDERS.videoPosted);
                        console.log('Moved video to Posted folder.');
                    }
                    return;
                }
            } else {
                console.log('Skipping Video check (Folder ID not set in Render)');
            }
        }

        // 2. Check Images (if folder ID is provided)
        if (FOLDERS.imagePending) {
            const images = await getFiles(FOLDERS.imagePending);
            if (images && images.length > 0) {
                console.log('Found image:', images[0].name);
                const success = await uploadToFacebook(images[0].id, false, images[0].mimeType);
                if (success) {
                    await moveFile(images[0].id, FOLDERS.imagePending, FOLDERS.imagePosted);
                    console.log('Moved image to Posted folder.');
                }
                return;
            }
        } else {
            console.log('Skipping Image check (Folder ID not set in Render)');
        }

        // 3. Fallback to Unsplash
        console.log('Drive is empty! Triggering Unsplash Fallback...');
        await fallbackToUnsplash();
        
    } catch (error) {
        console.error('Error in Auto-Poster:', error.message);
    }
}

module.exports = { runAutoPoster };
