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

        if (pago.pasajeroPhone !== usuarioPhone) return res.status(403).json({ error: 'Esta deuda no te pertenece.' });
        if (pago.status !== 'pendiente') return res.status(400).json({ error: 'Este pago ya fue procesado.' });

        const montoPagar = Number(pago.monto); // 50% financiado en Bs.
        const adminGanancia = Number(pago.montoOriginal) * 0.15; // 15% comisión retenida

        // Obtener tasa para la reposición del Fondo Admin en USD
        const snapTasa = await db.ref('admin/tasa').once('value');
        const tasa = Number(snapTasa.val()) || 1;
        const montoUSDReposicion = montoPagar / tasa;

        const userBalanceRef = db.ref(`users/${usuarioPhone}/balance`);

        // 1. Restar saldo al usuario
        const result = await userBalanceRef.transaction((balanceActual) => {
            if (balanceActual === null) return null;
            if (balanceActual < montoPagar) return; 
            return balanceActual - montoPagar;
        });

        if (!result.committed || result.snapshot.val() === null) {
            return res.status(400).json({ error: 'Saldo insuficiente para saldar la deuda.' });
        }

        // 2. Liberar Línea de Crédito (Resta a lineaCreditoUsadaBs)
        await db.ref(`users/${usuarioPhone}/lineaCreditoUsadaBs`).transaction((usado) => Math.max(0, (usado || 0) - montoPagar));

        // 3. Reponer Capital Financiado al Fondo Admin en USD (admin/fondoUsd += C)
        await db.ref('admin/fondoUsd').transaction((fondo) => (fondo || 0) + montoUSDReposicion);

        // 4. Liberar Comisión Retenida -> Ganancia Neta
        await db.ref('admin/comisionEspera').transaction((comision) => Math.max(0, (comision || 0) - adminGanancia));
        await db.ref('admin/profit').transaction((ganancia) => (ganancia || 0) + adminGanancia);
        
        // 5. Marcar deuda como pagada
        await pagoRef.update({ status: 'pagado' });

        return res.status(200).json({ mensaje: 'Pago realizado exitosamente y línea de crédito liberada.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error del servidor al procesar el pago.' });
    }
}
