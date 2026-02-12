const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

/**
 * WARZONE HUB - SECURE BACKEND (RENDER)
 * ------------------------------------
 * This server handles sensitive balance updates that shouldn't 
 * happen on the frontend to prevent cheating.
 * * DEPLOYMENT STEPS:
 * 1. Create a Web Service on Render.
 * 2. In 'Environment', add 'GOOGLE_APPLICATION_CREDENTIALS' pointing to your service account JSON.
 * 3. Ensure 'CORS' is configured to allow your Hostinger domain.
 */

// Initialize Firebase Admin
// Make sure to download your Service Account Key from Firebase Console -> Project Settings -> Service Accounts
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const db = admin.firestore();
const app = express();

// Configure CORS for your Hostinger Domain
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'https://your-hostinger-domain.com'] 
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * SECURE DEPOSIT PROCESSING
 * Triggered by Admin or a Webhook after verifying payment.
 */
app.post('/api/process-deposit', async (req, res) => {
  const { userId, transactionId, appId } = req.body;

  if (!userId || !transactionId || !appId) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  try {
    const txRef = db.doc(`artifacts/${appId}/users/${userId}/transactions/${transactionId}`);
    const profileRef = db.doc(`artifacts/${appId}/users/${userId}/profile/data`);

    await db.runTransaction(async (t) => {
      const tx = await t.get(txRef);
      if (!tx.exists) throw new Error('Transaction record not found.');
      if (tx.data().status !== 'pending') throw new Error('Transaction already processed.');

      const profile = await t.get(profileRef);
      const amount = parseFloat(tx.data().amount);

      // Use FieldValue.increment for atomic, safe updates
      t.update(txRef, { 
          status: 'approved', 
          processedAt: admin.firestore.Timestamp.now() 
      });

      if (!profile.exists) {
          t.set(profileRef, { 
              availableBalance: amount,
              totalBalance: amount,
              lockedBalance: 0
          });
      } else {
          t.update(profileRef, { 
              availableBalance: admin.firestore.FieldValue.increment(amount),
              totalBalance: admin.firestore.FieldValue.increment(amount)
          });
      }
    });

    res.json({ success: true, message: 'Deposit processed and balance updated.' });
  } catch (error) {
    console.error("Deposit Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * SECURE WITHDRAWAL APPROVAL
 * Marks a withdrawal as paid and clears the locked balance.
 */
app.post('/api/approve-withdrawal', async (req, res) => {
    const { userId, transactionId, appId } = req.body;

    try {
        const txRef = db.doc(`artifacts/${appId}/users/${userId}/transactions/${transactionId}`);
        const profileRef = db.doc(`artifacts/${appId}/users/${userId}/profile/data`);

        await db.runTransaction(async (t) => {
            const tx = await t.get(txRef);
            const amount = tx.data().amount;

            t.update(txRef, { status: 'approved', processedAt: admin.firestore.Timestamp.now() });
            t.update(profileRef, { 
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

/**
 * FIRESTORE SECURITY RULES (Copy this to your Firebase Console -> Rules)
 * ----------------------------------------------------------------------
 * service cloud.firestore {
 * match /databases/{database}/documents {
 * match /artifacts/{appId}/public/data/{document=**} {
 * allow read: if true;
 * allow write: if request.auth != null; 
 * }
 * match /artifacts/{appId}/users/{userId}/{document=**} {
 * allow read, write: if request.auth != null && request.auth.uid == userId;
 * }
 * match /users/{userId} {
 * allow read, write: if request.auth != null && request.auth.uid == userId;
 * }
 * }
 * }
 */
