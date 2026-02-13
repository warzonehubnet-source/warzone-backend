const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

/**
 * WARZONE HUB - PRODUCTION BACKEND (RENDER)
 * ----------------------------------------
 * Handles high-security balance updates that bypass client rules.
 */

const app = express();

// Configure CORS
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'http://localhost:5500', 'https://yourdomain.com'],
    methods: ['GET', 'POST']
}));

app.use(express.json());

// INITIALIZATION WITH ROBUST PARSING
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  } else {
    // Handle cases where Render provides the JSON as a string or double-encoded string
    const serviceAccount = typeof sa === 'string' ? JSON.parse(sa) : sa;
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Backend successfully connected to Project: " + serviceAccount.project_id);
  }
} catch (e) {
  console.error("❌ Auth Initialization Error: " + e.message);
}

const db = admin.firestore();

/**
 * POST /api/process-deposit
 * Approves a pending deposit and increments user balance.
 */
app.post('/api/process-deposit', async (req, res) => {
  const { userId, transactionId } = req.body;

  if (!userId || !transactionId) {
    return res.status(400).json({ success: false, error: "userId and transactionId are required" });
  }

  try {
    const txRef = db.doc(`transactions/${transactionId}`);
    const userRef = db.doc(`users/${userId}`);

    await db.runTransaction(async (t) => {
      const txDoc = await t.get(txRef);
      if (!txDoc.exists) throw new Error("Transaction not found");
      if (txDoc.data().status !== 'pending') throw new Error("Transaction already processed");

      const amount = parseFloat(txDoc.data().amount);
      const userDoc = await t.get(userRef);

      // Update status to approved
      t.update(txRef, { 
        status: 'approved', 
        processedAt: admin.firestore.Timestamp.now() 
      });

      // Increment User Balance
      if (!userDoc.exists) {
        // Fallback for new user docs
        t.set(userRef, { 
            availableBalance: amount, 
            totalBalance: amount, 
            role: "user" 
        });
      } else {
        t.update(userRef, { 
          availableBalance: admin.firestore.FieldValue.increment(amount),
          totalBalance: admin.firestore.FieldValue.increment(amount)
        });
      }
    });

    res.json({ success: true, message: "Balance updated successfully" });
  } catch (err) {
    console.error("Deposit Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/approve-withdrawal
 * Finalizes a withdrawal after manual payment.
 */
app.post('/api/approve-withdrawal', async (req, res) => {
    const { userId, transactionId } = req.body;

    try {
        const txRef = db.doc(`transactions/${transactionId}`);
        const userRef = db.doc(`users/${userId}`);

        await db.runTransaction(async (t) => {
            const tx = await t.get(txRef);
            const amount = tx.data().amount;

            t.update(txRef, { status: 'approved', processedAt: admin.firestore.Timestamp.now() });
            t.update(userRef, { 
                lockedBalance: admin.firestore.FieldValue.increment(-amount) 
            });
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/', (req, res) => res.send("Warzone Hub API Terminal Online."));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
