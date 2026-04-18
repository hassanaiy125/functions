const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const cron = require("node-cron");

// 1. تعريف التطبيق مرة واحدة فقط
const app = express();

// 2. إعدادات الـ CORS والـ JSON
app.use(cors({ origin: true }));
app.use(express.json());

// 3. تعريف وتشغيل Firebase Admin
if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: "waslny-e9da9" 
    });
}

const auth = admin.auth();
const db = admin.firestore();

// Environment Variables for OPay/WhatsApp
const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID || "281826011148891";
const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY || "OPAYPUB17681530142920.8131231637519822";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "EAAizfZBVBW2cBQ5J4ZACcQAOvptotpncomufveNnSX1YRnMfzXvZCy8gZA7goLNZCU84cFzZCr8QBgDRpCtyZBYjyqvBk58sbEVObyvrgjUqCyAZAswV86hWLZBcf0zlUuONZAe3akPQuwmebTw6V0n7CVFH5StCoZAogtHHGhAzAFmMy587uDO26uwrEAxBSIOitWSeKjZAqSSpLAO5H6d9wmzTgQl0Ks3JJjKyfzM7AE6hUaRYYwrWAimXcvsO9eM1ZAwEtLzYZCZBkFaI4ZCorZAULn8ZCz";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "1044924515367044";

// 4. المسارات (Routes)

// Health Check
app.get('/', (req, res) => {
    res.send('🔥 Waslny API is Running Correctly!');
});

// Admin Check Helpers
const ADMIN_EMAIL = "wondersco@gmail.com";
const ADMIN_PHONE = "+201024419931";
const isAdmin = (req) => req.auth && (req.auth.email === ADMIN_EMAIL || req.auth.phone_number === ADMIN_PHONE);

// Auth Middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).send({ success: false, error: 'Missing token' });
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.auth = decodedToken;
        next();
    } catch (e) {
        res.status(401).send({ success: false, error: 'Invalid token' });
    }
};

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/** 
 * TELEGRAM OTP
 */
app.post('/send-telegram-otp', async (req, res) => {
    try {
        const { phone } = req.body;
        console.log("Request for phone:", phone);
        if (!phone) return res.send({ success: false, error: "Phone number required" });

        const requestId = "tg_" + Math.random().toString(36).substring(7);
        const otp = generateOTP();
        
        await db.collection("otps").doc(phone).set({
            otp: otp,
            requestId: requestId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        console.log(`[SIMULATION] Telegram OTP ${otp} for ${phone}`);
        res.json({ success: true, requestId, message: "OTP endpoint reached successfully" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/verify-telegram-otp", async (req, res) => {
    try {
        const { phone, code } = req.body;
        const otpDoc = await db.collection("otps").doc(phone).get();
        if (!otpDoc.exists || otpDoc.data().otp !== code) return res.send({ success: false, error: "Invalid code" });
        await db.collection("otps").doc(phone).delete();
        let user;
        try { user = await auth.getUserByPhoneNumber(phone); } 
        catch (e) { user = await auth.createUser({ phoneNumber: phone }); }
        const customToken = await auth.createCustomToken(user.uid);
        res.send({ success: true, customToken });
    } catch (e) { res.status(500).send({ success: false, error: e.message }); }
});

/**
 * WHATSAPP OTP
 */
app.post("/sendWhatsAppOtp", async (req, res) => {
    try {
        const { phone } = req.body;
        const otp = generateOTP();
        await db.collection("otps").doc(phone).set({ otp, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        await axios.post(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
            messaging_product: "whatsapp", to: phone.replace('+', ''), type: "template",
            template: { name: "otp", language: { code: "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: otp }] }] }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
        res.send({ success: true });
    } catch (e) { res.status(500).send({ success: false, error: e.message }); }
});

app.post("/verifyWhatsAppOtp", async (req, res) => {
    const { phone, otp } = req.body;
    const doc = await db.collection("otps").doc(phone).get();
    if (!doc.exists || doc.data().otp !== otp) return res.send({ success: false, error: "Invalid" });
    await db.collection("otps").doc(phone).delete();
    let user;
    try { user = await auth.getUserByPhoneNumber(phone); } catch(e) { user = await auth.createUser({ phoneNumber: phone }); }
    const customToken = await auth.createCustomToken(user.uid);
    res.send({ success: true, customToken });
});

/**
 * PAYMENTS & CORE
 */
app.post("/createTopupIntent", verifyToken, async (req, res) => {
    const { amount } = req.body;
    const reference = `topup_${Date.now()}`;
    const payload = { 
        country: "EG", reference, amount: { total: amount * 100, currency: "EGP" },
        returnUrl: "https://waslny-7791e.web.app/payment-success",
        callbackUrl: "https://functions-tb4u.onrender.com/opayWebhook",
        payMethod: "BankCard"
    };
    const response = await axios.post("https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create", payload, {
        headers: { Authorization: `Bearer ${OPAY_PUBLIC_KEY}`, MerchantId: OPAY_MERCHANT_ID }
    });
    res.send({ cashierUrl: response.data.data.cashierUrl });
});

app.post("/opayWebhook", async (req, res) => {
    res.send("OK");
});

app.post("/exchangeNativeAuthToken", async (req, res) => {
    const { idToken } = req.body;
    const decoded = await auth.verifyIdToken(idToken);
    const customToken = await auth.createCustomToken(decoded.uid);
    res.send({ customToken });
});

// Scheduled Task
cron.schedule("* * * * *", async () => {
    // Cleanup logic...
});

// 5. تشغيل السيرفر على البورت الصحيح لـ Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`✅ Server live on port ${PORT}`);
});
