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
        const quincePorciento = monto * 0.15;

        // 1. Verificar y descontar el 35% del Fondo de Financiamiento del Admin
        const fondoRef = db.ref('admin/fondo');
        const snapFondo = await fondoRef.once('value');
        const fondoActual = snapFondo.val() || 0;

        if (fondoActual < treintaYCincoPorciento) {
            return res.status(400).json({ error: 'El Fondo de Financiamiento no cuenta con suficiente liquidez para procesar este financiamiento.' });
        }

        // Descontar el 35% del fondo del administrador
        await fondoRef.transaction((f) => (f || 0) - treintaYCincoPorciento);

        // 2. Procesar cobro inicial del 50% al comprador (Si es método digital)
        if (peticion.metodo === 'digital') {
            const userRef = db.ref(`users/${compradorId}`);
            const snapUser = await userRef.once('value');
            if (!snapUser.exists()) {
                await fondoRef.transaction((f) => (f || 0) + treintaYCincoPorciento); // Revertir fondo
                return res.status(400).json({ error: 'Usuario comprador no encontrado.' });
            }

            const userData = snapUser.val();
            const balanceActual = Number(userData.balance || 0);
            const creditoDisponible = Number(userData.credito_disponible_bs || 0);

            // Verificar si el comprador tiene cobro por saldo o por línea de crédito
            if (balanceActual >= cincuentaPorciento) {
                await db.ref(`users/${compradorId}/balance`).transaction((b) => (b || 0) - cincuentaPorciento);
            } else if (creditoDisponible >= cincuentaPorciento) {
                await db.ref(`users/${compradorId}/credito_disponible_bs`).transaction((c) => (c || 0) - cincuentaPorciento);
            } else if ((balanceActual + creditoDisponible) >= cincuentaPorciento) {
                const restante = cincuentaPorciento - balanceActual;
                await db.ref(`users/${compradorId}/balance`).set(0);
                await db.ref(`users/${compradorId}/credito_disponible_bs`).transaction((c) => (c || 0) - restante);
            } else {
                await fondoRef.transaction((f) => (f || 0) + treintaYCincoPorciento); // Revertir fondo
                return res.status(400).json({ error: 'Fondos y crédito insuficiente para realizar la compra.' });
            }

            // Acreditar al vendedor (50% pagado por comprador + 35% del fondo = 85%)
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);
            await vendedorRef.transaction((b) => (b || 0) + cincuentaPorciento + treintaYCincoPorciento);

        } else {
            // Método efectivo: El comprador le paga el 50% en mano al vendedor
            // Acreditar al vendedor el 35% del fondo en su balance de la app
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);
            await vendedorRef.transaction((b) => (b || 0) + treintaYCincoPorciento);
        }

        // 3. Sumar el 15% a la Comisión en Espera del administrador
        await db.ref('admin/comision_espera').transaction((c) => (c || 0) + quincePorciento);

        // 4. Crear la orden de pago pendiente por el 50% restante
        const pagoRef = db.ref('pending_payments').push();
        await pagoRef.set({
            pasajeroPhone: compradorId,
            motoId: vendedorId,
            monto: cincuentaPorciento,
            montoOriginal: monto,
            comisionEspera: quincePorciento,
            financiamientoFondo: treintaYCincoPorciento,
            dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000),
            status: 'pendiente'
        });

        // Eliminar solicitud OTP procesada
        await peticionRef.remove();

        return res.status(200).json({ mensaje: 'Venta procesada exitosamente.' });

    } catch (error) {
        console.error("Error procesando venta:", error);
        return res.status(500).json({ error: 'Error interno en el servidor procesando la venta.' });
    }
}
