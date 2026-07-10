import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: 'd:/whatbot/whatsapp-bot/.env' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
    try {
        const dummyJpeg = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "What is this?" },
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: dummyJpeg
                            }
                        }
                    ]
                }
            ]
        });
        console.log("Success:", response.text);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

run();
