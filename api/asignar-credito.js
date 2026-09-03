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
    
    const { adminEmail, usuarioPhone, creditUsd } = req.body;

    // Blindaje: Solo tu correo de administrador puede usar esta API
    if (adminEmail !== 'luisjose33427041@gmail.com') {
        return res.status(403).json({ error: 'No tienes permisos de administrador.' });
    }

    if (!usuarioPhone || !creditUsd || creditUsd < 0) {
        return res.status(400).json({ error: 'Datos de crédito inválidos.' });
    }

    try {
        const userRef = db.ref(`users/${usuarioPhone}`);
        const userSnap = await userRef.once('value');
        if (!userSnap.exists()) return res.status(400).json({ error: 'Usuario no encontrado.' });

        // Obtener la tasa de cambio oficial
        const tasaSnap = await db.ref('admin/tasa').once('value');
        const tasa = tasaSnap.val() || 1;

        const creditBs = Number(creditUsd) * tasa;

        // Actualizar línea de crédito blindada en el servidor
        await userRef.update({
            creditLineUsd: Number(creditUsd),
            creditLineBs: creditBs,
            creditAvailableBs: creditBs
        });

        return res.status(200).json({ 
            mensaje: `Línea de crédito de $${creditUsd} (Bs. ${creditBs}) asignada exitosamente al usuario ${usuarioPhone}.` 
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error del servidor al asignar la línea de crédito.' });
    }
}
