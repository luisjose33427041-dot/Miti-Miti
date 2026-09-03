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
        const pagoRef = db.ref(`pending_payments/${pagoId}`);
        const pagoSnap = await pagoRef.once('value');
        if (!pagoSnap.exists()) return res.status(400).json({ error: 'Pago no encontrado.' });
        
        const pago = pagoSnap.val();
        if (pago.pasajeroPhone !== usuarioPhone) return res.status(403).json({ error: 'Prohibido.' });
        if (pago.status !== 'pendiente') return res.status(400).json({ error: 'Pago ya procesado.' });

        const tasaSnap = await db.ref('admin/tasa').once('value');
        const tasa = tasaSnap.val() || 1;

        const montoBsPagar = Number(pago.montoUSD) * tasa; // Paga la deuda al equivalente del día

        // Descontar saldo digital del usuario
        const result = await db.ref(`users/${usuarioPhone}/balance`).transaction((balanceActual) => {
            if (balanceActual === null) return null;
            if (balanceActual < montoBsPagar) return; 
            return balanceActual - montoBsPagar;
        });

        if (!result.committed || result.snapshot.val() === null) {
            return res.status(400).json({ error: 'Saldo insuficiente para pagar deuda.' });
        }
        
        // 1. Restaurar $10 de línea de crédito al usuario y borrar la deuda
        await db.ref(`users/${usuarioPhone}/linea_credito`).set(10);
        await db.ref(`users/${usuarioPhone}/deuda_credito`).set(0);

        // 2. Mover $3 de "Comisión Espera" a "Profit"
        const com = pago.comisionAsociadaUSD || 0;
        await db.ref('admin/comision_espera').transaction(c => Math.max(0, (c || 0) - com));
        await db.ref('admin/profit').transaction(p => (p || 0) + com);

        // 3. Regresar los $7 frontados al Fondo de Inversión
        const colchon = pago.colchonAsociadoUSD || 0;
        await db.ref('admin/fondo').transaction(f => (f || 0) + colchon);

        // 4. Marcar pagado
        await pagoRef.update({ status: 'pagado' });

        return res.status(200).json({ mensaje: 'Deuda liquidada. Tu línea de crédito Cash-Compra de $10 se ha restaurado.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error de servidor pagando deuda.' });
    }
}
