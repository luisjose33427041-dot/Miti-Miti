import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import crypto from 'crypto';

// Inicializar Firebase Admin (Asegúrate de configurar tus credenciales en Vercel)
if (!getApps().length) {
  // Puedes usar variables de entorno para las credenciales de Firebase Admin
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Reemplaza los saltos de línea si usas una variable de entorno para la private key
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
    const { phone, password, name, cedula, tipo } = req.body;

    if (!phone || !password || !name) {
      return res.status(400).json({ success: false, message: 'Faltan datos obligatorios.' });
    }

    const userRef = db.ref(`usuarios/${phone}`);
    const snapshot = await userRef.once('value');

    if (snapshot.exists()) {
      return res.status(400).json({ success: false, message: 'El número de teléfono ya está registrado.' });
    }

    // Hashear contraseña en el servidor
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    
    // Generar OTP seguro de 6 dígitos en el servidor
    const otpRegistro = Math.floor(100000 + Math.random() * 900000).toString();

    const nuevoUsuario = {
      phone,
      password: hashedPassword,
      name,
      cedula: cedula || '',
      tipo: tipo || 'pasajero',
      saldo: 0,
      activo: false, // Inactivo hasta verificar OTP
      otpRegistro,
      createdAt: new Date().toISOString()
    };

    await userRef.set(nuevoUsuario);

    // AQUí INTEGRARÍAS TU API DE WHATSAPP (Evolution API, UltraMsg, etc.) para enviar el OTP al usuario
    // await enviarWhatsApp(phone, `Tu código de verificación Kashmoto es: ${otpRegistro}`);

    return res.status(200).json({ 
      success: true, 
      message: 'Usuario registrado. Valide su OTP.',
      // ¡OJO! En producción no devuelvas el otpRegistro en la respuesta, 
      // solo devuélvelo si estás probando sin API de WhatsApp conectada aún.
      debugOtp: otpRegistro 
    });

  } catch (error) {
    console.error('Error en registro:', error);
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}
