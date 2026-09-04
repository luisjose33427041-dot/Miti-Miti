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

        const montoPagar = Number(pago.monto);
        const adminGanancia = Number(pago.comisionEspera || (pago.montoOriginal * 0.15));
        const retornoFondo = Number(pago.financiamientoFondo || (pago.montoOriginal * 0.35));

        // 1. Verificar datos del comprador
        const userRef = db.ref(`users/${usuarioPhone}`);
        const userSnap = await userRef.once('value');
        if (!userSnap.exists()) return res.status(400).json({ error: 'Usuario no encontrado.' });

        const userData = userSnap.val();
        const balanceActual = Number(userData.balance || 0);
        const creditoDisponible = Number(userData.credito_disponible_bs || 0);

        // 2. Cobrar la deuda
        if (balanceActual >= montoPagar) {
            await db.ref(`users/${usuarioPhone}/balance`).transaction((b) => (b || 0) - montoPagar);
        } else if (creditoDisponible >= montoPagar) {
            await db.ref(`users/${usuarioPhone}/credito_disponible_bs`).transaction((c) => (c || 0) - montoPagar);
        } else if ((balanceActual + creditoDisponible) >= montoPagar) {
            const restante = montoPagar - balanceActual;
            await db.ref(`users/${usuarioPhone}/balance`).set(0);
            await db.ref(`users/${usuarioPhone}/credito_disponible_bs`).transaction((c) => (c || 0) - restante);
        } else {
            return res.status(400).json({ error: 'Saldo insuficiente para cancelar esta deuda.' });
        }

        // 3. Mover comisión de espera a ganancias reales (profit)
        await db.ref('admin/comision_espera').transaction((c) => Math.max(0, (c || 0) - adminGanancia));
        await db.ref('admin/profit').transaction((p) => (p || 0) + adminGanancia);

        // 4. Retornar el 35% prestado de vuelta al Fondo
        await db.ref('admin/fondo').transaction((f) => (f || 0) + retornoFondo);

        // 5. Restablecer la línea de crédito disponible del comprador
        if (userData.linea_credito_bs) {
            const limiteMax = Number(userData.linea_credito_bs);
            await db.ref(`users/${usuarioPhone}/credito_disponible_bs`).transaction((disp) => {
                const nuevoDisp = (disp || 0) + montoPagar;
                return Math.min(nuevoDisp, limiteMax);
            });
        }

        // 6. Marcar deuda como pagada
        await pagoRef.update({ status: 'pagado' });

        return res.status(200).json({ mensaje: 'Pago de deuda realizado exitosamente.' });
    } catch (error) {
        console.error("Error pagando deuda:", error);
        return res.status(500).json({ error: 'Error del servidor al procesar el pago.' });
    }
}
