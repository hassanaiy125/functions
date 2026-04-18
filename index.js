const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
        });
        console.log("✅ Firebase Admin Initialized");
    } catch (e) {
        console.error("❌ Firebase Admin Init Error:", e.message);
    }
}

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// تشغيل السيرفر على البورت الصحيح لـ Render
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('🔥 Waslny Minimal API is Running!');
});

app.post('/send-telegram-otp', async (req, res) => {
    const { phone } = req.body;
    console.log("إرسال كود للرقم:", phone);

    try {
        if (!phone) return res.send({ success: false, error: "Phone number required" });

        if (!process.env.TELEGRAM_TOKEN) {
            throw new Error("التوكن بتاع تليجرام مش موجود في إعدادات ريندر");
        }

        // توليد كود عشوائي من 4 أرقام
        const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();

        // إرسال الكود لتيليجرام
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN.trim()}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `كود تفعيل وصلني للرقم ${phone} هو: ${generatedOtp}`
        });

        // توليد Custom Token للـ Firebase Login
        let customToken = null;
        try {
            customToken = await admin.auth().createCustomToken(phone);
        } catch (tokenError) {
            console.error("Token Generation Error:", tokenError.message);
            // We'll still return success but token will be null (frontend will need to handle this or we fail here)
            throw new Error("Failed to generate Firebase token: " + tokenError.message);
        }

        res.json({
            success: true,
            message: "تم الإرسال بنجاح!",
            otp: generatedOtp,
            customToken: customToken
        });

    } catch (error) {
        console.error("❌ حصلت مشكلة:");
        console.error(error.response ? error.response.data : error.message);

        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response ? error.response.data : "No extra details"
        });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server live on port ${PORT}`);
});
