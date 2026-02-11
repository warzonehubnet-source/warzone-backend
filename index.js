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
    🛡️ WALLET INITIALIZATION HELPER
   ============================================= */
async function ensureWallet(t, uid) {
  const ref = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
  const snap = await t.get(ref);
  if (!snap.exists) {
    // Proactively initialize 0/0 balance for new units
    t.set(ref, { 
        available: 0, 
        locked: 0, 
        lastUpdated: Date.now() 
    });
  }
  return ref;
}

/* =============================================
    💰 PLAYER DEPOSIT REQUEST API
   ============================================= */
app.post("/api/wallet/deposit/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, utr } = req.body;
    const uid = req.uid;

    if (!amount || !utr || Number(amount) < 20) {
      return res.status(400).json({ error: "Invalid deposit parameters. Min: ₹20" });
    }

    // 🔐 UID-SPECIFIC UTR CHECK (Prevent double submission of same receipt)
    const existingReq = await db
      .collection(`artifacts/${APP_ID}/public/data/payment_requests`)
      .where("uid", "==", uid)
      .where("paymentRef", "==", utr)
      .limit(1)
      .get();

    if (!existingReq.empty) {
      return res.status(409).json({ error: "This reference has already been submitted by your account." });
    }

    // Create a pending request for Admin approval
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: Number(amount),
      paymentRef: utr,
      type: "deposit",
      status: "pending",
      node: "Player Terminal",
      createdAt: Date.now()
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
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      // Update Wallet: Deposits increase Available pool
      t.set(walletRef, {
        available: available + Number(amount),
        locked: locked,
        lastUpdated: Date.now()
      }, { merge: true });

      // Update Request Status
      t.update(requestRef, { 
        status: "approved",
        approvedBy: adminUid,
        approvedAt: Date.now()
      });
    });

    res.json({ success: true, message: "Credits successfully allocated." });
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

    if (!amount || Number(amount) < 20 || !upi) {
      return res.status(400).json({ error: "Minimum withdrawal is ₹20" });
    }

    await db.runTransaction(async (t) => {
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (Number(amount) > available) {
        throw new Error("Insufficient available balance.");
      }

      // 🔒 LOCK FUNDS: Move from available to locked pool
      t.set(walletRef, {
        available: available - Number(amount),
        locked: locked + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });

      // Create request
      const reqCol = db.collection(`artifacts/${APP_ID}/public/data/payment_requests`);
      t.set(reqCol.doc(), {
        uid,
        amount: Number(amount),
        upi,
        type: "withdraw",
        status: "pending",
        createdAt: Date.now(),
        node: "Secure Backend"
      });
    });

    res.json({ success: true, message: "Withdrawal request logged. Funds locked." });
  } catch (err) {
    console.error("Withdraw request error:", err);
    res.status(400).json({ error: err.message || "Internal server error" });
  }
});

/* =============================================
    👑 ADMIN APPROVE WITHDRAWAL
   ============================================= */
app.post("/api/admin/withdraw/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const { requestId } = req.body;
    const adminUid = req.uid;

    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${adminUid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    const reqRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);

    await db.runTransaction(async (t) => {
      const reqSnap = await t.get(reqRef);
      if (!reqSnap.exists || reqSnap.data().status !== "pending") {
        throw new Error("Invalid request state");
      }

      const { uid, amount } = reqSnap.data();
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);

      const locked = Number(walletSnap.data().locked || 0);

      // Clear from locked pool since it's now paid out manually
      t.set(walletRef, {
        locked: Math.max(0, locked - Number(amount)),
        lastUpdated: Date.now()
      }, { merge: true });

      t.update(reqRef, {
        status: "approved",
        approvedBy: adminUid,
        approvedAt: Date.now()
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Withdraw approval error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =============================================
   🎮 PLAYER JOIN MATCH (LOCK ENTRY FEE)
   ============================================= */
app.post("/api/match/join", verifyFirebaseToken, async (req, res) => {
  try {
    const { matchId } = req.body;
    const uid = req.uid;

    const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);
    const playerRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}/players/${uid}`);

    await db.runTransaction(async (t) => {
      const matchSnap = await t.get(matchRef);
      if (!matchSnap.exists) throw new Error("Match not found");

      const existingPlayer = await t.get(playerRef);
      if (existingPlayer.exists) throw new Error("Unit already deployed.");

      const match = matchSnap.data();
      if (match.status !== "open") throw new Error("Match lobby closed.");

      const currentCount = Number(match.joinedCount || 0);
      const totalSlots = Number(match.slots || 2);
      if (currentCount >= totalSlots) throw new Error("Sector Load Full.");

      const fee = Number(match.fee || 0);
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (fee > available) throw new Error("Insufficient Available Credits.");

      // 🔒 Lock fee
      t.set(walletRef, {
        available: available - fee,
        locked: locked + fee,
        lastUpdated: Date.now()
      }, { merge: true });

      // Update count
      t.update(matchRef, { joinedCount: currentCount + 1 });

      // Register player
      t.set(playerRef, {
        uid,
        joinedAt: Date.now(),
        feeLocked: fee,
        status: "confirmed"
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Match join error:", err);
    res.status(400).json({ error: err.message });
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

    if (!matchSnap.exists) return res.status(404).json({ error: "Match not found" });
    const match = matchSnap.data();

    if (match.status !== "claimed" || match.winnerUID !== uid) {
      return res.status(403).json({ error: "Unauthorized victory claim" });
    }

    if (match.payoutRequested) return res.status(409).json({ error: "Already requested" });

    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: Number(match.prize || 0),
      type: "prize",
      matchId,
      status: "pending",
      createdAt: Date.now()
    });

    await matchRef.update({ payoutRequested: true, payoutRequestedAt: Date.now() });

    res.json({ success: true });
  } catch (err) {
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
      if (!reqSnap.exists || reqSnap.data().status !== "pending") throw new Error("Invalid request");

      const { uid, amount, matchId } = reqSnap.data();
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      
      const available = Number(walletSnap.data().available || 0);

      // Credit the winner's Available balance
      t.set(walletRef, {
        available: available + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });

      t.update(reqRef, { status: "approved", approvedBy: req.uid, approvedAt: Date.now() });
      t.update(db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`), { payoutStatus: "paid" });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =============================================
    👑 ADMIN CREATE MATCH
   ============================================= */
app.post("/api/admin/match/create", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    // Allow admins OR authenticated users (for Forge wizard) to create matches as per rules
    // But we check admin role if you want strict restriction for certain games here
    
    const { game, mode, map, slots, fee, prize, startTime } = req.body;

    if (!startTime) return res.status(400).json({ error: "Invalid start time" });

    await db.collection(`artifacts/${APP_ID}/public/data/matches`).add({
      game,
      mode,
      map: map || "Any",
      slots: Number(slots || 2),
      fee: Number(fee || 0),
      prize: Number(prize || 0),
      startTime: Number(startTime),
      status: "open",
      joinedCount: 0,
      timestamp: Date.now(),
      createdBy: req.uid
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Match creation failed" });
  }
});

// Port Binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`*** Warzone Hub Secure Node: Running on port ${PORT} ***`));