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
        if (!pagoSnap.exists()) return res.status(400).json({ error: 'Deuda no encontrada.' });
        const pago = pagoSnap.val();

        if (pago.pasajeroPhone !== usuarioPhone) return res.status(403).json({ error: 'Seguridad: Deuda incorrecta.' });
        if (pago.status !== 'pendiente') return res.status(400).json({ error: 'El pago ya fue liquidado.' });

        const montoPagar = Number(pago.monto); // Ej. 10$

        const result = await db.ref(`users/${usuarioPhone}`).transaction((user) => {
            if (user === null) return null;
            if ((user.balance || 0) < montoPagar) return; 
            
            user.balance -= montoPagar;
            // Restauramos la línea de crédito
            user.lineaCreditoBs = (user.lineaCreditoBs || 0) + montoPagar;
            user.deudaActual = (user.deudaActual || 0) - montoPagar;
            return user;
        });

        if (!result.committed || result.snapshot.val() === null) {
            return res.status(400).json({ error: 'Saldo insuficiente para pagar la línea de crédito.' });
        }

        // Recuperar finanzas del Admin
        if (pago.impactoFondoUsd > 0) {
            await db.ref('admin/fondo').transaction((f) => (f || 0) + pago.impactoFondoUsd);
        }
        
        // Mover comisión de Espera a Aprobado
        if (pago.comisionAtrapada > 0) {
            await db.ref('admin/comision_espera').transaction((c) => Math.max(0, (c || 0) - pago.comisionAtrapada));
            await db.ref('admin/profit').transaction((p) => (p || 0) + pago.comisionAtrapada);
        }

        await pagoRef.update({ status: 'pagado' });
        return res.status(200).json({ mensaje: 'Deuda pagada. Línea de crédito recargada automáticamente.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error procesando el pago de deuda.' });
    }
}
