if (peticion.metodo === 'digital') {
            const pasajeroRef = db.ref(`users/${compradorId}/balance`);
            const vendedorRef = db.ref(`users/${vendedorId}/balance`);

            // 1. Leemos el saldo real primero para obligar a Firebase a conectarse y actualizar su memoria
            const snapPasajero = await pasajeroRef.once('value');
            const balanceReal = snapPasajero.val() || 0;

            // 2. Verificamos si realmente tiene saldo antes de entrar a la transacción
            if (balanceReal < cincuentaPorciento) {
                return res.status(400).json({ error: 'Fondos insuficientes en el balance del comprador.' });
            }

            // 3. Ejecutamos la transacción atómica de forma segura
            const pasajeroResult = await pasajeroRef.transaction((balanceActual) => {
                // Si por alguna razón el primer ciclo vuelve a leer null, usamos el saldo real pre-cargado
                let balance = balanceActual === null ? balanceReal : balanceActual;
                
                if (balance < cincuentaPorciento) return; 
                
                return balance - cincuentaPorciento;
            });

            if (!pasajeroResult.committed) {
                return res.status(400).json({ error: 'Hubo un conflicto al procesar el pago. Intenta de nuevo.' });
            }

            // Acreditar al vendedor
            await vendedorRef.transaction((balanceActual) => {
                return (balanceActual || 0) + cincuentaPorciento + treintaYCincoPorciento;
            });
        }
