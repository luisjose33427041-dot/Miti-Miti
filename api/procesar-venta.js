if (peticion.metodo === 'digital') {
            const pasajeroRef = db.ref(`users/${compradorId}/balance`);
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);

            // 1. Forzar lectura previa para llenar la caché y evitar el null especulativo
            const snap = await pasajeroRef.once('value');
            const balanceReal = snap.val() || 0;

            if (balanceReal < cincuentaPorciento) {
                return res.status(400).json({ error: 'Fondos insuficientes en el balance del pasajero.' });
            }

            // 2. Ejecutar la transacción con el valor real garantizado
            const pasajeroResult = await pasajeroRef.transaction((balanceActual) => {
                const balance = balanceActual || 0;
                if (balance < cincuentaPorciento) {
                    return; // Aborta por seguridad si el saldo cambia milisegundos antes
                }
                return balance - cincuentaPorciento;
            });

            if (!pasajeroResult.committed) {
                return res.status(400).json({ error: 'Error procesando el saldo. Intente de nuevo.' });
            }

            // Acreditar al vendedor
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + cincuentaPorciento + treintaYCincoPorciento;
            });
        } else {
