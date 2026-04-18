const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin'); // <--- السطر ده هو اللي ناقصك ومسبب المشكلة
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// تعريف وتشغيل Firebase Admin
if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: "waslny-e9da9" // الـ ID بتاع مشروعك
    });
}

const auth = admin.auth();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Environment Variables
const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID || "281826011148891";
const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY || "OPAYPUB17681530142920.8131231637519822";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "EAAizfZBVBW2cBQ5J4ZACcQAOvptotpncomufveNnSX1YRnMfzXvZCy8gZA7goLNZCU84cFzZCr8QBgDRpCtyZBYjyqvBk58sbEVObyvrgjUqCyAZAswV86hWLZBcf0zlUuONZAe3akPQuwmebTw6V0n7CVFH5StCoZAogtHHGhAzAFmMy587uDO26uwrEAxBSIOitWSeKjZAqSSpLAO5H6d9wmzTgQl0Ks3JJjKyfzM7AE6hUaRYYwrWAimXcvsO9eM1ZAwEtLzYZCZBkFaI4ZCorZAULn8ZCz";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "1044924515367044";

// Admin Check
const ADMIN_EMAIL = "wondersco@gmail.com";
const ADMIN_PHONE = "+201024419931";

const isAdmin = (req) => {
    return req.auth && (
        req.auth.email === ADMIN_EMAIL ||
        req.auth.phone_number === ADMIN_PHONE
    );
};

// Auth Middleware (Verifies Firebase ID Token)
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ success: false, error: 'Unauthorized: Missing token' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.auth = decodedToken;
        next();
    } catch (error) {
        console.error("Auth Token Verification Error:", error);
        return res.status(401).send({ success: false, error: 'Unauthorized: Invalid token' });
    }
};

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * =====================================================
 * WHATSAPP OTP
 * =====================================================
 */

app.post("/sendWhatsAppOtp", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.send({ success: false, error: "Missing phone number" });

        const otpDocRef = db.collection("otps").doc(phone);
        const otpDoc = await otpDocRef.get();

        if (otpDoc.exists) {
            const data = otpDoc.data();
            const now = new Date();
            const createdAt = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt)) : new Date(0);
            const diffSeconds = (now - createdAt) / 1000;
            
            if (diffSeconds < 60) {
                return res.send({ success: false, error: `Please wait ${Math.ceil(60 - diffSeconds)} seconds before requesting a new code.` });
            }
        }

        const otp = generateOTP();
        await otpDocRef.set({
            otp: otp,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        try {
            await axios.post(
                `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: phone.replace('+', ''),
                    type: "template",
                    template: {
                        name: "otp",
                        language: { code: "ar" },
                        components: [
                            { type: "body", parameters: [{ type: "text", text: otp }] },
                            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] }
                        ]
                    }
                },
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
            );
            return res.send({ success: true });
        } catch (error) {
            console.error("WhatsApp API Error:", error.response?.data || error.message);
            return res.send({ success: false, error: "Failed to send WhatsApp message." });
        }
    } catch (error) {
        console.error("sendWhatsAppOtp Error:", error);
        return res.send({ success: false, error: `Internal Error: ${error.message}` });
    }
});

app.post("/verifyWhatsAppOtp", async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.send({ success: false, error: "Missing phone or otp" });

        const otpDocRef = db.collection("otps").doc(phone);
        const otpDoc = await otpDocRef.get();

        if (!otpDoc.exists) return res.send({ success: false, error: "OTP not found or expired" });

        const data = otpDoc.data();
        if (data.otp !== otp) return res.send({ success: false, error: "Invalid OTP" });

        const expiresAt = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
        if (expiresAt < new Date()) {
            await otpDocRef.delete();
            return res.send({ success: false, error: "OTP expired" });
        }

        await otpDocRef.delete();

        let uid;
        try {
            const userRecord = await auth.getUserByPhoneNumber(phone);
            uid = userRecord.uid;
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                const newUser = await auth.createUser({ phoneNumber: phone });
                uid = newUser.uid;
            } else {
                return res.send({ success: false, error: `Error fetching user: ${error.message}` });
            }
        }

        const customToken = await auth.createCustomToken(uid);
        return res.send({ success: true, customToken });
    } catch (error) {
        console.error("verifyWhatsAppOtp Error:", error);
        return res.send({ success: false, error: `Internal Error: ${error.message}` });
    }
});

/**
 * =====================================================
 * TELEGRAM OTP
 * =====================================================
 */

app.post("/send-telegram-otp", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.send({ success: false, error: "Phone number required" });
        
        const requestId = "tg_" + Math.random().toString(36).substring(7);
        const otp = generateOTP();
        
        await db.collection("otps").doc(phone).set({
            otp: otp,
            requestId: requestId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        console.log(`[SIMULATION] Sending Telegram OTP ${otp} to ${phone}`);
        return res.send({ success: true, requestId });
    } catch (error) {
        console.error("Telegram Send Error:", error);
        return res.send({ success: false, error: error.message });
    }
});

app.post("/verify-telegram-otp", async (req, res) => {
    try {
        const { phone, requestId, code } = req.body;
        if (!phone || !code) return res.send({ success: false, error: "Missing data" });

        const otpDocRef = db.collection("otps").doc(phone);
        const otpDoc = await otpDocRef.get();

        if (!otpDoc.exists) return res.send({ success: false, error: "Invalid session" });
        
        const data = otpDoc.data();
        if (data.otp !== code) return res.send({ success: false, error: "Invalid code" });

        await otpDocRef.delete();

        let userRecord;
        try {
            userRecord = await auth.getUserByPhoneNumber(phone);
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                userRecord = await auth.createUser({ phoneNumber: phone });
            } else throw e;
        }

        const customToken = await auth.createCustomToken(userRecord.uid);
        return res.send({ success: true, customToken });
    } catch (error) {
        console.error("Telegram Verify Error:", error);
        return res.send({ success: false, error: error.message });
    }
});

/**
 * =====================================================
 * AUTH SYNC & CORE
 * =====================================================
 */

app.post("/exchangeNativeAuthToken", async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).send({ error: 'Missing ID Token' });
    try {
        const decoded = await auth.verifyIdToken(idToken);
        const customToken = await auth.createCustomToken(decoded.uid);
        return res.send({ customToken });
    } catch (e) {
        return res.status(401).send({ error: 'Invalid token' });
    }
});

app.post("/confirmManualTopup", verifyToken, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).send({ error: "Admin role required." });
    const { topupId } = req.body;
    const topupRef = db.collection("manualTopups").doc(topupId);
    try {
        await db.runTransaction(async (t) => {
            const topupDoc = await t.get(topupRef);
            if (!topupDoc.exists) throw new Error("Top-up request not found.");
            const data = topupDoc.data();
            if (data.status === "PAID") return;
            const userRef = db.collection("users").doc(data.userId);
            t.update(topupRef, { status: "PAID", confirmedAt: admin.firestore.FieldValue.serverTimestamp(), confirmedBy: req.auth.uid });
            t.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(data.amount) });
        });
        return res.send({ success: true });
    } catch (error) {
        return res.status(500).send({ error: error.message });
    }
});

app.post("/rejectManualTopup", verifyToken, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).send({ error: "Admin role required." });
    const { topupId, reason } = req.body;
    try {
        await db.collection("manualTopups").doc(topupId).update({
            status: "REJECTED",
            rejectionReason: reason || "Admin rejected payment.",
            confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
            confirmedBy: req.auth.uid
        });
        return res.send({ success: true });
    } catch (error) {
        return res.status(500).send({ error: error.message });
    }
});

/**
 * =====================================================
 * PAYMENTS (OPay)
 * =====================================================
 */

app.post("/createTopupIntent", verifyToken, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 10) return res.status(400).send({ error: "Minimum topup is 10 EGP" });

    const userId = req.auth.uid;
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return res.status(404).send({ error: "User not found" });
    const userData = userDoc.data();

    const topupRef = db.collection("topups").doc();
    const reference = `topup_${topupRef.id}`;
    const amountCents = Math.round(Number(amount) * 100);

    const payload = {
        country: "EG",
        reference: reference,
        amount: { total: amountCents, currency: "EGP" },
        returnUrl: "https://waslny-7791e.web.app/payment-success",
        callbackUrl: "https://functions-tb4u.onrender.com/opayWebhook",
        userInfo: { userId, userEmail: userData.email || "user@waslny.com", userMobile: userData.phone || "+201000000000", userName: userData.name || "User" },
        productList: [{ productId: "WALLET_TOPUP", name: "Wallet Topup", price: amountCents, quantity: 1 }],
        payMethod: "BankCard"
    };

    try {
        const response = await axios.post("https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create", payload, {
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPAY_PUBLIC_KEY}`, MerchantId: OPAY_MERCHANT_ID }
        });
        if (response.data.code !== "00000") throw new Error(response.data.message);
        await topupRef.set({ userId, amountCents, status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp(), cashierUrl: response.data.data.cashierUrl });
        return res.send({ topupId: topupRef.id, cashierUrl: response.data.data.cashierUrl });
    } catch (error) {
        return res.status(500).send({ error: "Failed to initiate topup" });
    }
});

app.post("/createOPayOrder", verifyToken, async (req, res) => {
    const { rideId } = req.body;
    if (!rideId) return res.status(400).send({ error: "Missing rideId" });

    const rideDoc = await db.collection("rides").doc(rideId).get();
    if (!rideDoc.exists) return res.status(404).send({ error: "Ride not found" });
    const rideData = rideDoc.data();

    if (rideData.passengerId !== req.auth.uid) return res.status(403).send({ error: "Unauthorized" });

    const payload = {
        country: "EG",
        reference: `ride_${rideId}`,
        amount: { total: Math.round(rideData.fare * 100), currency: "EGP" },
        returnUrl: "https://waslny-7791e.web.app/payment-success",
        callbackUrl: "https://functions-tb4u.onrender.com/opayWebhook",
        userInfo: { userId: rideData.passengerId, userEmail: "pax@waslny.com", userMobile: "+201000000000", userName: "Passenger" },
        productList: [{ productId: rideId, name: "Ride Payment", price: Math.round(rideData.fare * 100), quantity: 1 }],
        payMethod: "BankCard"
    };

    try {
        const response = await axios.post("https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create", payload, {
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPAY_PUBLIC_KEY}`, MerchantId: OPAY_MERCHANT_ID }
        });
        if (response.data.code !== "00000") throw new Error(response.data.message);
        return res.send({ cashierUrl: response.data.data.cashierUrl });
    } catch (error) {
        return res.status(500).send({ error: "Failed to create order" });
    }
});

app.post("/opayWebhook", async (req, res) => {
    const payload = req.body?.payload;
    if (!payload || payload.status !== "SUCCESS") return res.send("IGNORE");

    const reference = payload.reference;
    const amountCents = Number(payload.amount);
    const amountEgp = amountCents / 100;

    try {
        if (reference.startsWith('topup_')) {
            const topupId = reference.replace('topup_', '');
            const topupRef = db.collection("topups").doc(topupId);
            await db.runTransaction(async (t) => {
                const doc = await t.get(topupRef);
                if (!doc.exists || doc.data().status === "paid") return;
                t.update(topupRef, { status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp() });
                t.update(db.collection("users").doc(doc.data().userId), { walletBalance: admin.firestore.FieldValue.increment(amountEgp) });
            });
        }
        return res.send("OK");
    } catch (e) {
        return res.send("OK_WITH_ERROR");
    }
});

/**
 * =====================================================
 * SCHEDULED & TRIGGER LOGIC
 * =====================================================
 */

const cleanupExpiredRides = async () => {
    const now = Date.now();
    const timeoutThreshold = now - 600000;
    const snapshot = await db.collection('rides').where('status', 'in', ['SEARCHING', 'OFFER_RECEIVED']).where('timestamp', '<', timeoutThreshold).get();
    for (const doc of snapshot.docs) {
        await doc.ref.update({ status: 'CANCELLED', cancelledBy: 'system', closedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    if (!snapshot.empty) console.log(`Cleaned up ${snapshot.size} expired rides.`);
};

cron.schedule("* * * * *", cleanupExpiredRides);

app.get("/", (req, res) => {
    res.send({ status: "Waslny API is Running", timestamp: new Date().toISOString() });
});

// Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Waslny API listening on port ${PORT}`);
});
