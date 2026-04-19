const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(express.json());

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/* =========================
   ENV
========================= */
const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID;
const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

/* =========================
   ADMIN CHECK
========================= */
function isAdmin(req) {
    const email = req.headers.email;
    const phone = req.headers.phone;

    return (
        email === "wondersco@gmail.com" ||
        phone === "+201024419931"
    );
}

/* =========================
   OTP
========================= */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
    res.send("🔥 API is running on Render");
});

/* =====================================================
   WHATSAPP OTP
===================================================== */
app.post("/send-whatsapp-otp", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.json({ success: false, error: "Missing phone" });

        const otp = generateOTP();

        await db.collection("otps").doc(phone).set({
            otp,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 5 * 60000)
        });

        await axios.post(
            `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: phone.replace("+", ""),
                type: "text",
                text: { body: `Your OTP is: ${otp}` }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`
                }
            }
        );

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false, error: e.message });
    }
});

/* =====================================================
   VERIFY OTP
===================================================== */
app.post("/verify-whatsapp-otp", async (req, res) => {
    try {
        const { phone, otp } = req.body;

        const doc = await db.collection("otps").doc(phone).get();
        if (!doc.exists) return res.json({ success: false, error: "Not found" });

        const data = doc.data();

        if (data.otp !== otp)
            return res.json({ success: false, error: "Invalid OTP" });

        await db.collection("otps").doc(phone).delete();

        let user;
        try {
            user = await admin.auth().getUserByPhoneNumber(phone);
        } catch {
            user = await admin.auth().createUser({ phoneNumber: phone });
        }

        const token = await admin.auth().createCustomToken(user.uid);

        res.json({ success: true, token });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

/* =====================================================
   TOPUP INTENT (OPAY)
===================================================== */
app.post("/create-topup", async (req, res) => {
    try {
        const { userId, amount } = req.body;

        const topupRef = db.collection("topups").doc();
        const topupId = topupRef.id;

        const payload = {
            country: "EG",
            reference: `topup_${topupId}`,
            amount: {
                total: Math.round(amount * 100),
                currency: "EGP"
            }
        };

        const response = await axios.post(
            "https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create",
            payload,
            {
                headers: {
                    Authorization: `Bearer ${OPAY_PUBLIC_KEY}`,
                    MerchantId: OPAY_MERCHANT_ID
                }
            }
        );

        await topupRef.set({
            userId,
            amount,
            status: "pending"
        });

        res.json({
            success: true,
            cashierUrl: response.data.data.cashierUrl
        });
    } catch (e) {
        console.error(e);
        res.json({ success: false, error: e.message });
    }
});

/* =====================================================
   WEBHOOK
===================================================== */
app.post("/opay-webhook", async (req, res) => {
    try {
        const payload = req.body.payload;

        if (!payload || payload.status !== "SUCCESS") {
            return res.send("IGNORED");
        }

        const ref = payload.reference;

        if (ref.startsWith("topup_")) {
            const id = ref.replace("topup_", "");
            const doc = await db.collection("topups").doc(id).get();

            if (!doc.exists) return res.send("OK");

            const data = doc.data();

            await db.collection("users").doc(data.userId).update({
                walletBalance: admin.firestore.FieldValue.increment(data.amount)
            });

            await db.collection("topups").doc(id).update({
                status: "paid"
            });
        }

        res.send("OK");
    } catch (e) {
        console.error(e);
        res.send("ERROR");
    }
});

/* =====================================================
   START SERVER (IMPORTANT FOR RENDER)
===================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 Server running on port", PORT);
});