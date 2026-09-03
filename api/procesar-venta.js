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

    const { compradorId, vendedorId, otp } = req.body;
    if (!compradorId || !vendedorId || !otp) return res.status(400).json({ error: 'Faltan datos.' });

    try {
        const peticionRef = db.ref(`auth_requests/${compradorId}`);
        const snapPeticion = await peticionRef.once('value');

        if (!snapPeticion.exists()) return res.status(400).json({ error: 'La solicitud expiró o fue cancelada.' });
        
        const peticion = snapPeticion.val();
        if (peticion.otp !== otp) return res.status(400).json({ error: 'Código OTP incorrecto.' });

        const montoTotal = Number(peticion.monto);
        
        // Reglas de negocio Cash-Compra
        const porcentajeDescuento = 0.15; // 15% que pierde el vendedor
        const comisionAdmin = montoTotal * porcentajeDescuento; // 3$ en tu ejemplo
        const pagoVendedor = montoTotal - comisionAdmin; // 17$ en tu ejemplo

        if (peticion.metodo === 'digital') {
            const pasajeroRef = db.ref(`users/${compradorId}`);
            
            // Ejecutamos transacción en el comprador para deducir saldo/crédito
            const resultadoCompra = await pasajeroRef.transaction((user) => {
                if (user === null) return null;
                
                const balanceActual = user.balance || 0;
                const lineaCredito = user.lineaCreditoBs || 0; // Pre-convertida en BS por tu admin panel
                
                let pagadoConSaldo = 0;
                let pagadoConCredito = 0;

                if (balanceActual >= montoTotal) {
                    pagadoConSaldo = montoTotal;
                } else {
                    pagadoConSaldo = balanceActual;
                    pagadoConCredito = montoTotal - balanceActual;
                }

                // Verificamos si tiene fondo y crédito suficiente
                if (lineaCredito < pagadoConCredito) return; // Aborta la transacción

                user.balance = balanceActual - pagadoConSaldo;
                user.lineaCreditoBs = lineaCredito - pagadoConCredito;
                user.deudaActual = (user.deudaActual || 0) + pagadoConCredito; // Registramos deuda en el usuario
                
                // Guardamos metadatos temporales para la ruta del admin
                user._temp_pagadoSaldo = pagadoConSaldo;
                user._temp_pagadoCredito = pagadoConCredito;

                return user;
            });

            if (!resultadoCompra.committed || resultadoCompra.snapshot.val() === null) {
                return res.status(400).json({ error: 'Saldo digital y línea de crédito insuficientes.' });
            }

            const userData = resultadoCompra.snapshot.val();
            const pagadoConSaldo = userData._temp_pagadoSaldo;
            const pagadoConCredito = userData._temp_pagadoCredito;

            // Limpiamos los datos temporales
            await pasajeroRef.child('_temp_pagadoSaldo').remove();
            await pasajeroRef.child('_temp_pagadoCredito').remove();

            // 1. Acreditar al vendedor el 85%
            await db.ref(`users/${vendedorId}/balance`).transaction((b) => (b || 0) + pagoVendedor);

            // 2. Lógica del Fondo y Comisión en Espera
            // El fondo cubre la diferencia líquida enviada al vendedor menos el saldo real cobrado.
            const impactoFondoBs = pagoVendedor - pagadoConSaldo; // Si es positivo, el admin pone dinero.
            
            // Obtenemos la tasa para afectar el fondo en USD
            const tasaSnap = await db.ref('admin/tasa').once('value');
            const tasa = tasaSnap.val() || 1;
            const impactoFondoUsd = impactoFondoBs / tasa;

            if (impactoFondoUsd > 0) {
                await db.ref('admin/fondo').transaction((fondo) => (fondo || 0) - impactoFondoUsd);
            }

            // Los 3$ del admin van a espera SI HUBO USO DE CRÉDITO
            if (pagadoConCredito > 0) {
                await db.ref('admin/comision_espera').transaction((c) => (c || 0) + comisionAdmin);
                
                // Generamos la orden de deuda pendiente para que el usuario la pague
                await db.ref('pending_payments').push().set({
                    pasajeroPhone: compradorId,
                    motoId: vendedorId,
                    monto: pagadoConCredito, // Debe solo su crédito usado (10$)
                    comisionAtrapada: comisionAdmin, // 3$ que se liberarán
                    impactoFondoUsd: impactoFondoUsd, // Dinero que se regresará al fondo
                    dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000),
                    status: 'pendiente'
                });
            } else {
                // Si pago 100% con saldo, los 3$ van directo a ganancia limpia
                await db.ref('admin/profit').transaction((p) => (p || 0) + comisionAdmin);
            }
        } 

        await peticionRef.remove();
        return res.status(200).json({ mensaje: 'Compra autorizada correctamente mediante Cash-Compra.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error procesando la venta.' });
    }
}
