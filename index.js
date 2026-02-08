const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  // Fallback for local development
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
const APP_ID = "warzone-hub-prod-v2";

// Health check
app.get("/", (req, res) => {
  res.send("Warzone Hub Backend Secure Node: ONLINE ✅");
});

/* =============================================
   🔐 AUTHENTICATION MIDDLEWARE
   ============================================= */
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid token" });
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    // 🔐 UID is now locked to the authenticated user
    req.uid = decodedToken.uid;
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(401).json({ error: "Unauthorized" });
  }
};

/* =============================================
   💰 SECURE WALLET CREDIT API (Auto-Approved)
   ============================================= */
app.post("/api/wallet/credit", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, paymentId } = req.body;
    const uid = req.uid;

    if (!amount || !paymentId || amount <= 0) {
      return res.status(400).json({ error: "Invalid credit request" });
    }

    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
    const txCollection = db.collection(`artifacts/${APP_ID}/public/data/payment_requests`);

    // 🔐 Idempotency Check
    const existingTx = await txCollection.where("paymentId", "==", paymentId).limit(1).get();
    if (!existingTx.empty) {
      return res.status(409).json({ error: "Payment already processed" });
    }

    await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      const currentBalance = walletSnap.exists ? (Number(walletSnap.data().amount) || 0) : 0;

      t.set(txCollection.doc(), {
        uid,
        amount,
        paymentId,
        type: "deposit",
        status: "approved",
        node: "Automated API",
        timestamp: Date.now()
      });

      t.set(walletRef, {
        amount: currentBalance + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Wallet Credit Error:", err);
    res.status(500).json({ error: "Internal Server Protocol Error" });
  }
});

/* =============================================
   💸 SECURE WITHDRAWAL REQUEST API
   ============================================= */
app.post("/api/wallet/withdraw/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, upi } = req.body;
    const uid = req.uid;

    if (!amount || amount <= 0 || !upi) {
      return res.status(400).json({ error: "Invalid withdrawal parameters" });
    }

    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
    const walletSnap = await walletRef.get();
    const balance = walletSnap.exists ? Number(walletSnap.data().amount || 0) : 0;

    // Tactical Balance Check
    if (amount > balance) {
      return res.status(400).json({ error: "Insufficient balance for extraction" });
    }

    // Create secure request in payment_requests
    // Mapping to payment_requests ensures history visibility in wallet.html
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount,
      upi,
      type: "withdraw",
      status: "pending",
      timestamp: Date.now(),
      node: "Secure Backend"
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Withdraw request error:", err);
    res.status(500).json({ error: "Internal server protocol error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`*** Warzone Secure Node running on port ${PORT} ***`));