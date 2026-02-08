const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin (SAFE)
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const db = admin.firestore();
const APP_ID = "warzone-hub-prod-v2";

// Health check (IMPORTANT for Render)
app.get("/", (req, res) => {
  res.send("Warzone Hub Backend is running ✅");
});

/* =====================
   WALLET CREDIT (SAFE)
===================== */
app.post("/api/wallet/credit", async (req, res) => {
  try {
    const { uid, amount, paymentId } = req.body;

    if (!uid || !amount || !paymentId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const walletRef = db.doc(`artifacts/${APP_ID}/users/${uid}/wallet/data`);
    const txRef = db.collection(`artifacts/${APP_ID}/public/data/transactions`);

    await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      const balance = walletSnap.exists ? walletSnap.data().balance : 0;

      t.set(txRef.doc(), {
        uid,
        amount,
        paymentId,
        type: "CREDIT",
        status: "SUCCESS",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(walletRef, {
        balance: balance + amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Render PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
