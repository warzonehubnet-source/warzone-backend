const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

/**
 * PRODUCTION BACKEND - DEBUG VERSION
 */

try {
  const saData = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saData) {
    console.error("FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is EMPTY!");
  } else {
    const serviceAccount = JSON.parse(saData);
    if (!serviceAccount.project_id) {
      console.error("FATAL: JSON parsed but 'project_id' is missing. Check your JSON format!");
    } else {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log(`✅ Firebase Admin Initialized for Project: ${serviceAccount.project_id}`);
    }
  }
} catch (error) {
  console.error("❌ Initialization Error:", error.message);
}

const db = admin.firestore();

app.post('/api/process-deposit', async (req, res) => {
  const { userId, transactionId } = req.body;
  console.log(`Attempting to approve Tx: ${transactionId} for User: ${userId}`);

  if (!userId || !transactionId) {
    return res.status(400).json({ success: false, error: "Missing userId or transactionId" });
  }

  try {
    const txRef = db.doc(`transactions/${transactionId}`);
    const userRef = db.doc(`users/${userId}`);

    await db.runTransaction(async (t) => {
      const tx = await t.get(txRef);
      if (!tx.exists) throw new Error('Transaction not found');
      if (tx.data().status !== 'pending') throw new Error('Transaction is not pending');

      const amount = parseFloat(tx.data().amount);
      const userSnap = await t.get(userRef);

      // Update Transaction
      t.update(txRef, { 
        status: 'approved', 
        processedAt: admin.firestore.Timestamp.now() 
      });

      // Update User Balance
      if (!userSnap.exists) {
        t.set(userRef, { 
          availableBalance: amount, 
          totalBalance: amount, 
          role: "user",
          username: tx.username || "Player"
        });
      } else {
        t.update(userRef, { 
          availableBalance: admin.firestore.FieldValue.increment(amount),
          totalBalance: admin.firestore.FieldValue.increment(amount)
        });
      }
    });

    console.log("✅ Success: Balance updated.");
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Deposit Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send("Warzone API Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
