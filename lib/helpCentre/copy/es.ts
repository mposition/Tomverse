import type { HelpLocaleCopy } from "../types";

/**
 * Spanish copy. Quoted screen names use the wording of the Spanish screens
 * (locales/es.ts and the per-feature copy files), written inside «».
 */
export const es: HelpLocaleCopy = {
  ui: {
    metaTitle: "Centro de ayuda de Tomverse | Pregunta y te respondemos",
    metaDescription: "Chat, Review, imágenes, investigación, archivos, asistentes, importación, conectores, herramientas de programación, planes y créditos: resuélvelo con guías paso a paso y el asistente de ayuda.",
    eyebrow: "Centro de ayuda",
    heroTitleLead: "¿En qué",
    heroTitleAccent: "podemos ayudarte?",
    heroSubtitle: "Pregunta lo que quieras tal como se te ocurra. Buscamos en los documentos de ayuda de Tomverse, te respondemos paso a paso y te indicamos a qué pantalla ir.",
    askPlaceholder: "Ejemplo: ¿cómo cambio solo el fondo después de crear una imagen?",
    askButton: "Preguntar",
    askMetaLead: "Asistente de ayuda · responde con los documentos de ayuda y muestra las fuentes",
    askMetaPrivacy: "No lee tus conversaciones · no descuenta créditos",
    askSignIn: "Inicia sesión para preguntar al asistente de ayuda. Por ahora se buscan guías.",
    askSignInButton: "Iniciar sesión",
    askUnavailable: "Busca directamente en los títulos y el contenido de las guías",
    askThinking: "Buscando en los documentos de ayuda…",
    askError: "Ahora mismo no se pudo obtener una respuesta. Inténtalo de nuevo en un momento o consulta las guías de abajo.",
    askFollowUp: "Seguir preguntando…",
    suggestions: [
      "Comparar 3 respuestas en Review",
      "¿Dónde veo mis créditos restantes?",
      "Importar conversaciones de ChatGPT",
      "Conectar Claude Code con Tomverse",
      "No se suben mis archivos",
      "La respuesta se detuvo a la mitad",
    ],
    searchPlaceholder: "Buscar guías: por ejemplo, créditos, editar imagen, eliminar cuenta",
    searchEmpty: "No encontramos ninguna guía que coincida. Prueba con otras palabras o escribe al soporte.",
    commonTasks: "Tareas habituales",
    allGuides: "Todas las guías",
    byFeature: "Ayuda por función",
    guideCount: "{count} guías",
    stepsAndMinutes: "{steps} pasos · unos {minutes} min",
    newBadge: "NUEVO",
    noAnswerTitle: "Si no encuentras la respuesta",
    contactTitle: "¿No encuentras lo que buscas?",
    contactBody: "Si el asistente de ayuda y las guías no lo resuelven, escribe al soporte. Normalmente respondemos en 1-2 días laborables.",
    contactButton: "Contactar con soporte",
    statusButton: "Estado del servicio",
    reportButton: "Reportar error",
    assistantName: "Asistente de ayuda",
    foundIn: "✓ Encontrado en {count} documentos de ayuda",
    notFound: "No encontramos la respuesta en los documentos de ayuda.",
    notFoundBody: "No respondemos adivinando. Si escribes al soporte, una persona lo revisará.",
    sources: "Fuentes",
    helpful: "¿Te ha servido?",
    thanks: "Gracias por avisarnos",
    disclaimer: "El asistente de ayuda solo lee los documentos de ayuda públicos. No lee ni cambia tus conversaciones, archivos ni datos de pago. Puede equivocarse, así que para decisiones importantes consulta la guía enlazada.",
    openGuide: "Ver la guía paso a paso",
    relatedGuides: "Guías relacionadas",
    requirements: "Para usar esta función",
    signInRequired: "Requiere iniciar sesión",
    signInNotRequired: "Sin iniciar sesión",
    planLabel: "Plan",
    allPlans: "Todos los planes",
    paidPlans: "Planes de pago",
    breadcrumbHome: "Centro de ayuda",
    stepLabel: "Paso {n}",
    previous: "Anterior",
    next: "Siguiente paso",
    faqTitle: "Preguntas frecuentes",
    stuckTitle: "¿Te has atascado en este paso?",
    stuckBody: "El asistente de ayuda responde a partir de la guía que estás viendo.",
    stuckPlaceholder: "Ejemplo: no veo el botón",
    tryItTitle: "Pruébalo ahora",
    tryItBody: "Se abre en una pestaña nueva, para que sigas esta guía a su lado.",
    tryItButton: "Pruébalo ahora",
    onThisPage: "En esta página",
    stepsSection: "Sigue los pasos",
    nextGuides: "Qué leer a continuación",
    backToHelp: "Volver al centro de ayuda",
    newQuestion: "Nueva pregunta",
    formatsTitle: "Formatos compatibles",
    formatGroups: {
      image: "Imágenes (solo GIF estáticos)",
      document: "Documentos",
      data: "Datos",
      markup: "Texto y marcado",
      code: "Código fuente (se lee como texto)",
      archive: "Archivos comprimidos (su contenido debe pasar las comprobaciones)",
    },
    formatsSignedInOnly: "Solo con sesión iniciada: {list}",
    formatsGuestLimits: "Sin iniciar sesión: {files} archivo por mensaje, hasta {mb} MB.",
    formatsSignedInLimits: "Con sesión iniciada: hasta {files} archivos por mensaje, {mb} MB cada uno y {total} MB en total.",
  },
  categories: {
    "getting-started": { title: "Primeros pasos", description: "Desde crear tu cuenta hasta enviar tu primera pregunta." },
    chat: { title: "Chat", description: "Conversar con un modelo, elegir modelo y adaptación inteligente, mejora automática de preguntas, entrada y conversación por voz, ubicación actual." },
    review: { title: "Review · AI Review", description: "Lee las respuestas de varios modelos en paralelo y comprueba las diferencias con AI Review." },
    images: { title: "Imágenes", description: "Crea imágenes, retoca partes de una foto y compara los resultados de cada modelo." },
    research: { title: "Investigación · búsqueda web", description: "Encuentra información reciente con la búsqueda web y recibe informes con Deep Research." },
    files: { title: "Archivos · archivos generados", description: "Subir archivos, Google Drive, conversión de archivos y descargar los archivos que crea la IA." },
    assistants: { title: "Asistentes · Memory", description: "Tus propios asistentes, archivos de conocimiento y gestión de la memoria." },
    imports: { title: "Importar · continuar", description: "Importa conversaciones de otros servicios de IA y continúalas aquí." },
    connectors: { title: "Conectores · MCP", description: "Conecta servicios externos y servidores MCP." },
    coding: { title: "Herramientas de programación · claves de API", description: "Usa Tomverse en herramientas de programación como Claude Code, Codex y Cursor. Disponible en Pro y planes superiores." },
    projects: { title: "Proyectos · compartir", description: "Organiza, bloquea y comparte tus conversaciones en proyectos." },
    billing: { title: "Planes · créditos · pagos", description: "Cómo se usan los créditos, cambios de plan, cancelación y reembolsos." },
    account: { title: "Cuenta · privacidad", description: "Métodos de acceso, descarga de datos y eliminación de la cuenta." },
    notifications: { title: "Notificaciones · móvil", description: "Notificaciones por correo y uso desde el teléfono." },
    troubleshooting: { title: "Solución de problemas", description: "Respuestas que se detienen, fallos al subir archivos, reportar errores, estado del servicio y contacto." },
  },
  guides: {
    // -------------------------------------------------------- getting started
    "create-account": {
      title: "Crear una cuenta e iniciar sesión",
      summary: "Crea una cuenta gratuita con tu cuenta de Google, Microsoft o Apple, o con el código de 6 dígitos que recibes por correo, e inicia sesión.",
      steps: [
        { title: "Abrir la pantalla de acceso", body: "Pulsa «Iniciar sesión / Registrarse»." },
        { title: "Elegir un método", body: "Pulsa «Continuar con Google», «Continuar con Microsoft» o «Continuar con Apple», o escribe tu «Correo electrónico» y pulsa «Obtener código de acceso». Los botones que ves pueden variar según el entorno." },
        { title: "Introducir el código", body: "Escribe el código de 6 dígitos que recibiste por correo en «Introduce el código» y pulsa «Verificar». También puedes pulsar el enlace de acceso del correo." },
        { title: "Si es tu primera vez", body: "Si el correo no está registrado, pulsa «Registrarme con esta dirección»." },
        { title: "Si no llega el código", body: "Pulsa «Enviar un código nuevo» o cambia la dirección con «Usar otro correo»." },
      ],
      faq: [
        { q: "¿Cuánto tiempo es válido el código?", a: "El código es válido como máximo 10 minutos. Si caduca, pulsa «Enviar un código nuevo». Si escribes un código incorrecto varias veces, se bloquea un momento." },
        { q: "¿Puedo usarlo sin iniciar sesión?", a: "Si está disponible, puedes probarlo como invitado. Las conversaciones de invitado se guardan solo en este navegador y no quedan en el servidor (los archivos adjuntos se conservan un tiempo breve y después se borran automáticamente)." },
      ],
    },
    "tour-workspace": {
      title: "Recorrido por la pantalla principal",
      summary: "Conoce en la barra lateral el chat nuevo, la búsqueda, las herramientas de organización, los proyectos, el menú de cada conversación y dónde está la ayuda.",
      steps: [
        { title: "Chat nuevo", body: "Abre una conversación nueva con «Nuevo chat», arriba del todo en la barra lateral." },
        { title: "Buscar chats", body: "Con «Buscar chats» encuentras conversaciones por título. Si has iniciado sesión, también busca en el contenido de los mensajes guardados." },
        { title: "Herramientas de organización", body: "Al desplegar «Herramientas de organización» aparecen los filtros «Bloqueo con contraseña» y «Enlace compartido activo», y «Proyectos»." },
        { title: "Menú de la conversación", body: "En el menú ⋮ junto a una conversación elige «Renombrar», «Fijar chat», «Mover a proyecto», «Compartir», «Descargar (.txt)», «Bloquear chat» o «Eliminar»." },
        { title: "Ayuda", body: "En «Ayuda y guías», en la barra lateral, puedes volver a ver la guía de la barra lateral o abrir toda la ayuda." },
      ],
      faq: [
        { q: "¿Qué significan las marcas «Bloqueado» y «Compartido»?", a: "«Bloqueado» es una conversación que pide contraseña, y «Compartido» es una conversación con un enlace público de solo lectura activado." },
        { q: "¿Se ven en otros dispositivos los chats fijados?", a: "Si has iniciado sesión, se guardan en tu cuenta y son iguales en otros dispositivos. Si no, solo quedan en este navegador." },
      ],
    },
    "chat-vs-review": {
      title: "Diferencia entre Chat y Review",
      summary: "Chat es donde sigues una conversación con un modelo; Review es donde comparas en paralelo las respuestas de varios modelos que elijas.",
      steps: [
        { title: "Elegir el producto", body: "En el selector de producto de la parte superior, elige «Chat» o «Comparación de modelos» (Review)." },
        { title: "Chat", body: "En Chat responde un solo modelo cada vez. Si eliges otro modelo, cambia el modelo que responde." },
        { title: "De Chat a la comparación", body: "Si quieres ver una respuesta de Chat con varios modelos, pulsa «Comparar en Review». Se abre un Review nuevo con esa pregunta." },
        { title: "De Review a Chat", body: "Con la sesión iniciada, bajo el resultado de un análisis de Review guardado, pulsa «Continuar en Chat» para seguir desde un borrador de Chat. Todavía no está disponible en las comparaciones de invitado ni en los enlaces compartidos." },
      ],
      faq: [
        { q: "¿Puedo pasar una conversación ya creada a otro producto?", a: "Cada conversación se abre en el producto donde se creó. Comparar o continuar crea una conversación nueva." },
        { q: "¿Qué diferencia hay entre «Easy» y «Professional» en Review?", a: "Si está disponible, en Easy solo eliges proveedores y se decide el modelo para cada pregunta; en Professional eliges tú los modelos que se comparan." },
      ],
    },
    // ------------------------------------------------------------------- chat
    "choose-model-auto": {
      title: "Elegir modelo y la adaptación inteligente",
      summary: "Con la adaptación inteligente activada se elige un modelo para cada mensaje; si la desactivas, responde el modelo que elijas tú.",
      steps: [
        { title: "Comprobar la adaptación inteligente", body: "Si tu cuenta la tiene, el cuadro de texto muestra el interruptor «Adaptación inteligente», que en un Chat vacío está activado al principio." },
        { title: "Elegir tú el modelo", body: "Abre el selector de modelos y pulsa un modelo en la pestaña «Chat». Así la adaptación inteligente se desactiva y responde el modelo elegido." },
        { title: "Ver qué modelo respondió", body: "En la insignia «Automático · nombre del modelo», bajo la respuesta, ves qué modelo respondió realmente." },
        { title: "Ver cómo se entendió el mensaje", body: "Si Auto reformuló tu mensaje, puedes desplegar «Cómo leyó Auto tu mensaje», bajo la insignia. No se muestra en las conversaciones con adjuntos." },
      ],
      faq: [
        { q: "¿Cuántos créditos cuesta?", a: "Con la adaptación inteligente, los créditos dependen del modelo que responda. Si eliges tú, se aplican los créditos base de ese modelo; si la entrada es larga se aplica un multiplicador y, si se ejecuta la búsqueda web, se suman 8 créditos por modelo." },
        { q: "¿Se guarda cambiado el mensaje que envié?", a: "No. Tu mensaje se guarda tal como lo escribiste." },
        { q: "¿Dejará de poder desactivarse la adaptación inteligente?", a: "No. Puedes desactivarla en cualquier momento eligiendo tú el modelo." },
      ],
    },
    "prompt-refiner": {
      title: "Mejora de la pregunta (adaptación inteligente)",
      summary: "En Chat con la adaptación inteligente activada, Tomverse mejora cuando hace falta la pregunta que envías para que sea más clara y la pasa al modelo que responde. En la conversación se guarda tal como la escribiste.",
      steps: [
        { title: "Comprobar la adaptación inteligente", body: "Comprueba que el interruptor «Adaptación inteligente» del cuadro de texto está activado. En un Chat vacío lo está desde el principio." },
        { title: "Enviar", body: "Escribe tu pregunta y pulsa «Enviar». No hay ningún botón extra que pulsar." },
        { title: "Ver el resultado", body: "En la insignia «Automático · nombre del modelo», bajo la respuesta, ves qué modelo respondió. Si Auto reformuló tu pregunta, puedes desplegar «Cómo leyó Auto tu mensaje»." },
        { title: "Si quieres mejorarla tú", body: "Con la sesión iniciada, en una conversación guardada en la que desactivaste la adaptación inteligente y elegiste tú el modelo, puedes pulsar «Mejorar redacción» para recibir una sugerencia y elegir «Usar esta redacción» o «Conservar original»." },
      ],
      faq: [
        { q: "¿Se guarda cambiado el mensaje que envié?", a: "No. La frase mejorada solo se pasa al modelo que responde; en la conversación se guarda tal como la escribiste." },
        { q: "¿Y si quiero enviarla sin mejorarla?", a: "Desactiva la adaptación inteligente y elige tú el modelo." },
        { q: "¿Lee también la conversación anterior o mis archivos?", a: "Para resolver referencias a lo anterior, como «arregla el código de arriba», puede leer parte de la respuesta inmediatamente anterior. No lee el contenido de los archivos adjuntos y, en las conversaciones con adjuntos, no reescribe la pregunta." },
      ],
    },
    "voice-input": {
      title: "Escribir con la voz",
      summary: "Habla al micrófono y tu voz se convierte en texto en el cuadro de texto; puedes corregirlo antes de enviar.",
      steps: [
        { title: "Empezar a grabar", body: "Pulsa el micrófono («Grabar entrada de voz») bajo el cuadro de texto. Si el navegador pide permiso para el micrófono, permítelo." },
        { title: "Hablar", body: "Mientras hablas, sobre el cuadro de texto se muestra «Grabando» con el tiempo." },
        { title: "Convertir en texto", body: "Si pulsas de nuevo el mismo botón, al terminar la conversión el texto aparece en el cuadro de texto." },
        { title: "Corregir y enviar", body: "Corrige el texto y pulsa «Enviar». Para descartarlo, pulsa «Cancelar»." },
      ],
      faq: [
        { q: "¿Se guarda la grabación?", a: "Tomverse no guarda las grabaciones. Se envían al proveedor de reconocimiento de voz solo para convertirlas en texto, y las grabaciones canceladas no se envían." },
        { q: "¿Cuesta créditos?", a: "La entrada de voz no descuenta créditos. Puede haber un límite de uso diario. La «conversación por voz», en la que hablas y te responden de viva voz, descuenta aparte el uso de voz." },
        { q: "No puedo grabar.", a: "Funciona en las últimas versiones de Chrome, Edge, Safari y Firefox. Si el micrófono está bloqueado, permite el micrófono de este sitio en los ajustes del navegador." },
      ],
    },
    "voice-conversation": {
      title: "Seguir la conversación hablando (conversación por voz)",
      summary: "Con el botón de conversación por voz, que aparece cuando el cuadro de texto está vacío, sigues la conversación hablando. Tus preguntas y respuestas quedan en este chat y el uso de voz se descuenta en créditos.",
      steps: [
        { title: "Empezar la conversación por voz", body: "Cuando el cuadro de texto está vacío, en el lugar del botón de enviar aparece el botón «Conversación por voz». Púlsalo y luego pulsa «Iniciar conversación por voz»; el navegador pedirá permiso para el micrófono. Permítelo." },
        { title: "Hablar", body: "Mientras hablas, se muestran por separado tus subtítulos y los de Tomverse. Puedes interrumpir hablando en cualquier momento." },
        { title: "Silenciar el micrófono", body: "Aunque pulses «Silenciar micrófono», el tiempo de conexión sigue contando. Si quieres hacer una pausa, es mejor terminar la conversación." },
        { title: "Terminar la conversación", body: "Pulsa «Finalizar conversación» para volver al mismo chat; tus preguntas y respuestas siguen en este chat." },
      ],
      faq: [
        { q: "¿Cuántos créditos cuesta?", a: "Aunque dejes de hablar o silencies el micrófono, el uso de voz se descuenta en créditos por el tiempo que estés conectado. El modelo que genera la respuesta y la búsqueda web se descuentan aparte. Antes de empezar se indica el máximo de créditos que se reservan temporalmente, y lo que no se use se devuelve tras la liquidación." },
        { q: "¿En qué se diferencia de la entrada de voz?", a: "La entrada de voz convierte lo que dices en texto en el cuadro de texto, puedes corregirlo antes de enviar y no cuesta créditos. La conversación por voz es de ida y vuelta hablando y el uso de voz se descuenta aparte." },
        { q: "¿Puedo usarla sin iniciar sesión?", a: "No. Solo se puede usar con la sesión iniciada, y una conversación bloqueada hay que desbloquearla antes. La voz se envía al proveedor del servicio de conversación por voz y Tomverse no guarda las grabaciones." },
      ],
    },
    "use-current-location": {
      title: "Preguntar por lugares cercanos con tu ubicación actual",
      summary: "Si activas «Ubicación actual» en «Añadir y herramientas», en cada mensaje se envía tu ubicación aproximada al proveedor de IA para responder a preguntas como los lugares cercanos. Viene desactivada por defecto.",
      steps: [
        { title: "Activarla", body: "En el menú «Añadir y herramientas» del cuadro de texto, activa «Ubicación actual». Si el navegador o el dispositivo pide permiso de ubicación, permítelo." },
        { title: "Comprobar el estado", body: "Mientras está activada se muestra «Ubicación activada · se actualiza con cada mensaje». No hay seguimiento en segundo plano." },
        { title: "Preguntar", body: "Pregunta, por ejemplo, «Dime qué cafeterías hay cerca». Si la pregunta necesita tu ubicación actual, se puede pedir el permiso de ubicación antes de responder aunque no la hayas activado." },
        { title: "Desactivarla", body: "Pulsa «Desactivar ubicación actual» o desactívala en el menú «Añadir y herramientas». Se desactiva al recargar la página o al cambiar de cuenta." },
      ],
      faq: [
        { q: "¿A dónde se envía la ubicación?", a: "Mientras está activada, en cada mensaje se envía tu ubicación aproximada, junto con esa solicitud, al proveedor de IA que genera la respuesta. No se crea un registro de ubicación aparte." },
        { q: "¿Queda el lugar en la respuesta?", a: "La respuesta de la IA puede mencionar lugares, y a esa respuesta se le aplican los ajustes habituales de conservación, exportación y compartir de las conversaciones. Compruébalo antes de compartir." },
        { q: "¿Y si rechazo el permiso de ubicación?", a: "La conversación continúa sin la ubicación. También puedes escribir el lugar tú. Si rechazas el permiso o la desactivas, en la sesión actual no se vuelve a pedir automáticamente." },
      ],
    },
    "chat-starters": {
      title: "Rellenar tu pregunta con ejemplos de inicio",
      summary: "Al elegir una tarjeta de ejemplo en una conversación nueva, la pregunta se rellena en el cuadro de texto. No se envía nada hasta que envías el mensaje.",
      steps: [
        { title: "Elegir una tarjeta", body: "Si está disponible, pulsa una tarjeta de “Lo que puedes hacer aquí” en la pantalla de chat nuevo. Para ver más, pulsa «Ver más sugerencias»." },
        { title: "Ajustarla", body: "Modifica como quieras la frase que se rellenó en el cuadro de texto." },
        { title: "Enviar", body: "Solo se envía de verdad cuando pulsas «Enviar». Las tarjetas con una insignia como «Requiere iniciar sesión» te llevan al inicio de sesión o a la información de planes." },
      ],
      faq: [
        { q: "¿Se borra lo que estaba escribiendo?", a: "No. Solo cambia si el cuadro de texto está vacío o contiene exactamente la frase que rellenó la tarjeta anterior." },
        { q: "¿Cuesta créditos pulsar una tarjeta?", a: "Pulsar una tarjeta no cuesta nada. Pero las tarjetas que activan la búsqueda web, como las de fuentes, pueden aumentar los créditos del siguiente envío." },
      ],
    },
    // ----------------------------------------------------------------- review
    "compare-answers": {
      title: "Comparar en paralelo las respuestas de varios modelos",
      summary: "En Review envías la misma pregunta hasta a 3 modelos y lees las respuestas en paralelo.",
      steps: [
        { title: "Elegir modelos", body: "En Review abre «Elegir modelos» y escoge hasta 3. Si ya hay 3, elige el modelo que quieres sustituir." },
        { title: "Enviar la pregunta", body: "Escribe la pregunta y pulsa «Comparar» (en la pantalla Classic, «Enviar»). Los modelos elegidos responden a la vez." },
        { title: "Preguntar solo a un modelo", body: "Para seguir preguntando solo a un modelo, usa «Preguntar solo a este modelo» en su panel." },
        { title: "Cambiar la vista", body: "Cambia entre «Enfoque» y «En paralelo». Cambiar la vista no vuelve a enviar nada." },
        { title: "Quitar un modelo", body: "Pulsa «Quitar de la comparación». Puedes volver atrás con «Deshacer»." },
      ],
      faq: [
        { q: "¿Se cobran créditos por cada modelo?", a: "Sí. Cada modelo elegido consume los créditos de respuesta." },
        { q: "¿Puedo comparar sin iniciar sesión?", a: "Si está disponible, los invitados también pueden comparar hasta 3 modelos." },
      ],
    },
    "quick-difference-summary": {
      title: "Hojear las respuestas con el resumen rápido de diferencias",
      summary: "Si pulsas «Resumen rápido de diferencias» bajo las respuestas comparadas, la IA resume brevemente las conclusiones comunes, las diferencias importantes, las afirmaciones clave de cada modelo y lo que requiere verificación adicional.",
      steps: [
        { title: "Preparar las respuestas", body: "Espera a que terminen las respuestas de varios modelos a la misma pregunta." },
        { title: "Iniciar el resumen", body: "En la pantalla de comparación, pulsa «Resumen rápido de diferencias» (en pantallas estrechas, «Diferencias»)." },
        { title: "Ejecutar", body: "Lee el aviso «La IA comparará N respuestas completas a la pregunta más reciente» y el uso estimado, y pulsa «Analizar · N créditos»." },
        { title: "Leer", body: "Léelo en este orden: «Conclusiones comunes», «Diferencias importantes», «Afirmaciones clave por modelo» y «Requiere verificación adicional»." },
      ],
      faq: [
        { q: "¿Cuántos créditos cuesta?", a: "Una comparación corta típica cuesta alrededor de 1 crédito; las respuestas largas pueden costar más. Si el análisis falla, se devuelven los créditos reservados." },
        { q: "¿Me dice cuál es la respuesta correcta?", a: "No. Solo compara las respuestas recibidas y no busca en la web ni verifica hechos externos. Las citas por punto y la comprobación en la web se hacen en AI Review." },
        { q: "¿También pueden usarlo los invitados?", a: "Los invitados solo pueden usarlo una vez al día. Con la sesión iniciada no hay límite y, en las conversaciones guardadas, el análisis se guarda." },
      ],
    },
    "read-ai-review": {
      title: "Ejecutar y leer AI Review",
      summary: "Cuando hay al menos 2 respuestas completas, un modelo revisor independiente (normalmente dos revisores de proveedores distintos) resume los puntos en común, las diferencias, las contradicciones, lo que falta y lo que conviene comprobar.",
      steps: [
        { title: "Preparar las respuestas", body: "Comprueba que al menos 2 respuestas a la misma pregunta han terminado." },
        { title: "Ejecutar", body: "Pulsa «Revisión cruzada de respuestas con IA» (en Studio de escritorio, «Analizar con Tomverse»)." },
        { title: "Elegir el criterio", body: "Si la pantalla permite elegir criterio, escoge «Equilibrado», «Evidencia» o «Acción» y pulsa «Ejecutar revisión cruzada»." },
        { title: "Leer el resultado", body: "Léelo en este orden: lo que coincide, las diferencias importantes, las contradicciones, lo que falta y lo que conviene comprobar." },
        { title: "Dejar tu opinión", body: "En cada punto puedes pulsar «Útil», «Incorrecto», «Poco claro» o «Falta un punto importante»." },
      ],
      faq: [
        { q: "¿AI Review me dice cuál es la respuesta correcta?", a: "No. Solo compara entre sí las respuestas recibidas y no hace búsquedas web ni comprobaciones de hechos externas." },
        { q: "¿Y los créditos si falla?", a: "Si no se completa, recuperas los créditos reservados. Cada ejecución cuesta normalmente en torno a 8 créditos y, si el saldo no alcanza, se muestran los créditos necesarios antes de ejecutar." },
        { q: "¿Hay un límite de usos?", a: "Un invitado puede probarlo 1 vez al mes y se muestran los usos que quedan. Free puede usarlo un número determinado de veces al mes y el límite mensual se muestra en la pantalla de ejecución." },
      ],
    },
    "follow-citations": {
      title: "Seguir las citas de los puntos de la revisión",
      summary: "Abre la cita textual de cada punto de la revisión para ver a qué parte de la respuesta real corresponde.",
      steps: [
        { title: "Elegir un punto", body: "Elige un punto en «Hallazgos de la revisión». Sobre la cita se indica a qué respuesta (A/B/C) pertenece." },
        { title: "Ver la marca de comprobación", body: "Se indica si la cita se ha comprobado en el original o si no se pudo comprobar y conviene tener más cuidado." },
        { title: "Ir al original", body: "Pulsa «Ver en la respuesta original», bajo la cita, para ir a esa parte del texto original de la respuesta." },
        { title: "Comprobar en la web (opcional)", body: "Si lo necesitas, pulsa «Comprobar con búsqueda web» solo en ese punto. Se ejecuta aparte, cuesta créditos y no cambia la revisión original." },
      ],
      faq: [
        { q: "Si aparece «Esta cita se encontró en la respuesta de origen», ¿es cierto?", a: "No. Solo significa que esa frase está en la respuesta; no garantiza que el contenido sea correcto. Para saber si es verdad, usa «Comprobar con búsqueda web» en ese punto." },
        { q: "¿La coincidencia con la fuente es una medida de exactitud?", a: "No. Solo muestra cuánto coincide la frase citada con el original." },
      ],
    },
    "save-share-review": {
      title: "Guardar, compartir y exportar comparaciones y análisis",
      summary: "Si has iniciado sesión, se guardan la conversación y el análisis. Puedes compartir el análisis con un enlace de solo lectura o exportarlo como archivo.",
      steps: [
        { title: "Iniciar sesión y comparar", body: "Si comparas con la sesión iniciada, la conversación y el resultado del análisis se guardan en tu cuenta. El análisis de un invitado desaparece al recargar la página." },
        { title: "Compartir el análisis", body: "Pulsa «Compartir análisis», bajo el resultado, revisa qué contenido se hará público y pulsa «Publicar enlace»." },
        { title: "Enviar o detener el enlace", body: "Envíalo con «Copiar enlace». Para detenerlo, pulsa «Revocar enlace»." },
        { title: "Obtener un archivo", body: "Pulsa «Exportar» y elige el formato del archivo (PDF, Word, TXT, Markdown)." },
      ],
      faq: [
        { q: "Si comparto el análisis, ¿qué pasa con el enlace anterior de la conversación?", a: "El enlace compartido anterior de esta conversación se sustituye por el nuevo." },
        { q: "¿Qué incluye el archivo exportado?", a: "Incluye el análisis completo, la pregunta, el modelo de origen y si las citas coinciden. No incluye las respuestas completas de los modelos ni los archivos adjuntos." },
      ],
    },
    // ----------------------------------------------------------------- images
    "create-image": {
      title: "Crear imágenes en el chat",
      summary: "Describe en el chat la escena que quieres y, si se entiende como una petición de imagen, la respuesta llega como imagen en la misma conversación.",
      steps: [
        { title: "Escribir la petición", body: "En el cuadro de texto de Chat describe la escena, por ejemplo: «Crea una imagen: …»." },
        { title: "Enviar", body: "Envía el mensaje. No se pide ninguna confirmación aparte, y en el lugar de la respuesta aparece «Creando la imagen…»." },
        { title: "Ver el resultado", body: "Al terminar, la imagen lleva una insignia de calidad (borrador, estándar o alta calidad; el «Final» de la pantalla de imágenes equivale a alta calidad). Si necesitas más calidad, envía «Vuelve a crear esta imagen en alta calidad»." },
        { title: "Seguir retocándola", body: "Si envías algo como «Hazla más azul», se dibuja una imagen nueva a partir de la anterior." },
      ],
      faq: [
        { q: "¿Cuándo se usan los créditos?", a: "Cuando Chat responde con una imagen, se usan los créditos de imagen enseguida, sin pedir confirmación. También se usan al volver a crearla en alta calidad." },
        { q: "¿Y si no se entiende como una petición de imagen?", a: "Se responde con un texto normal." },
        { q: "Si comparto o exporto la conversación, ¿se incluyen las imágenes?", a: "No. Solo se incluye la frase que indica que se creó una imagen." },
      ],
    },
    "compare-image-models": {
      title: "Comparar los resultados de varios modelos de imagen",
      summary: "En la pantalla de imágenes envías una misma descripción a varios modelos a la vez y comparas los resultados en paralelo.",
      steps: [
        { title: "Abrir la pantalla de imágenes", body: "Pulsa el icono de imagen a la derecha del botón «Nuevo chat» de la barra lateral (en la barra lateral plegada, «+») y elige «Nueva imagen». También puedes elegir un modelo en la pestaña «Imagen» del selector de modelos." },
        { title: "Elegir modelos", body: "En el chip de modelo sobre el cuadro de texto elige los que quieres comparar. Se muestra cuántos puedes elegir a la vez." },
        { title: "Calidad y tamaño", body: "Elige la «Calidad» (borrador, estándar, final) y el «Tamaño» (cuadrada, horizontal, vertical). Según el modelo, solo se pueden elegir algunos tamaños." },
        { title: "Escribir la descripción y generar", body: "Describe la imagen que quieres, comprueba los créditos del chip de modelo (si eliges varios, «Total N créditos») y pulsa «Generar»." },
        { title: "Obtener los resultados", body: "Pulsa «Tamaño completo» o «Descargar». Si un modelo falla, solo ese modelo se puede volver a probar con «Reintentar este modelo»." },
      ],
      faq: [
        { q: "¿Se cancela la generación si salgo de la página?", a: "No. Puede tardar hasta unos 2 minutos y sigue creándose aunque salgas de la página." },
        { q: "El enlace «Tamaño completo» no se abre.", a: "El enlace del original solo es válido unos minutos. Si lo pulsas de nuevo pasado un rato, se genera un enlace nuevo." },
      ],
    },
    "edit-photo": {
      title: "Retocar una foto adjunta",
      summary: "Adjunta una foto al chat y escribe qué quieres cambiar. Si se entiende como una petición de edición, la respuesta llega como la imagen retocada.",
      steps: [
        { title: "Adjuntar la foto", body: "En «Añadir y herramientas», junto al cuadro de texto, usa «Añadir un archivo» para adjuntar una foto (excepto GIF animados)." },
        { title: "Escribir qué cambiar", body: "Describe el cambio, por ejemplo: «Cambia el fondo por una playa al atardecer»." },
        { title: "Enviar", body: "Si es una petición de edición, responde con la imagen retocada; si no, con una respuesta normal sobre la foto." },
      ],
      faq: [
        { q: "¿Se cambia la foto original?", a: "No. Tu foto se queda como está y se crea una imagen nueva." },
        { q: "¿Y si adjunto varias fotos?", a: "Se retoca la primera de las fotos adjuntas." },
        { q: "¿Cuántos créditos cuesta?", a: "Se descuentan enseguida, sin confirmación. Al precio de una imagen del tamaño que corresponde a la orientación de la foto se le puede sumar un coste de edición según el modelo." },
      ],
    },
    "image-credits": {
      title: "Créditos de imagen y devoluciones",
      summary: "Las imágenes usan créditos fijos según modelo, calidad y tamaño, y si la generación falla recuperas todos los créditos reservados.",
      steps: [
        { title: "Ver el precio", body: "En la pantalla de imágenes comprueba el precio de cada modelo y el total de créditos." },
        { title: "Generar", body: "Al pulsar «Generar», los créditos se reservan primero." },
        { title: "Liquidación", body: "Si sale bien, se usan los créditos indicados; si falla, recuperas los créditos reservados." },
      ],
      faq: [
        { q: "¿En qué planes se puede usar?", a: "Con la sesión iniciada, Free, Pro y Max pueden usarlo dentro de los créditos que tengan." },
        { q: "¿Y si Chat responde con una imagen o retoco una foto?", a: "Se descuentan enseguida, sin confirmar el precio. Si falla, se devuelven con la misma regla." },
        { q: "¿Cuándo se devuelven?", a: "Cuando no se creó la imagen por un rechazo del proveedor, un bloqueo de seguridad, un error o un tiempo de espera agotado." },
        { q: "Me aparece «Los créditos del plan de hoy se agotaron».", a: "Las imágenes también usan los créditos diarios del plan. Si tienes créditos comprados, puedes seguir usándolos." },
      ],
    },
    // --------------------------------------------------------------- research
    "deep-research": {
      title: "Empezar con Deep Research",
      summary: "Escribe tu pregunta y ejecuta «Deep Research»: crea un informe con varias fuentes web a lo largo de unos minutos.",
      steps: [
        { title: "Escribir la pregunta", body: "Escribe primero en el cuadro de texto la pregunta que quieres investigar." },
        { title: "Abrir Deep Research", body: "En el menú «Añadir y herramientas» del cuadro de texto, pulsa «Deep Research»." },
        { title: "Elegir el alcance", body: "Elige el alcance entre «Rápido», «Estándar» y «Profundo», y comprueba el tiempo estimado y el uso estimado." },
        { title: "Empezar", body: "Pulsa «Iniciar la investigación». Se muestra el progreso: búsqueda de fuentes y redacción del informe." },
        { title: "Empezar desde la tarjeta de sugerencia", body: "Si bajo una respuesta normal aparece la tarjeta «Ampliar con Deep Research», puedes pulsarla para empezar enseguida con el alcance estándar." },
      ],
      faq: [
        { q: "¿En qué planes se puede usar?", a: "Con la sesión iniciada en Pro y Max." },
        { q: "Si borro el indicador de progreso, ¿se cancela la investigación?", a: "No. La investigación continúa en segundo plano." },
        { q: "¿Al pulsar la tarjeta de sugerencia se cobran créditos enseguida?", a: "Sí. Empieza directamente con el alcance estándar sin preguntar el alcance." },
      ],
    },
    "web-search": {
      title: "Activar la búsqueda web y comprobar las fuentes",
      summary: "Con la búsqueda web activada, se busca automáticamente cuando hace falta información reciente o fuentes, y bajo la respuesta se muestran los enlaces de las fuentes.",
      steps: [
        { title: "Activar la búsqueda web", body: "En el menú «Añadir y herramientas» del cuadro de texto, activa el interruptor «Búsqueda web»." },
        { title: "Ver el estado", body: "Si has elegido tú los modelos y pulsas el indicador «Búsqueda web activada» del cuadro de texto, ves cuántos de los modelos elegidos admiten la búsqueda." },
        { title: "Abrir las fuentes", body: "Los enlaces de la lista «Fuentes», bajo la respuesta, se abren en una pestaña nueva." },
        { title: "Sugerencia de buscar de nuevo", body: "Si con la búsqueda desactivada haces una pregunta que necesita información reciente, aparece la tarjeta «Consultar en la web». Al pulsarla, se vuelve a enviar la misma pregunta con búsqueda." },
      ],
      faq: [
        { q: "¿Cuesta créditos adicionales?", a: "Se suman 8 créditos por cada modelo que ejecuta la búsqueda web (igual sin importar cuántas búsquedas haga). Los modelos que no buscaron recuperan esos 8 créditos y los modelos de Perplexity no tienen créditos adicionales." },
        { q: "Me aparece «Los modelos que responden no pueden buscar en la web».", a: "Ninguno de los modelos elegidos admite búsqueda. Añade un modelo que admita búsqueda." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Adjuntar archivos: formatos y tamaño admitidos",
      summary: "Puedes adjuntar varios archivos por mensaje: documentos, tablas y datos, código, imágenes y ZIP. Todos los formatos aceptados están en la lista de abajo.",
      steps: [
        { title: "Añadir archivos", body: "En «Añadir y herramientas», junto al cuadro de texto, pulsa «Añadir un archivo» → «Elegir desde tu ordenador», o arrastra los archivos al cuadro de texto." },
        { title: "Esperar la comprobación", body: "Espera a que terminen las indicaciones «Subiendo» y «Comprobando»." },
        { title: "Enviar", body: "Envía el mensaje." },
      ],
      faq: [
        { q: "¿Cuántos archivos y de qué tamaño?", a: "Los límites de cantidad y tamaño, con y sin sesión, y todos los formatos aceptados están en la lista de formatos de abajo." },
        { q: "¿Qué archivos no se aceptan?", a: "No se aceptan programas ni instaladores, archivos comprimidos que no sean ZIP (RAR, 7Z, etc.), audio y vídeo, algunas imágenes como HEIC, TIFF y BMP, GIF animados, Keynote y PSD, ni documentos y ZIP protegidos con contraseña." },
        { q: "¿Hasta cuándo se conservan los archivos adjuntos?", a: "Con la sesión iniciada, los adjuntos se conservan junto con la conversación y se borran cuando eliminas la conversación o la cuenta. Los archivos de invitado se conservan un tiempo breve y se borran automáticamente." },
      ],
    },
    "google-drive": {
      title: "Adjuntar archivos desde Google Drive",
      summary: "Elige en Drive documentos, hojas de cálculo o presentaciones de Google y adjúntalos a la conversación.",
      steps: [
        { title: "Abrir Drive", body: "En el cuadro de texto, pulsa «Añadir y herramientas» → «Añadir un archivo» → «Adjuntar desde Google Drive»." },
        { title: "Permitir el acceso", body: "Si aparece la ventana de permisos de Google, permítelo. Es un permiso que solo da acceso a los archivos que elijas." },
        { title: "Elegir archivos", body: "Elige archivos en la ventana de selección de Google. Puedes elegir varios, pero no carpetas." },
        { title: "Enviar", body: "Cuando aparezca la etiqueta del adjunto, envía el mensaje." },
      ],
      faq: [
        { q: "¿Tengo que iniciar sesión?", a: "Sí. Google Drive solo se puede usar con la sesión iniciada." },
        { q: "¿Qué archivos se ven?", a: "Se ven documentos, hojas de cálculo y presentaciones de Google, y se adjuntan convertidos a texto, xlsx y pptx respectivamente." },
      ],
    },
    "convert-files": {
      title: "Convertir archivos adjuntos",
      summary: "Reúne fotos en un PDF, une o divide PDF y cambia el formato de tablas: adjunta el archivo y pídelo con tus palabras.",
      steps: [
        { title: "Adjuntar el archivo", body: "En «Añadir y herramientas» del cuadro de texto, usa «Añadir un archivo» para adjuntar a este mensaje el archivo que quieres convertir. Solo se convierten los archivos adjuntos a este mensaje." },
        { title: "Decir qué conversión quieres", body: "Escribe, por ejemplo, «Haz un solo PDF con estas dos fotos», «Divide este PDF de 3 en 3 páginas» o «Pasa este Excel a CSV». Se pueden reunir fotos y PDF en un solo PDF, unir o dividir PDF, reordenar o girar páginas, convertir un PDF en imágenes, cambiar el formato o el tamaño de imágenes y convertir tablas de Excel y CSV." },
        { title: "Enviar", body: "Envía el mensaje. Mientras se crea, se muestra «Creando…»." },
        { title: "Descargar", body: "En la tarjeta «Archivo generado», bajo la respuesta, pulsa «Descargar». Si hay varios resultados, llegan juntos en un ZIP." },
      ],
      faq: [
        { q: "¿Se convierten también los archivos que subí antes?", a: "No. Se convierten los archivos adjuntos al mensaje que envías ahora. Para cambiar un archivo anterior, vuelve a adjuntarlo y envíalo." },
        { q: "¿Tengo que iniciar sesión? ¿Sirve cualquier modelo?", a: "Hay que iniciar sesión y debe responder un modelo que pueda crear archivos. Si el modelo que elegiste no puede crear archivos, se te avisa; vuelve a pedirlo con la adaptación inteligente u otro modelo." },
        { q: "¿Puede convertir un documento de Word en PDF?", a: "Reescribir el contenido de un documento en otro formato no es una conversión sino crear algo nuevo, así que el diseño del original no se copia tal cual y se vuelve a crear." },
      ],
    },
    "generated-files": {
      title: "Descargar los archivos que crea la IA",
      summary: "Si pides algo como «hazlo en Excel», bajo la respuesta aparece una tarjeta «Archivo generado» desde la que lo descargas.",
      steps: [
        { title: "Indicar el formato", body: "En la conversación, pide el archivo indicando el formato que quieres (Excel, Word, PDF, PowerPoint, CSV, etc.)." },
        { title: "Esperar", body: "Mientras se crea, se muestra «Creando…»." },
        { title: "Descargar", body: "En la tarjeta «Archivo generado», bajo la respuesta, pulsa «Descargar». Si falla, pulsa «Crear el archivo de nuevo»." },
        { title: "Pedir cambios", body: "Si pulsas «Crear una revisión», se rellena en el cuadro de texto un borrador con el archivo adjunto. Tienes que enviarlo tú, y se crea como una versión nueva." },
      ],
      faq: [
        { q: "¿Tengo que iniciar sesión?", a: "Sí. Con la sesión iniciada se puede usar con cualquier plan. Si el modelo que elegiste no puede crear archivos, se te avisa; vuelve a pedirlo con la adaptación inteligente u otro modelo." },
        { q: "¿Puedes cambiar a otro formato un archivo que subí?", a: "Sí. Para reunir fotos en un PDF, unir y dividir PDF o cambiar el formato de tablas, mira la guía «Convertir archivos adjuntos»." },
        { q: "Me aparece «Desbloquea este chat para descargar el archivo».", a: "Los archivos de una conversación bloqueada solo se descargan después de desbloquearla." },
        { q: "Si pido cambios, ¿se sobrescribe el archivo original?", a: "No. Se crea una versión nueva y en la lista «Versiones del archivo» puedes ver las anteriores." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Crear tu propio asistente y añadir archivos de conocimiento",
      summary: "Reúne nombre, instrucciones, modelo y archivos de conocimiento en un asistente solo tuyo y elígelo en las conversaciones.",
      steps: [
        { title: "Empezar a crearlo", body: "En la pestaña «Asistentes de IA» de «Ajustes», pulsa «Nuevo asistente». También puedes empezar desde «Asistente», en el menú de herramientas de la conversación." },
        { title: "Nombre e instrucciones", body: "Escribe el «Nombre» y las «Instrucciones personalizadas» y pulsa «Crear asistente»." },
        { title: "Añadir archivos de conocimiento", body: "En «Archivos de conocimiento que puede usar esta revisión», pulsa «Añadir un archivo» y espera a que aparezca «listo»." },
        { title: "Guardar", body: "Pulsa «Guardar instrucciones, modelos y archivos». Cada vez que guardas se crea una revisión nueva." },
        { title: "Usarlo en las conversaciones", body: "Pulsa «Chatear con este asistente» o elígelo en «Asistente», en el menú de herramientas de la conversación." },
      ],
      faq: [
        { q: "¿Qué archivos puedo añadir como conocimiento?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods y odp. No se pueden añadir imágenes." },
        { q: "Si cambio las instrucciones, ¿se aplica también a las conversaciones en curso?", a: "No. Cambia solo cuando pulsas “Usar la revisión más reciente aquí” en la conversación." },
        { q: "¿Pueden otras personas ver mi asistente?", a: "No. El asistente solo se usa desde tu cuenta y no se comparte." },
      ],
    },
    "manage-memory": {
      title: "Ver, desactivar y borrar la memoria",
      summary: "Puedes ver y editar los recuerdos guardados, desactivarlos para todo o por conversación, y borrarlos uno a uno o todos.",
      steps: [
        { title: "Abrir la gestión de memoria", body: "En la pestaña «Personalización de la IA» de «Ajustes», en la fila «Memoria de la cuenta», pulsa «Gestionar memoria»." },
        { title: "Ver y editar", body: "En «Recuerdos en uso», pulsa «Editar», «Fijar» o «Eliminar». Para borrar hay que pulsar una vez más." },
        { title: "Desactivar todo", body: "En «Ajustes de uso de la memoria», desactiva «Usar la memoria en todos los chats». Los recuerdos guardados no se borran." },
        { title: "Desactivar por conversación", body: "En «Añadir y herramientas», junto al cuadro de texto, elige «Memoria de la cuenta» y luego «No usar en esta conversación»." },
        { title: "Borrar todo", body: "Si lo necesitas, haz antes una copia con «Descargar todo (JSON)» y borra con «Eliminar todos los recuerdos» introduciendo la frase de confirmación. No se puede deshacer." },
      ],
      faq: [
        { q: "¿De dónde salen los recuerdos?", a: "De lo que se resume de las conversaciones importadas de otros servicios de IA y de lo que añades con «Añadir un recuerdo manualmente»." },
        { q: "¿Se pasan los recuerdos al proveedor de IA?", a: "En las respuestas que usan la memoria, se pasan como material de referencia al proveedor de IA que genera la respuesta." },
        { q: "Si borro todos los recuerdos, ¿se borran también las conversaciones importadas?", a: "No. Las conversaciones importadas se borran por separado, en la gestión de importaciones." },
      ],
    },
    // --------------------------------------------------------------- projects
    "organise-projects": {
      title: "Organizar conversaciones con proyectos",
      summary: "Agrupa conversaciones relacionadas como en carpetas. Las conversaciones de un mismo proyecto no comparten contenido ni archivos entre sí.",
      steps: [
        { title: "Crear un proyecto", body: "Pulsa «Nuevo», junto a «Proyectos» en la barra lateral (la primera vez, «Crear tu primer proyecto») y escribe un nombre." },
        { title: "Mover conversaciones", body: "En el menú ⋮ de la conversación, elige el proyecto en «Mover a proyecto»." },
        { title: "Quitar y renombrar", body: "Quita una conversación con «Quitar del proyecto» y cambia el nombre con el botón del lápiz." },
        { title: "Eliminar un proyecto", body: "Pulsa «Eliminar proyecto» y confirma una vez más. Las conversaciones pasan a «Sin categoría» y no se borran." },
      ],
      faq: [
        { q: "¿Puedo poner instrucciones o archivos comunes en un proyecto?", a: "No. Un proyecto es solo una carpeta para organizar. Para instrucciones y archivos comunes, usa un asistente." },
        { q: "¿Cuántos proyectos puedo crear?", a: "Hasta 24 por cuenta." },
      ],
    },
    "lock-conversation": {
      title: "Bloquear una conversación (contraseña)",
      summary: "Si pones contraseña a una conversación, se pide antes de abrirla, compartirla, descargarla, modificarla o eliminarla.",
      steps: [
        { title: "Empezar el bloqueo", body: "En el menú ⋮ de la conversación, pulsa «Bloquear chat»." },
        { title: "Elegir la contraseña", body: "Introduce una contraseña de 8 a 128 caracteres." },
        { title: "Abrir una conversación bloqueada", body: "Al abrir una conversación bloqueada se pide la contraseña. Una vez verificada, no se vuelve a pedir durante un tiempo." },
        { title: "Quitar el bloqueo", body: "Pulsa «Desbloquear» en el menú e introduce la contraseña." },
      ],
      faq: [
        { q: "¿Y si olvido la contraseña?", a: "Tomverse no puede mostrarte ni restablecer la contraseña, así que si la olvidas no podrás volver a abrir esta conversación." },
        { q: "¿Bloquear significa cifrar?", a: "No. Es solo un bloqueo que impide verla; cuando se genera una respuesta, el contenido se envía al proveedor de IA." },
      ],
    },
    "share-link": {
      title: "Crear y detener un enlace para compartir",
      summary: "Convierte la conversación actual en una página pública de solo lectura. Quien tenga el enlace puede verla sin iniciar sesión.",
      steps: [
        { title: "Abrir compartir", body: "En el menú ⋮ de la conversación, pulsa «Compartir». Si la conversación está bloqueada, desbloquéala primero." },
        { title: "Crear el enlace", body: "Lee el aviso y pulsa «Crear enlace para compartir»; el enlace se copia." },
        { title: "Incluir lo último", body: "Los mensajes enviados después de compartir no se añaden automáticamente. Para incluirlos, pulsa «Regenerar enlace compartido»." },
        { title: "Dejar de compartir", body: "Pulsa «Dejar de compartir» y el enlace anterior deja de funcionar al instante." },
      ],
      faq: [
        { q: "¿Hasta cuándo es válido el enlace?", a: "Caduca 30 días después de crearlo, y la fecha de caducidad se muestra en la página compartida." },
        { q: "¿Hay conversaciones que no se pueden compartir?", a: "No se pueden compartir las conversaciones que continúan una conversación importada ni las de la pantalla de imágenes. La página compartida no incluye archivos generados ni imágenes." },
        { q: "¿Se comparte también mi memoria (Memory)?", a: "No. El contenido de la memoria no se comparte. Borra el contenido sensible antes de compartir." },
      ],
    },
    // ---------------------------------------------------------------- imports
    "import-chatgpt": {
      title: "Importar conversaciones de ChatGPT",
      summary: "Sube el archivo de exportación de datos de ChatGPT para guardar tus conversaciones anteriores en tu cuenta de Tomverse. El archivo original solo se lee dentro de tu navegador.",
      steps: [
        { title: "Exportar desde ChatGPT", body: "En ChatGPT, ve a Configuración → Controles de datos, solicita «Exportar datos» y descarga el archivo ZIP desde el enlace que recibes por correo. No hace falta descomprimirlo." },
        { title: "Abrir la pantalla de importación", body: "En la pestaña «Datos» de «Ajustes» de Tomverse, en la fila «Importar desde otro servicio de IA», pulsa «Gestionar importaciones» y luego «Empezar una importación nueva». También puedes llegar desde la tarjeta «Continuar un chat de otra IA» de la pantalla inicial de un Chat nuevo." },
        { title: "Elegir el servicio y el archivo", body: "En «¿Dónde está tu conversación?» elige «ChatGPT» y selecciona el archivo .zip o .json con «Elegir archivo de exportación»." },
        { title: "Elegir conversaciones", body: "Acota con la búsqueda por título o por fecha, usa «Seleccionar todas las conversaciones normales» o elige una a una, y pulsa «Revisar los chats seleccionados (N)»." },
        { title: "Importar", body: "En «Revisar antes de importar», pulsa «Importar N conversaciones». No cierres la pantalla hasta que termine el guardado." },
      ],
      faq: [
        { q: "¿Se importan también imágenes o adjuntos?", a: "No. No se importan imágenes, audio ni archivos adjuntos; solo se guarda el texto." },
        { q: "¿Se sube el archivo de exportación al servidor?", a: "El archivo original no sale de tu dispositivo. Solo se guarda en tu cuenta el texto de las conversaciones que elijas." },
        { q: "Si subo el mismo archivo otra vez, ¿se duplica?", a: "Las conversaciones que ya están en tu cuenta se omiten por duplicadas." },
      ],
    },
    "import-claude": {
      title: "Importar conversaciones de Claude",
      summary: "Sube el archivo de exportación de datos de Claude (ZIP o JSON) para guardar tus conversaciones en tu cuenta.",
      steps: [
        { title: "Exportar desde Claude", body: "En Claude, ve a Configuración → Privacidad, solicita «Exportar datos» y descarga el archivo desde el enlace del correo. Sirven tanto el ZIP como el JSON, tal cual." },
        { title: "Abrir la pantalla de importación", body: "Pulsa «Ajustes» → «Datos» → «Importar desde otro servicio de IA» → «Gestionar importaciones» → «Empezar una importación nueva»." },
        { title: "Elegir Claude", body: "En «¿Dónde está tu conversación?» elige «Claude» y selecciona el archivo con «Elegir archivo de exportación»." },
        { title: "Elegir conversaciones e importar", body: "Elige las conversaciones que quieres importar, pulsa «Revisar los chats seleccionados (N)» y después «Importar N conversaciones»." },
      ],
      faq: [
        { q: "Elegí mal el servicio.", a: "No pasa nada. Tras abrir el archivo, se comprueba automáticamente su formato real y se continúa según ese formato." },
        { q: "¿Qué pasa con los mensajes muy largos?", a: "Si superan el límite de guardado, con tu consentimiento se guardan acortados, conservando solo el principio y el final. Las conversaciones con mensajes demasiado largos se marcan como no importables." },
        { q: "¿Cuánto puedo importar?", a: "Cada cuenta tiene un límite de texto y de número de conversaciones que se pueden importar. Si lo elegido supera el espacio que queda, redúcelo con «Ajustar la selección»." },
      ],
    },
    "continue-imported": {
      title: "Continuar en Tomverse una conversación importada",
      summary: "Empieza una conversación nueva de Tomverse a partir de la importada. El original queda como solo lectura.",
      steps: [
        { title: "Empezar a continuar", body: "En la pantalla de importación completada, pulsa «Continuar esta conversación», o pulsa «Continuar» en la lista de «Gestionar importaciones». También sirve el botón «Continuar en Tomverse», al pie de la pantalla del original." },
        { title: "Leer el aviso", body: "Comprueba que se crea una conversación nueva y que el original queda intacto, que no se incluyen adjuntos y solo se usa como contexto una parte reciente, y que cada respuesta cuesta créditos." },
        { title: "Crear la conversación", body: "Pulsa «Crear la conversación»." },
        { title: "Elegir el original de referencia (opcional)", body: "Si lo necesitas, elige tú los fragmentos del original con «Elegir fragmentos del original» y pulsa «Usar los fragmentos seleccionados»." },
      ],
      faq: [
        { q: "¿Puedo crear imágenes en la conversación continuada?", a: "No. Empieza una imagen nueva desde la barra lateral." },
        { q: "¿Puedo compartir públicamente la conversación continuada?", a: "Todavía no." },
        { q: "¿Qué pasa con la conversación continuada si borro el original?", a: "Los mensajes de Tomverse se conservan y se añade la marca «Original eliminado»." },
      ],
    },
    "import-gemini": {
      title: "Importar conversaciones de Gemini",
      summary: "Sube el archivo JSON que exportas desde Google Takeout con la actividad de la app Gemini para guardar tus conversaciones anteriores en tu cuenta de Tomverse. El archivo original solo se lee dentro de tu navegador.",
      steps: [
        { title: "Abrir Takeout y desmarcar todo", body: "Abre Google Takeout y desmarca todo." },
        { title: "Elegir la actividad de la app Gemini en JSON", body: "Selecciona «Mi actividad», elige dentro de ella las apps de Gemini y establece el formato JSON. El elemento «Gemini» de Takeout en sí no contiene conversaciones, sino Gems." },
        { title: "Descargar el archivo", body: "Tras exportar, descarga el archivo .zip con el enlace de descarga que te envía Google. No hace falta descomprimirlo." },
        { title: "Abrir la pantalla de importación", body: "En la pestaña «Datos» de «Ajustes» de Tomverse, en la fila «Importar desde otro servicio de IA», pulsa «Gestionar importaciones» y luego «Empezar una importación nueva»." },
        { title: "Elegir e importar", body: "En «¿Dónde está tu conversación?» elige «Gemini» y selecciona el archivo con «Elegir archivo de exportación». Elige las conversaciones, pulsa «Revisar los chats seleccionados (N)» y luego «Importar N conversaciones»." },
      ],
      faq: [
        { q: "Lo exporté en HTML.", a: "La exportación de Gemini debe estar en formato JSON. El HTML no se puede leer; vuelve a exportar desde Takeout con el formato JSON." },
        { q: "¿Se sube el archivo original al servidor?", a: "El archivo original no sale de tu dispositivo. Solo se guarda en tu cuenta el texto de las conversaciones que elijas; no se importan imágenes, audio ni archivos adjuntos." },
        { q: "¿Se pueden importar también conversaciones de Perplexity?", a: "Sí. En Perplexity, pulsa el botón de exportar bajo una respuesta y elige Markdown (.md); luego elige Perplexity en la pantalla de importación y sube el archivo. Un archivo es un hilo. La exportación de Perplexity no marca dónde termina una pregunta, así que una pregunta y su respuesta pueden dividirse mal; abre la conversación tras importar para comprobarlo." },
      ],
    },
    "import-guest-conversations": {
      title: "Guardar en tu cuenta las conversaciones que tuviste como invitado",
      summary: "Pasa a tu cuenta las conversaciones de invitado que tuviste en este navegador antes de iniciar sesión.",
      steps: [
        { title: "Iniciar sesión", body: "Al iniciar sesión aparece la ventana «¿Importar tus conversaciones de invitado?»." },
        { title: "Elegir qué importar", body: "Pulsa «Importar solo la conversación actual» o «Importar las N conversaciones de invitado». Para omitirlo, pulsa «Empezar sin importar»." },
        { title: "Importar más tarde", body: "Si lo omitiste, puedes hacerlo desde «Importar las conversaciones de invitado de este navegador», en la pestaña «Datos» de «Ajustes». Solo aparece si en este navegador quedan conversaciones de invitado para importar." },
      ],
      faq: [
        { q: "¿Y si borro los datos del navegador?", a: "Si borras los datos del navegador o usas otro navegador o dispositivo, las conversaciones de invitado no se pueden recuperar." },
        { q: "Solo han fallado algunas.", a: "Se muestra cuántas han fallado y puedes pulsar «Volver a intentar»." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Conectar un plugin y elegir permisos",
      summary: "Conecta servicios externos como plugins y elige tú los permisos que concedes y las herramientas que se usan. Con la sesión iniciada, verás el botón del puzle en el cuadro de texto de Chat.",
      steps: [
        { title: "Abrir la pantalla de plugins", body: "En Chat, pulsa el botón del puzle del cuadro de texto y luego «Gestionar plugins»." },
        { title: "Empezar la conexión", body: "Pulsa «Añadir conexión MCP» o «Conectar» en la tarjeta de un servicio. Los servicios marcados «Requiere configurar el servidor» todavía no se pueden conectar." },
        { title: "Elegir permisos", body: "Si el servicio usa inicio de sesión, cuando aparezca la lista «Permisos que se conceden», marca solo lo necesario y pulsa «Conectar». Al volver tras iniciar sesión en el servicio, aparece «Conectados»." },
        { title: "Guardar las herramientas que se usarán", body: "En «Gestionar acceso», bajo «Seleccionar herramientas», marca las herramientas que usarás y pulsa «Guardar acceso». Hay que guardar las herramientas para poder elegirlas en Chat." },
      ],
      faq: [
        { q: "Quiero cambiar los permisos.", a: "En «Gestionar acceso», pulsa «Volver a autenticar» y elige de nuevo." },
        { q: "¿Se pasa el contenido de la conversación al servicio?", a: "Solo se envían la consulta y los valores necesarios para ejecutar. La conversación completa y la memoria no se comparten automáticamente." },
        { q: "¿Y si desconecto?", a: "Tras «Desconectar», se bloquean las llamadas nuevas y se borran las credenciales guardadas. Lo que ya se incluyó en respuestas permanece." },
      ],
    },
    "custom-mcp-server": {
      title: "Añadir la dirección de tu propio servidor MCP",
      summary: "Conecta un servidor MCP remoto de confianza introduciendo su dirección HTTPS pública.",
      steps: [
        { title: "Abrir MCP personalizado", body: "En la pantalla de plugins, pulsa «Conectar» en la tarjeta «Servidor MCP personalizado»." },
        { title: "Introducir la dirección", body: "Escribe la dirección del servidor en «URL del servidor (HTTPS)» y, si quieres, un «Nombre visible»." },
        { title: "Elegir la autenticación", body: "Elige «Sin autenticación», «Token Bearer» u «OAuth (registro dinámico de clientes)». Para Token Bearer, usa un token con los mínimos permisos emitido aparte por ese servicio." },
        { title: "Conectar y guardar las herramientas", body: "Pulsa «Conectar», elige las herramientas que usarás en «Gestionar acceso» y pulsa «Guardar acceso»." },
      ],
      faq: [
        { q: "Me aparece «No se puede usar esta dirección».", a: "Solo se admiten direcciones HTTPS públicas. No se permiten direcciones de redes internas, puertos distintos del 443 ni consultas después de la dirección." },
        { q: "OAuth no funciona.", a: "Ese servidor no admite el registro dinámico de clientes. Prueba a conectarte con un Token Bearer." },
        { q: "¿Tengo que aprobar cada vez que se usa una herramienta?", a: "Sí. En los servidores personalizados, cada ejecución de una herramienta se aprueba cada vez." },
      ],
    },
    "use-plugin-in-chat": {
      title: "Usar plugins en la conversación y aprobar su ejecución",
      summary: "Elige en Chat los plugins que conectaste y, si no es una herramienta de solo lectura ya revisada, comprueba el contenido y apruébala antes de ejecutarla.",
      steps: [
        { title: "Elegir un plugin", body: "Pulsa el botón del puzle del cuadro de texto de Chat y elige las conexiones que usarás en esta conversación." },
        { title: "Enviar la pregunta", body: "Pregunta como siempre. El modelo usa las herramientas que necesita." },
        { title: "Aprobar la ejecución", body: "Cuando aparezca «Revisar esta acción en Plugins», pulsa «Gestionar plugins» junto a él y, en la pestaña «Aprobaciones», revisa lo que se enviará y pulsa «Aprobar esta acción» o «Rechazar». Si no la apruebas en 10 minutos, caduca." },
      ],
      faq: [
        { q: "Lo conecté, pero no aparece en la lista.", a: "Hay que guardar al menos una herramienta en «Gestionar acceso» para que aparezca en la lista." },
        { q: "¿Se puede usar también en Review?", a: "La selección de plugins está en el cuadro de texto de Chat." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "Crear y revocar claves de API",
      summary: "Crea claves de API de Tomverse para usar en herramientas de programación, cambia su límite y nombre, y revoca las que no uses. La API y la CLI están disponibles en Pro y superiores. Las claves empiezan por tvk_.",
      steps: [
        { title: "Abrir la pantalla de claves de API", body: "En la pestaña «Cuenta» de «Ajustes», en la fila «Claves de API», pulsa «Gestionar»." },
        { title: "Crear una clave", body: "Junto a «Tus claves», pulsa «Nueva clave», escribe el «Nombre» y, si quieres, fija el «Límite de créditos (opcional)» y el vencimiento («Caduca», por defecto 90 días), y pulsa «Crear clave»." },
        { title: "Guardar la clave", body: "En «Copia tu clave ahora», pulsa «Copiar», guárdala en un lugar seguro y pulsa «Ya la guardé · Conectar una herramienta». La clave solo se ve esta vez." },
        { title: "Gestionarla", body: "En la lista «Tus claves», pulsa «⋯» en la fila de la clave y usa «Renombrar», «Cambiar límite» y «Solicitudes recientes»." },
        { title: "Revocar y sustituir", body: "En «⋯», en la fila de la clave, al pulsar «Revocar» las herramientas que usan esa clave se detienen al instante y no se puede deshacer. Para cambiarla, crea una clave nueva, ponla en la herramienta y revoca la anterior." },
      ],
      faq: [
        { q: "Perdí la clave.", a: "No se puede volver a ver. Tomverse solo guarda una huella de la clave. Crea una clave nueva y revoca la anterior." },
        { q: "¿Cuántas claves puedo crear?", a: "Hasta 10 claves en uso por cuenta." },
        { q: "Me aparece «La API y la CLI de Tomverse requieren un plan de pago».", a: "Las claves de API se pueden crear en Pro o superior. En Free está bloqueado; al pasar a Pro o Max podrás crear claves. Las claves que ya creaste se pueden revocar en esta pantalla. Si aparece «La API de Tomverse aún no está disponible para esta cuenta», es que la API todavía no está habilitada para esta cuenta." },
      ],
    },
    "connect-claude-code": {
      title: "Conectar Claude Code con Tomverse",
      summary: "Con unas pocas líneas de configuración, en el terminal o en la extensión oficial de VS Code, Claude Code usa los modelos Claude y los créditos de Tomverse. Disponible en Pro y superiores.",
      steps: [
        { title: "Preparar la clave", body: "Crea y guarda una clave siguiendo la guía «Crear y revocar claves de API»." },
        { title: "Elegir el modelo", body: "En la pantalla de claves de API, en «Conectar una herramienta», elige «Claude Code» y luego el «Modelo». Claude Code solo usa modelos Claude, así que solo aparecen los modelos compatibles con esta herramienta. Si eliges «Smart Adaptive», Tomverse elige uno de los modelos Claude al empezar una tarea y lo mantiene hasta que termina." },
        { title: "Usarlo en el terminal", body: "Elige «Línea de comandos», luego «Windows (PowerShell)» o «macOS / Linux», pulsa «Copiar» en el bloque y pégalo en el terminal. La última línea, claude, inicia Claude Code conectado a Tomverse." },
        { title: "Usarlo en la extensión de VS Code", body: "Elige «Extensión de VS Code», pon el bloque de settings.json que aparece en tu settings.json de usuario y reinicia VS Code." },
        { title: "Poner la clave", body: "Si acabas de crear la clave, ya está rellenada en la configuración hasta que salgas de esta página. Si no, sustituye <YOUR_TOMVERSE_API_KEY>, en la configuración copiada, por la clave que guardaste." },
      ],
      faq: [
        { q: "¿Cómo vuelvo a mi cuenta de Claude de siempre?", a: "Cierra el terminal, o elimina la configuración que pusiste en settings.json y reinicia VS Code." },
        { q: "La búsqueda web no funciona.", a: "Las herramientas que se ejecutan en los servidores de Anthropic, como la búsqueda web, no están disponibles con la conexión de Tomverse." },
        { q: "¿Puedo usar modelos de otros proveedores, como GPT o Gemini?", a: "No. Claude Code solo usa modelos Claude. Para usar los modelos de todos los proveedores, conecta una herramienta compatible con OpenAI como Cursor." },
        { q: "¿Se guarda la clave tal cual en settings.json?", a: "Sí. La extensión de Claude Code lee la clave del valor de una variable de entorno, así que la clave queda en el archivo. No compartas ese archivo." },
      ],
    },
    "connect-codex": {
      title: "Conectar Codex con Tomverse",
      summary: "Añade el proveedor de Tomverse al archivo de configuración de Codex y ejecútalo con --profile tomverse. Codex solo usa modelos de OpenAI y tu cuenta habitual de Codex no se toca. Disponible en Pro y superiores.",
      steps: [
        { title: "Preparar la clave y el modelo", body: "Crea una clave y, en la pantalla de claves de API, en «Conectar una herramienta», elige «Codex» y luego el «Modelo». Si eliges «Smart Adaptive», Tomverse elige uno de los modelos de OpenAI al empezar una tarea y lo mantiene hasta que termina." },
        { title: "Añadir el proveedor", body: "Pega el bloque «Añadir a ~/.codex/config.toml» en ~/.codex/config.toml." },
        { title: "Guardar el perfil", body: "Guarda el bloque siguiente como ~/.codex/tomverse.config.toml." },
        { title: "Poner la clave y empezar", body: "Sustituye <YOUR_TOMVERSE_API_KEY>, en el bloque «Define la clave donde se inicia Codex», por tu clave y ejecútalo. La última línea, codex --profile tomverse, inicia Codex con Tomverse." },
        { title: "Si usas la extensión de VS Code", body: "Elige «Extensión de VS Code» y pon al principio de config.toml el bloque «Para la extensión de VS Code, que solo lee config.toml…». La clave se pone como en el bloque «Define la clave donde se inicia Codex»." },
      ],
      faq: [
        { q: "¿Afecta a mi cuenta habitual de Codex?", a: "Si ejecutas Codex sin --profile tomverse, sigue usando tu cuenta de siempre." },
        { q: "¿Cómo deshago la configuración de la extensión de VS Code?", a: "Borra la línea model_provider que pusiste al principio de config.toml." },
        { q: "¿Hay funciones que no funcionan?", a: "No se pueden usar la búsqueda web alojada, las conversaciones almacenadas ni las respuestas en segundo plano." },
        { q: "¿Puedo usar modelos de otros proveedores, como Claude o Gemini?", a: "No. Codex solo usa modelos de OpenAI. Para usar los modelos de todos los proveedores, conecta una herramienta compatible con OpenAI como Cursor." },
      ],
    },
    "connect-cursor": {
      title: "Conectar Cursor con Tomverse",
      summary: "Pon Tomverse en la clave de OpenAI API y en la sustitución de la Base URL de Cursor para que Chat y Agent usen los modelos y créditos de Tomverse. Cursor es una herramienta compatible con OpenAI, así que puede usar los modelos de todos los proveedores. Disponible en Pro y superiores.",
      steps: [
        { title: "Preparar la clave", body: "Crea y guarda una clave siguiendo la guía «Crear y revocar claves de API»." },
        { title: "Ver la configuración de Cursor", body: "En la pantalla de claves de API, en «Conectar una herramienta», elige «Cursor» para ver su configuración. La clave que acabas de crear aparece rellenada hasta que salgas de esta página." },
        { title: "Ponerla en Cursor", body: "En Cursor, ve a Settings > Models > API Keys, pon la clave de Tomverse en OpenAI API Key, activa la sustitución de OpenAI Base URL y pon la URL base que se muestra en pantalla." },
        { title: "Elegir el modelo", body: "Los modelos GPT que ofrece Tomverse se eligen directamente en la lista de modelos de Cursor. Otros modelos, como Claude o Smart Adaptive, se añaden una sola vez: escribe su ID en Cursor Settings › Models y elige Add Custom Model." },
      ],
      faq: [
        { q: "¿Dónde usa Cursor esta clave?", a: "Solo la usan Chat y Agent; Tab, los modelos propios de Cursor y los agentes en la nube no." },
        { q: "¿Por qué puedo usar modelos de todos los proveedores?", a: "Cursor es una herramienta compatible con OpenAI, así que puedes elegir los modelos de todos los proveedores que permite el plan de tu cuenta. Claude Code y Codex solo usan modelos de su propio proveedor." },
        { q: "¿Cómo lo deshago?", a: "En Cursor, desactiva la clave de OpenAI y la sustitución de la Base URL." },
        { q: "¿Las solicitudes salen de mi ordenador?", a: "No. Cursor envía las solicitudes desde sus propios servidores, así que llegan a Tomverse por internet y no desde tu ordenador." },
      ],
    },
    "api-smart-adaptive": {
      title: "Usar Smart Adaptive en la API",
      summary: "Si pones smart-adaptive como nombre del modelo, Tomverse elige el modelo que responde en cada solicitud. La respuesta indica qué modelo respondió. Disponible en Pro y superiores.",
      steps: [
        { title: "Copiar la configuración", body: "La configuración que se copia al elegir una herramienta en la pantalla de claves de API ya incluye Smart Adaptive por defecto. No hace falta volver a copiarla cuando se añaden o retiran modelos." },
        { title: "Poner el nombre del modelo", body: "En las herramientas compatibles con OpenAI (Chat Completions), pon smart-adaptive como nombre del modelo." },
        { title: "Ver qué modelo respondió", body: "El valor model de la respuesta y las cabeceras x-tomverse-routed-model y x-tomverse-routed-by indican el modelo que respondió y cómo se eligió." },
        { title: "Comprobar los créditos", body: "Los créditos se descuentan según el modelo que respondió. En «Modelos permitidos por la API», de la pantalla de claves de API, ves el rango de créditos por solicitud." },
      ],
      faq: [
        { q: "¿Funciona también en Claude Code y Codex?", a: "Sí, pero solo elige dentro de los modelos del proveedor de cada herramienta (Claude Code, modelos Claude; Codex, modelos de OpenAI). Elige un modelo al empezar una tarea y lo mantiene hasta que termina." },
        { q: "¿Y si quiero fijar el modelo?", a: "Pon como nombre del modelo el ID de modelo que aparece en «Modelos permitidos por la API»." },
        { q: "¿Funciona en otras herramientas, como Cursor?", a: "En cualquier app que acepte un endpoint personalizado de OpenAI Chat Completions (URL base, clave de API, modelo) puedes poner esos tres valores." },
      ],
    },
    "api-usage": {
      title: "Consultar el uso de la API y los límites",
      summary: "Las solicitudes hechas con una clave usan los mismos créditos de la cuenta que Chat, y puedes fijar un límite de créditos para cada clave.",
      steps: [
        { title: "Ver el uso por clave", body: "En «Tus claves», en la pantalla de claves de API, ves los créditos que ha usado cada clave y los reservados para solicitudes en curso." },
        { title: "Ver las solicitudes recientes", body: "Al pulsar «⋯» → «Solicitudes recientes» en la fila de la clave ves, por solicitud, el modelo, los créditos, los tokens de entrada y salida, y el ID de solicitud." },
        { title: "Ver el saldo de la cuenta", body: "Al pulsar «Saldo y uso de la cuenta», se abre la pestaña «Plan»." },
        { title: "Créditos por modelo", body: "En «Modelos permitidos por la API», comprueba los créditos por solicitud de cada modelo." },
      ],
      faq: [
        { q: "Las solicitudes fallan con 401, 403, 404 o 429.", a: "401: la clave es incorrecta, ha caducado o se ha revocado. 403: la API está desactivada para esta cuenta o el uso de la cuenta está restringido. 404: el modelo no se ofrece (vuelve a copiar la configuración). 429: se alcanzó el límite de la clave, de los créditos o de la frecuencia de solicitudes." },
        { q: "¿Cuestan créditos las solicitudes fallidas?", a: "Si fallan antes de generar salida, no cuestan. Si cortas o detienes la respuesta a mitad, puede descontarse lo ya generado." },
        { q: "La herramienta hace varias solicitudes.", a: "Los pasos posteriores a ejecutar una herramienta y la compactación de la conversación cuentan también como una solicitud cada uno." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "Configurar las notificaciones por correo",
      summary: "Elige qué tipos de correo recibir. El correo de marketing empieza solo después de confirmar tu país de residencia y pulsar «Confirmar suscripción» en el correo de confirmación.",
      steps: [
        { title: "Abrir las notificaciones por correo", body: "En la pestaña «Cuenta» de «Ajustes», pulsa «Notificaciones por correo» → «Abrir notificaciones por correo»." },
        { title: "Activar y desactivar", body: "«Seguridad y cuenta» y «Facturación» están siempre activados. «Estado del servicio» se puede desactivar, y «Novedades del producto», «Boletín» y «Ofertas» empiezan desactivados." },
        { title: "Recibir correo de marketing", body: "Para activar un tipo de marketing, elige primero tu «País de residencia» (puedes guardarlo antes con «Confirmar país»)." },
        { title: "Correo de confirmación", body: "El envío empieza solo cuando abres el enlace del correo de confirmación que recibes y pulsas «Confirmar suscripción». Si hace falta, pulsa «Reenviar correo de confirmación»." },
        { title: "Desactivar todo de una vez", body: "Si algún tipo de marketing está activado, aparece «Desactivar todo el correo de marketing» y, al pulsarlo, se desactivan todos de una vez." },
      ],
      faq: [
        { q: "¿No puedo desactivar los correos de seguridad?", a: "Son avisos imprescindibles para proteger tu cuenta, así que no se pueden desactivar. Con los de facturación pasa lo mismo." },
        { q: "Activé el interruptor, pero sigue desactivado.", a: "Se ha enviado el correo de confirmación. Se activa cuando abres el enlace del correo y pulsas «Confirmar suscripción»." },
        { q: "No puedo pulsar el interruptor de marketing.", a: "Es el caso de que en tu país de residencia todavía no se ofrece correo de marketing. Sigues recibiendo los correos de seguridad, facturación y estado del servicio." },
        { q: "¿Puedo darme de baja sin iniciar sesión?", a: "Sí, con el enlace de baja que hay al pie del correo. Para volver a activarlo, tendrás que iniciar sesión." },
      ],
    },
    "use-on-mobile": {
      title: "Usar Tomverse en el navegador del teléfono",
      summary: "En el teléfono, la lista de conversaciones se abre como un panel a la izquierda y el cuadro de texto queda en la parte inferior de la pantalla.",
      steps: [
        { title: "Abrir el menú", body: "Pulsa el botón de menú de arriba a la izquierda para abrir el panel. Contiene el chat nuevo, la búsqueda y la lista de chats, y abajo el uso, el idioma, el menú de la cuenta y los comentarios." },
        { title: "Enviar", body: "La tecla Enter del teclado del teléfono hace un salto de línea. Para enviar, pulsa el botón de enviar." },
        { title: "Añadir a la pantalla de inicio", body: "Si en el menú de la cuenta aparece «Instalar Tomverse», púlsalo. En iPhone, sigue las indicaciones de ese menú: botón Compartir de Safari y «Añadir a la pantalla de inicio». Si no aparece, es que ya lo instalaste o que el navegador no lo admite." },
      ],
      faq: [
        { q: "¿Puedo subir archivos desde el teléfono?", a: "Sí. Sin iniciar sesión puedes adjuntar menos archivos y más pequeños; con sesión iniciada también puedes usar Google Drive. Los límites están en la guía de archivos adjuntos." },
        { q: "¿Puedo importar conversaciones desde el teléfono?", a: "Sí. Pero si el archivo de exportación es grande, te recomendamos hacerlo desde un ordenador." },
      ],
    },
    // ---------------------------------------------------------------- account
    "manage-login-methods": {
      title: "Añadir y quitar métodos de acceso",
      summary: "Puedes vincular a tu cuenta o quitar el acceso por correo, Google y Microsoft. Siempre debe quedar al menos un método de acceso.",
      steps: [
        { title: "Abrir los ajustes", body: "Pulsa el botón de la cuenta, abajo en la barra lateral, y en el menú de la cuenta pulsa «Configuración»." },
        { title: "Buscar la tarjeta de métodos de acceso", body: "En la pestaña «Cuenta», abre la tarjeta «Métodos de acceso»." },
        { title: "Vincular uno", body: "Pulsa «Añadir» en la fila del método que quieres vincular. El correo se verifica con un código; Google y Microsoft te llevan al inicio de sesión de ese servicio." },
        { title: "Quitar uno", body: "Pulsa «Eliminar» en la fila del método que quieres quitar y, cuando el botón cambie, pulsa una vez más «Haz clic de nuevo para eliminar». Si aparece una indicación para volver a iniciar sesión, inicia sesión y vuelve a eliminarlo." },
        { title: "Volver a iniciar sesión", body: "Al eliminar uno se cierra la sesión en todos los dispositivos, así que vuelve a iniciar sesión con el método que queda." },
      ],
      faq: [
        { q: "¿Puedo quitar el último método de acceso?", a: "No. La cuenta debe tener al menos un método de acceso." },
        { q: "Me aparece «Ese correo ya se usa con otro método de acceso».", a: "Inicia sesión con el método que usaste al registrarte (Google, Microsoft, Apple o correo) y añade el método nuevo desde los ajustes." },
        { q: "Me dice que la cuenta que quiero vincular ya está vinculada a otra cuenta de Tomverse.", a: "Una cuenta externa solo se puede vincular a una cuenta de Tomverse." },
        { q: "Me registré con Apple.", a: "El acceso con Apple no aparece en esta tarjeta, así que no se puede añadir ni quitar desde aquí. Si te registraste con Apple, añade también el correo, Google o Microsoft." },
      ],
    },
    "export-account-data": {
      title: "Descargar los datos de tu cuenta",
      summary: "Descarga en un solo archivo tus conversaciones, memoria, importaciones, pagos y uso. También hay una forma de descargar solo las conversaciones como texto.",
      steps: [
        { title: "Abrir la pestaña de datos", body: "En «Configuración», en el menú de la cuenta, abre la pestaña «Datos»." },
        { title: "Empezar la descarga", body: "En «Gestión de datos», en la fila «Los datos de tu cuenta», pulsa «Descargar tus datos»." },
        { title: "Preparar el archivo", body: "Pulsa «Preparar una descarga». Si no has iniciado sesión hace poco, vuelve a iniciarla una vez más y regresa." },
        { title: "Descargar el archivo", body: "Pulsa «Descargar el archivo». El enlace solo se puede usar una vez y caduca a los 5 minutos; si caduca, pulsa «Preparar una nueva descarga»." },
        { title: "Si solo necesitas las conversaciones", body: "En «Exportar tus conversaciones», en la pestaña de datos, pulsa «Descargar todos los chats como .txt». Las conversaciones bloqueadas no se incluyen en este archivo." },
      ],
      faq: [
        { q: "¿Hay datos que no se incluyen?", a: "No se incluyen los elementos que no son datos del usuario, como los registros operativos. Dentro del archivo se indica qué se ha incluido y qué no, y por qué." },
        { q: "¿Puedo ver el historial de descargas?", a: "En «Historial de descargas» puedes ver durante 90 días el registro de solicitudes, descargas y rechazos." },
      ],
    },
    "delete-account": {
      title: "Eliminar tu cuenta",
      summary: "Al solicitar la eliminación se cierra tu sesión al instante y, pasado el plazo de gracia de 7 días, tus datos, incluidas las conversaciones y los archivos, se eliminan de forma permanente. Pueden conservarse los registros mínimos necesarios para obligaciones de pago y legales, y el registro de bajas de correo.",
      steps: [
        { title: "Antes, descarga tus datos (recomendado)", body: "Si quieres conservar algún dato, descárgalo antes siguiendo la guía «Descargar los datos de tu cuenta»." },
        { title: "Abrir la zona de riesgo", body: "En la pestaña «Cuenta» de «Ajustes», en «Zona de riesgo», abajo, pulsa «Eliminar cuenta»." },
        { title: "Escribir la confirmación", body: "Marca la casilla de consentimiento y escribe exactamente DELETE MY ACCOUNT." },
        { title: "Enviar la solicitud", body: "Pulsa «Eliminar cuenta» y vuelve a pulsar «Solicitar eliminación de cuenta». Si se te pide iniciar sesión de nuevo, hazlo y repite el paso." },
      ],
      faq: [
        { q: "¿Puedo cancelar la eliminación?", a: "No se puede cancelar desde la pantalla. Escribe a support@tomverse.app en un plazo de 7 días. Aunque se recupere, el plan se mantiene solo hasta su fecha de vencimiento original y la renovación automática no se vuelve a activar." },
        { q: "¿Se reembolsa el plan que pagué?", a: "Eliminar la cuenta por sí solo no da lugar a reembolso. Si necesitas un reembolso, envía la solicitud antes de eliminar la cuenta." },
        { q: "¿En qué se diferencia de «Eliminar todos los chats»?", a: "«Eliminar todos los chats» está en la pestaña «Datos», solo borra las conversaciones y la cuenta se conserva. No se puede deshacer." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "Cómo se descuentan los créditos",
      summary: "Cada modelo tiene unos créditos base por respuesta, si la entrada es larga se aplica un multiplicador, y la búsqueda web y las imágenes se calculan aparte.",
      steps: [
        { title: "Ver la carga de créditos de cada modelo", body: "En el selector de modelos, compara la carga de créditos de cada modelo con las barras (5 niveles) y «unas N respuestas». Con el filtro «Uso» puedes elegir los tramos de 1, 4, 8 y 12+ créditos. Los valores pueden cambiar, así que guíate por lo que ves en pantalla." },
        { title: "Estimación si eliges tú el modelo", body: "Si eliges tú el modelo, bajo el selector ves la suma de la «estimación base» de créditos de los modelos elegidos. Con la adaptación inteligente se descuentan los créditos del modelo que respondió." },
        { title: "Multiplicador por conversaciones y archivos largos", body: "Si la entrada, que suma la pregunta actual, la conversación anterior y el contenido de los archivos adjuntos, supera los 16.000 tokens, se aplica ×1,5; con 50.000, ×2; y con 100.000, ×3. Los archivos adjuntos en sí no tienen un coste aparte." },
        { title: "Búsqueda web e imágenes", body: "Si activas la búsqueda web, se suman 8 créditos por cada modelo que ejecuta la búsqueda (sin multiplicador por longitud de entrada y excepto en los modelos de Perplexity). Si no se buscó, se devuelven. La generación de imágenes tiene créditos fijos según modelo, calidad y tamaño, que se muestran en el botón de generar de la pantalla de imágenes (cuando Chat responde con una imagen, se descuentan sin confirmación)." },
        { title: "Orden de descuento", body: "Primero se usan los créditos del plan de este mes y después los créditos adicionales comprados, empezando por los que caducan antes. El día en que alcanzas el límite diario puedes seguir usando los créditos adicionales comprados." },
      ],
      faq: [
        { q: "Se descontó más de lo que pensaba.", a: "Pueden sumarse el multiplicador por conversaciones y archivos largos (×1,5, ×2, ×3) y la búsqueda web (+8 créditos por modelo)." },
        { q: "¿Se descuentan créditos si la respuesta falla?", a: "En un chat normal, si falla o la respuesta llega vacía, no se descuentan créditos. Una respuesta que detienes tú se descuenta solo por la parte recibida." },
        { q: "Me aparece «Una comprobación de seguridad interna pausó esta solicitud».", a: "En este caso no se descuentan créditos. Vuelve a intentarlo en un momento o elige un modelo más económico." },
      ],
    },
    "check-credits": {
      title: "Consultar los créditos restantes y la fecha de caducidad",
      summary: "En el menú de la cuenta y en la pestaña «Plan» ves el uso de hoy y de este mes, los créditos restantes, el ciclo de facturación y la fecha de caducidad.",
      steps: [
        { title: "Abrir el menú de la cuenta", body: "Al pulsar el botón de la cuenta, abajo en la barra lateral, ves el medidor «Uso actual» y la hora del próximo reinicio." },
        { title: "Ir a la pestaña Plan", body: "Al pulsar «Uso y plan» se abre la pestaña «Plan» de los ajustes." },
        { title: "Comprobar el plan actual", body: "En la tarjeta «Plan actual», comprueba el ciclo de facturación (mensual/anual) y «Caduca» (fecha de fin del periodo de facturación actual)." },
        { title: "Comprobar los créditos restantes", body: "Mira las tarjetas «Créditos de respuestas de IA hoy», «Créditos de respuestas de IA este mes» y «Créditos comprados restantes». Los créditos adicionales muestran también su fecha de caducidad más próxima." },
      ],
      faq: [
        { q: "¿Cuándo se reinician los créditos?", a: "Los créditos diarios se reinician a medianoche de la «Zona horaria del reinicio diario» de Preferencias, y los créditos mensuales del plan el día 1 de cada mes a las 00:00 UTC; no se acumulan." },
        { q: "¿Los créditos que compré también desaparecen a principios de mes?", a: "No. Se mantienen aparte de los créditos mensuales y caducan 365 días después de la compra." },
        { q: "El plan no cambió justo después de pagar.", a: "Puede tardar un momento en procesarse el pago. Vuelve a comprobar el plan actual y la fecha de caducidad en la pestaña «Plan»." },
      ],
    },
    "change-plan": {
      title: "Cambiar entre Pro y Max",
      summary: "Se cambia desde la página de precios. La mejora se aplica en cuanto se completa el pago, y la bajada de plan al terminar el periodo de facturación actual.",
      steps: [
        { title: "Abrir la página de precios", body: "Ve a la página de precios." },
        { title: "Empezar el cambio", body: "Si tienes Pro, pulsa «Mejorar a Max»; si tienes Max, pulsa «Cambiar a Pro»." },
        { title: "Comprobar el importe y los créditos", body: "En la pantalla del cambio, comprueba el importe de «A pagar hoy» y cuántos créditos del plan de este mes te quedan tras el cambio." },
        { title: "Completar la mejora", body: "Pulsa «Pagar y cambiar a Max». Hasta que se complete el pago se muestra «Esperando el pago»." },
        { title: "Programar la bajada de plan", body: "Pulsa «Programar Pro». Puedes deshacerlo con «Cancelar este cambio» hasta la fecha en que se aplica." },
      ],
      faq: [
        { q: "Si mejoro el plan, ¿se crean créditos nuevos?", a: "El límite de este mes pasa a ser el de Max y lo que ya usaste se sigue contando igual. No se dan créditos adicionales aparte." },
        { q: "¿Puedo pasar de mensual a anual?", a: "Solo se puede cambiar entre planes con el mismo ciclo de facturación. Para cambiar de mensual a anual o al revés, escribe al soporte." },
        { q: "¿Y si falla el pago?", a: "Se mantiene tu plan actual y no se cobra nada." },
      ],
    },
    "cancel-subscription": {
      title: "Cancelar la suscripción (detener la renovación automática)",
      summary: "La cancelación se aplica al terminar el periodo de facturación actual, y hasta entonces sigues usando tu plan actual.",
      steps: [
        { title: "Abrir la pestaña Plan", body: "En el menú de la cuenta, pulsa «Uso y plan» para abrir la pestaña «Plan»." },
        { title: "Programar la cancelación", body: "En la tarjeta «Cancelar plan», pulsa «Cancelar al final del periodo». Se programa al instante, sin ventana de confirmación." },
        { title: "Comprobar el resultado", body: "Comprueba que el botón cambia a «Cancelación programada» y que aparece el aviso de que no se hará el próximo cobro." },
      ],
      faq: [
        { q: "Al cancelar, ¿paso a Free al instante?", a: "No. Tu plan actual se mantiene hasta la fecha de caducidad indicada y después pasas a Free." },
        { q: "¿Se pierden los créditos adicionales que compré?", a: "No. Se conservan hasta su fecha de caducidad, pero solo se pueden usar en los modelos disponibles en el plan al que pases." },
        { q: "¿Se puede deshacer la cancelación programada?", a: "No desde la pantalla. Para deshacerla, escribe al soporte." },
      ],
    },
    "request-refund": {
      title: "Solicitar un reembolso",
      summary: "Si lo solicitas desde la pestaña «Plan» o por correo, el equipo de operaciones lo revisa caso por caso. Por norma, un simple arrepentimiento o los créditos sin usar no dan derecho a reembolso.",
      steps: [
        { title: "Escribir el motivo", body: "Escribe el motivo en la tarjeta «Solicitud de reembolso» de la pestaña «Plan»." },
        { title: "Enviar la solicitud", body: "Al pulsar «Solicitar reembolso», se muestran «Solicitud de reembolso recibida» y la fecha de recepción." },
        { title: "Si lo solicitas por correo", body: "Si no ves la tarjeta, envía a support@tomverse.app el correo de tu cuenta, el nombre del plan o del paquete de créditos, la fecha de pago, el número de recibo y el motivo. Si compraste un paquete de créditos en el plan Free, no hay tarjeta, así que pídelo por correo." },
      ],
      faq: [
        { q: "¿En qué casos se reembolsa?", a: "Cobros duplicados, no autorizados o por un importe erróneo, casos en que no se te dio el plan o los créditos, casos que requieren una corrección tras la revisión, como una incidencia grave del servicio, o cuando la ley exige el reembolso. Según las circunstancias, puede aprobarse un reembolso parcial. Consulta los criterios detallados en la página de la política de reembolsos." },
        { q: "¿Al solicitarlo se cancela también la suscripción?", a: "No se cancela solo por solicitarlo. Si se aprueba el reembolso de una suscripción, se cancela la suscripción de pago y pasas a Free. El reembolso de un paquete de créditos solo recupera los créditos de ese paquete, y lo ya usado puede compensarse con los créditos que se concedan después." },
        { q: "¿Puedo enviar la solicitud varias veces?", a: "Solo se revisa una solicitud a la vez. Cuando se recibe, te llega un correo de confirmación." },
        { q: "¿Cuándo llega el dinero del reembolso?", a: "Depende del plazo de procesamiento de tu método de pago." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "Cuando la respuesta se detiene o llega vacía",
      summary: "Vuelve a intentarlo una vez, elige otro modelo o envía sin adjuntos. Si sigue pasando, comprueba el estado del servicio y reporta el error.",
      steps: [
        { title: "Leer el aviso", body: "Mira el aviso de la tarjeta de la respuesta fallida y «Ver información de diagnóstico». Se muestra también el ID de seguimiento." },
        { title: "Reintentar", body: "Pulsa «Reintentar», «Elegir otro modelo» o «Reducir el número de modelos», según lo que aparezca en la tarjeta (depende del tipo de error)." },
        { title: "Si es por un adjunto", body: "Si el problema es el adjunto, pulsa «Reintentar sin archivos»." },
        { title: "Si es por el límite de longitud", body: "Si ves «La respuesta se detuvo por el límite de longitud de salida», vuelve a preguntar pidiendo que continúe." },
        { title: "Si aun así no funciona", body: "Comprueba la página de estado del servicio y pulsa «Reportar error» en la misma tarjeta." },
      ],
      faq: [
        { q: "Me aparece «Ya se está generando una respuesta».", a: "Vuelve a intentarlo cuando la respuesta en curso termine o se detenga." },
        { q: "Me aparece «Los créditos del plan de este mes se han agotado».", a: "Puedes seguir usándolo comprando créditos adicionales o mejorando el plan." },
        { q: "¿Se descuentan créditos por una respuesta fallida?", a: "En un chat normal, si falla o la respuesta llega vacía, no se descuentan créditos. Una respuesta que detienes tú se descuenta solo por la parte recibida." },
      ],
    },
    "file-upload-failed": {
      title: "Cuando falla la subida de un archivo",
      summary: "Comprueba el formato, el tamaño, la contraseña y que haya texto legible, y vuelve a intentarlo con un solo archivo.",
      steps: [
        { title: "Leer el mensaje de error", body: "Fíjate en mensajes como «Cada archivo debe tener 50 MB o menos», «Este documento está protegido con contraseña» o «No se encontró texto legible en este archivo»." },
        { title: "Arreglar el archivo", body: "Quita la contraseña, vuelve a guardarlo como PDF o reduce su tamaño." },
        { title: "Probar de uno en uno", body: "Adjunta solo un archivo y vuelve a enviar. Si tienes prisa, pega lo esencial directamente en el cuadro de texto." },
        { title: "Si es un error de imagen", body: "Elige un modelo que pueda leer imágenes o pulsa «Quitar modelos incompatibles»." },
      ],
      faq: [
        { q: "¿Cuántos archivos y de qué tamaño puedo subir?", a: "Los límites de cantidad y tamaño, con y sin sesión, están en la lista de formatos de la guía de archivos adjuntos." },
        { q: "¿Qué formatos se admiten?", a: "Todos los formatos aceptados están en la lista de formatos de la guía de archivos adjuntos. No se aceptan GIF animados ni ZIP protegidos con contraseña." },
        { q: "Me dice que no se puede leer un archivo que subí antes.", a: "Es el caso en que el archivo ya no está guardado. Vuelve a adjuntarlo o pulsa «Continuar sin el archivo»." },
      ],
    },
    "report-a-problem": {
      title: "Reportar un error y enviar comentarios",
      summary: "Si usas «Reportar error» en una respuesta fallida, se envían juntos el detalle del error y el ID de seguimiento. Los comentarios generales se envían con «Comentarios».",
      steps: [
        { title: "Abrir la ventana de reporte", body: "En la tarjeta de la respuesta fallida, pulsa «Reportar error». Para opiniones generales, pulsa «Comentarios» en la barra lateral." },
        { title: "Elegir el tipo", body: "Para comentarios generales, elige «Informar un problema», «Solicitar función», «Facturación» u «Otro» y escribe al menos 5 caracteres. Un reporte de error no necesita elegir tipo y se puede enviar sin descripción." },
        { title: "Revisar lo que se envía", body: "En «Ver los detalles del error que se adjuntarán», comprueba la información de diagnóstico. Los valores que parecen credenciales se ocultan automáticamente." },
        { title: "Enviar", body: "Si quieres recibir por correo los avisos de recepción y avance, marca «Recibir el estado por correo» y pulsa «Enviar». Si no has iniciado sesión, tienes que marcar esta opción y dejar tu correo para poder recibir respuesta. Se muestra un número de recepción." },
      ],
      faq: [
        { q: "¿Es obligatorio incluir el ID de seguimiento?", a: "Es opcional. Se recibe igualmente sin él." },
        { q: "Falló el envío.", a: "Lo que escribiste se conserva, así que vuelve a enviarlo. No incluyas contraseñas ni números de tarjeta en el reporte." },
      ],
    },
    "sign-in-problems": {
      title: "Cuando no puedes iniciar sesión",
      summary: "Vuelve a intentarlo con el correo y el método de acceso con los que te registraste la primera vez, y en el mismo navegador.",
      steps: [
        { title: "Comprobar cómo te registraste", body: "Comprueba que usas el correo y el método de acceso con los que te registraste (código por correo, Google, Microsoft, Apple)." },
        { title: "Pedir el código de nuevo", body: "Si el código del correo caducó, pulsa «Enviar un código nuevo». También puedes pulsar el enlace de acceso del correo." },
        { title: "Si hay demasiadas solicitudes", body: "Si aparece «Demasiadas solicitudes», espera el tiempo indicado. Si superaste el número diario, vuelve a intentarlo al día siguiente." },
        { title: "En el mismo navegador", body: "Continúa en el navegador donde empezaste el inicio de sesión. Si falla la verificación de seguridad, recarga la página y vuelve a intentarlo." },
        { title: "Avisar al soporte", body: "Si sigue sin funcionar, envía al soporte el método de acceso y el texto del error que ves en pantalla." },
      ],
      faq: [
        { q: "Me aparece «Ese correo ya se usa con otro método de acceso».", a: "Ese correo está registrado con otro método. Inicia sesión con el método con el que te registraste primero." },
        { q: "Me dice que el acceso está bloqueado.", a: "Si hay una eliminación de cuenta programada, el acceso queda bloqueado. Para cancelarla, escribe al soporte en un plazo de 7 días." },
      ],
    },
    "service-status": {
      title: "Comprobar el estado del servicio",
      summary: "En la página de estado ves el estado de cada proveedor de modelos de chat y en qué se basa esa valoración.",
      steps: [
        { title: "Abrir la página de estado", body: "Abre tomverse.app/status. No hace falta iniciar sesión." },
        { title: "Ver el resumen", body: "Comprueba el resumen de arriba y «Datos a fecha de» (UTC)." },
        { title: "Ver el estado por proveedor", body: "En «Estado de los proveedores», comprueba si está Operativo, con Rendimiento reducido, con Incidente o Desconocido. Si los fallos se concentran en un modelo, se muestra también su nombre." },
      ],
      faq: [
        { q: "¿«Desconocido» significa que hay una incidencia?", a: "No. Significa que no hay datos para valorar el estado, y tampoco se da por normal." },
        { q: "Si aparece «Rendimiento reducido», ¿se han agotado mis créditos?", a: "Ese aviso por sí solo no significa que la solicitud falle ni que se hayan agotado los créditos." },
        { q: "¿Aparece también el estado de la generación de imágenes o la búsqueda web?", a: "No. Esta página solo muestra el estado de los proveedores de modelos de chat." },
      ],
    },
    "contact-support": {
      title: "Contactar con soporte",
      summary: "Escribe con el formulario de la página de soporte o a support@tomverse.app. Normalmente respondemos en 1-2 días laborables.",
      steps: [
        { title: "Abrir la página de soporte", body: "Abre la página de soporte." },
        { title: "Elegir el tipo de consulta", body: "Elige entre «Soporte general», «Problema o bug», «Facturación», «Solicitud de función» y «Otro»." },
        { title: "Escribir el contenido", body: "Escribe tu correo y el contenido. Si en pantalla había un ID de seguimiento, escríbelo en el campo «Trace ID o referencia, opcional»." },
        { title: "Enviar", body: "Al pulsar «Enviar solicitud», aparece un aviso de que se ha recibido. Las capturas de pantalla no se pueden adjuntar al formulario, así que envíalas aparte al correo de soporte." },
      ],
      faq: [
        { q: "¿Qué conviene enviar junto con la consulta?", a: "El correo de la cuenta, la hora aproximada en que ocurrió, el producto y el modelo, el navegador, si había adjuntos y el ID de seguimiento que se veía en pantalla. No envíes contraseñas ni números de tarjeta." },
        { q: "¿Hay atención telefónica?", a: "No. Atendemos por correo y por el formulario de contacto." },
      ],
    },
  },
};
