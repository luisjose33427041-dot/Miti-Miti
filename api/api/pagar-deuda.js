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
    
    const { usuarioPhone, pagoId } = req.body;
    if (!usuarioPhone || !pagoId) return res.status(400).json({ error: 'Faltan datos.' });

    try {
        // 1. Buscar la deuda en la base de datos (No confiamos en lo que mande el frontend)
        const pagoRef = db.ref(`pending_payments/${pagoId}`);
        const pagoSnap = await pagoRef.once('value');
        
        if (!pagoSnap.exists()) return res.status(400).json({ error: 'Pago no encontrado.' });
        const pago = pagoSnap.val();

        if (pago.pasajeroPhone !== usuarioPhone) return res.status(403).json({ error: 'Esta deuda no te pertenece.' });
        if (pago.status !== 'pendiente') return res.status(400).json({ error: 'Este pago ya fue procesado.' });

        const montoPagar = Number(pago.monto);
        const adminGanancia = Number(pago.montoOriginal) * 0.15;

        // 2. Restar saldo al usuario de forma atómica y segura
        const userBalanceRef = db.ref(`users/${usuarioPhone}/balance`);
        const result = await userBalanceRef.transaction((balanceActual) => {
            const balance = balanceActual || 0;
            if (balance < montoPagar) return; // Cancela la operación si no tiene saldo
            return balance - montoPagar;
        });

        if (!result.committed) return res.status(400).json({ error: 'Saldo insuficiente.' });

        // 3. Sumar ganancia al administrador
        await db.ref('admin/profit').transaction((ganancia) => (ganancia || 0) + adminGanancia);
        
        // 4. Marcar deuda como pagada
        await pagoRef.update({ status: 'pagado' });

        return res.status(200).json({ mensaje: 'Pago realizado exitosamente.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error del servidor al procesar el pago.' });
    }
}
