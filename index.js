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
    💰 PLAYER DEPOSIT REQUEST API
   ============================================= */
app.post("/api/wallet/deposit/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, paymentRef } = req.body;
    const uid = req.uid;

    if (!amount || !paymentRef || amount < 20) {
      return res.status(400).json({ error: "Invalid deposit parameters. Min: ₹20" });
    }

    // 🔐 UID-SPECIFIC UTR CHECK
    const existingReq = await db
      .collection(`artifacts/${APP_ID}/public/data/payment_requests`)
      .where("uid", "==", uid)
      .where("paymentRef", "==", paymentRef)
      .limit(1)
      .get();

    if (!existingReq.empty) {
      return res.status(409).json({ error: "This reference has already been submitted by your account." });
    }

    // Create a pending request for Admin approval
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: Number(amount),
      paymentRef,
      type: "deposit",
      status: "pending",
      node: "Player Terminal",
      timestamp: Date.now()
    });

    res.json({ success: true, message: "Deposit request transmitted to Command Center." });
  } catch (err) {
    console.error("Deposit Request Error:", err);
    res.status(500).json({ error: "Internal Server Protocol Error" });
  }
});

/* =============================================
    👑 ADMIN DEPOSIT APPROVAL API
   ============================================= */
app.post("/api/admin/deposit/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const { requestId } = req.body;
    const adminUid = req.uid;

    // Verify Admin Role
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${adminUid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') {
      return res.status(403).json({ error: "Access Denied: Admin privileges required." });
    }

    const requestRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);
    
    await db.runTransaction(async (t) => {
      const reqDoc = await t.get(requestRef);
      if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
        throw new Error("Request already processed or invalid.");
      }

      const { uid, amount } = reqDoc.data();
      const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
      const walletSnap = await t.get(walletRef);
      
      const currentBalance = walletSnap.exists ? (Number(walletSnap.data().amount) || 0) : 0;

      // Update Wallet
      t.set(walletRef, {
        amount: currentBalance + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });

      // Update Request Status
      t.update(requestRef, { 
        status: "approved",
        approvedBy: adminUid,
        finalizedAt: Date.now()
      });
    });

    res.json({ success: true, message: "Credits successfully allocated to Unit War Chest." });
  } catch (err) {
    console.error("Admin Approval Error:", err);
    res.status(500).json({ error: err.message || "Approval Protocol Failed." });
  }
});

/* =============================================
    💸 SECURE WITHDRAWAL REQUEST API
   ============================================= */
app.post("/api/wallet/withdraw/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, upi } = req.body;
    const uid = req.uid;

    if (!amount || amount < 50 || !upi) {
      return res.status(400).json({ error: "Invalid withdrawal parameters. Min: ₹50" });
    }

    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
    const walletSnap = await walletRef.get();
    const balance = walletSnap.exists ? Number(walletSnap.data().amount || 0) : 0;

    // Tactical Balance Check
    if (amount > balance) {
      return res.status(400).json({ error: "Insufficient balance for extraction" });
    }

    // Create secure request in payment_requests
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: Number(amount),
      upi,
      type: "withdraw",
      status: "pending",
      timestamp: Date.now(),
      node: "Secure Backend"
    });

    res.json({ success: true, message: "Extraction request logged. Awaiting Command clearance." });
  } catch (err) {
    console.error("Withdraw request error:", err);
    res.status(500).json({ error: "Internal server protocol error" });
  }
});

/* =============================================
   🏆 WINNER CASHOUT REQUEST
   ============================================= */
app.post("/api/match/cashout/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { matchId } = req.body;
    const uid = req.uid;

    const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);
    const matchSnap = await matchRef.get();

    if (!matchSnap.exists) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = matchSnap.data();

    // 🔐 SECURITY CHECKS
    if (match.status !== "claimed") {
      return res.status(400).json({ error: "Match not finalized" });
    }

    if (match.winnerUID !== uid) {
      return res.status(403).json({ error: "You are not the winner" });
    }

    if (match.payoutStatus === "paid") {
      return res.status(409).json({ error: "Prize already paid" });
    }

    // FIX 1: Block double cashout requests
    if (match.payoutRequested === true) {
      return res.status(409).json({ error: "Cashout already requested" });
    }

    // Standardize prize field lookup
    const prizeAmount = Number(match.prize || match.prizePool || 0);

    // FIX 2: Prize amount zero protection
    if (prizeAmount <= 0) {
      return res.status(400).json({ error: "Invalid prize amount" });
    }

    // Create payout request (NO WALLET CREDIT YET)
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: prizeAmount,
      type: "prize",
      matchId,
      status: "pending",
      node: "Match Cashout",
      timestamp: Date.now()
    });

    // Lock match to prevent duplicate requests
    await matchRef.update({
      payoutRequested: true,
      payoutRequestedAt: Date.now()
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Cashout request error:", err);
    res.status(500).json({ error: "Cashout failed" });
  }
});

/* =============================================
   👑 ADMIN APPROVE PRIZE PAYOUT
   ============================================= */
app.post("/api/admin/prize/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const { requestId } = req.body;

    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    const reqRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);

    await db.runTransaction(async (t) => {
      const reqSnap = await t.get(reqRef);
      if (!reqSnap.exists || reqSnap.data().status !== "pending") {
        throw new Error("Invalid or already processed request");
      }

      const { uid, amount, matchId } = reqSnap.data();
      const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
      const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);

      // FIX 3: Match status check in prize approval
      const matchSnap = await t.get(matchRef);
      if (!matchSnap.exists || matchSnap.data().status !== "claimed") {
        throw new Error("Associated match is not eligible for payout (Not Claimed)");
      }

      const walletSnap = await t.get(walletRef);
      const balance = walletSnap.exists ? Number(walletSnap.data().amount) : 0;

      // Update Winner Wallet
      t.set(walletRef, {
        amount: balance + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });

      // Update Request Status
      t.update(reqRef, {
        status: "approved",
        approvedBy: req.uid,
        finalizedAt: Date.now()
      });

      // Update Match Record
      t.update(matchRef, {
        payoutStatus: "paid",
        paidAt: Date.now()
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Prize approval error:", err);
    res.status(500).json({ error: err.message || "Prize approval failed" });
  }
});

/* =============================================
   👑 ADMIN CREATE MATCH
   ============================================= */
app.post("/api/admin/match/create", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    const { game, mode, map, totalSlots, entryFee, prizePool } = req.body;

    await db.collection(`artifacts/${APP_ID}/public/data/matches`).add({
      game,
      mode,
      map,
      slots: Number(totalSlots),
      fee: Number(entryFee),
      prize: Number(prizePool),
      status: "open",
      timestamp: Date.now(),
      createdBy: req.uid
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Match create error:", err);
    res.status(500).json({ error: "Match creation failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`*** Warzone Secure Node running on port ${PORT} ***`));