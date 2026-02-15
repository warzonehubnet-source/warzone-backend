const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

/**
 * WARZONE HUB - SECURE BACKEND (RENDER)
 * ------------------------------------
 * Updated to use root collections: /users and /transactions
 */

// Initialize Firebase Admin (Using Service Account)
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const db = admin.firestore();
const app = express();

app.use(cors({
    origin: ['http://127.0.0.1:5500', 'https://yourdomain.com'] 
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * SECURE DEPOSIT PROCESSING
 */
app.post('/api/process-deposit', async (req, res) => {
  const { userId, transactionId } = req.body;

  if (!userId || !transactionId) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  try {
    const txRef = db.doc(`transactions/${transactionId}`);
    const userRef = db.doc(`users/${userId}`);

    await db.runTransaction(async (t) => {
      const tx = await t.get(txRef);
      if (!tx.exists) throw new Error('Transaction record not found.');
      if (tx.data().status !== 'pending') throw new Error('Transaction already processed.');

      const amount = parseFloat(tx.data().amount);

      t.update(txRef, { 
          status: 'approved', 
          processedAt: admin.firestore.Timestamp.now() 
      });

      t.update(userRef, { 
          availableBalance: admin.firestore.FieldValue.increment(amount),
          totalBalance: admin.firestore.FieldValue.increment(amount)
      });
    });

    res.json({ success: true, message: 'Deposit processed successfully.' });
  } catch (error) {
    console.error("Deposit Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * SECURE WITHDRAWAL APPROVAL
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

app.get('/', (req, res) => res.send("Warzone Hub API is Online."));
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
