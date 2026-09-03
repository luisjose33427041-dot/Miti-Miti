import admin from 'firebase-admin';
import crypto from 'crypto';

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
        const { phone, password } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Teléfono y contraseña requeridos.' });

        const userRef = db.ref(`users/${phone}`);
        const snapshot = await userRef.once('value');

        if (!snapshot.exists()) return res.status(401).json({ success: false, message: 'Usuario no encontrado.' });

        const userData = snapshot.val();
        
        // Hacemos el hash de la contraseña que entra para comparar con la guardada
        const hashedInputPass = crypto.createHash('sha256').update(password).digest('hex');

        if (userData.password !== hashedInputPass) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta.' });
        }

        // Devolvemos el usuario igual a como lo leía el frontend
        return res.status(200).json({
            success: true,
            user: userData
        });

    } catch (error) {
        console.error('Error en login:', error);
        return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
} 
