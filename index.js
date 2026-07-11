import { makeWASocket, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import { getAiResponse, getVisionDescription } from './services/ai.js';
import { getChatHistory, saveChatHistory, createOrder, getOrdersForFollowUp, markOrderFollowedUp, getCustomerByPhone } from './services/db.js';
import { useSupabaseAuthState } from './services/authState.js';
import express from 'express';

// Setup Express server to keep Render instance awake
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running!');
});

app.listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

// Store muted users (phone number -> timestamp when mute expires)
const mutedUsers = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState();
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Turn off default to use custom
        logger: pino({ level: 'silent' }), // change to 'info' for debug logs
        markOnlineOnConnect: true, // Show bot as online on WhatsApp
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Scan this QR code from your WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error?.message || lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
            } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
        }
    });

    // Start automated follow-up cron job (Runs every day at 10:00 AM)
    cron.schedule('0 10 * * *', async () => {
        console.log('Running automated order follow-up job...');
        try {
            const ordersToFollowUp = await getOrdersForFollowUp();
            for (const order of ordersToFollowUp) {
                let cleanPhone = order.customer_phone.replace(/[^0-9]/g, '');
                // Basic check if local number without 94
                if (cleanPhone.startsWith('0')) {
                    cleanPhone = '94' + cleanPhone.substring(1);
                } else if (!cleanPhone.startsWith('94')) {
                    // Assuming Sri Lankan number if no country code provided
                    cleanPhone = '94' + cleanPhone;
                }
                const jid = `${cleanPhone}@s.whatsapp.net`;
                
                const followUpMsg = "Hi dr, oyage order eka hamba unada? Monawahari prashnayak thiyenawanam kiyanna 😊";
                
                await sock.sendMessage(jid, { text: followUpMsg });
                console.log(`Follow-up sent to ${cleanPhone}`);
                
                await markOrderFollowedUp(order.id);
                // slight delay to avoid spamming rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.error('Error in follow-up cron job:', error);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; // ignore our own messages or empty messages

        const remoteJid = msg.key.remoteJid;
        const phoneNumber = remoteJid.split('@')[0];
        const pushName = msg.pushName || 'Customer';
        
        // Check if user is muted (handed over to human)
        if (mutedUsers.has(phoneNumber)) {
            const unMuteTime = mutedUsers.get(phoneNumber);
            if (Date.now() < unMuteTime) {
                console.log(`Ignoring message from ${phoneNumber} - Bot is muted (human handoff active)`);
                return;
            } else {
                mutedUsers.delete(phoneNumber); // Mute expired
            }
        }

        // Extract text depending on message type
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        console.log(`Received message from ${phoneNumber}`);

        try {
            // 1. Immediately mark message as read (Blue tick) and show typing
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', remoteJid);

            // Handle images
            if (msg.message.imageMessage) {
                text = msg.message.imageMessage.caption || '';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                    const base64Image = buffer.toString('base64');
                    console.log(`Received image from ${phoneNumber}. Processing with Vision AI...`);
                    const imageDesc = await getVisionDescription(base64Image);
                    text = `[Customer sent an image of: ${imageDesc}] \n${text}`;
                } catch (err) {
                    console.error("Error downloading image:", err);
                    text = `[Customer sent an image] \n${text}`;
                }
            }

            if (!text) {
                await sock.sendPresenceUpdate('paused', remoteJid);
                return;
            }

            console.log(`Message text to process: ${text}`);

            // 2. Fetch chat history and returning customer data
            let history = await getChatHistory(phoneNumber);
            const pastCustomer = await getCustomerByPhone(phoneNumber);
            
            let messageToAi = text;
            if (pastCustomer) {
                messageToAi = `[SYSTEM NOTE: This is a RETURNING VIP CUSTOMER. Their saved Name is "${pastCustomer.name}" and saved Address is "${pastCustomer.address}". If they want to order, follow the RETURNING CUSTOMER RULE.]\n${text}`;
            }

            // 3. Define order creation callback
            const onOrderCreated = async (customerData, productData) => {
                const orderItems = [];
                if (productData) {
                    orderItems.push({
                        product_id: productData.id,
                        quantity: 1, // Defaulting to 1
                        price: productData.price
                    });
                }
                
                await createOrder(customerData, orderItems);
                console.log('Order created for', customerData.name);

                // Send notification to Admin
                const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER;
                if (adminNumber && adminNumber !== '94700000000') {
                    try {
                        const adminJid = `${adminNumber}@s.whatsapp.net`;
                        const itemName = productData ? productData.name : customerData.product_notes || 'Unknown Item';
                        const adminMsg = `🔔 *New Order Received!*\n\n*Customer:* ${customerData.name}\n*Address:* ${customerData.address}\n*Phone:* ${customerData.phone_number}\n*Item:* ${itemName}`;
                        await sock.sendMessage(adminJid, { text: adminMsg });
                        console.log('Admin notified successfully.');
                    } catch (err) {
                        console.error('Failed to notify admin:', err);
                    }
                }
            };

            // 4. Define handover callback
            const onHandoverRequired = async (reason) => {
                console.log(`Handover requested for ${phoneNumber}. Reason: ${reason}`);
                // Mute for 2 hours
                mutedUsers.set(phoneNumber, Date.now() + 2 * 60 * 60 * 1000);
                
                // Notify admin
                const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER;
                if (adminNumber && adminNumber !== '94700000000') {
                    try {
                        const adminJid = `${adminNumber}@s.whatsapp.net`;
                        const adminMsg = `🚨 *Human Assistance Required!*\n\n*Customer:* ${pushName}\n*Phone:* ${phoneNumber}\n*Reason:* ${reason}\n\n_Bot is now muted for this customer for 2 hours. Please reply to them directly._`;
                        await sock.sendMessage(adminJid, { text: adminMsg });
                    } catch (err) {
                        console.error('Failed to notify admin about handoff:', err);
                    }
                }
                
                // Tell customer
                await sock.sendMessage(remoteJid, { text: "Meka ape staff ekata forward kala dr. Eyala ikmanatama oyata katha karawi! 😊" });
            };

            // 5. Get AI response
            const aiResponse = await getAiResponse(messageToAi, history, onOrderCreated, pushName, onHandoverRequired);

            // 6. Send reply with simulated typing delay
            const typingDelay = Math.min(Math.max(aiResponse.length * 30, 1000), 5000);
            await new Promise(resolve => setTimeout(resolve, typingDelay));

            // Parse [IMAGE: url] tags from AI response and send actual images
            const imageTagRegex = /\[IMAGE:\s*(https?:\/\/[^\]]+)\]/gi;
            const imageUrls = [];
            let cleanedResponse = aiResponse.replace(imageTagRegex, (_, url) => {
                imageUrls.push(url.trim());
                return ''; // remove the tag from text
            }).trim();

            // Send each image first
            for (const imgUrl of imageUrls) {
                try {
                    await sock.sendMessage(remoteJid, {
                        image: { url: imgUrl },
                        caption: ''
                    });
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (imgErr) {
                    console.error('Failed to send product image:', imgErr.message);
                }
            }

            // Send the text message (without image tags)
            if (cleanedResponse) {
                await sock.sendMessage(remoteJid, { text: cleanedResponse });
            }
            
            // Stop typing indicator
            await sock.sendPresenceUpdate('paused', remoteJid);

            // 7. Update and save chat history
            history.push({ role: 'user', content: text });
            history.push({ role: 'assistant', content: aiResponse });
            
            // Keep only last 30 messages to save space/tokens but maintain context
            if (history.length > 30) history = history.slice(-30);
            
            await saveChatHistory(phoneNumber, history);

        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

connectToWhatsApp();
