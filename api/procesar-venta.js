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
        if (!snapPeticion.exists()) return res.status(400).json({ error: 'La solicitud expiró.' });

        const peticion = snapPeticion.val();
        if (peticion.otp !== otp) return res.status(400).json({ error: 'Código incorrecto.' });

        // Tasa del día
        const tasaSnap = await db.ref('admin/tasa').once('value');
        const tasa = tasaSnap.val() || 1;

        // Montos y Cálculos
        const montoBs = Number(peticion.monto);
        const montoUSD = montoBs / tasa;

        const compradorSnap = await db.ref(`users/${compradorId}`).once('value');
        const comprador = compradorSnap.val();
        
        // Manejo del Crédito
        const lineaActiva = comprador.linea_credito || 0; 
        const creditoUsadoUSD = Math.min(lineaActiva, montoUSD); // Usa hasta $10 si el producto vale $20
        const pagoBolsilloUSD = montoUSD - creditoUsadoUSD; // Los $10 restantes que debe pagar el usuario ya
        const pagoBolsilloBs = pagoBolsilloUSD * tasa;

        const vendedorDebeRecibirUSD = montoUSD * 0.85; // 85% para el vendedor ($17)
        const comisionGeneradaUSD = montoUSD * 0.15; // 15% de comisión de la app ($3)

        // Verificaciones de saldo y fondos
        if (peticion.metodo === 'digital') {
            const balanceReal = comprador.balance || 0;
            if (balanceReal < pagoBolsilloBs) {
                return res.status(400).json({ error: `Saldo digital insuficiente para cubrir los Bs ${pagoBolsilloBs.toFixed(2)} faltantes.` });
            }
        }

        // El colchón necesario (Fondo de Inversión) 
        // Si el producto vale 20 y usan 10 de crédito, tú pones $7 y guardas $3 en espera.
        let colchonNecesarioUSD = 0;
        if (peticion.metodo === 'efectivo') {
            // Vendedor tiene el "pagoBolsillo" en efectivo físico en la mano.
            // Para llegar a su 85% digital, el admin completa.
            colchonNecesarioUSD = vendedorDebeRecibirUSD - pagoBolsilloUSD;
        } else {
            // Si es digital, el admin igual transfiere al vendedor, usando saldo digital del usuario y su propio fondo
            colchonNecesarioUSD = vendedorDebeRecibirUSD - pagoBolsilloUSD;
        }

        // Si es necesario colchón (porque usó crédito), descontar del fondo seguro
        if (colchonNecesarioUSD > 0) {
            const fondoRef = db.ref('admin/fondo');
            const result = await fondoRef.transaction(fondo => {
                if (fondo === null) return fondo;
                if (fondo < colchonNecesarioUSD) return; 
                return fondo - colchonNecesarioUSD;
            });
            if (!result.committed) return res.status(400).json({ error: 'El administrador no tiene colchón de fondo suficiente.' });
        }

        // ACTUALIZACIONES MASIVAS
        // 1. Descontar saldo digital del usuario (si aplica)
        if (peticion.metodo === 'digital' && pagoBolsilloBs > 0) {
            await db.ref(`users/${compradorId}/balance`).transaction(bal => (bal || 0) - pagoBolsilloBs);
        }

        // 2. Acreditar saldo digital al vendedor
        await db.ref(`users/${vendedorId}/balance`).transaction(bal => (bal || 0) + (vendedorDebeRecibirUSD * tasa));

        // 3. Generar Deuda y vaciar línea de crédito al usuario
        if (creditoUsadoUSD > 0) {
            await db.ref(`users/${compradorId}/linea_credito`).set(lineaActiva - creditoUsadoUSD);
            await db.ref(`users/${compradorId}/deuda_credito`).transaction(deuda => (deuda || 0) + creditoUsadoUSD);
            
            // 4. Comisión se va a la sección ESPERA
            await db.ref('admin/comision_espera').transaction(c => (c || 0) + comisionGeneradaUSD);
        } else {
            // Si no usó crédito, la comisión es libre directamente
            await db.ref('admin/profit').transaction(p => (p || 0) + comisionGeneradaUSD);
        }

        // 5. Crear la orden de pago pendiente en BD para recordarle al usuario
        if(creditoUsadoUSD > 0) {
            await db.ref('pending_payments').push().set({
                pasajeroPhone: compradorId,
                vendedorId: vendedorId,
                montoUSD: creditoUsadoUSD, // Deuda de $10 exactos
                comisionAsociadaUSD: comisionGeneradaUSD, // $3 atados a esta deuda
                colchonAsociadoUSD: colchonNecesarioUSD, // $7 que deben retornar al fondo
                dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000),
                status: 'pendiente'
            });
        }

        await peticionRef.remove();
        return res.status(200).json({ mensaje: 'Venta exitosa. Transacción procesada por Cash-Compra.' });

    } catch (error) {
        return res.status(500).json({ error: 'Error procesando la venta.' });
    }
}
