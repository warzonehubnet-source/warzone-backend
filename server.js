const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// Initialize Firebase Admin (You must set GOOGLE_APPLICATION_CREDENTIALS in Render environment)
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * Endpoint to verify a transaction and update balance securely.
 * Example of what you'd put in Render.
 */
app.post('/api/process-deposit', async (req, res) => {
  const { userId, transactionId, appId } = req.body;

  try {
    const txRef = db.doc(`artifacts/${appId}/users/${userId}/transactions/${transactionId}`);
    const profileRef = db.doc(`artifacts/${appId}/users/${userId}/profile/data`);

    await db.runTransaction(async (t) => {
      const tx = await t.get(txRef);
      if (!tx.exists || tx.data().status !== 'pending') throw new Error('Invalid Transaction');

      const profile = await t.get(profileRef);
      const currentBalance = profile.exists ? (profile.data().availableBalance || 0) : 0;

      t.update(txRef, { status: 'approved', processedAt: admin.firestore.Timestamp.now() });
      t.update(profileRef, { availableBalance: currentBalance + tx.data().amount });
    });

    res.json({ success: true, message: 'Balance updated successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));