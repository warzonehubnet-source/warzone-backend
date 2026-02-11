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
    🆕 USER INITIALIZATION API
    Called after registration to initialize wallet
    and leaderboard entry via Admin SDK (bypasses rules)
   ============================================= */
app.post("/api/user/init", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { username, email } = req.body;

    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/current`);
    const leaderboardRef = db.doc(`artifacts/${APP_ID}/public/data/leaderboard/${uid}`);

    // Only initialize if wallet doesn't exist yet (idempotent)
    const walletSnap = await walletRef.get();
    if (!walletSnap.exists) {
      await walletRef.set({
        available: 0,
        locked: 0,
        lastUpdated: Date.now()
      });
    }

    // Only initialize leaderboard if not exists
    const lbSnap = await leaderboardRef.get();
    if (!lbSnap.exists) {
      await leaderboardRef.set({
        username: username || 'Recruit',
        email: email || '',
        wins: 0,
        winnings: 0,
        joined: Date.now()
      });
    }

    res.json({ success: true, message: "Unit initialized successfully." });
  } catch (err) {
    console.error("User init error:", err);
    res.status(500).json({ error: "Initialization failed" });
  }
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
    const { amount, paymentRef, utr } = req.body;
    const uid = req.uid;

    const ref = paymentRef || utr; 

    if (!amount || !ref || amount < 20) {
      return res.status(400).json({ error: "Invalid deposit parameters. Min: ₹20" });
    }

    // 🔐 UID-SPECIFIC UTR CHECK
    const existingReq = await db
      .collection(`artifacts/${APP_ID}/public/data/payment_requests`)
      .where("uid", "==", uid)
      .where("paymentRef", "==", ref)
      .limit(1)
      .get();

    if (!existingReq.empty) {
      return res.status(409).json({ error: "This reference has already been submitted by your account." });
    }

    // Create a pending request for Admin approval
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: Number(amount),
      paymentRef: ref,
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

      // Update Wallet: Deposits only increase Available pool
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

    res.json({ success: true, message: "Credits successfully allocated to Unit Available Balance." });
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

    if (!amount || amount < 20 || !upi) {
      return res.status(400).json({ error: "Minimum withdrawal is ₹20" });
    }

    await db.runTransaction(async (t) => {
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (Number(amount) > available) {
        throw new Error("Insufficient available balance for extraction");
      }

      // 🔒 LOCK FUNDS: Move from available pool to locked pool
      t.set(walletRef, {
        available: available - Number(amount),
        locked: locked + Number(amount),
        lastUpdated: Date.now()
      }, { merge: true });

      // Create secure request in payment_requests
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

    res.json({ success: true, message: "Withdrawal request logged. Funds locked in transit." });
  } catch (err) {
    console.error("Withdraw request error:", err);
    res.status(400).json({ error: err.message || "Internal server protocol error" });
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

      if (reqSnap.data().type !== "withdraw") {
        throw new Error("Invalid request type.");
      }

      const { uid, amount } = reqSnap.data();
      // Use ensureWallet for auto-init safety
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);

      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (Number(amount) > locked) {
        throw new Error("Locked balance inconsistency. Cannot approve.");
      }

      // 💸 Finalize Withdrawal: Remove from locked pool (funds sent externally)
      t.set(walletRef, {
        available: available,
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
    👑 ADMIN DENY WITHDRAWAL (REFUND)
   ============================================= */
app.post("/api/admin/withdraw/deny", verifyFirebaseToken, async (req, res) => {
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
      // FIX: Use ensureWallet instead of direct path
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);

      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (Number(amount) > locked) {
        throw new Error("Locked balance inconsistency detected.");
      }

      // 🔁 REFUND: Move from locked pool back to available pool
      t.set(walletRef, {
        available: available + Number(amount),
        locked: Math.max(0, locked - Number(amount)),
        lastUpdated: Date.now()
      }, { merge: true });

      t.update(reqRef, {
        status: "denied",
        deniedBy: adminUid,
        deniedAt: Date.now()
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Withdraw denial error:", err);
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

      // Double join prevention
      const existingPlayer = await t.get(playerRef);
      if (existingPlayer.exists) {
        throw new Error("Unit already deployed in this match.");
      }

      const match = matchSnap.data();

      // Block join after start time
      if (match.startTime && Date.now() >= match.startTime) {
        throw new Error("Match deployment window closed.");
      }

      if (match.status !== "open") throw new Error("Match sector is no longer open for deployment.");

      // 🐛 FIX: SLOT CAPACITY CHECK (CRITICAL BUG)
      const playersSnapshot = await t.get(
        db.collection(`artifacts/${APP_ID}/public/data/matches/${matchId}/players`)
      );
      const currentPlayers = playersSnapshot.size;
      const maxSlots = Number(match.slots || 0);

      if (currentPlayers >= maxSlots) {
        throw new Error("Match is full. All deployment slots occupied.");
      }

      const fee = Number(match.fee || 0);

      // Verify and init wallet
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      if (fee > available) {
        throw new Error("Insufficient available credits for deployment.");
      }

      // 🔒 Lock entry fee in unit war chest
      t.set(walletRef, {
        available: available - fee,
        locked: locked + fee,
        lastUpdated: Date.now()
      }, { merge: true });

      // Register tactical signature in match roster
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

    if (!matchSnap.exists) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = matchSnap.data();

    if (match.status !== "claimed") {
      return res.status(400).json({ error: "Match not finalized" });
    }

    if (match.winnerUID !== uid) {
      return res.status(403).json({ error: "You are not the winner" });
    }

    if (match.payoutStatus === "paid") {
      return res.status(409).json({ error: "Prize already paid" });
    }

    if (match.payoutRequested === true) {
      return res.status(409).json({ error: "Cashout already requested" });
    }

    const prizeAmount = Number(match.prize || match.prizePool || 0);

    if (prizeAmount <= 0) {
      return res.status(400).json({ error: "Invalid prize amount" });
    }

    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid,
      amount: prizeAmount,
      type: "prize",
      matchId,
      status: "pending",
      node: "Match Cashout",
      createdAt: Date.now()
    });

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
      const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);

      const matchSnap = await t.get(matchRef);
      if (!matchSnap.exists || matchSnap.data().status !== "claimed") {
        throw new Error("Associated match is not eligible for payout (Not Claimed)");
      }

      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      // Update Winner Wallet: Prize pool goes to Available pool
      t.set(walletRef, {
        available: available + Number(amount),
        locked: locked,
        lastUpdated: Date.now()
      }, { merge: true });

      t.update(reqRef, {
        status: "approved",
        approvedBy: req.uid,
        approvedAt: Date.now()
      });

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
   👑 ADMIN SETTLE MATCH FUNDS (CLEARS LOCKED FEES)
   ============================================= */
app.post("/api/admin/match/settle", verifyFirebaseToken, async (req, res) => {
  try {
    const { matchId, winnerUID } = req.body;

    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);
    const playersSnap = await db
      .collection(`artifacts/${APP_ID}/public/data/matches/${matchId}/players`)
      .get();

    await db.runTransaction(async (t) => {
      const matchSnap = await t.get(matchRef);
      if (!matchSnap.exists) throw new Error("Match not found");

      // Single settlement check
      if (matchSnap.data().status === "claimed") {
        throw new Error("Match already settled.");
      }

      // Process roster to clear locked entry fees (fees are spent upon settlement)
      for (const p of playersSnap.docs) {
        const pData = p.data();
        const walletRef = await ensureWallet(t, p.id);
        const walletSnap = await t.get(walletRef);

        const available = Number(walletSnap.data().available || 0);
        const locked = Number(walletSnap.data().locked || 0);
        const fee = Number(pData.feeLocked || 0);

        // Deduct fee from locked pool (effectively burning it from user wallet)
        t.set(walletRef, {
          available: available,
          locked: Math.max(0, locked - fee),
          lastUpdated: Date.now()
        }, { merge: true });
      }

      t.update(matchRef, {
        status: "claimed",
        winnerUID,
        claimedAt: Date.now()
      });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Match settle error:", err);
    res.status(500).json({ error: err.message });
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

    const { game, mode, map, slots, fee, prize, startTime } = req.body;

    if (!startTime || typeof startTime !== "number") {
      return res.status(400).json({ error: "Invalid match start time" });
    }

    await db.collection(`artifacts/${APP_ID}/public/data/matches`).add({
      game,
      mode,
      map,
      slots: Number(slots),
      fee: Number(fee),
      prize: Number(prize),
      startTime,
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
app.listen(PORT, () => console.log(`*** Warzone Hub Secure Node: Running on port ${PORT} ***`));