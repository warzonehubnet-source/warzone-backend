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
    t.set(ref, { 
        available: 0, 
        locked: 0, 
        lastUpdated: Date.now() 
    });
  }
  return ref;
}

/* =============================================
    🔥 USER ARENA FORGE (CREATE & DEDUCT)
   ============================================= */
app.post("/api/arena/match/create", verifyFirebaseToken, async (req, res) => {
  try {
    const { game, mode, map, fee, startTime, leaderIGN, teammates } = req.body;
    const uid = req.uid;

    if (!fee || Number(fee) < 20) {
      return res.status(400).json({ error: "Minimum deployment fee is ₹20." });
    }

    const result = await db.runTransaction(async (t) => {
      const walletRef = await ensureWallet(t, uid);
      const walletSnap = await t.get(walletRef);
      const available = Number(walletSnap.data().available || 0);
      const locked = Number(walletSnap.data().locked || 0);

      const entryFee = Number(fee);

      if (available < entryFee) {
        throw new Error("Insufficient available credits in War Chest.");
      }

      // Create Match Reference
      const matchRef = db.collection(`artifacts/${APP_ID}/public/data/matches`).doc();
      const prize = (entryFee * 2) * 0.93; // 7% Platform Fee

      // 1. Create the Match Document
      t.set(matchRef, {
        game,
        mode,
        map: map || "Any",
        fee: entryFee,
        prize: Number(prize.toFixed(2)),
        startTime: Number(startTime),
        status: "open",
        slots: 2, // PvP matches are always 2 Team slots
        joinedCount: 1, // Creator is joined by default
        timestamp: Date.now(),
        createdBy: uid
      });

      // 2. Register Creator in Players roster
      const playerRef = matchRef.collection("players").doc(uid);
      t.set(playerRef, {
        uid,
        ign: leaderIGN || "Unknown Unit",
        teammates: teammates || [],
        joinedAt: Date.now(),
        feeLocked: entryFee,
        status: "confirmed"
      });

      // 3. Deduct from Wallet
      t.update(walletRef, {
        available: available - entryFee,
        locked: locked + entryFee,
        lastUpdated: Date.now()
      });

      return { matchId: matchRef.id };
    });

    res.json({ success: true, matchId: result.matchId });
  } catch (err) {
    console.error("Arena Forge Error:", err);
    res.status(400).json({ error: err.message });
  }
});

/* =============================================
    💰 FINANCIAL OPERATIONS (DEPOSIT/WITHDRAW)
   ============================================= */
app.post("/api/wallet/deposit/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, utr } = req.body;
    if (!amount || !utr || Number(amount) < 20) return res.status(400).json({ error: "Invalid parameters." });
    
    await db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).add({
      uid: req.uid,
      amount: Number(amount),
      paymentRef: utr,
      type: "deposit",
      status: "pending",
      createdAt: Date.now()
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Deposit Protocol Error" }); }
});

app.post("/api/admin/deposit/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') return res.status(403).json({ error: "Admin only" });

    const { requestId } = req.body;
    const requestRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);
    
    await db.runTransaction(async (t) => {
      const reqDoc = await t.get(requestRef);
      if (!reqDoc.exists || reqDoc.data().status !== 'pending') throw new Error("Request already processed.");
      
      const walletRef = await ensureWallet(t, reqDoc.data().uid);
      const wSnap = await t.get(walletRef);
      t.update(walletRef, { 
        available: Number(wSnap.data().available || 0) + Number(reqDoc.data().amount), 
        lastUpdated: Date.now() 
      });
      t.update(requestRef, { status: "approved", approvedBy: req.uid, approvedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/wallet/withdraw/request", verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, upi } = req.body;
    if (!amount || Number(amount) < 20 || !upi) return res.status(400).json({ error: "Invalid parameters" });

    await db.runTransaction(async (t) => {
      const walletRef = await ensureWallet(t, req.uid);
      const wSnap = await t.get(walletRef);
      const avail = Number(wSnap.data().available || 0);
      const lock = Number(wSnap.data().locked || 0);

      if (avail < Number(amount)) throw new Error("Insufficient available balance.");

      t.update(walletRef, {
        available: avail - Number(amount),
        locked: lock + Number(amount),
        lastUpdated: Date.now()
      });

      t.set(db.collection(`artifacts/${APP_ID}/public/data/payment_requests`).doc(), {
        uid: req.uid, amount: Number(amount), upi, type: "withdraw", status: "pending", createdAt: Date.now()
      });
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/admin/withdraw/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') return res.status(403).json({ error: "Admin only" });

    const { requestId } = req.body;
    const reqRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);

    await db.runTransaction(async (t) => {
      const rSnap = await t.get(reqRef);
      if (!rSnap.exists || rSnap.data().status !== 'pending') throw new Error("Request processed");
      
      const { uid, amount } = rSnap.data();
      const walletRef = await ensureWallet(t, uid);
      const wSnap = await t.get(walletRef);
      const locked = Number(wSnap.data().locked || 0);

      t.update(walletRef, {
        locked: Math.max(0, locked - Number(amount)),
        lastUpdated: Date.now()
      });
      t.update(reqRef, { status: "approved", approvedBy: req.uid, approvedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* =============================================
   🎮 MATCH ENGAGEMENT (JOIN/SETTLE/CASHOUT)
   ============================================= */
app.post("/api/match/join", verifyFirebaseToken, async (req, res) => {
    try {
      const { matchId, ign, teammates } = req.body;
      const uid = req.uid;
      const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);
      const playerRef = matchRef.collection("players").doc(uid);
  
      await db.runTransaction(async (t) => {
        const mSnap = await t.get(matchRef);
        if (!mSnap.exists) throw new Error("Match not found");
        const match = mSnap.data();
        if (match.status !== "open" || Number(match.joinedCount) >= Number(match.slots)) throw new Error("Lobby full or closed");
        
        const existing = await t.get(playerRef);
        if (existing.exists) throw new Error("Unit already deployed.");

        const walletRef = await ensureWallet(t, uid);
        const wSnap = await t.get(walletRef);
        const avail = Number(wSnap.data().available || 0);
        const fee = Number(match.fee);
  
        if (avail < fee) throw new Error("Insufficient credits in War Chest.");
  
        t.update(walletRef, { 
          available: avail - fee, 
          locked: Number(wSnap.data().locked || 0) + fee, 
          lastUpdated: Date.now() 
        });
        t.set(playerRef, { uid, ign: ign || "Recruit", teammates: teammates || [], joinedAt: Date.now(), feeLocked: fee, status: "confirmed" });
        t.update(matchRef, { joinedCount: Number(match.joinedCount) + 1 });
      });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/admin/match/settle", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') return res.status(403).json({ error: "Admin only" });

    const { matchId, winnerUID } = req.body;
    const matchRef = db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`);
    const playersSnap = await matchRef.collection("players").get();

    await db.runTransaction(async (t) => {
      const mSnap = await t.get(matchRef);
      if (mSnap.data().status === 'claimed') throw new Error("Already settled");

      for (const p of playersSnap.docs) {
        const wRef = await ensureWallet(t, p.id);
        const wSnap = await t.get(wRef);
        const fee = Number(p.data().feeLocked || 0);
        t.update(wRef, { 
          locked: Math.max(0, Number(wSnap.data().locked || 0) - fee),
          lastUpdated: Date.now()
        });
      }
      t.update(matchRef, { status: "claimed", winnerUID, claimedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/admin/prize/approve", verifyFirebaseToken, async (req, res) => {
  try {
    const adminSnap = await db.doc(`artifacts/${APP_ID}/admin/${req.uid}`).get();
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') return res.status(403).json({ error: "Admin only" });

    const { requestId } = req.body;
    const reqRef = db.doc(`artifacts/${APP_ID}/public/data/payment_requests/${requestId}`);

    await db.runTransaction(async (t) => {
      const rSnap = await t.get(reqRef);
      if (!rSnap.exists || rSnap.data().status !== 'pending') throw new Error("Processed");
      
      const { uid, amount, matchId } = rSnap.data();
      const walletRef = await ensureWallet(t, uid);
      const wSnap = await t.get(walletRef);
      
      t.update(walletRef, { 
        available: Number(wSnap.data().available || 0) + Number(amount),
        lastUpdated: Date.now()
      });
      t.update(reqRef, { status: "approved", approvedBy: req.uid, approvedAt: Date.now() });
      t.update(db.doc(`artifacts/${APP_ID}/public/data/matches/${matchId}`), { payoutStatus: "paid" });
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Port Binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`*** Warzone Hub Secure Node: Running on port ${PORT} ***`));