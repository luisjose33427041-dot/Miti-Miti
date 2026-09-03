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
        const { 
            rol, nombres, apellidos, nacionalidad, cedulaNum, fechaNac, 
            phone, banco, password, emailGoogle, 
            fotoCaraBase64, fotoCedulaBase64 
        } = req.body;

        if(!phone || !password || !fotoCaraBase64 || !fotoCedulaBase64) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios.' });
        }

        const userRef = db.ref(`users/${phone}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            return res.status(400).json({ success: false, message: 'El número de teléfono ya está registrado.' });
        }

        const cedula = nacionalidad + "-" + cedulaNum;
        const nombreCompleto = `${nombres} ${apellidos}`;
        
        // Hacemos el hash idéntico al de tu frontend antiguo
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        const codigoOtp = Math.floor(100000 + Math.random() * 900000).toString();

        const nuevoUsuario = { 
            rol, 
            nombre: nombreCompleto, 
            cedula, 
            fechaNac, 
            phone, 
            banco: banco || '', 
            password: hashedPassword, 
            balance: 0, 
            locked: false, 
            status: 'espera',
            fotoCara: fotoCaraBase64, 
            fotoCedula: fotoCedulaBase64,
            otpRegistro: codigoOtp,
            lineaCredito: 0,
            email: emailGoogle
        };
        
        await userRef.set(nuevoUsuario);

        return res.status(200).json({ success: true, message: 'Registrado con éxito.' });

    } catch (error) {
        console.error('Error en registro:', error);
        return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
} 
