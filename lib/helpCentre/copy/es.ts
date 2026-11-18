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
  },
  categories: {
    "getting-started": { title: "Primeros pasos", description: "Desde crear tu cuenta hasta enviar tu primera pregunta." },
    chat: { title: "Chat", description: "Conversar con un modelo, elegir modelo y Auto, mejorar preguntas y entrada de voz." },
    review: { title: "Review · AI Review", description: "Lee las respuestas de varios modelos en paralelo y comprueba las diferencias con AI Review." },
    images: { title: "Imágenes", description: "Crea imágenes, retoca partes de una foto y compara los resultados de cada modelo." },
    research: { title: "Investigación · búsqueda web", description: "Encuentra información reciente con la búsqueda web y recibe informes con Deep Research." },
    files: { title: "Archivos · archivos generados", description: "Subir archivos, Google Drive y descargar los archivos que crea la IA." },
    assistants: { title: "Asistentes · Memory", description: "Tus propios asistentes, archivos de conocimiento y gestión de la memoria." },
    imports: { title: "Importar · continuar", description: "Importa conversaciones de otros servicios de IA y continúalas aquí." },
    connectors: { title: "Conectores · MCP", description: "Conecta servicios externos y servidores MCP." },
    coding: { title: "Herramientas de programación · claves de API", description: "Usa Tomverse en herramientas de programación como Claude Code y Codex." },
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
        { title: "Elegir un método", body: "Pulsa un botón como «Continuar con Google» o «Continuar con Microsoft», o escribe tu «Correo electrónico» y pulsa «Obtener código de acceso». Los botones que ves pueden variar según el entorno." },
        { title: "Introducir el código", body: "Escribe el código de 6 dígitos que recibiste por correo en «Introduce el código» y pulsa «Verificar». También puedes pulsar el enlace de acceso del correo." },
        { title: "Si es tu primera vez", body: "Si el correo no está registrado, pulsa «Registrarme con esta dirección»." },
        { title: "Si no llega el código", body: "Pulsa «Enviar un código nuevo» o cambia la dirección con «Usar otro correo»." },
      ],
      faq: [
        { q: "¿Cuánto tiempo es válido el código?", a: "Solo unos minutos. Si caduca, pulsa «Enviar un código nuevo». Si escribes un código incorrecto varias veces, se bloquea un momento." },
        { q: "¿Puedo usarlo sin iniciar sesión?", a: "Si está disponible, puedes probarlo como invitado. Las conversaciones de invitado se guardan solo en este navegador y no quedan en el servidor." },
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
        { title: "De Review a Chat", body: "En el resultado del análisis de Review, pulsa «Continuar en Chat» para seguir desde un borrador de Chat." },
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
        { title: "Ver cómo se entendió el mensaje", body: "Si Auto reformuló tu mensaje, puedes desplegar «Cómo leyó Auto tu mensaje», bajo la insignia." },
      ],
      faq: [
        { q: "¿Cuántos créditos cuesta?", a: "Con la adaptación inteligente, los créditos dependen del modelo que responda. Si eliges tú, se aplican los créditos base que ves en el selector de modelos." },
        { q: "¿Se guarda cambiado el mensaje que envié?", a: "No. Tu mensaje se guarda tal como lo escribiste." },
        { q: "¿Dejará de poder desactivarse la adaptación inteligente?", a: "No. Puedes desactivarla en cualquier momento eligiendo tú el modelo." },
      ],
    },
    "prompt-refiner": {
      title: "Usar las sugerencias para mejorar tu pregunta",
      summary: "«Mejorar redacción» propone una frase más clara sin enviar la pregunta. Tú decides si la usas.",
      steps: [
        { title: "Recibir una sugerencia", body: "Si está disponible, escribe tu pregunta en el cuadro de texto y pulsa «Mejorar redacción»." },
        { title: "Comparar", body: "Aparecen lado a lado el «Original» y la «Redacción sugerida»." },
        { title: "Elegir", body: "Pulsa «Usar esta redacción» o «Conservar original». Con cualquiera de las dos, todavía no se envía nada." },
        { title: "Enviar", body: "Pulsa «Enviar» como siempre. Si falla, pulsa «Reintentar»; el original no cambia." },
      ],
      faq: [
        { q: "¿Y si cambio el texto mientras se prepara la sugerencia?", a: "Si cambia una sola letra, esa sugerencia desaparece. Vuelve a pulsar «Mejorar redacción»." },
        { q: "¿Lee también mis archivos o mi historial?", a: "Solo lee la frase que acabas de escribir. No usa el historial, los adjuntos ni la memoria." },
      ],
    },
    "voice-input": {
      title: "Escribir con la voz",
      summary: "Habla al micrófono y tu voz se convierte en texto en el cuadro de texto; puedes corregirlo antes de enviar.",
      steps: [
        { title: "Empezar a grabar", body: "Si está disponible, pulsa el micrófono («Grabar entrada de voz») bajo el cuadro de texto. Si el navegador pide permiso para el micrófono, permítelo." },
        { title: "Hablar", body: "Mientras hablas, sobre el cuadro de texto se muestra «Grabando» con el tiempo." },
        { title: "Convertir en texto", body: "Si pulsas de nuevo el mismo botón, al terminar la conversión el texto aparece en el cuadro de texto." },
        { title: "Corregir y enviar", body: "Corrige el texto y pulsa «Enviar». Para descartarlo, pulsa «Cancelar»." },
      ],
      faq: [
        { q: "¿Se guarda la grabación?", a: "Tomverse no guarda las grabaciones. Se envían al proveedor de reconocimiento de voz solo para convertirlas en texto, y las grabaciones canceladas no se envían." },
        { q: "¿Cuesta créditos?", a: "La entrada de voz no descuenta créditos. Puede haber un límite de uso diario." },
        { q: "No puedo grabar.", a: "Funciona en las últimas versiones de Chrome, Edge, Safari y Firefox. Si el micrófono está bloqueado, permite el micrófono de este sitio en los ajustes del navegador." },
      ],
    },
    "chat-starters": {
      title: "Rellenar tu pregunta con ejemplos de inicio",
      summary: "Al elegir una tarjeta de ejemplo en una conversación nueva, la pregunta se rellena en el cuadro de texto. No se envía nada hasta que envías el mensaje.",
      steps: [
        { title: "Elegir una tarjeta", body: "Si está disponible, pulsa una tarjeta de «Lo que puedes hacer aquí» en la pantalla de chat nuevo. Para ver más, pulsa «Ver más sugerencias»." },
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
        { title: "Enviar la pregunta", body: "Escribe la pregunta y pulsa «Enviar». Los modelos elegidos responden a la vez." },
        { title: "Preguntar solo a un modelo", body: "Para seguir preguntando solo a un modelo, usa «Preguntar solo a este modelo» en su panel." },
        { title: "Cambiar la vista", body: "Cambia entre «Enfoque» y «En paralelo». Cambiar la vista no vuelve a enviar nada." },
        { title: "Quitar un modelo", body: "Pulsa «Quitar de la comparación». Puedes volver atrás con «Deshacer»." },
      ],
      faq: [
        { q: "¿Se cobran créditos por cada modelo?", a: "Sí. Cada modelo elegido consume los créditos de respuesta." },
        { q: "¿Puedo comparar sin iniciar sesión?", a: "Si está disponible, los invitados también pueden comparar hasta 3 modelos." },
      ],
    },
    "read-ai-review": {
      title: "Ejecutar y leer AI Review",
      summary: "Cuando hay al menos 2 respuestas completas, un modelo revisor independiente resume los puntos en común, las diferencias, las contradicciones, lo que falta y lo que conviene comprobar.",
      steps: [
        { title: "Preparar las respuestas", body: "Comprueba que al menos 2 respuestas a la misma pregunta han terminado." },
        { title: "Ejecutar", body: "Pulsa «Revisión cruzada de respuestas con IA» (en Studio de escritorio, «Analizar con Tomverse»)." },
        { title: "Elegir el criterio", body: "Si la pantalla permite elegir criterio, escoge «Equilibrado», «Evidencia» o «Acción» y pulsa «Ejecutar revisión cruzada»." },
        { title: "Leer el resultado", body: "Léelo en este orden: lo que coincide, las diferencias importantes, las contradicciones, lo que falta y lo que conviene comprobar." },
        { title: "Dejar tu opinión", body: "En cada punto puedes pulsar «Útil», «Incorrecto», «Poco claro» o «Falta un punto importante»." },
      ],
      faq: [
        { q: "¿AI Review me dice cuál es la respuesta correcta?", a: "No. Solo compara entre sí las respuestas recibidas y no hace búsquedas web ni comprobaciones de hechos externas." },
        { q: "¿Y los créditos si falla?", a: "Si no se completa, recuperas los créditos reservados. El coste se muestra en pantalla antes de ejecutar." },
        { q: "¿Hay un límite de usos?", a: "Invitados y Free tienen un límite mensual de usos. Consulta en pantalla los que te quedan." },
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
        { q: "Si una cita aparece como «Respaldado», ¿es cierta?", a: "No. Solo significa que esa frase está en la respuesta; no garantiza que el contenido sea correcto." },
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
        { title: "Ver el resultado", body: "Al terminar, la imagen lleva una insignia de calidad (borrador, estándar o alta calidad). Si necesitas más calidad, envía «Vuelve a crear esta imagen en alta calidad»." },
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
        { title: "Abrir la pantalla de imágenes", body: "En la barra lateral, junto a «Nuevo chat», abre «Nuevo…» y elige «Nueva imagen». También puedes elegir un modelo en la pestaña «Imagen» del selector de modelos." },
        { title: "Elegir modelos", body: "En «Modelos» elige los que quieres comparar. Se muestra cuántos puedes elegir a la vez." },
        { title: "Calidad y tamaño", body: "Elige la «Calidad» (borrador, estándar, final) y el «Tamaño» (cuadrada, horizontal, vertical)." },
        { title: "Escribir la descripción y generar", body: "Describe la imagen que quieres, comprueba el precio de cada modelo y el total de créditos, y pulsa «Generar»." },
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
        { title: "Adjuntar la foto", body: "En «Añadir y herramientas», junto al cuadro de texto, usa «Añadir un archivo» para adjuntar una foto (PNG, JPEG, WebP, GIF)." },
        { title: "Escribir qué cambiar", body: "Describe el cambio, por ejemplo: «Cambia el fondo por una playa al atardecer»." },
        { title: "Enviar", body: "Si es una petición de edición, responde con la imagen retocada; si no, con una respuesta normal sobre la foto." },
      ],
      faq: [
        { q: "¿Se cambia la foto original?", a: "No. Tu foto se queda como está y se crea una imagen nueva." },
        { q: "¿Y si adjunto varias fotos?", a: "Se retoca la primera de las fotos adjuntas." },
        { q: "¿Cuántos créditos cuesta?", a: "A los créditos de generación de imagen se les puede sumar un coste de edición según el modelo." },
      ],
    },
    "image-credits": {
      title: "Créditos de imagen y devoluciones",
      summary: "Las imágenes usan créditos fijos según calidad y tamaño, y si la generación falla recuperas todos los créditos reservados.",
      steps: [
        { title: "Ver el precio", body: "En la pantalla de imágenes comprueba el precio de cada modelo y el total de créditos." },
        { title: "Generar", body: "Al pulsar «Generar», los créditos se reservan primero." },
        { title: "Liquidación", body: "Si sale bien, se usan los créditos indicados; si falla, recuperas los créditos reservados." },
      ],
      faq: [
        { q: "¿En qué planes se puede usar?", a: "Con la sesión iniciada, Free, Pro y Max pueden usarlo dentro de los créditos que tengan." },
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
        { title: "Ver el estado", body: "Si pulsas el indicador «Búsqueda web activada» del cuadro de texto, ves cuántos de los modelos elegidos admiten la búsqueda." },
        { title: "Abrir las fuentes", body: "Los enlaces de la lista «Fuentes», bajo la respuesta, se abren en una pestaña nueva." },
        { title: "Sugerencia de buscar de nuevo", body: "Si con la búsqueda desactivada haces una pregunta que necesita información reciente, aparece la tarjeta «Consultar en la web». Al pulsarla, se vuelve a enviar la misma pregunta con búsqueda." },
      ],
      faq: [
        { q: "¿Cuesta créditos adicionales?", a: "Cada modelo que realmente ejecutó la búsqueda suma unos créditos fijos, y los modelos que no buscaron se devuelven." },
        { q: "Me aparece «Los modelos que responden no pueden buscar en la web».", a: "Ninguno de los modelos elegidos admite búsqueda. Añade un modelo que admita búsqueda." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Adjuntar archivos: formatos y tamaño admitidos",
      summary: "Puedes adjuntar varios archivos por mensaje: imágenes, PDF, Office, texto, código y ZIP.",
      steps: [
        { title: "Añadir archivos", body: "En «Añadir y herramientas», junto al cuadro de texto, pulsa «Añadir un archivo» → «Elegir desde tu ordenador», o arrastra los archivos al cuadro de texto." },
        { title: "Esperar la comprobación", body: "Espera a que terminen las indicaciones «Subiendo» y «Comprobando»." },
        { title: "Enviar", body: "Envía el mensaje." },
      ],
      faq: [
        { q: "¿Cuántos archivos y de qué tamaño?", a: "Con sesión iniciada, hasta 5 archivos por mensaje, 10 MB cada uno y 25 MB en total. Los límites sin sesión y todos los formatos aceptados están en la lista de formatos de abajo." },
        { q: "¿Qué archivos no se aceptan?", a: "Ejecutables, archivos comprimidos que no sean ZIP (RAR, 7Z, etc.), audio y vídeo, HEIC y TIFF, GIF animados y documentos protegidos con contraseña." },
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
        { q: "¿Tengo que iniciar sesión?", a: "Sí. Con la sesión iniciada se puede usar con cualquier plan." },
        { q: "Me aparece «Desbloquea este chat para descargar el archivo».", a: "Los archivos de una conversación bloqueada solo se descargan después de desbloquearla." },
        { q: "Si pido cambios, ¿se sobrescribe el archivo original?", a: "No. Se crea una versión nueva y en la lista «Versiones del archivo» puedes ver las anteriores." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Crear tu propio asistente y añadir archivos de conocimiento",
      summary: "Reúne nombre, instrucciones, modelo y archivos de conocimiento en un asistente solo tuyo y elígelo en las conversaciones.",
      steps: [
        { title: "Empezar a crearlo", body: "Si está disponible, en la pestaña «Asistentes de IA» de «Ajustes», pulsa «Nuevo asistente». También puedes empezar desde «Asistente», en el menú de herramientas de la conversación." },
        { title: "Nombre e instrucciones", body: "Escribe el «Nombre» y las «Instrucciones personalizadas» y pulsa «Crear asistente»." },
        { title: "Añadir archivos de conocimiento", body: "En «Archivos de conocimiento que puede usar esta revisión», pulsa «Añadir un archivo» y espera a que aparezca «listo»." },
        { title: "Guardar", body: "Pulsa «Guardar instrucciones, modelos y archivos». Cada vez que guardas se crea una revisión nueva." },
        { title: "Usarlo en las conversaciones", body: "Pulsa «Chatear con este asistente» o elígelo en «Asistente», en el menú de herramientas de la conversación." },
      ],
      faq: [
        { q: "¿Qué archivos puedo añadir como conocimiento?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods y odp. No se pueden añadir imágenes." },
        { q: "Si cambio las instrucciones, ¿se aplica también a las conversaciones en curso?", a: "No. Cambia solo cuando pulsas «Usar la revisión más reciente aquí» en la conversación." },
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
        { q: "¿Y si olvido la contraseña?", a: "Tomverse no puede mostrarte ni recuperar la contraseña. Escribe al soporte." },
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
        { q: "¿Hasta cuándo es válido el enlace?", a: "Caduca pasado un tiempo determinado, y la fecha de caducidad se muestra en la página compartida." },
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
    "import-guest-conversations": {
      title: "Guardar en tu cuenta las conversaciones que tuviste como invitado",
      summary: "Pasa a tu cuenta las conversaciones de invitado que tuviste en este navegador antes de iniciar sesión.",
      steps: [
        { title: "Iniciar sesión", body: "Al iniciar sesión aparece la ventana «¿Importar tus conversaciones de invitado?»." },
        { title: "Elegir qué importar", body: "Pulsa «Importar solo la conversación actual» o «Importar las N conversaciones de invitado». Para omitirlo, pulsa «Empezar sin importar»." },
        { title: "Importar más tarde", body: "Si lo omitiste, puedes hacerlo desde «Importar las conversaciones de invitado de este navegador», en la pestaña «Datos» de «Ajustes»." },
      ],
      faq: [
        { q: "¿Y si borro los datos del navegador?", a: "Si borras los datos del navegador o usas otro navegador o dispositivo, las conversaciones de invitado no se pueden recuperar." },
        { q: "Solo han fallado algunas.", a: "Se muestra cuántas han fallado y puedes pulsar «Volver a intentar»." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Conectar un plugin y elegir permisos",
      summary: "Conecta servicios externos como plugins y elige tú los permisos que concedes y las herramientas que se usan. Aparece en las cuentas que tienen esta función activada.",
      steps: [
        { title: "Abrir la pantalla de plugins", body: "En Chat, pulsa el botón del puzle del cuadro de texto y luego «Gestionar plugins»." },
        { title: "Empezar la conexión", body: "Pulsa «Añadir conexión MCP» o «Conectar» en la tarjeta de un servicio. Los servicios marcados «Requiere configurar el servidor» todavía no se pueden conectar." },
        { title: "Elegir permisos", body: "Si el servicio usa inicio de sesión, marca solo lo necesario en la lista «Permisos que se conceden» y pulsa «Conectar». Al volver tras iniciar sesión en el servicio, aparece «Conectados»." },
        { title: "Guardar las herramientas que se usarán", body: "En «Gestionar acceso», marca «Seleccionar herramientas» y pulsa «Guardar acceso». Hay que guardar las herramientas para poder elegirlas en Chat." },
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
      summary: "Elige en Chat los plugins que conectaste y, si una acción envía algo al exterior, revisa el contenido y apruébala.",
      steps: [
        { title: "Elegir un plugin", body: "Pulsa el botón del puzle del cuadro de texto de Chat y elige las conexiones que usarás en esta conversación." },
        { title: "Enviar la pregunta", body: "Pregunta como siempre. El modelo usa las herramientas que necesita." },
        { title: "Aprobar la ejecución", body: "Si la acción escribe fuera, aparece «Revisar esta acción en Plugins». En «Aprobaciones», revisa lo que se enviará y pulsa «Aprobar esta acción» o «Rechazar»." },
      ],
      faq: [
        { q: "Lo conecté, pero no aparece en la lista.", a: "Hay que guardar al menos una herramienta en «Gestionar acceso» para que aparezca en la lista." },
        { q: "¿Se puede usar también en Review?", a: "La selección de plugins está en el cuadro de texto de Chat." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "Crear y revocar claves de API",
      summary: "Crea claves de API de Tomverse para usar en herramientas de programación, cambia su límite y nombre, y revoca las que no uses. Aparece en las cuentas con la API habilitada.",
      steps: [
        { title: "Abrir la pantalla de claves de API", body: "En la pestaña «Cuenta» de «Ajustes», en la fila «Claves de API», pulsa «Gestionar»." },
        { title: "Crear una clave", body: "Escribe el «Nombre», fija si quieres un «Límite de créditos» y el vencimiento («Caduca», por defecto 90 días) y pulsa «Crear clave»." },
        { title: "Guardar la clave", body: "En «Copia tu clave ahora», pulsa «Copiar», guárdala en un lugar seguro y pulsa «Ya la guardé». La clave solo se ve esta vez." },
        { title: "Gestionarla", body: "En la lista «Tus claves» usa «Renombrar», «Cambiar límite» y «Solicitudes recientes»." },
        { title: "Revocar y sustituir", body: "Al pulsar «Revocar», las herramientas que usan esa clave se detienen al instante y no se puede deshacer. Para cambiarla, crea una clave nueva, ponla en la herramienta y revoca la anterior." },
      ],
      faq: [
        { q: "Perdí la clave.", a: "No se puede volver a ver. Tomverse solo guarda una huella de la clave. Crea una clave nueva y revoca la anterior." },
        { q: "¿Cuántas claves puedo crear?", a: "Hasta 10 claves en uso por cuenta." },
        { q: "Me aparece «La API de Tomverse aún no está disponible para esta cuenta».", a: "La API se está abriendo por fases. Cuando puedas usarla, podrás crear claves en esta pantalla." },
      ],
    },
    "connect-claude-code": {
      title: "Conectar Claude Code con Tomverse",
      summary: "Con unas pocas líneas de configuración, en el terminal o en la extensión oficial de VS Code, Claude Code usa los modelos y créditos de Tomverse.",
      steps: [
        { title: "Preparar la clave", body: "Crea y guarda una clave siguiendo la guía «Crear y revocar claves de API»." },
        { title: "Elegir el modelo", body: "En «Herramientas de programación», en la pantalla de claves de API, elige el «Modelo» en la tarjeta «Configurar Claude Code». Solo aparecen los modelos compatibles con esta herramienta." },
        { title: "Usarlo en el terminal", body: "Pulsa «Copiar» en el bloque de PowerShell o de macOS / Linux y pégalo en el terminal. La última línea, claude, inicia Claude Code conectado a Tomverse." },
        { title: "Usarlo en la extensión de VS Code", body: "Pon el bloque «settings.json de usuario de VS Code» en tu settings.json de usuario y reinicia VS Code." },
        { title: "Poner la clave", body: "Sustituye <YOUR_TOMVERSE_API_KEY>, en la configuración copiada, por la clave que guardaste." },
      ],
      faq: [
        { q: "¿Cómo vuelvo a mi cuenta de Claude de siempre?", a: "Cierra el terminal, o elimina la configuración que pusiste en settings.json y reinicia VS Code." },
        { q: "La búsqueda web no funciona.", a: "Las herramientas que se ejecutan en los servidores de Anthropic, como la búsqueda web, no están disponibles con la conexión de Tomverse." },
        { q: "¿Se guarda la clave tal cual en settings.json?", a: "Sí. La extensión de Claude Code lee la clave del valor de una variable de entorno, así que la clave queda en el archivo. No compartas ese archivo." },
      ],
    },
    "connect-codex": {
      title: "Conectar Codex con Tomverse",
      summary: "Añade el proveedor de Tomverse al archivo de configuración de Codex y ejecútalo con --profile tomverse. Tu cuenta habitual de Codex no se toca.",
      steps: [
        { title: "Preparar la clave y el modelo", body: "Crea una clave y, en «Herramientas de programación» → «Configurar Codex», en la pantalla de claves de API, elige el «Modelo»." },
        { title: "Añadir el proveedor", body: "Pega el bloque «Añadir a ~/.codex/config.toml» en ~/.codex/config.toml." },
        { title: "Guardar el perfil", body: "Guarda el bloque siguiente como ~/.codex/tomverse.config.toml." },
        { title: "Poner la clave y empezar", body: "Sustituye <YOUR_TOMVERSE_API_KEY>, en el bloque «Define la clave donde se inicia Codex», por tu clave y ejecútalo. La última línea, codex --profile tomverse, inicia Codex con Tomverse." },
        { title: "Si usas la extensión de VS Code", body: "La extensión solo lee config.toml, así que pon el bloque «Para la extensión de VS Code…» de la pantalla al principio de config.toml." },
      ],
      faq: [
        { q: "¿Afecta a mi cuenta habitual de Codex?", a: "Si ejecutas Codex sin --profile tomverse, sigue usando tu cuenta de siempre." },
        { q: "¿Cómo deshago la configuración de la extensión de VS Code?", a: "Borra la línea model_provider que pusiste al principio de config.toml." },
        { q: "¿Hay funciones que no funcionan?", a: "No se pueden usar la búsqueda web alojada, las conversaciones almacenadas ni las respuestas en segundo plano." },
      ],
    },
    "api-usage": {
      title: "Consultar el uso de la API y los límites",
      summary: "Las solicitudes hechas con una clave usan los mismos créditos de la cuenta que Chat, y puedes fijar un límite de créditos para cada clave.",
      steps: [
        { title: "Ver el uso por clave", body: "En «Tus claves», en la pantalla de claves de API, ves los créditos que ha usado cada clave y los reservados para solicitudes en curso." },
        { title: "Ver las solicitudes recientes", body: "Al pulsar «Solicitudes recientes» ves, por solicitud, el modelo, los créditos, los tokens de entrada y salida, y el ID de solicitud." },
        { title: "Ver el saldo de la cuenta", body: "Al pulsar «Saldo y uso de la cuenta», se abre la pestaña «Plan»." },
        { title: "Créditos por modelo", body: "En «Modelos disponibles», comprueba los créditos por solicitud de cada modelo." },
      ],
      faq: [
        { q: "Las solicitudes fallan con 401, 403, 404 o 429.", a: "401: la clave es incorrecta, ha caducado o se ha revocado. 403: la API está desactivada para la cuenta. 404: el modelo no se ofrece (vuelve a copiar la configuración). 429: se alcanzó el límite de la clave, de los créditos o de la frecuencia de solicitudes." },
        { q: "¿Cuestan créditos las solicitudes fallidas?", a: "Si fallan antes de generar salida, no cuestan." },
        { q: "La herramienta hace varias solicitudes.", a: "Los pasos posteriores a ejecutar una herramienta y la compactación de la conversación cuentan también como una solicitud cada uno." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "Configurar las notificaciones por correo",
      summary: "Elige qué tipos de correo recibir. El correo de marketing empieza solo después de confirmar tu país de residencia y pulsar el enlace del correo de confirmación.",
      steps: [
        { title: "Abrir las notificaciones por correo", body: "En la pestaña «Cuenta» de «Ajustes», pulsa «Notificaciones por correo» → «Abrir notificaciones por correo»." },
        { title: "Activar y desactivar", body: "«Seguridad y cuenta» y «Facturación» están siempre activados. «Estado del servicio» se puede desactivar, y «Novedades del producto», «Boletín» y «Ofertas» empiezan desactivados." },
        { title: "Recibir correo de marketing", body: "Para activar un tipo de marketing, elige primero tu «País de residencia» y pulsa «Confirmar país»." },
        { title: "Correo de confirmación", body: "El envío empieza solo cuando pulsas el enlace del correo de confirmación que recibes. Si hace falta, pulsa «Reenviar correo de confirmación»." },
        { title: "Desactivar todo de una vez", body: "Pulsa «Desactivar todo el correo de marketing»." },
      ],
      faq: [
        { q: "¿No puedo desactivar los correos de seguridad?", a: "Son avisos imprescindibles para proteger tu cuenta, así que no se pueden desactivar. Con los de facturación pasa lo mismo." },
        { q: "Activé el interruptor, pero sigue desactivado.", a: "Se ha enviado el correo de confirmación. Se activa cuando pulsas el enlace del correo." },
        { q: "¿Puedo darme de baja sin iniciar sesión?", a: "Sí, con el enlace de baja que hay al pie del correo. Para volver a activarlo, tendrás que iniciar sesión." },
      ],
    },
    "use-on-mobile": {
      title: "Usar Tomverse en el navegador del teléfono",
      summary: "En el teléfono, la lista de conversaciones se abre como un panel a la izquierda y el cuadro de texto queda en la parte inferior de la pantalla.",
      steps: [
        { title: "Abrir el menú", body: "Pulsa el botón de menú de arriba a la izquierda para abrir el panel. Contiene el chat nuevo, la búsqueda y la lista de chats, y abajo el uso, el idioma, el menú de la cuenta y los comentarios." },
        { title: "Enviar", body: "La tecla Enter del teclado del teléfono hace un salto de línea. Para enviar, pulsa el botón de enviar." },
        { title: "Añadir a la pantalla de inicio", body: "Pulsa «Instalar Tomverse» en el menú de la cuenta. En iPhone, usa el botón Compartir de Safari y elige «Añadir a la pantalla de inicio»." },
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
        { title: "Quitar uno", body: "Pulsa «Eliminar» en la fila del método que quieres quitar y, cuando el botón cambie, pulsa una vez más «Haz clic de nuevo para eliminar»." },
        { title: "Volver a iniciar sesión", body: "Al eliminar uno se cierra la sesión en todos los dispositivos, así que vuelve a iniciar sesión con el método que queda." },
      ],
      faq: [
        { q: "¿Puedo quitar el último método de acceso?", a: "No. La cuenta debe tener al menos un método de acceso." },
        { q: "Me aparece «Ese correo ya se usa con otro método de acceso».", a: "Inicia sesión con el método que usaste al registrarte (Google, Microsoft o correo) y añade el método nuevo desde los ajustes." },
        { q: "Me dice que la cuenta que quiero vincular ya está vinculada a otra cuenta de Tomverse.", a: "Una cuenta externa solo se puede vincular a una cuenta de Tomverse." },
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
      summary: "Al solicitar la eliminación se cierra tu sesión al instante y, pasado el plazo de gracia de 7 días, tus datos, incluidas las conversaciones y los archivos, se eliminan de forma permanente.",
      steps: [
        { title: "Antes, descarga tus datos (recomendado)", body: "Si quieres conservar algún dato, descárgalo antes siguiendo la guía «Descargar los datos de tu cuenta»." },
        { title: "Abrir la zona de riesgo", body: "En la pestaña «Cuenta» de «Ajustes», en «Zona de riesgo», abajo, pulsa «Eliminar cuenta»." },
        { title: "Escribir la confirmación", body: "Marca la casilla de consentimiento y escribe exactamente DELETE MY ACCOUNT." },
        { title: "Enviar la solicitud", body: "Pulsa «Eliminar cuenta» y vuelve a pulsar «Solicitar eliminación de cuenta». Si se te pide iniciar sesión de nuevo, hazlo y repite el paso." },
        { title: "Cancelar las suscripciones de las tiendas", body: "Si pagaste con App Store o Google Play, eliminar la cuenta no detiene la suscripción, así que cancélala aparte en cada tienda." },
      ],
      faq: [
        { q: "¿Puedo cancelar la eliminación?", a: "No se puede cancelar desde la pantalla. Escribe a support@tomverse.app en un plazo de 7 días. Aunque se recupere, el plan se mantiene solo hasta su fecha de vencimiento original y la renovación automática no se vuelve a activar." },
        { q: "¿Se reembolsa el plan que pagué?", a: "En las suscripciones pagadas en la web solo se detiene la renovación automática; no se reembolsa." },
        { q: "¿En qué se diferencia de «Eliminar todos los chats»?", a: "«Eliminar todos los chats» está en la pestaña «Datos», solo borra las conversaciones y la cuenta se conserva. No se puede deshacer." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "Cómo se descuentan los créditos",
      summary: "Cada modelo tiene unos créditos base por respuesta, si la entrada es larga se aplica un multiplicador, y la búsqueda web y las imágenes se calculan aparte.",
      steps: [
        { title: "Ver los créditos base por modelo", body: "En el selector de modelos, comprueba los créditos base de cada modelo. Los valores pueden cambiar, así que guíate por los números que ves en pantalla." },
        { title: "Estimación antes de enviar", body: "El valor que ves antes de enviar es la estimación de créditos base." },
        { title: "Multiplicador por conversaciones y archivos largos", body: "Si la conversación es larga o el archivo es grande, según la longitud de la entrada puede aplicarse ×1,5, ×2 o ×3." },
        { title: "Búsqueda web e imágenes", body: "Si dejas la búsqueda web siempre activada, se suman unos créditos fijos y, si realmente no se buscó, se devuelven. La generación de imágenes tiene créditos fijos según la calidad." },
        { title: "Orden de descuento", body: "Primero se usan los créditos del plan de este mes y después los créditos adicionales comprados, empezando por los que caducan antes." },
      ],
      faq: [
        { q: "Se descontó más de lo que se mostraba.", a: "En las conversaciones largas y los archivos puede aplicarse un multiplicador según la longitud de la entrada." },
        { q: "¿Se descuentan créditos si la respuesta falla?", a: "Si falla antes de dar una respuesta utilizable, o la respuesta llega vacía, normalmente se devuelven automáticamente. Si la detienes tú mientras se genera, puede descontarse lo ya generado." },
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
        { title: "Programar la cancelación", body: "En la tarjeta «Cancelar plan», pulsa «Cancelar al final del periodo»." },
        { title: "Comprobar el resultado", body: "Comprueba que el botón cambia a «Cancelación programada» y que aparece el aviso de que no se hará el próximo cobro." },
      ],
      faq: [
        { q: "Al cancelar, ¿paso a Free al instante?", a: "No. Tu plan actual se mantiene hasta la fecha de caducidad indicada y después pasas a Free." },
        { q: "¿Se pierden los créditos adicionales que compré?", a: "No. Se conservan hasta su fecha de caducidad, pero solo se pueden usar en los modelos disponibles en el plan al que pases." },
        { q: "Pagué en una tienda de apps.", a: "Las suscripciones de App Store y Google Play se cancelan en cada tienda." },
      ],
    },
    "request-refund": {
      title: "Solicitar un reembolso",
      summary: "Si lo solicitas desde la pestaña «Plan» o por correo, el equipo de operaciones lo revisa caso por caso. Por norma, un simple arrepentimiento o los créditos sin usar no dan derecho a reembolso.",
      steps: [
        { title: "Escribir el motivo", body: "Escribe el motivo en la tarjeta «Solicitud de reembolso» de la pestaña «Plan»." },
        { title: "Enviar la solicitud", body: "Al pulsar «Solicitar reembolso», se muestran «Solicitud de reembolso recibida» y la fecha de recepción." },
        { title: "Si lo solicitas por correo", body: "Si no ves la tarjeta, envía a support@tomverse.app el correo de tu cuenta, el nombre del plan o del paquete de créditos, la fecha de pago, el número de recibo y el motivo." },
      ],
      faq: [
        { q: "¿En qué casos se reembolsa?", a: "Cobros duplicados, no autorizados o por un importe erróneo, casos en que no se te dio el plan o los créditos, y casos que requieren una corrección tras la revisión, como una incidencia grave del servicio. Consulta los criterios detallados en la página de la política de reembolsos." },
        { q: "¿Al solicitarlo se cancela también la suscripción?", a: "No se cancela solo por solicitarlo. Si se aprueba, se cancela la suscripción de pago y pasas a Free." },
        { q: "¿Cuándo llega el dinero del reembolso?", a: "Depende del plazo de procesamiento de tu método de pago." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "Cuando la respuesta se detiene o llega vacía",
      summary: "Vuelve a intentarlo una vez, elige otro modelo o envía sin adjuntos. Si sigue pasando, comprueba el estado del servicio y reporta el error.",
      steps: [
        { title: "Leer el aviso", body: "Mira el aviso de la tarjeta de la respuesta fallida y «Ver información de diagnóstico». Se muestra también el ID de seguimiento." },
        { title: "Reintentar", body: "Pulsa «Reintentar», o elige «Elegir otro modelo» o «Reducir el número de modelos»." },
        { title: "Si es por un adjunto", body: "Si el problema es el adjunto, pulsa «Reintentar sin archivos»." },
        { title: "Si es por el límite de longitud", body: "Si ves «La respuesta se detuvo por el límite de longitud de salida», vuelve a preguntar pidiendo que continúe." },
        { title: "Si aun así no funciona", body: "Comprueba la página de estado del servicio y pulsa «Reportar error» en la misma tarjeta." },
      ],
      faq: [
        { q: "Me aparece «Ya se está generando una respuesta».", a: "Vuelve a intentarlo cuando la respuesta en curso termine o se detenga." },
        { q: "Me aparece «Los créditos del plan de este mes se han agotado».", a: "Puedes seguir usándolo comprando créditos adicionales o mejorando el plan." },
        { q: "¿Se descuentan créditos por una respuesta fallida?", a: "Los créditos reservados para una respuesta vacía o fallida normalmente se devuelven." },
      ],
    },
    "file-upload-failed": {
      title: "Cuando falla la subida de un archivo",
      summary: "Comprueba el formato, el tamaño, la contraseña y que haya texto legible, y vuelve a intentarlo con un solo archivo.",
      steps: [
        { title: "Leer el mensaje de error", body: "Fíjate en mensajes como «Cada archivo debe tener 10 MB o menos», «Este documento está protegido con contraseña» o «No se encontró texto legible en este archivo»." },
        { title: "Arreglar el archivo", body: "Quita la contraseña, vuelve a guardarlo como PDF o reduce su tamaño." },
        { title: "Probar de uno en uno", body: "Adjunta solo un archivo y vuelve a enviar. Si tienes prisa, pega lo esencial directamente en el cuadro de texto." },
        { title: "Si es un error de imagen", body: "Elige un modelo que pueda leer imágenes o pulsa «Quitar modelos incompatibles»." },
      ],
      faq: [
        { q: "¿Cuántos archivos y de qué tamaño puedo subir?", a: "Con sesión iniciada, hasta 5 archivos por mensaje, 10 MB cada uno y 25 MB en total. Los límites sin sesión están en la lista de formatos de la guía de archivos adjuntos." },
        { q: "¿Qué formatos se admiten?", a: "Todos los formatos aceptados están en la lista de formatos de la guía de archivos adjuntos. No se aceptan GIF animados ni ZIP protegidos con contraseña." },
        { q: "Me dice que no se puede leer un archivo que subí antes.", a: "Es el caso en que el archivo ya no está guardado. Vuelve a adjuntarlo o pulsa «Continuar sin el archivo»." },
      ],
    },
    "report-a-problem": {
      title: "Reportar un error y enviar comentarios",
      summary: "Si usas «Reportar error» en una respuesta fallida, se envían juntos el detalle del error y el ID de seguimiento. Los comentarios generales se envían con «Comentarios».",
      steps: [
        { title: "Abrir la ventana de reporte", body: "En la tarjeta de la respuesta fallida, pulsa «Reportar error». Para opiniones generales, pulsa «Comentarios» en la barra lateral." },
        { title: "Elegir el tipo", body: "Elige «Informar un problema», «Solicitar función», «Facturación» u «Otro» y escribe el contenido. Un reporte de error se puede enviar sin descripción." },
        { title: "Revisar lo que se envía", body: "En «Ver los detalles del error que se adjuntarán», comprueba la información de diagnóstico. Los valores que parecen credenciales se ocultan automáticamente." },
        { title: "Enviar", body: "Si quieres recibir el resultado, marca «Recibir el estado por correo» y pulsa «Enviar». Se muestra un número de recepción." },
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
        { title: "Comprobar cómo te registraste", body: "Comprueba que usas el correo y el método de acceso con los que te registraste (código por correo, Google, Microsoft, etc.)." },
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
      summary: "En la página de estado ves el estado de cada proveedor de IA y en qué se basa esa valoración.",
      steps: [
        { title: "Abrir la página de estado", body: "Abre tomverse.app/status. No hace falta iniciar sesión." },
        { title: "Ver el resumen", body: "Comprueba el resumen de arriba y «Datos a fecha de» (UTC)." },
        { title: "Ver el estado por proveedor", body: "En «Estado de los proveedores», comprueba si está Operativo, con Rendimiento reducido, con Incidente o Desconocido, y qué modelos se ven afectados." },
      ],
      faq: [
        { q: "¿«Desconocido» significa que hay una incidencia?", a: "No. Significa que no hay datos para valorar el estado, y tampoco se da por normal." },
        { q: "Si aparece un aviso, ¿se han agotado mis créditos?", a: "Ese aviso por sí solo no significa que la solicitud falle ni que se hayan agotado los créditos." },
      ],
    },
    "contact-support": {
      title: "Contactar con soporte",
      summary: "Escribe con el formulario de la página de soporte o a support@tomverse.app. Normalmente respondemos en 1-2 días laborables.",
      steps: [
        { title: "Abrir la página de soporte", body: "Abre la página de soporte." },
        { title: "Elegir el tipo de consulta", body: "Elige entre «Soporte general», «Problema o bug», «Facturación», «Solicitud de función» y «Otro»." },
        { title: "Escribir el contenido", body: "Escribe tu correo y el contenido. Si en pantalla había un ID de seguimiento, inclúyelo." },
        { title: "Enviar", body: "Al pulsar «Enviar solicitud», aparece un aviso de que se ha recibido. Las capturas de pantalla no se pueden adjuntar al formulario, así que envíalas aparte al correo de soporte." },
      ],
      faq: [
        { q: "¿Qué conviene enviar junto con la consulta?", a: "El correo de la cuenta, la hora aproximada en que ocurrió, el producto y el modelo, el navegador, si había adjuntos y el ID de seguimiento que se veía en pantalla. No envíes contraseñas ni números de tarjeta." },
        { q: "¿Hay atención telefónica?", a: "No. Atendemos por correo y por el formulario de contacto." },
      ],
    },
  },
};
