
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const admin = require("firebase-admin");
const axios = require("axios");

if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = admin.firestore();

// OPAY
const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID;
const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY;

// Admin check
const isAdmin = (context) => {
    return context.auth && (
        context.auth.token.email === "wondersco@gmail.com" ||
        context.auth.token.phone_number === "+201024419931"
    );
};

/* =====================================================
   WHATSAPP OTP
===================================================== */
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// TELEGRAM
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

exports.sendWhatsAppOtp = onCall({ cors: true }, async (request) => {
    try {
        const { phone } = request.data;
        if (!phone) return { success: false, error: "Missing phone number" };

        const otpDocRef = db.collection("otps").doc(phone);
        const otpDoc = await otpDocRef.get();

        // Rate Limiting: Check if OTP was sent in the last 60 seconds
        if (otpDoc.exists) {
            const data = otpDoc.data();
            const now = new Date();
            const createdAt = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt)) : new Date(0);
            const diffSeconds = (now - createdAt) / 1000;
            
            if (diffSeconds < 60) {
                return { success: false, error: `Please wait ${Math.ceil(60 - diffSeconds)} seconds before requesting a new code.` };
            }
        }

        const otp = generateOTP();
        
        // Store OTP in Firestore with an expiration time (5 minutes)
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
                        name: "otp", // Assuming the approved template is named 'otp'
                        language: { code: "ar" },
                        components: [
                            {
                                type: "body",
                                parameters: [
                                    { type: "text", text: otp }
                                ]
                            },
                            {
                                type: "button",
                                sub_type: "url",
                                index: "0",
                                parameters: [
                                    { type: "text", text: otp }
                                ]
                            }
                        ]
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            return { success: true };
        } catch (error) {
            console.error("WhatsApp API Error:", error.response?.data || error.message);
            return { success: false, error: "Failed to send WhatsApp message. Please try again." };
        }
    } catch (error) {
        console.error("sendWhatsAppOtp Error:", error);
        return { success: false, error: `Internal Error: ${error.message}` };
    }
});

exports.verifyWhatsAppOtp = onCall({ cors: true }, async (request) => {
    try {
        const { phone, otp } = request.data;
        if (!phone || !otp) return { success: false, error: "Missing phone or otp" };

        const otpDocRef = db.collection("otps").doc(phone);
        const otpDoc = await otpDocRef.get();

        if (!otpDoc.exists) {
            return { success: false, error: "OTP not found or expired" };
        }

        const data = otpDoc.data();
        if (data.otp !== otp) {
            return { success: false, error: "Invalid OTP" };
        }

        const expiresAt = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
        if (expiresAt < new Date()) {
            await otpDocRef.delete();
            return { success: false, error: "OTP expired" };
        }

        // OTP is valid, delete it
        await otpDocRef.delete();

        // Create or get user in Firebase Auth
        let uid;
        try {
            const userRecord = await admin.auth().getUserByPhoneNumber(phone);
            uid = userRecord.uid;
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                const newUser = await admin.auth().createUser({
                    phoneNumber: phone
                });
                uid = newUser.uid;
            } else {
                console.error("Error fetching user:", error);
                return { success: false, error: `Error fetching user: ${error.message}` };
            }
        }

        // Generate custom token
        try {
            const customToken = await admin.auth().createCustomToken(uid);
            return { success: true, customToken };
        } catch (tokenError) {
            console.error("Error creating custom token:", tokenError);
            
            if (tokenError.message.includes('iam.serviceAccounts.signBlob')) {
                return { 
                    success: false, 
                    error: "IAM Permission Denied: Your Cloud Function service account needs the 'Service Account Token Creator' role. Please go to Google Cloud Console -> IAM & Admin -> IAM, find your default compute service account, and add this role." 
                };
            }
            
            return { success: false, error: `Error creating token: ${tokenError.message}` };
        }
    } catch (error) {
        console.error("verifyWhatsAppOtp Error:", error);
        return { success: false, error: `Internal Error: ${error.message}` };
    }
});

/* =====================================================
   TELEGRAM OTP
===================================================== */
exports.sendTelegramOTP = onCall({ cors: true }, async (request) => {
    try {
        const { phone } = request.data;
        if (!phone) return { success: false, error: "Missing phone number" };

        const response = await axios.post('https://gatewayapi.telegram.org/sendVerificationMessage', {
            phone_number: phone,
            code_length: 6
        }, {
            headers: { 'Authorization': `Bearer ${TELEGRAM_TOKEN}` }
        });

        if (response.data.ok) {
            return { success: true, requestId: response.data.result.request_id };
        } else {
            console.error("Telegram API Error:", response.data);
            return { success: false, error: response.data.error || "Failed to send Telegram OTP" };
        }
    } catch (error) {
        console.error("sendTelegramOTP Error:", error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || "Internal Error" };
    }
});

exports.verifyTelegramOTP = onCall({ cors: true }, async (request) => {
    try {
        const { phone, requestId, code } = request.data;
        if (!phone || !requestId || !code) return { success: false, error: "Missing phone, requestId or code" };

        const response = await axios.post('https://gatewayapi.telegram.org/checkVerificationMessage', {
            phone_number: phone,
            verification_id: requestId,
            code: code
        }, {
            headers: { 'Authorization': `Bearer ${TELEGRAM_TOKEN}` }
        });

        if (response.data.ok && response.data.result.status === 'verified') {
            // Create or get user in Firebase Auth
            let uid;
            try {
                const userRecord = await admin.auth().getUserByPhoneNumber(phone);
                uid = userRecord.uid;
            } catch (error) {
                if (error.code === 'auth/user-not-found') {
                    const newUser = await admin.auth().createUser({
                        phoneNumber: phone
                    });
                    uid = newUser.uid;
                } else {
                    throw error;
                }
            }

            const customToken = await admin.auth().createCustomToken(uid);
            return { success: true, customToken };
        } else {
            console.error("Telegram Verify Error:", response.data);
            return { success: false, error: response.data.error || "Invalid or expired code" };
        }
    } catch (error) {
        console.error("verifyTelegramOTP Error:", error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || "Verification failed" };
    }
});

/* =====================================================
   AUTH SYNC (NATIVE -> WEB)
===================================================== */
exports.exchangeNativeAuthToken = onCall({ cors: true }, async (request) => {
    const { idToken } = request.data;
    if (!idToken) throw new HttpsError('invalid-argument', 'Missing ID Token');
    try {
        // Verify the Native ID Token
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;
        
        // Create a Custom Token for the JS SDK
        const customToken = await admin.auth().createCustomToken(uid);
        return { customToken };
    } catch (e) {
        console.error("Token Exchange Error", e);
        throw new HttpsError('unauthenticated', 'Invalid token');
    }
});

/* =====================================================
   MANUAL TOPUP CONFIRMATION (FAWRY STYLE)
===================================================== */
exports.confirmManualTopup = onCall({ cors: true }, async (request) => {
    if (!isAdmin(request)) throw new HttpsError("permission-denied", "Admin role required.");
    const { topupId } = request.data;
    if (!topupId) throw new HttpsError("invalid-argument", "Missing topupId");

    const topupRef = db.collection("manualTopups").doc(topupId);

    try {
        await db.runTransaction(async (t) => {
            const topupDoc = await t.get(topupRef);
            if (!topupDoc.exists) throw new HttpsError("not-found", "Top-up request not found.");
            
            const data = topupDoc.data();
            if (data.status === "PAID") return; // Already processed

            const userRef = db.collection("users").doc(data.userId);
            
            t.update(topupRef, { 
                status: "PAID", 
                confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
                confirmedBy: request.auth.uid 
            });

            t.update(userRef, { 
                walletBalance: admin.firestore.FieldValue.increment(data.amount) 
            });
        });
        return { success: true };
    } catch (error) {
        console.error("Confirm Manual Topup Error:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Failed to confirm payment.");
    }
});

exports.rejectManualTopup = onCall({ cors: true }, async (request) => {
    if (!isAdmin(request)) throw new HttpsError("permission-denied", "Admin role required.");
    const { topupId, reason } = request.data;
    if (!topupId) throw new HttpsError("invalid-argument", "Missing topupId");

    try {
        await db.collection("manualTopups").doc(topupId).update({
            status: "REJECTED",
            rejectionReason: reason || "Admin rejected payment.",
            confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
            confirmedBy: request.auth.uid
        });
        return { success: true };
    } catch (error) {
        console.error("Reject Manual Topup Error:", error);
        throw new HttpsError("internal", "Failed to reject payment.");
    }
});


/* =====================================================
   PAYMENT INTENTS (SECURE SERVER-SIDE CONTROL)
===================================================== */

exports.createTopupIntent = onCall({ cors: true }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "User must be logged in.");
    
    const { amount } = request.data;
    if (!amount || amount < 10) throw new HttpsError("invalid-argument", "Minimum topup is 10 EGP");
    if (Number(amount) > 5000) throw new HttpsError("invalid-argument", "Maximum topup is 5000 EGP");

    const userId = request.auth.uid;
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
    const userData = userDoc.data();

    const topupRef = db.collection("topups").doc();
    const topupId = topupRef.id;
    const reference = `topup_${topupId}`;
    const amountCents = Math.round(Number(amount) * 100);

    const payload = {
        country: "EG",
        reference: reference,
        amount: { total: amountCents, currency: "EGP" },
        returnUrl: "https://waslny-e9da9.web.app/payment-success",
        cancelUrl: "https://waslny-e9da9.web.app/payment-cancel",
        callbackUrl: "https://us-central1-waslny-e9da9.cloudfunctions.net/opayWebhook",
        userInfo: { 
            userId: userId, 
            userEmail: userData.email || request.auth.token.email || "user@waslny.com", 
            userMobile: userData.phone || "+201000000000", 
            userName: userData.name || request.auth.token.name || "Waslny User" 
        },
        productList: [{ productId: "WALLET_TOPUP", name: "Wallet Topup", description: "Adding funds to Waslny Wallet", price: amountCents, quantity: 1 }],
        payMethod: "BankCard"
    };

    try {
        const response = await axios.post("https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create", payload, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPAY_PUBLIC_KEY}`, "MerchantId": OPAY_MERCHANT_ID },
            timeout: 15000
        });

        if (response.data.code !== "00000") throw new Error(response.data.message);

        const cashierUrl = response.data.data.cashierUrl;

        await topupRef.set({
            userId,
            amountCents: amountCents,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            cashierUrl
        });

        return { topupId, cashierUrl };
    } catch (error) {
        console.error("OPay Intent Error:", error.response?.data || error.message);
        throw new HttpsError("internal", "Failed to initiate topup");
    }
});

exports.createOPayOrder = onCall({ cors: true }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Auth required");
    const { rideId } = request.data;
    if (!rideId) throw new HttpsError("invalid-argument", "Missing rideId");

    const rideDoc = await db.collection("rides").doc(rideId).get();
    if (!rideDoc.exists) throw new HttpsError("not-found", "Ride not found");
    const rideData = rideDoc.data();

    if (rideData.passengerId !== request.auth.uid) {
        throw new HttpsError("permission-denied", "Unauthorized ride payment attempt.");
    }

    if (rideData.isPaid) {
        throw new HttpsError("already-exists", "Ride is already paid.");
    }

    const userDoc = await db.collection("users").doc(rideData.passengerId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const payload = {
        country: "EG",
        reference: `ride_${rideId}`,
        amount: { total: Math.round(rideData.fare * 100), currency: "EGP" },
        returnUrl: "https://waslny-e9da9.web.app/payment-success",
        cancelUrl: "https://waslny-e9da9.web.app/payment-cancel",
        callbackUrl: "https://us-central1-waslny-e9da9.cloudfunctions.net/opayWebhook",
        userInfo: { 
            userId: rideData.passengerId, 
            userEmail: userData.email || "pax@waslny.com", 
            userMobile: userData.phone || "+201000000000", 
            userName: userData.name || rideData.passengerName || "Passenger" 
        },
        productList: [{ productId: rideId, name: "Ride Payment", description: "Trip payment", price: Math.round(rideData.fare * 100), quantity: 1 }],
        payMethod: "BankCard"
    };

    try {
        const response = await axios.post("https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create", payload, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPAY_PUBLIC_KEY}`, "MerchantId": OPAY_MERCHANT_ID },
            timeout: 15000
        });
        if (response.data.code !== "00000") throw new Error(response.data.message);
        return { cashierUrl: response.data.data.cashierUrl };
    } catch (error) {
        console.error("OPay Ride Error:", error.response?.data || error.message);
        throw new HttpsError("internal", "Payment creation failed");
    }
});

exports.opayWebhook = onRequest(async (req, res) => {
    const payload = req.body?.payload;
    if (!payload || payload.status !== "SUCCESS") { 
        res.status(200).send("IGNORE"); 
        return; 
    }

    const reference = payload.reference;
    const amountCentsFromOpay = Number(payload.amount);
    const amountEgp = amountCentsFromOpay / 100;

    try {
        if (reference.startsWith('topup_')) {
            const topupId = reference.replace('topup_', '');
            const topupRef = db.collection("topups").doc(topupId);
            
            await db.runTransaction(async (t) => {
                const doc = await t.get(topupRef);
                if (!doc.exists || doc.data().status === "paid") return;
                
                if (doc.data().amountCents !== amountCentsFromOpay) {
                    console.error("Critical: Amount mismatch on topup webhook", { expected: doc.data().amountCents, received: amountCentsFromOpay });
                    t.update(topupRef, { status: "failed", failReason: "AMOUNT_MISMATCH" });
                    return;
                }

                const userId = doc.data().userId;
                t.update(topupRef, { status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp() });
                t.update(db.collection("users").doc(userId), { 
                    walletBalance: admin.firestore.FieldValue.increment(amountEgp) 
                });
            });
        } 
        else if (reference.startsWith('ride_')) {
            const rideId = reference.replace('ride_', '');
            const rideRef = db.collection("rides").doc(rideId);

            await db.runTransaction(async (t) => {
                const doc = await t.get(rideRef);
                if (!doc.exists || doc.data().isPaid) return;
                
                const data = doc.data();
                
                if (Math.round(data.fare * 100) !== amountCentsFromOpay) {
                    console.error("Critical: Amount mismatch on ride webhook", { expected: Math.round(data.fare * 100), received: amountCentsFromOpay });
                    t.update(rideRef, { paymentStatus: "MISMATCH" });
                    return;
                }

                const adminComm = amountEgp * 0.1;
                const driverNet = amountEgp - adminComm;

                t.update(rideRef, { 
                    isPaid: true, 
                    status: "COMPLETED", 
                    adminCommission: adminComm, 
                    driverEarning: driverNet,
                    paymentTimestamp: admin.firestore.FieldValue.serverTimestamp() 
                });
                
                if (data.driverId) {
                    t.update(db.collection("users").doc(data.driverId), { 
                        walletBalance: admin.firestore.FieldValue.increment(driverNet),
                        earnings: admin.firestore.FieldValue.increment(driverNet),
                        totalRides: admin.firestore.FieldValue.increment(1)
                    });
                }
            });
        }
        res.status(200).send("OK");
    } catch (e) {
        console.error("Webhook Processing Error:", e);
        res.status(200).send("OK_WITH_ERROR");
    }
});

/* =====================================================
   CORE LOGIC (CLEANUP & NOTIFICATIONS)
===================================================== */

exports.cleanupExpiredRidesV2 = onSchedule("every 1 minutes", async (event) => {
    const now = Date.now();
    // Target rides that haven't been accepted for 10 minutes
    const timeoutThreshold = now - 600000; // 10 minutes (600,000 ms)
    
    // Statuses that qualify as "pending/no action"
    const pendingStatuses = ['SEARCHING', 'OFFER_RECEIVED'];
    
    const ridesRef = db.collection('rides');
    
    // Query for rides older than 10 mins in pending state
    // Note: This requires a composite index on status + timestamp
    const expiredRidesQuery = ridesRef.where('status', 'in', pendingStatuses).where('timestamp', '<', timeoutThreshold);
    
    const snapshot = await expiredRidesQuery.get();
    if (snapshot.empty) return null;

    console.log(`Found ${snapshot.size} expired rides to clean up.`);

    const results = [];
    for (const doc of snapshot.docs) {
        const rideId = doc.id;
        const rideData = doc.data();
        
        // 1. Cancel the ride
        const updateTask = doc.ref.update({ 
            status: 'CANCELLED', 
            cancelledBy: 'system',
            cancelReason: 'Inactivity timeout (10 mins)',
            closedAt: admin.firestore.FieldValue.serverTimestamp() 
        });

        // 2. Add system chat message explaining the reason
        const msgEn = "Trip cancelled by system due to no action or connection issues.";
        const msgAr = "تم إلغاء الرحلة تلقائياً لعدم وجود استجابة أو لضعف الاتصال بالإنترنت.";
        
        const messageTask = ridesRef.doc(rideId).collection('messages').add({
            senderId: 'system',
            text: msgAr, // Defaulting to Arabic per requirement
            text_en: msgEn,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            isSystem: true
        });

        // 3. Notify the passenger if token exists
        let notifyTask = Promise.resolve();
        if (rideData.passengerId) {
            const userDoc = await db.collection("users").doc(rideData.passengerId).get();
            const token = userDoc.data()?.fcmToken;
            if (token) {
                notifyTask = admin.messaging().send({
                    notification: {
                        title: "تنبيه النظام ⚠️",
                        body: "تم إلغاء طلبك تلقائياً لعدم العثور على سائق في خلال ١٠ دقائق."
                    },
                    data: { type: "SYSTEM_CANCEL", rideId: rideId },
                    token: token
                }).catch(e => console.error("FCM System Cancel Error", e));
            }
        }

        results.push(Promise.all([updateTask, messageTask, notifyTask]));
    }
    
    await Promise.all(results);
    console.log(`System cleaned up ${snapshot.size} expired trips.`);
    return null;
});

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  var R = 6371; var dLat = deg2rad(lat2 - lat1); var dLon = deg2rad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

async function notifyNearbyDrivers(ride) {
    if (!ride || !ride.pickup?.coords) return [];
    const searchRadiusKm = ride.searchRadiusKm || 3;
    const previouslyNotified = ride.notifiedDriverIds || [];
    const driversSnapshot = await db.collection("users").where("role", "==", "DRIVER").where("isOnline", "==", true).where("status", "==", "approved").get();
    if (driversSnapshot.empty) return [];
    const eligibleDrivers = [];
    driversSnapshot.forEach(doc => {
        const driver = { id: doc.id, ...doc.data() };
        if (previouslyNotified.includes(driver.id)) return;
        if (!driver.currentLocation || !driver.fcmToken) return;
        const distance = getDistanceFromLatLonInKm(ride.pickup.coords.lat, ride.pickup.coords.lng, driver.currentLocation.lat, driver.currentLocation.lng);
        if (distance <= searchRadiusKm && distance <= (driver.searchRadius || 5)) eligibleDrivers.push(driver);
    });
    if (eligibleDrivers.length === 0) return [];
    const tokens = eligibleDrivers.map(d => d.fcmToken).filter(Boolean);
    const notifiedIds = eligibleDrivers.map(d => d.id);
    if(tokens.length === 0) return [];
    const isParcel = ride.rideType === 'PARCEL';
    const title = isParcel ? "طلب توصيل طرد! 📦" : "طلب رحلة جديد! 🚗";
    const body = `من: ${ride.pickup.address.substring(0, 50)}... | الأجرة: ${ride.fare} ج.م`;
    await admin.messaging().sendEachForMulticast({
        data: { type: "NEW_RIDE_REQUEST", rideId: ride.id },
        notification: { title, body },
        android: { priority: "high", notification: { sound: "default", channelId: "rides-channel" } },
        apns: { payload: { aps: { sound: "default" } } },
        tokens
    });
    return notifiedIds;
}

exports.onDriverStatusUpdated = onDocumentUpdated("users/{userId}", async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    if (!afterData.fcmToken) return;
    const statusBefore = beforeData.status || beforeData.driverStatus;
    const statusAfter = afterData.status || afterData.driverStatus;
    if (statusBefore !== statusAfter) {
        let title = ""; let body = "";
        if (statusAfter === "approved") { title = "تهانينا! تم قبول طلبك 🎉"; body = "أصبحت الآن كابتن معتمد في وصلني."; }
        else if (statusAfter === "rejected") { title = "تم رفض طلب التسجيل ❌"; body = "يرجى مراجعة الملف الشخصي ورفع مستندات جديدة واضحة."; }
        if (title && body) { await admin.messaging().send({ notification: { title, body }, data: { type: "STATUS_UPDATE", status: statusAfter }, token: afterData.fcmToken }); }
    }
});

exports.onRideCreated = onDocumentCreated("rides/{rideId}", async (event) => {
    const rideData = event.data.data();
    if (!rideData || rideData.status !== 'SEARCHING') return;
    const notifiedIds = await notifyNearbyDrivers({ id: event.params.rideId, ...rideData });
    if (notifiedIds.length > 0) await db.collection("rides").doc(event.params.rideId).update({ notifiedDriverIds: admin.firestore.FieldValue.arrayUnion(...notifiedIds) });
});

exports.onRideSearchUpdated = onDocumentUpdated("rides/{rideId}", async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    if ((afterData.status === 'SEARCHING' || afterData.status === 'OFFER_RECEIVED') && beforeData.searchRadiusKm !== afterData.searchRadiusKm) {
        const newlyNotifiedIds = await notifyNearbyDrivers({ id: event.params.rideId, ...afterData });
        if (newlyNotifiedIds.length > 0) await db.collection("rides").doc(event.params.rideId).update({ notifiedDriverIds: admin.firestore.FieldValue.arrayUnion(...newlyNotifiedIds) });
    }
});

exports.onOfferCreated = onDocumentCreated("rides/{rideId}/offers/{offerId}", async (event) => {
    try {
        const rideDoc = await db.collection("rides").doc(event.params.rideId).get();
        if (!rideDoc.exists) return;
        const userDoc = await db.collection("users").doc(rideDoc.data().passengerId).get();
        if (userDoc.data()?.fcmToken) await admin.messaging().send({ notification: { title: "عرض سعر جديد! 💰", body: `سائق يقدم عرضاً بقيمة ${event.data.data().price} ج.م` }, token: userDoc.data().fcmToken });
    } catch (e) { console.error(e); }
});

exports.onCounterOfferCreated = onDocumentUpdated("rides/{rideId}/offers/{offerId}", async (event) => {
    const newData = event.data.after.data();
    const oldData = event.data.before.data();

    // Check if a counter offer was just added
    if (newData.status === 'countered' && oldData.status !== 'countered') {
        const { driverId, passengerCounterPrice } = newData;
        const rideId = event.params.rideId;
        const offerId = event.params.offerId;
        
        const driverDoc = await db.collection("users").doc(driverId).get();
        if (!driverDoc.exists() || !driverDoc.data().fcmToken) {
            console.log(`Driver ${driverId} not found or has no token.`);
            return;
        }
        
        const rideDoc = await db.collection("rides").doc(rideId).get();
        const passengerName = rideDoc.data()?.passengerName || "A passenger";

        const token = driverDoc.data().fcmToken;
        const title = `💰 عرض مضاد من ${passengerName}!`;
        const body = `عرض جديد: ${passengerCounterPrice} ج.م. اضغط للمراجعة.`;

        try {
            await admin.messaging().send({
                notification: { title, body },
                data: {
                    type: "COUNTER_OFFER",
                    rideId: rideId,
                    offerId: offerId,
                    price: String(passengerCounterPrice)
                },
                token: token,
                android: { priority: "high", notification: { sound: "default", channelId: "rides-channel" } },
                apns: { payload: { aps: { sound: "default" } } },
            });
            console.log(`Sent counter offer notification to driver ${driverId}`);
        } catch(e) {
            console.error("FCM counter offer error", e);
        }
    }
});

exports.onOfferRejected = onDocumentUpdated("rides/{rideId}/offers/{offerId}", async (event) => {
    const newData = event.data.after.data();
    const oldData = event.data.before.data();
    if (oldData.status !== "rejected" && newData.status === "rejected") {
        const driverDoc = await db.collection("users").doc(newData.driverId).get();
        if (driverDoc.exists && driverDoc.data().fcmToken) await admin.messaging().send({ notification: { title: "تم رفض العرض ❌", body: "Your offer was refused. You can submit a new price now." }, token: driverDoc.data().fcmToken });
    }
});

exports.onReviewCreated = onDocumentCreated("reviews/{reviewId}", async (event) => {
    const { targetUserId, rating } = event.data.data();
    if (!targetUserId || typeof rating !== "number") return null;
    const userRef = db.collection("users").doc(targetUserId);
    await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) return;
        const { rating: currentRating = 0, totalRatings = 0 } = userDoc.data();
        const newTotalRatings = totalRatings + 1;
        const newRating = ((currentRating * totalRatings) + rating) / newTotalRatings;
        t.update(userRef, { rating: newRating, totalRatings: newTotalRatings });
    });
});

exports.triggerSOS = onCall({ cors: true }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");
    const { rideId, location, userRole } = request.data;
    const rideRef = db.collection("rides").doc(rideId);
    await rideRef.update({ sosEvent: { triggeredBy: userRole, location: new admin.firestore.GeoPoint(location.lat, location.lng), timestamp: admin.firestore.FieldValue.serverTimestamp() } });
    return { success: true };
});

exports.sendBroadcastNotification = onCall({ cors: true }, async (request) => {
    if (!request.auth || request.auth.token.email !== "wondersco@gmail.com") throw new HttpsError("permission-denied", "Unauthorized.");
    const { title, body } = request.data;
    const usersSnapshot = await db.collection("users").where("fcmToken", "!=", null).get();
    const tokens = []; usersSnapshot.forEach(doc => tokens.push(doc.data().fcmToken));
    if (tokens.length === 0) return { success: true, sentCount: 0 };
    let successCount = 0;
    for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const response = await admin.messaging().sendEachForMulticast({ notification: { title, body }, tokens: chunk });
        successCount += response.successCount;
    }
    return { success: true, sentCount: successCount };
});

exports.generateCustomToken = onCall({ cors: true }, async (request) => {
  const { sessionId } = request.data;
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "Session ID is required");
  }
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "User must be logged in");
  }

  try {
    const customToken = await admin.auth().createCustomToken(request.auth.uid);
    await db.collection("auth_sessions").doc(sessionId).set({
      token: customToken,
      uid: request.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    console.error("Error generating custom token:", error);
    throw new HttpsError("internal", "Failed to generate custom token");
  }
});

exports.sendOtp = onCall({ cors: true }, async (request) => {
  const { phone } = request.data;

  if (!phone) {
    throw new HttpsError("invalid-argument", "Phone number is required");
  }

  const otp = Math.floor(100000 + Math.random() * 900000);

  try {
    // Store OTP in Firestore to verify later
    await db.collection("otps").doc(phone).set({
      otp: otp.toString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000) // 10 mins expiry
    });

    await twilioClient.messages.create({
      body: `Your OTP code is ${otp}`,
      messagingServiceSid: "MG99426f537cb229f146666b021cb870ad",
      to: `whatsapp:${phone}`,
    });

    return { success: true };
  } catch (error) {
    console.error("Twilio Error:", error);
    throw new HttpsError("internal", error.message);
  }
});

exports.verifyOtp = onCall({ cors: true }, async (request) => {
  const { phone, otp } = request.data;
  if (!phone || !otp) {
    throw new HttpsError("invalid-argument", "Phone and OTP are required.");
  }

  const otpDoc = await db.collection("otps").doc(phone).get();
  if (!otpDoc.exists) {
    throw new HttpsError("not-found", "OTP not found or expired.");
  }

  const data = otpDoc.data();
  if (data.otp !== otp) {
    throw new HttpsError("invalid-argument", "Invalid OTP.");
  }

  if (data.expiresAt.toMillis() < Date.now()) {
    throw new HttpsError("failed-precondition", "OTP expired.");
  }

  // OTP is valid, delete it
  await db.collection("otps").doc(phone).delete();

  // Create a custom token for the user
  try {
    // Check if user exists, if not create one
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByPhoneNumber(phone);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        userRecord = await admin.auth().createUser({
          phoneNumber: phone,
        });
      } else {
        throw e;
      }
    }

    const customToken = await admin.auth().createCustomToken(userRecord.uid);
    return { success: true, customToken };
  } catch (error) {
    console.error("Auth Error:", error);
    throw new HttpsError("internal", "Failed to authenticate user.");
  }
});
