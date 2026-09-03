import admin from 'firebase-admin';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        }),
        databaseURL: "https://motoweb-a6fdd-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    
    const { motoPhone, monto } = req.body;
    if (!motoPhone || !monto || monto <= 0) return res.status(400).json({ error: 'Datos inválidos.' });

    try {
        // 1. Obtener datos reales del usuario desde la BD (para evitar falsificaciones de identidad)
        const motoRef = db.ref(`users/${motoPhone}`);
        const motoSnap = await motoRef.once('value');
        if (!motoSnap.exists()) return res.status(400).json({ error: 'Usuario no encontrado.' });
        
        const moto = motoSnap.val();

        // 2. Restar saldo de forma segura
        const userBalanceRef = db.ref(`users/${motoPhone}/balance`);
        const result = await userBalanceRef.transaction((balanceActual) => {
            const balance = balanceActual || 0;
            if (balance < monto) return; // Cancela si pide más de lo que tiene
            return balance - monto;
        });

        if (!result.committed) return res.status(400).json({ error: 'Saldo insuficiente para este retiro.' });

        // 3. Crear la orden de retiro en taquilla
        const ordenId = db.ref('withdrawal_orders').push().key;
        await db.ref(`withdrawal_orders/${ordenId}`).set({
            motoPhone: motoPhone,
            motoName: moto.nombre,
            cedula: moto.cedula,
            banco: moto.banco,
            monto: Number(monto),
            status: 'pendiente',
            fecha: Date.now()
        });

        return res.status(200).json({ mensaje: `Se descontaron Bs ${monto}. Ve a la taquilla para tu dinero.` });
    } catch (error) {
        return res.status(500).json({ error: 'Error del servidor al procesar el retiro.' });
    }
          }
