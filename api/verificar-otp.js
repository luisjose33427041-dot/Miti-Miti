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
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Método no permitido' });

    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ success: false, message: 'Faltan datos.' });

        const userRef = db.ref(`users/${phone}`);
        const snapshot = await userRef.once('value');

        if (!snapshot.exists()) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

        const data = snapshot.val();
        
        if (data.otpRegistro !== otp) {
            return res.status(400).json({ success: false, message: 'Código incorrecto.' });
        }

        // Actualizamos a aprobado y limpiamos el OTP para seguridad
        await userRef.update({
            status: 'aprobado',
            otpRegistro: null
        });

        return res.status(200).json({ 
            success: true, 
            user: { ...data, status: 'aprobado', otpRegistro: null } 
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
}
