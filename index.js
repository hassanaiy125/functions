const express = require('express');
const cors = require('cors');
const axios = require('axios');

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

        // تأكد أنك عرفت TELEGRAM_TOKEN في Render Environment
        if (!process.env.TELEGRAM_TOKEN) {
            throw new Error("التوكن بتاع تليجرام مش موجود في إعدادات ريندر");
        }

        // تجربة إرسال بسيطة لتيليجرام
        const telegramResponse = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN.trim()}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID, // ضيف ده في Render برضه
            text: `كود تفعيل وصلني للرقم ${phone} هو: ${Math.floor(1000 + Math.random() * 9000)}`
        });

        res.json({
            success: true,
            message: "تم الإرسال بنجاح!",
            telegram_info: telegramResponse.data
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
