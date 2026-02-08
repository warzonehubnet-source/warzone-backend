const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
// On Render, we'll use the environment variable for credentials
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
   💰 SECURE WALLET CREDIT API
   ============================================= */
app.post("/api/wallet/credit", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, paymentId } = req.body;
    const uid = req.uid; // 🔐 Extracted from verified token

    if (!amount || !paymentId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // PATH FIX: Matching your frontend's 'wallet/current' path
    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
    const txCollection = db.collection(`artifacts/${APP_ID}/public/data/payment_requests`);

    // 🔐 1. Prevent duplicate paymentId (Idempotency)
    const existingTx = await txCollection
      .where("paymentId", "==", paymentId)
      .limit(1)
      .get();

    if (!existingTx.empty) {
      return res.status(409).json({ error: "Payment already processed" });
    }

    // 🔐 2. Atomic Transaction
    await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      const currentBalance = walletSnap.exists ? (Number(walletSnap.data().amount) || 0) : 0;

      // Log the transaction publicly for Admin view
      t.set(txCollection.doc(), {
        uid,
        amount,
        paymentId,
        type: "deposit",
        status: "approved",
        node: "Automated API",
        timestamp: Date.now()
      });

      // Update the user's private wallet
      t.set(walletRef, {
        amount: currentBalance + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });
    });

    res.json({ success: true, newBalance: 'updated' });
  } catch (err) {
    console.error("Wallet Credit Error:", err);
    res.status(500).json({ error: "Internal Server Protocol Error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`*** Warzone Secure Node running on port ${PORT} ***`));