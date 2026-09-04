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

        // 1. Obtener Tasa actual
        const snapTasa = await db.ref('admin/tasa').once('value');
        const tasa = Number(snapTasa.val()) || 1;

        // 2. Verificar Crédito Disponible del Comprador
        const compradorRef = db.ref(`users/${compradorId}`);
        const snapComprador = await compradorRef.once('value');
        if (!snapComprador.exists()) {
            return res.status(400).json({ error: 'Comprador no encontrado.' });
        }

        const compradorData = snapComprador.val();
        const lineaCreditoUsd = Number(compradorData.lineaCreditoUsd || 0);
        const lineaCreditoUsadaBs = Number(compradorData.lineaCreditoUsadaBs || 0);

        const creditoBsDisponible = (lineaCreditoUsd * tasa) - lineaCreditoUsadaBs;

        if (creditoBsDisponible < cincuentaPorciento) {
            return res.status(400).json({ error: 'Línea de crédito insuficiente del comprador para financiar el 50%.' });
        }

        // 3. Verificar Fondo Administrador Suficiente
        const financiadoUsd = cincuentaPorciento / tasa;
        const fondoRef = db.ref('admin/fondoUsd');
        const snapFondo = await fondoRef.once('value');
        const fondoUsdActual = Number(snapFondo.val() || 0);

        if (fondoUsdActual < financiadoUsd) {
            return res.status(400).json({ error: 'El Fondo Administrador no dispone de suficiente capital para esta compra.' });
        }

        if (peticion.metodo === 'digital') {
            const pasajeroRef = db.ref(`users/${compradorId}/balance`);
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);

            const snap = await pasajeroRef.once('value');
            const balanceReal = snap.val() || 0;

            if (balanceReal < cincuentaPorciento) {
                return res.status(400).json({ error: 'Fondos insuficientes en el balance digital del comprador.' });
            }

            const pasajeroResult = await pasajeroRef.transaction((balanceActual) => {
                if (balanceActual === null) return null;
                if (balanceActual < cincuentaPorciento) return; 
                return balanceActual - cincuentaPorciento;
            });

            if (!pasajeroResult.committed || pasajeroResult.snapshot.val() === null) {
                return res.status(400).json({ error: 'Error procesando el saldo del comprador. Intente de nuevo.' });
            }

            // Acreditar al vendedor: 50% pagado por comprador + 35% financiado por fondo
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + cincuentaPorciento + treintaYCincoPorciento;
            });
        } else {
            // Caso Efectivo: El comprador pagó el 50% directo en físico al vendedor.
            // Acreditar al vendedor únicamente el 35% en app (completando su 85% total)
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + treintaYCincoPorciento;
            });
        }

        // --- ACTUALIZACIÓN DE CREDITOS Y FONDO ADMIN ---
        // 1. Incrementar lineaCreditoUsadaBs del comprador
        await db.ref(`users/${compradorId}/lineaCreditoUsadaBs`).transaction((usado) => (usado || 0) + cincuentaPorciento);

        // 2. Descontar financiado USD del Fondo del Administrador
        await fondoRef.transaction((fondo) => Math.max(0, (fondo || 0) - financiadoUsd));

        // 3. Retención de Comisión (15%) en admin/comisionEspera
        await db.ref('admin/comisionEspera').transaction((comision) => (comision || 0) + quincePorciento);

        // 4. Registrar deuda en pending_payments
        const pagoRef = db.ref('pending_payments').push();
        await pagoRef.set({
            pasajeroPhone: compradorId,
            motoId: vendedorId,
            monto: cincuentaPorciento,
            montoOriginal: monto,
            dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000),
            status: 'pendiente'
        });

        await peticionRef.remove();

        return res.status(200).json({ mensaje: 'Venta procesada de forma 100% segura en el servidor.' });

    } catch (error) {
        return res.status(500).json({ error: 'Error interno en el servidor procesando la venta.' });
    }
}
