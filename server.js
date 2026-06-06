require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// Ruta que será llamada desde el webhook de n8n
app.post('/api/consultar-cliente', async (req, res) => {
    const { cedula } = req.body;

    if (!cedula) {
        return res.status(400).json({ error: 'El número de cédula es requerido' });
    }

    let browser;
    try {
        console.log(`Iniciando consulta para la cédula: ${cedula}`);

        // 1. Iniciamos el navegador en modo invisible (headless)
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        // -------------------------------------------------------------
        // TODO: REEMPLAZA ESTA URL POR LA DEL SISTEMA OBJETIVO
        // -------------------------------------------------------------
        const urlLogin = 'https://tunorte.saeplus.com/';

        console.log('Navegando a la página de login...');
        await page.goto(urlLogin);



        // -------------------------------------------------------------
        // TODO: AJUSTA LOS SELECTORES CSS (#id, .clase) SEGÚN LA PÁGINA REAL
        // -------------------------------------------------------------

        console.log('Iniciando sesión...');

        // Escribe el usuario
        await page.fill('#login_usuario', process.env.SYSTEM_USERNAME);

        // Escribe la contraseña
        await page.fill('#pass_usuario', process.env.SYSTEM_PASSWORD);

        // Primer clic (esto hace que aparezca la nueva casilla)
        await page.click('#iniciar');

        // Esperamos 1 segundo para que la página termine de mostrar la casilla
        await page.waitForTimeout(1000);

        // Segundo clic (ahora sí, entra al sistema)
        await page.click('#iniciar');

        // Esperamos a que la red se calme (indicador de que ya cargó la siguiente página)
        await page.waitForLoadState('networkidle');

        console.log('Login exitoso (presuntamente).');
        // --- INICIO DE MANEJO DE POP-UP ---
        console.log('Intentando cerrar el Pop-up (si existe)...');
        try {
            // Buscamos cualquier botón que diga "CERRAR" y le damos 5 segundos
            await page.click('.bootstrap-dialog-footer-buttons button', { timeout: 5000 });
            console.log('Pop-up cerrado con éxito.');
        } catch (e) {
            console.log('No salió ningún Pop-up o ya se cerró, continuamos.');
        }
        // --- FIN DE MANEJO DE POP-UP ---

        console.log('Abriendo menú de Abonados...');

        // Busca cualquier elemento en la pantalla que diga exactamente "Abonados" y le da clic
        await page.getByText('Abonados', { exact: true }).click();

        // Le damos 1 segundo de espera para que la animación del submenú termine de bajar
        await page.waitForTimeout(300);

        console.log('Haciendo clic en Consultar Abonado...');

        // Buscamos el texto exacto en el submenú y le damos clic
        await page.getByText('Consultar Abonado', { exact: false }).click();

        // Esperamos a que cargue la pantalla del buscador
        await page.waitForLoadState('networkidle');

        console.log('Escribiendo la cédula y buscando...');

        // 1. Escribimos la cédula que n8n nos mandó en la caja de texto
        await page.fill('#cedula_b', cedula);

        // 2. Presionamos la tecla 'Enter' para lanzar la búsqueda
        await page.keyboard.press('Enter');

        // Le damos unos 3 segundos para que el sistema piense y muestre la tabla de resultados
        // El robot esperará hasta que las filas de la tabla aparezcan (y ni un milisegundo más)
        await page.waitForSelector('#dt_listar_abonados tbody tr', { state: 'visible' });
        console.log('Extrayendo el resumen de la tabla a la velocidad de la luz...');
        
        // Extraemos la información de TODAS las filas de la tabla de una sola vez
        const cuentasEncontradas = await page.evaluate(() => {
            const filas = document.querySelectorAll('#dt_listar_abonados tbody tr');
            const lista = [];

            filas.forEach(fila => {
                const columnas = fila.querySelectorAll('td');
                
                if(columnas.length > 5) { // Verificamos que sea una fila real de datos
                    lista.push({
                        nro_abonado: columnas[0]?.innerText.trim() || '',
                        nombre: columnas[2]?.innerText.trim() || '',
                        saldo_actual: columnas[3]?.innerText.trim() || '',
                        estatus: columnas[4]?.innerText.trim() || '',
                        barrio: columnas[5]?.innerText.trim() || '',
                        sector: columnas[6]?.innerText.trim() || ''
                    });
                }
            });
            return lista;
        });

        console.log(`¡Se extrajo el resumen de ${cuentasEncontradas.length} cuentas al instante!`);

        // Devolvemos la información a n8n sin haber entrado a ninguna cuenta
        res.json({
            success: true,
            cantidad_cuentas: cuentasEncontradas.length,
            cuentas: cuentasEncontradas
        });

    } catch (error) {
        console.error('Error durante la automatización:', error);
        res.status(500).json({ success: false, error: 'Hubo un error al procesar la solicitud.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de automatización corriendo en http://localhost:${PORT}`);
    console.log(`Endpoint disponible en: POST http://localhost:${PORT}/api/consultar-cliente`);
});
