import admin from 'firebase-admin';

// Inicializar Firebase Admin de forma segura en el servidor de Vercel
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
    // Solo permitir peticiones POST por seguridad
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    const { compradorId, vendedorId, otp } = req.body;

    if (!compradorId || !vendedorId || !otp) {
        return res.status(400).json({ error: 'Faltan datos en la petición.' });
    }

    try {
        const peticionRef = db.ref(`auth_requests/${compradorId}`);
        const snapPeticion = await peticionRef.once('value');

        if (!snapPeticion.exists()) {
            return res.status(400).json({ error: 'La solicitud expiró o fue cancelada.' });
        }

        const peticion = snapPeticion.val();

        if (peticion.otp !== otp) {
            return res.status(400).json({ error: 'El código OTP es incorrecto.' });
        }

        const monto = Number(peticion.monto);
        const cincuentaPorciento = monto * 0.50;
        const treintaYCincoPorciento = monto * 0.35;

        if (peticion.metodo === 'digital') {
            const pasajeroRef = db.ref(`users/${compradorId}/balance`);
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);

            // 1. Forzar lectura previa para llenar la caché y evitar el null especulativo
            const snap = await pasajeroRef.once('value');
            const balanceReal = snap.val() || 0;

            if (balanceReal < cincuentaPorciento) {
                return res.status(400).json({ error: 'Fondos insuficientes en el balance del pasajero.' });
            }

      // 2. Ejecutar la transacción de forma segura manejando el null especulativo
            const pasajeroResult = await pasajeroRef.transaction((balanceActual) => {
                // Si la lectura es especulativa (null), devolvemos null para obligar a Firebase 
                // a comparar los datos con el servidor y traer el saldo real.
                if (balanceActual === null) {
                    return null;
                }
                
                // Ya tenemos el saldo real. Abortamos si de verdad es insuficiente.
                if (balanceActual < cincuentaPorciento) {
                    return; 
                }
                return balanceActual - cincuentaPorciento;
            });

            // Validamos que la transacción se haya guardado y no sea null
            if (!pasajeroResult.committed || pasajeroResult.snapshot.val() === null) {
                return res.status(400).json({ error: 'Error procesando el saldo. Intente de nuevo.' });
            }
            // Acreditar al vendedor
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + cincuentaPorciento + treintaYCincoPorciento;
            });
        } else {
            // Lógica para efectivo
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + treintaYCincoPorciento;
            });
        }

        // Crear la orden de pago pendiente en la base de datos
        const pagoRef = db.ref('pending_payments').push();
        await pagoRef.set({
            pasajeroPhone: compradorId,
            motoId: vendedorId,
            monto: cincuentaPorciento,
            montoOriginal: monto,
            dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000),
            status: 'pendiente'
        });

        // Borrar la solicitud OTP usada para que no se pueda reutilizar
        await peticionRef.remove();

        return res.status(200).json({ mensaje: 'Venta procesada de forma 100% segura en el servidor.' });

    } catch (error) {
        return res.status(500).json({ error: 'Error interno en el servidor procesando la venta.' });
    }
}
