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

        const isDevMode = process.env.DEV_MODE === 'true';
        // 1. Iniciamos el navegador en modo invisible (headless) o visual según el entorno
        browser = await chromium.launch({ headless: !isDevMode });
        const context = await browser.newContext();

        // Bloqueo agresivo de recursos pesados para acelerar la carga
        if (!isDevMode) {
            await context.route('**/*', route => {
                const type = route.request().resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });
        }

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

        // Esperamos a que la estructura HTML cargue y aparezca el botón Abonados (Ultra rápido)
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('text="Abonados"');

        console.log('Login exitoso (presuntamente).');
        // --- INICIO DE MANEJO DE POP-UP ---
        console.log('Intentando cerrar el Pop-up (si existe)...');
        try {
            // 100ms fue demasiado rápido para la animación. Le daremos 1.5s (1500ms) como equilibrio seguro.
            await page.click('.bootstrap-dialog-footer-buttons button', { timeout: 1500 });
            console.log('Pop-up cerrado con éxito.');
        } catch (e) {
            console.log('No salió ningún Pop-up o ya se cerró, continuamos.');
        }
        // --- FIN DE MANEJO DE POP-UP ---

        console.log('Abriendo menú de Abonados...');

        // Busca cualquier elemento en la pantalla que diga exactamente "Abonados" y le da clic
        await page.getByText('Abonados', { exact: true }).click();

        // Le damos 1 segundo de espera para que la animación del submenú termine de bajar
        await page.waitForTimeout(100);

        console.log('Haciendo clic en Consultar Abonado...');

        // Buscamos el texto exacto en el submenú y le damos clic
        await page.getByText('Consultar Abonado', { exact: false }).click();

        // Esperamos a que cargue la caja de texto en vez de toda la red
        await page.waitForSelector('#cedula_b');

        console.log('Escribiendo la cédula y buscando...');

        // 1. Escribimos la cédula que n8n nos mandó en la caja de texto
        await page.fill('#cedula_b', cedula);

        // 2. Presionamos la tecla 'Enter' para lanzar la búsqueda
        await page.keyboard.press('Enter');

        // Carrera (Race) entre la tabla y el identificador único del perfil
        const resultadoCarrera = await Promise.race([
            page.waitForSelector('#dt_listar_abonados tbody tr', { state: 'visible' }).then(() => 'tabla'),
            page.waitForSelector('#n_contrato1_div', { state: 'visible' }).then(() => 'perfil')
        ]);

        let cuentasEncontradas = [];

        if (resultadoCarrera === 'tabla') {
            console.log('Apareció la tabla de resultados múltiples. Extrayendo resumen...');
            cuentasEncontradas = await page.evaluate(() => {
                const filas = document.querySelectorAll('#dt_listar_abonados tbody tr');
                const lista = [];

                filas.forEach(fila => {
                    const columnas = fila.querySelectorAll('td');

                    if (columnas.length > 5) {
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
        } else if (resultadoCarrera === 'perfil') {
            console.log('Apareció directamente el perfil único. Extrayendo resumen básico...');
            const cuentaUnica = await page.evaluate(() => {
                const getText = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.innerText.trim() : '';
                };
                return {
                    nro_abonado: getText('#n_contrato1_div'),
                    nombre: getText('#cliente_label'),
                    saldo_actual: getText('#saldo1_div'),
                    estatus: getText('#id_status_div'),
                    barrio: getText('#barrio_label'),
                    sector: getText('#municipio_label')
                };
            });
            cuentasEncontradas.push(cuentaUnica);
        }

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

// Ruta para obtener todos los detalles de una cuenta específica
app.post('/api/detalles-abonado', async (req, res) => {
    const { cedula, numero_abonado } = req.body;

    if (!cedula || !numero_abonado) {
        return res.status(400).json({ error: 'La cédula y el número de abonado son requeridos' });
    }

    let browser;
    try {
        console.log(`Iniciando consulta profunda para el abonado: ${numero_abonado} (Cédula: ${cedula})`);

        const isDevMode = process.env.DEV_MODE === 'true';
        // Iniciamos el navegador en modo óptimo
        browser = await chromium.launch({ headless: !isDevMode });
        const context = await browser.newContext();

        // Bloqueo agresivo de recursos pesados
        if (!isDevMode) {
            await context.route('**/*', route => {
                const type = route.request().resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });
        }

        const page = await context.newPage();

        const urlLogin = 'https://tunorte.saeplus.com/';
        await page.goto(urlLogin);

        // Login
        await page.fill('#login_usuario', process.env.SYSTEM_USERNAME);
        await page.fill('#pass_usuario', process.env.SYSTEM_PASSWORD);
        await page.click('#iniciar');
        await page.waitForTimeout(1000);
        await page.click('#iniciar');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('text="Abonados"');

        // Cerrar Pop-up si existe (1500ms timeout para dar tiempo a la animación)
        try {
            await page.click('.bootstrap-dialog-footer-buttons button', { timeout: 1500 });
        } catch (e) {
            // Ignorar
        }

        // Navegar a buscador
        await page.getByText('Abonados', { exact: true }).click();
        await page.waitForTimeout(100);
        await page.getByText('Consultar Abonado', { exact: false }).click();
        await page.waitForSelector('#cedula_b');

        // Buscar por cédula
        await page.fill('#cedula_b', cedula);
        await page.keyboard.press('Enter');
        const resultadoCarrera = await Promise.race([
            page.waitForSelector('#dt_listar_abonados tbody tr', { state: 'visible' }).then(() => 'tabla'),
            page.waitForSelector('#n_contrato1_div', { state: 'visible' }).then(() => 'perfil')
        ]);

        if (resultadoCarrera === 'tabla') {
            console.log('Tabla cargada, buscando el abonado específico...');
            const fila = page.locator('#dt_listar_abonados tbody tr').filter({ hasText: numero_abonado });

            if (await fila.count() === 0) {
                console.log('No se encontró el abonado en la tabla.');
                return res.status(404).json({ success: false, error: 'Abonado no encontrado en la lista' });
            }

            console.log('Abonado encontrado, haciendo clic para entrar al perfil...');
            await fila.first().click();
            await page.waitForSelector('#n_contrato1_div');
            await page.waitForTimeout(500); 
        } else if (resultadoCarrera === 'perfil') {
            console.log('Perfil único cargado directamente. Verificando que sea el abonado correcto...');
            // Verificamos si el numero de abonado cargado es el que estamos buscando
            const abonadoEnPantalla = await page.locator('#n_contrato1_div').innerText();
            if (abonadoEnPantalla.trim() !== numero_abonado) {
                return res.status(404).json({ success: false, error: `El único abonado encontrado (${abonadoEnPantalla.trim()}) no coincide con el buscado (${numero_abonado}).` });
            }
        }

        console.log('Cargando histórico de Estado de Cuenta...');
        await page.click('a#edo_btn').catch(()=>console.log("No se pudo hacer clic en Estado de Cuenta"));
        await page.waitForTimeout(800);

        console.log('Cargando histórico de Operaciones...');
        await page.click('a#ope_btn').catch(()=>console.log("No se pudo hacer clic en Operaciones"));
        await page.waitForTimeout(800);

        console.log('Perfil y pestañas cargados exitosamente. Extrayendo datos estructurados...');

        const datosEstructurados = await page.evaluate(() => {
            const getText = (selector) => {
                const el = document.querySelector(selector);
                return el ? el.innerText.trim() : '';
            };

            const datos = {
                "Resumen": {
                    "Nro_Abonado": getText('#n_contrato1_div'),
                    "Estatus": getText('#id_status_div'),
                    "Suscripcion_Mensual": getText('#suscrito_div'),
                    "Saldo_Actual": getText('#saldo1_div')
                },
                "Datos del contrato": {
                    "Franquicia": getText('#nombre_franq_label'),
                    "Grupo_Afinidad": getText('#nombre_g_a_label'),
                    "Estrato_Social": getText('#nombre_estrato_label'),
                    "Tipo_Facturacion": getText('#tipo_fact_label'),
                    "Vendedor": getText('#vendedor_label'),
                    "Fecha_Contrato": getText('#fecha_contrato_label'),
                    "Observacion": getText('#observacion_label')
                },
                "Datos personales del cliente": {
                    "Tipo_Cliente": getText('#tipo_cliente_label'),
                    "Documento": getText('#cedula_label'),
                    "Cliente": getText('#cliente_label'),
                    "Celular": getText('#telefono_label'),
                    "Telefono_Adicional": getText('#telf_adic_label'),
                    "Email": getText('#email_label'),
                    "Fecha_Nacimiento": getText('#fecha_nac_label')
                },
                "Datos de direccion": {
                    "Departamento": getText('#estado_label'),
                    "Ciudad": getText('#ciudad_label'),
                    "Sector": getText('#municipio_label'),
                    "Barrio": getText('#barrio_label'),
                    "Avenida": getText('#av_label'),
                    "Lote": getText('#lote_label')
                },
                "Datos de residencia": {
                    "Tipo_Residencia": getText('#tipo_res_label'),
                    "Nro_CasaApto": getText('#n_res_label'),
                    "Punto_Referencia": getText('#pto_ref_label'),
                    "Direccion_Fiscal": getText('#dir_fiscal_label')
                },
                "Datos de los servicios mensuales suscritos": (() => {
                    const servicios = [];
                    const headers = Array.from(document.querySelectorAll('.panel-heading'));
                    const header = headers.find(h => h.innerText.includes('SERVICIOS MENSUALES SUSCRITOS'));
                    if (header && header.parentElement) {
                        const trs = header.parentElement.querySelectorAll('table tbody tr');
                        trs.forEach(tr => {
                            const tds = tr.querySelectorAll('td');
                            if (tds.length >= 8) {
                                servicios.push({
                                    "Tipo_Servicio": tds[1]?.innerText.trim(),
                                    "Descripcion": tds[2]?.innerText.trim(),
                                    "Tipo_Paquete": tds[3]?.innerText.trim(),
                                    "Estatus": tds[4]?.innerText.trim(),
                                    "Cantidad": tds[5]?.innerText.trim(),
                                    "Total": tds[8]?.innerText.trim()
                                });
                            }
                        });
                    }
                    return servicios;
                })(),
                "Datos de equipos": (() => {
                    const equipos = [];
                    const headers = Array.from(document.querySelectorAll('.panel-heading'));
                    const header = headers.find(h => h.innerText.includes('EQUIPO'));
                    if (header && header.parentElement) {
                        const trs = header.parentElement.querySelectorAll('table tbody tr');
                        trs.forEach(tr => {
                            const tds = tr.querySelectorAll('td');
                            // Dependiendo de la estructura de la tabla de equipos, extraemos las columnas. 
                            // Generalmente tienen 4-6 columnas.
                            if (tds.length >= 4) {
                                equipos.push({
                                    "Equipo": tds[0]?.innerText.trim(),
                                    "MAC": tds[1]?.innerText.trim(),
                                    "Marca": tds[2]?.innerText.trim(),
                                    "Modelo": tds[3]?.innerText.trim()
                                });
                            }
                        });
                    }
                    return equipos;
                })(),
                "Estado de Cuenta (Ultimos 3)": (() => {
                    const registros = [];
                    const trs = document.querySelectorAll('#edo_cuenta_resp tbody tr');
                    for (let i = 0; i < Math.min(trs.length, 3); i++) {
                        const tds = trs[i].querySelectorAll('td');
                        if (tds.length >= 7) {
                            registros.push({
                                "Fecha": tds[0]?.innerText.trim(),
                                "Nro_Documento": tds[1]?.innerText.trim(),
                                "Tipo": tds[2]?.innerText.trim(),
                                "Descripcion": tds[3]?.innerText.trim(),
                                "Cargo": tds[4]?.innerText.trim(),
                                "Abono": tds[5]?.innerText.trim(),
                                "Saldo": tds[6]?.innerText.trim()
                            });
                        }
                    }
                    return registros;
                })(),
                "Operaciones (Ultimas 3)": (() => {
                    const registros = [];
                    const trs = document.querySelectorAll('#operacion_resp tbody tr');
                    for (let i = 0; i < Math.min(trs.length, 3); i++) {
                        const tds = trs[i].querySelectorAll('td');
                        if (tds.length >= 8) {
                            registros.push({
                                "Nro_Orden": tds[0]?.innerText.trim(),
                                "Fecha_Emision": tds[1]?.innerText.trim(),
                                "Tipo_Orden": tds[5]?.innerText.trim(),
                                "Orden": tds[6]?.innerText.trim(),
                                "Estatus": tds[7]?.innerText.trim(),
                                "Observacion": tds[8]?.innerText.trim()
                            });
                        }
                    }
                    return registros;
                })()
            };
            return datos;
        });

        res.json({
            success: true,
            datos_abonado: datosEstructurados
        });

    } catch (error) {
        console.error('Error durante la automatización profunda:', error);
        res.status(500).json({ success: false, error: 'Hubo un error al procesar la solicitud profunda.' });
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
