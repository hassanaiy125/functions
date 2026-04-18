const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("✅ Firebase Admin Initialized with Service Account JSON");
        } else {
            // Fallback to individual env vars if JSON not provided
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                }),
            });
            console.log("✅ Firebase Admin Initialized with individual Env Vars");
        }
    } catch (e) {
        console.error("❌ Firebase Admin Init Error:", e.message);
    }
}

const app = express();

// Enable CORS for all origins
app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('🔥 Waslny Minimal API is Running!');
});

// --- TELEGRAM OTP ---

app.post('/send-telegram-otp', async (req, res) => {
    const { phone } = req.body;
    console.log("إرسال كود للرقم:", phone);

    try {
        if (!phone) return res.status(400).json({ success: false, error: "Phone number required" });

        if (!process.env.TELEGRAM_TOKEN) {
            throw new Error("TELEGRAM_TOKEN is missing in environment");
        }

        const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN.trim()}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `كود تفعيل وصلني للرقم ${phone} هو: ${generatedOtp}`
        });

        let customToken = null;
        try {
            customToken = await admin.auth().createCustomToken(phone);
        } catch (tokenError) {
            console.error("Token Generation Error:", tokenError.message);
            throw new Error("Failed to generate Firebase token");
        }

        res.json({
            success: true,
            message: "تم الإرسال بنجاح!",
            otp: generatedOtp,
            customToken: customToken
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// --- FCM PUSH NOTIFICATIONS ---

/**
 * Flexible Push Notification Endpoint
 * Scenarios handled by this:
 * 1. New Trip Request (to Drivers)
 * 2. Trip Accepted/Offer made (to Passenger)
 * 3. New Chat Message
 * 4. Trip Cancellation
 */
app.post('/send-push-notification', async (req, res) => {
    const { token, title, body, data } = req.body;

    if (!token || !title || !body) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields: token, title, body"
        });
    }

    const message = {
        token: token,
        notification: {
            title: title,
            body: body,
        },
        data: data || {}, // Optional custom data (e.g., rideId, senderId)
        android: {
            notification: {
                sound: 'default',
                priority: 'high',
                channelId: 'default'
            }
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1
                }
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log("🚀 Notification sent successfully:", response);
        res.json({
            success: true,
            messageId: response
        });
    } catch (error) {
        console.error("❌ Notification Error:", error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server live on port ${PORT}`);
});
