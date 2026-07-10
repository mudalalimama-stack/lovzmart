import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY
});

// --- Dynamic Personality Loader ---
let cachedPersonality = null;
let personalityLoadedAt = 0;
const PERSONALITY_TTL_MS = 60 * 60 * 1000; // refresh every 1 hour

async function getSystemPrompt() {
  const now = Date.now();
  if (cachedPersonality && (now - personalityLoadedAt) < PERSONALITY_TTL_MS) {
    return cachedPersonality;
  }

  // Try Supabase bot_config first
  try {
    const { supabase } = await import('./db.js');
    const { data, error } = await supabase
      .from('bot_config')
      .select('personality')
      .eq('id', 'main')
      .single();

    if (!error && data?.personality) {
      console.log('✅ Loaded personality from Supabase bot_config');
      cachedPersonality = data.personality;
      personalityLoadedAt = now;
      return cachedPersonality;
    }
  } catch (e) {
    console.warn('⚠️ Could not load personality from Supabase, using file fallback');
  }

  // Fallback to personality.txt
  try {
    cachedPersonality = fs.readFileSync(path.join(__dirname, 'personality.txt'), 'utf8');
    personalityLoadedAt = now;
    console.log('✅ Loaded personality from personality.txt');
  } catch (e) {
    cachedPersonality = 'You are Lovzy, a friendly sales assistant for Lovzmart in Sri Lanka. Speak in Singlish.';
  }
  return cachedPersonality;
}

// --- Tool Definitions ---
const createOrderTool = {
  name: 'create_order',
  description: 'Creates a new order when the customer provides their name, address, and phone number and agrees to purchase.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'Customer full name' },
      address: { type: Type.STRING, description: 'Customer delivery address' },
      phone_number: { type: Type.STRING, description: 'Customer phone number' },
      product_name: { type: Type.STRING, description: 'The exact name of the product they are buying' },
      product_notes: { type: Type.STRING, description: 'Any extra notes (e.g., color, size)' },
    },
    required: ['name', 'address', 'phone_number', 'product_name'],
  },
};

const searchProductsTool = {
  name: 'search_products',
  description: 'Searches the product database to find items and their prices. Call this when a customer asks about a product price, availability, or when they send an image of an item they want.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'A keyword to search for in the product database (e.g., "necklace", "panda lamp", "ring")',
      },
    },
    required: ['query'],
  },
};

const transferToHumanTool = {
  name: 'transfer_to_human',
  description: 'Transfers the conversation to a human administrator. Call this when the customer is angry, asks to speak to a human, or has a complex issue you cannot resolve.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'The reason for transferring to a human (e.g., "Customer is angry about delivery delay").',
      },
    },
    required: ['reason'],
  },
};

// --- Model Cache ---
let cachedTextModels = null;
let cachedVisionModels = null;

async function getAvailableModels() {
  if (cachedTextModels && cachedVisionModels) {
    return { textModels: cachedTextModels, visionModels: cachedVisionModels };
  }

  try {
    console.log("Fetching Gemini models list from API...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) throw new Error(data.error.message);

    const textModels = [];
    const visionModels = [];

    if (data.models) {
      for (const model of data.models) {
        if (!model.name?.includes('gemini')) continue;
        if (!model.supportedGenerationMethods?.includes('generateContent')) continue;
        
        const name = model.name.replace('models/', '');
        
        // Skip non-language models
        if (name.includes('embedding') || name.includes('tts') || name.includes('robotics')) continue;
        
        // Vision models support images
        if (model.supportedGenerationMethods?.includes('generateContent')) {
          // All gemini models support text; flash and pro also support vision
          textModels.push(name);
          
          // Vision capable: flash and pro models (not lite for reliability)
          if ((name.includes('flash') || name.includes('pro')) && !name.includes('lite') && !name.includes('audio')) {
            visionModels.push(name);
          }
        }
      }
    }

    if (textModels.length > 0) {
      cachedTextModels = textModels.sort().reverse();
      cachedVisionModels = visionModels.sort().reverse();
      console.log('✅ Text Models:', cachedTextModels.slice(0, 5), '...');
      console.log('✅ Vision Models:', cachedVisionModels);
      return { textModels: cachedTextModels, visionModels: cachedVisionModels };
    }

    throw new Error("No models found");
  } catch (error) {
    console.log('❌ Could not fetch models. Falling back to Groq. Error:', error.message);
    return { textModels: [], visionModels: [] };
  }
}

/**
 * Describe an image using Gemini Vision (with fallback)
 */
export async function getVisionDescription(base64Image) {
  const { visionModels } = await getAvailableModels();

  for (let i = 0; i < visionModels.length; i++) {
    const modelName = visionModels[i];
    try {
      console.log(`Trying Vision model: ${modelName}`);
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{
          role: 'user',
          parts: [
            { text: "Briefly describe this product (name, color, type, material, etc) so I can search for its price. Output only the description." },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image
              }
            }
          ]
        }]
      });

      if (response.text) {
        console.log(`✅ Vision description from ${modelName}: ${response.text}`);
        return response.text;
      }
    } catch (error) {
      console.error(`❌ Vision model ${modelName} failed:`, error.message);
      // Short wait, then try next model  
      if (i < visionModels.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return "an image of an item (could not be analyzed)";
}

/**
 * Execute a tool call from the AI
 */
async function executeTool(toolName, toolArgs, onOrderCreated, onHandoverRequired) {
  if (toolName === 'search_products') {
    const { supabase } = await import('./db.js');
    const { query } = toolArgs;
    console.log(`🔍 Searching products for: "${query}"`);
    
    let unique = [];

    // Special case: show all available items as a visual catalog
    if (query.toLowerCase().trim() === 'all' || query.toLowerCase().includes('monawada') || query.toLowerCase().includes('all items')) {
      const { data } = await supabase
        .from('products')
        .select('name, price, description, image_url, stock')
        .gt('stock', 0)
        .limit(10);
      unique = data || [];

      if (unique.length === 0) {
        return `No products in stock right now. Tell the customer naturally.`;
      }

      // Build a visual catalog response
      const catalogImages = unique.filter(p => p.image_url).map(p => `[IMAGE: ${p.image_url}]`).join('\n');
      const productList = unique.map((p, i) => `${i + 1}. ${p.name} - Rs.${p.price}`).join('\n');
      return `CATALOG MODE: Send these product photos to the customer first as a visual catalog, then list the items with prices and ask which one they are interested in. Here are the image tags to include IN YOUR REPLY:\n${catalogImages}\n\nProduct list:\n${productList}\n\nAfter the images, write a short friendly message listing the items with prices and ask "Which one interests you?" in Singlish.`;
    } else {
      // Split query into individual keywords and search each one
      const keywords = query.toLowerCase().split(/[\s,]+/).filter(k => k.length > 2);
      let allResults = [];
      
      for (const keyword of keywords) {
        const { data } = await supabase
          .from('products')
          .select('name, price, description, image_url, stock')
          .or(`name.ilike.%${keyword}%,description.ilike.%${keyword}%`)
          .limit(5);
        
        if (data) allResults.push(...data);
      }
      
      // Deduplicate by name
      const seen = new Set();
      unique = allResults.filter(p => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
      });
    }
    
    if (unique.length === 0) {
      return `0 products found. Inform the customer naturally that we don't have this item right now. CRITICAL: DO NOT mention the "database", "system", or "search". Just act like a real shop assistant saying it's out of stock or unavailable.`;
    }

    // Separate in-stock and out-of-stock
    const inStock = unique.filter(p => (p.stock ?? 0) > 0);
    const outOfStock = unique.filter(p => (p.stock ?? 0) === 0);

    const results = [];

    if (inStock.length > 0) {
      results.push(`Found these products: ${inStock.map(p => `${p.name} - Rs.${p.price} (stock: ${p.stock})${p.image_url ? ` [has_image: ${p.image_url}]` : ''}`).join('; ')}. Tell the customer the EXACT price clearly.`);
    }

    if (outOfStock.length > 0) {
      results.push(`These products are OUT OF STOCK: ${outOfStock.map(p => p.name).join(', ')}. Inform the customer naturally that we don't have stock right now, but will notify them when new stock arrives.`);
    }

    return results.join(' | ');
  }

  if (toolName === 'create_order') {
    const { supabase } = await import('./db.js');
    const { name, address, phone_number, product_name, product_notes } = toolArgs;
    
    // Look up product by name to get its ID and price
    const { data: products } = await supabase
      .from('products')
      .select('id, name, price, stock')
      .ilike('name', product_name)
      .limit(1);
      
    let productData = null;
    if (products && products.length > 0) {
      productData = products[0];
    }

    if (onOrderCreated) {
      await onOrderCreated({ name, address, phone_number, product_notes }, productData);
    }
    return "Order saved successfully";
  }

  if (toolName === 'transfer_to_human') {
    if (onHandoverRequired) {
      await onHandoverRequired(toolArgs.reason);
    }
    return "Conversation handed over to human. Stop talking to the customer now.";
  }

  return "Tool not found";
}

/**
 * Get AI response with Gemini (full tool calling loop) with Groq fallback
 */
export async function getAiResponse(message, history, onOrderCreated, pushName = 'Customer', onHandoverRequired) {
  const { textModels } = await getAvailableModels();
  const systemPrompt = await getSystemPrompt();

  const formattedHistory = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  formattedHistory.push({ role: 'user', parts: [{ text: `[Customer Name: ${pushName}]\n${message}` }] });

  // --- Try Gemini models ---
  for (let i = 0; i < textModels.length; i++) {
    const modelName = textModels[i];
    try {
      console.log(`Trying model: ${modelName}`);

      let currentContents = [...formattedHistory];
      let finalReply = '';

      // Agentic loop: keep calling until no more function calls
      for (let turn = 0; turn < 5; turn++) {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: currentContents,
          config: {
            systemInstruction: systemPrompt,
            tools: [{ functionDeclarations: [createOrderTool, searchProductsTool, transferToHumanTool] }],
            temperature: 0.7
          }
        });

        const functionCalls = response.functionCalls;

        if (functionCalls && functionCalls.length > 0) {
          // Add model's response (with function calls) to history
          currentContents.push({ role: 'model', parts: response.candidates[0].content.parts });

          // Execute all tool calls and collect results
          const toolResults = [];
          for (const call of functionCalls) {
            const result = await executeTool(call.name, call.args, onOrderCreated, onHandoverRequired);
            console.log(`Tool ${call.name} result: ${result}`);
            toolResults.push({
              functionResponse: {
                name: call.name,
                response: { result }
              }
            });
          }

          // Add tool results back into context
          currentContents.push({ role: 'user', parts: toolResults });

          // If it was create_order, the loop will continue and model will generate final natural confirmation.
        } else {
          finalReply = response.text || "Sorry, eka mata therune na.";
          break;
        }
      }

      if (finalReply) return finalReply;

    } catch (error) {
      console.error(`❌ Model ${modelName} failed:`, error.message);
      if (i < textModels.length - 1) {
        console.log(`Waiting 3s before next model...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  // --- Groq Fallback (text only, no vision) ---
  try {
    console.log(`All Gemini models failed. Falling back to Groq...`);
    const groqMessages = [
      { role: "system", content: systemPrompt },
      ...history.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      { role: "user", content: `[Customer Name: ${pushName}]\n${message}` }
    ];

    const groqResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: groqMessages,
      tools: [{
        type: "function",
        function: {
          name: "create_order",
          description: "Creates a new order.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              address: { type: "string" },
              phone_number: { type: "string" },
              product_name: { type: "string" },
              product_notes: { type: "string" }
            },
            required: ["name", "address", "phone_number", "product_name"]
          }
        }
      }],
      temperature: 0.7
    });

    const groqChoice = groqResponse.choices[0];

    if (groqChoice.message.tool_calls?.length > 0) {
      const toolCall = groqChoice.message.tool_calls[0];
      if (toolCall.function.name === 'create_order') {
        const args = JSON.parse(toolCall.function.arguments);
        if (onOrderCreated) await onOrderCreated(args);
        return "Order eka confirm wuna! 🎉 Mama order details save kala dr. Thank you! ❤️✨";
      }
    }

    return groqChoice.message.content || "Sorry, eka mata therune na.";
  } catch (groqError) {
    console.error("Groq fallback failed:", groqError.message);
  }

  return "Samawenna, podi technical awulak. Tikakin try karanna. 🙏";
}
