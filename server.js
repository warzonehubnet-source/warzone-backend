const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

/**
 * FIREBASE ADMIN INITIALIZATION
 * Note: For Render deployment, you must set the FIREBASE_SERVICE_ACCOUNT 
 * environment variable with the contents of your Service Account JSON file.
 */
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? 
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.warn("WARNING: FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// Set your project ID as the default APP_ID
const APP_ID = process.env.APP_ID || "warzonehub-s2";

/**
 * ADMIN ONLY: Approve a Deposit or Withdrawal
 * Securely updates user wallet and transaction status using a Firestore transaction.
 */
app.post('/admin/process-transaction', async (req, res) => {
    const { transactionId, action } = req.body; // action: 'approve' or 'decline'
    
    if (!transactionId || !action) {
        return res.status(400).send("Missing transactionId or action");
    }

    try {
        const transRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('transactions').doc(transactionId);
        const transDoc = await transRef.get();

        if (!transDoc.exists) return res.status(404).send("Transaction not found");
        
        const data = transDoc.data();
        if (data.status !== 'pending') return res.status(400).send("Transaction already processed");

        if (action === 'approve') {
            const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(data.userId).collection('profile').doc('profile');
            
            await db.runTransaction(async (t) => {
                const userDoc = await t.get(userRef);
                if (!userDoc.exists) throw "User profile not found";
                
                const currentBalance = userDoc.data().wallet || 0;
                let newBalance = currentBalance;

                if (data.type === 'deposit') {
                    newBalance += data.amount;
                } else if (data.type === 'withdraw') {
                    if (currentBalance < data.amount) throw "Insufficient Balance for withdrawal";
                    newBalance -= data.amount;
                }

                t.update(userRef, { wallet: newBalance });
                t.update(transRef, { 
                    status: 'approved', 
                    processedAt: admin.firestore.FieldValue.serverTimestamp() 
                });
            });
            res.send({ success: true, message: "Approved and Wallet Updated" });
        } else {
            await transRef.update({ 
                status: 'declined', 
                processedAt: admin.firestore.FieldValue.serverTimestamp() 
            });
            res.send({ success: true, message: "Transaction Declined" });
        }
    } catch (error) {
        console.error("Process Transaction Error:", error);
        res.status(500).send({ error: error.toString() });
    }
});

/**
 * USER: Join a Match
 * Atomically checks user balance, validates match availability, and joins.
 */
app.post('/user/join-match', async (req, res) => {
    const { userId, matchId } = req.body;

    if (!userId || !matchId) {
        return res.status(400).send("Missing userId or matchId");
    }

    try {
        const matchRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('matches').doc(matchId);
        const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('profile').doc('profile');

        await db.runTransaction(async (t) => {
            const mDoc = await t.get(matchRef);
            const uDoc = await t.get(userRef);

            if (!mDoc.exists) throw "Match not found";
            if (!uDoc.exists) throw "User profile not found";
            
            const match = mDoc.data();
            const user = uDoc.data();

            if (user.wallet < match.entry) throw "Insufficient Balance";
            if (user.joinedMatches && user.joinedMatches.includes(matchId)) throw "Already Joined";
            if (match.players >= match.maxPlayers) throw "Match is already full";

            t.update(userRef, { 
                wallet: user.wallet - match.entry,
                joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
            });
            t.update(matchRef, { players: (match.players || 0) + 1 });
        });

        res.send({ success: true, message: "Joined successfully" });
    } catch (error) {
        console.error("Join Match Error:", error);
        res.status(400).send({ error: error.toString() });
    }
});

/**
 * HEALTH CHECK
 */
app.get('/', (req, res) => {
    res.send("WarzoneHub Backend is Online");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running for project ${APP_ID} on port ${PORT}`);
});
