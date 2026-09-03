import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import crypto from 'crypto';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = getDatabase();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Teléfono y contraseña requeridos.' });
    }

    const userRef = db.ref(`usuarios/${phone}`);
    const snapshot = await userRef.once('value');

    if (!snapshot.exists()) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    const userData = snapshot.val();
    const hashedInputPass = crypto.createHash('sha256').update(password).digest('hex');

    if (userData.password !== hashedInputPass) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    // Generar un token de sesión temporal seguro para guardar en localStorage en vez del teléfono plano
    const sessionToken = crypto.randomBytes(32).toString('hex');
    
    // Opcional: Guardar el token en la base de datos asociado al usuario
    await db.ref(`sesiones/${sessionToken}`).set({
      phone: userData.phone,
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 horas
    });

    return res.status(200).json({
      success: true,
      token: sessionToken,
      user: {
        phone: userData.phone,
        name: userData.name,
        tipo: userData.tipo,
        saldo: userData.saldo,
        activo: userData.activo
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}
