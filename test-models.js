import dotenv from 'dotenv';
dotenv.config({ path: 'd:/whatbot/whatsapp-bot/.env' });

async function checkModels() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    console.log(data.models.map(m => m.name).filter(m => m.includes('gemini')));
}
checkModels();
