import type { HelpLocaleCopy } from "../types";

/**
 * Portuguese (Brazil) copy. Quoted screen names are the strings the pt screens
 * show (locales/pt.ts and the *Copy.ts files); the few names that have no pt
 * screen yet are translated here and used the same way everywhere in the file.
 */
export const pt: HelpLocaleCopy = {
  ui: {
    metaTitle: "Central de Ajuda do Tomverse | Pergunte e receba a resposta",
    metaDescription: "Chat, Review, imagens, pesquisa, arquivos, assistentes, importação, conectores, ferramentas de código, planos e créditos: resolva com guias passo a passo e o assistente de ajuda.",
    eyebrow: "Central de Ajuda",
    heroTitleLead: "Como podemos",
    heroTitleAccent: "ajudar?",
    heroSubtitle: "Pergunte do seu jeito. O assistente procura nos documentos de ajuda do Tomverse, responde passo a passo e indica a tela para onde ir.",
    askPlaceholder: "Ex.: como troco só o fundo depois de criar uma imagem?",
    askButton: "Perguntar",
    askMetaLead: "Assistente de ajuda · responde com base nos documentos de ajuda e mostra as fontes",
    askMetaPrivacy: "Não lê suas conversas · não usa créditos",
    askSignIn: "Entre para perguntar ao assistente de ajuda. Por enquanto, a busca percorre os guias.",
    askSignInButton: "Entrar",
    askUnavailable: "Busca direta nos títulos e no conteúdo dos guias",
    askThinking: "Procurando nos documentos de ajuda…",
    askError: "Não foi possível obter a resposta agora. Tente novamente em instantes ou veja os guias abaixo.",
    askFollowUp: "Continuar perguntando…",
    suggestions: [
      "Comparar 3 respostas no Review",
      "Onde vejo meus créditos restantes?",
      "Importar conversas do ChatGPT",
      "Conectar o Claude Code ao Tomverse",
      "Meu arquivo não sobe",
      "A resposta parou no meio",
    ],
    searchPlaceholder: "Buscar guias: ex. créditos, editar imagem, excluir conta",
    searchEmpty: "Nenhum guia encontrado. Tente outras palavras ou fale com o suporte.",
    commonTasks: "Tarefas comuns",
    allGuides: "Todos os guias",
    byFeature: "Ajuda por recurso",
    guideCount: "{count} guias",
    stepsAndMinutes: "{steps} etapas · cerca de {minutes} min",
    newBadge: "NOVO",
    noAnswerTitle: "Se não encontrar a resposta",
    contactTitle: "Não achou o que procurava?",
    contactBody: "Se o assistente de ajuda e os guias não resolverem, fale com o suporte. Normalmente respondemos em 1 a 2 dias úteis.",
    contactButton: "Falar com o suporte",
    statusButton: "Status do serviço",
    reportButton: "Reportar erro",
    assistantName: "Assistente de ajuda",
    foundIn: "✓ Encontrado em {count} documentos de ajuda",
    notFound: "Não encontrei a resposta nos documentos de ajuda.",
    notFoundBody: "Não respondo por suposição. Se você falar com o suporte, uma pessoa verifica o seu caso.",
    sources: "Fontes",
    helpful: "Isto ajudou?",
    thanks: "Obrigado pelo retorno",
    disclaimer: "O assistente de ajuda lê apenas os documentos públicos de ajuda. Ele não lê nem altera suas conversas, arquivos ou dados de pagamento. A resposta pode estar errada, então confira o guia indicado antes de decisões importantes.",
    openGuide: "Ver o guia passo a passo",
    relatedGuides: "Guias relacionados",
    requirements: "Para usar este recurso",
    signInRequired: "Requer login",
    signInNotRequired: "Funciona sem login",
    planLabel: "Plano",
    allPlans: "Todos os planos",
    paidPlans: "Planos pagos",
    breadcrumbHome: "Central de Ajuda",
    stepLabel: "Etapa {n}",
    previous: "Anterior",
    next: "Próxima etapa",
    faqTitle: "Perguntas frequentes",
    stuckTitle: "Travou nesta etapa?",
    stuckBody: "O assistente de ajuda responde com base no guia que você está lendo.",
    stuckPlaceholder: "Ex.: não vejo o botão",
    tryItTitle: "Experimente agora",
    tryItBody: "Abra em uma nova aba e siga este guia ao lado.",
    tryItButton: "Experimentar agora",
    onThisPage: "Nesta página",
    stepsSection: "Siga passo a passo",
    nextGuides: "Próximos guias",
    backToHelp: "Voltar à Central de Ajuda",
    newQuestion: "Nova pergunta",
  },
  categories: {
    "getting-started": { title: "Primeiros passos", description: "Da criação da conta até a primeira pergunta." },
    chat: { title: "Chat", description: "Conversar com um modelo, escolher modelos e o Auto, melhorar perguntas, entrada de voz." },
    review: { title: "Review · AI Review", description: "Leia as respostas de vários modelos lado a lado e veja as diferenças com o AI Review." },
    images: { title: "Imagens", description: "Crie imagens, edite partes de uma foto e compare resultados de vários modelos." },
    research: { title: "Pesquisa · Busca na web", description: "Busque informações recentes na web e receba relatórios com o Deep Research." },
    files: { title: "Arquivos · Arquivos gerados", description: "Enviar arquivos, Google Drive e baixar arquivos criados pela IA." },
    assistants: { title: "Assistentes · Memory", description: "Seus assistentes, arquivos de conhecimento e a gestão da memória." },
    imports: { title: "Importar · Continuar", description: "Importe conversas de outros serviços de IA e continue de onde parou." },
    connectors: { title: "Conectores · MCP", description: "Conecte serviços externos e servidores MCP." },
    coding: { title: "Ferramentas de programação · Chaves de API", description: "Use o Tomverse no Claude Code, no Codex e em ferramentas parecidas." },
    projects: { title: "Projetos · Compartilhar", description: "Organize, bloqueie e compartilhe conversas em projetos." },
    billing: { title: "Plano · Créditos · Pagamento", description: "Como os créditos são usados, troca de plano, cancelamento e reembolso." },
    account: { title: "Conta · Privacidade", description: "Métodos de login, baixar seus dados e excluir a conta." },
    notifications: { title: "Notificações · Celular", description: "Notificações por e-mail e uso no celular." },
    troubleshooting: { title: "Solução de problemas", description: "Resposta que para, falha no envio de arquivos, reportar erros, status do serviço e contato." },
  },
  guides: {
    // -------------------------------------------------------- getting started
    "create-account": {
      title: "Criar conta e entrar",
      summary: "Crie uma conta gratuita e entre com uma conta Google, Microsoft ou Apple, ou com um código de 6 dígitos enviado por e-mail.",
      steps: [
        { title: "Abrir a tela de login", body: "Toque em “Entrar / Criar conta”." },
        { title: "Escolher o método", body: "Toque em um botão como “Continuar com Google” ou “Continuar com Microsoft”, ou digite o “Endereço de e-mail” e toque em “Receber código de login”. Os botões exibidos podem variar conforme o ambiente." },
        { title: "Digitar o código", body: "Digite em “Digite o código” o código de 6 dígitos recebido por e-mail e toque em “Verificar”. Você também pode tocar no link de login que veio no e-mail." },
        { title: "Se for a primeira vez", body: "Se o e-mail ainda não tiver cadastro, toque em “Cadastrar com este endereço”." },
        { title: "Se o código não chegar", body: "Toque em “Enviar um novo código” ou use “Usar outro e-mail” para trocar o endereço." },
      ],
      faq: [
        { q: "Por quanto tempo o código vale?", a: "Só por alguns minutos. Se expirar, toque em “Enviar um novo código”. Se você digitar o código errado várias vezes, o acesso é bloqueado por um tempo." },
        { q: "Dá para usar sem entrar?", a: "Quando disponível, você pode experimentar como convidado. As conversas de convidado ficam salvas só neste navegador, não no servidor." },
      ],
    },
    "tour-workspace": {
      title: "Conhecer a tela inicial",
      summary: "Veja onde ficam, na barra lateral, o novo chat, a busca, as ferramentas de organização, os projetos, o menu da conversa e a ajuda.",
      steps: [
        { title: "Novo chat", body: "Use “Novo chat”, no topo da barra lateral, para abrir uma nova conversa." },
        { title: "Buscar conversas", body: "Use “Buscar chats” para procurar pelo título. Se estiver logado, a busca também encontra o conteúdo das mensagens salvas." },
        { title: "Ferramentas de organização", body: "Ao expandir “Ferramentas de organização”, você vê os filtros “Bloqueio por palavra-passe” e “Link de partilha ativo” e os “Projetos”." },
        { title: "Menu da conversa", body: "No menu ⋮ ao lado da conversa, escolha “Renomear”, “Fixar chat”, “Mover para projeto”, “Compartilhar”, “Baixar (.txt)”, “Bloquear chat” ou “Excluir”." },
        { title: "Ajuda", body: "Em “Ajuda”, na barra lateral, você revê o tour da barra lateral ou abre a ajuda completa." },
      ],
      faq: [
        { q: "O que significam as marcas “Bloqueado” e “Compartilhado”?", a: "“Bloqueado” é uma conversa que pede a senha para abrir. “Compartilhado” é uma conversa com um link público somente de leitura ativado." },
        { q: "Os chats fixados aparecem em outros dispositivos?", a: "Se você estiver logado, a escolha fica salva na conta e vale em todos os dispositivos. Sem login, ela fica só neste navegador." },
      ],
    },
    "chat-vs-review": {
      title: "Diferença entre Chat e Review",
      summary: "O Chat é onde você conversa com um modelo. O Review compara lado a lado as respostas de vários modelos escolhidos.",
      steps: [
        { title: "Escolher o produto", body: "Na seleção de produto, no alto da tela, escolha “Chat” ou “Review”." },
        { title: "Chat", body: "No Chat, um modelo responde por vez. Se você escolher outro modelo, quem responde passa a ser ele." },
        { title: "Do Chat para a comparação", body: "Para ver uma resposta do Chat em vários modelos, toque em “Comparar no Review”. Um novo Review é aberto com essa pergunta." },
        { title: "Do Review para o Chat", body: "No resultado da análise do Review, toque em “Continuar no Chat” para seguir em um rascunho do Chat." },
      ],
      faq: [
        { q: "Posso mover uma conversa já criada para outro produto?", a: "Uma conversa abre no produto em que foi criada. Comparar ou continuar cria uma conversa nova." },
        { q: "Qual a diferença entre “Easy” e “Professional” no Review?", a: "Quando disponível, no Easy você escolhe só o provedor e o modelo é definido a cada pergunta. No Professional você escolhe os modelos a comparar." },
      ],
    },
    // ------------------------------------------------------------------- chat
    "choose-model-auto": {
      title: "Escolher o modelo e a Adaptação inteligente",
      summary: "Com a Adaptação inteligente ligada, o modelo é escolhido a cada mensagem. Desligada, responde o modelo que você escolheu.",
      steps: [
        { title: "Ver a Adaptação inteligente", body: "Em contas com o recurso disponível, o campo de mensagem tem a chave “Adaptação inteligente”, que começa ligada em um Chat vazio." },
        { title: "Escolher manualmente", body: "Abra o seletor de modelos e toque em um modelo na aba “Conversa”. A Adaptação inteligente é desligada e o modelo escolhido responde." },
        { title: "Ver quem respondeu", body: "Abaixo da resposta, o selo “Automático · nome do modelo” mostra qual modelo respondeu de fato." },
        { title: "Ver a mensagem como foi lida", body: "Se o Auto reformulou sua mensagem, abra “Como o Auto leu sua mensagem”, abaixo do selo." },
      ],
      faq: [
        { q: "Quantos créditos isso usa?", a: "Com a Adaptação inteligente, os créditos dependem do modelo que respondeu. Se você escolher o modelo, vale o crédito base mostrado no seletor." },
        { q: "A mensagem que enviei é alterada ao ser salva?", a: "Não. Sua mensagem é salva exatamente como você a escreveu." },
        { q: "A Adaptação inteligente vai deixar de poder ser desligada?", a: "Não. Você pode desligá-la a qualquer momento escolhendo um modelo." },
      ],
    },
    "prompt-refiner": {
      title: "Usar a sugestão para melhorar a pergunta",
      summary: "“Melhorar redação” sugere uma frase mais clara sem enviar a pergunta. Você decide se vai usá-la.",
      steps: [
        { title: "Pedir a sugestão", body: "Quando disponível, escreva a pergunta no campo de mensagem e toque em “Melhorar redação”." },
        { title: "Comparar", body: "O “Original” e a “Redação sugerida” aparecem lado a lado." },
        { title: "Escolher", body: "Toque em “Usar esta redação” ou “Manter original”. Nenhuma das duas opções envia a mensagem ainda." },
        { title: "Enviar", body: "Toque em “Enviar” como de costume. Se falhar, toque em “Tentar novamente”; o original não é alterado." },
      ],
      faq: [
        { q: "E se eu mudar o texto enquanto a sugestão é gerada?", a: "Se mudar uma única letra, a sugestão desaparece. Toque em “Melhorar redação” de novo." },
        { q: "Ele lê meus arquivos ou o histórico da conversa?", a: "Lê apenas a frase que você digitou agora. O histórico da conversa, os anexos e a memória não são usados." },
      ],
    },
    "voice-input": {
      title: "Digitar por voz",
      summary: "O que você fala no microfone vira texto no campo de mensagem, e você pode corrigir antes de enviar.",
      steps: [
        { title: "Começar a gravar", body: "Quando disponível, toque no microfone (“Gravar entrada de voz”) abaixo do campo de mensagem. Se o navegador pedir permissão para o microfone, permita." },
        { title: "Falar", body: "Enquanto você fala, o aviso “Gravando” e o tempo aparecem acima do campo de mensagem." },
        { title: "Transformar em texto", body: "Toque no mesmo botão de novo. Quando a conversão terminar, a frase entra no campo de mensagem." },
        { title: "Corrigir e enviar", body: "Corrija a frase e toque em “Enviar”. Para descartar a gravação, toque em “Descartar”." },
      ],
      faq: [
        { q: "A gravação fica salva?", a: "O Tomverse não guarda gravações. O áudio é enviado ao provedor de reconhecimento de voz apenas para ser transformado em texto, e gravações descartadas não são enviadas." },
        { q: "Usa créditos?", a: "A entrada de voz não consome créditos. Pode haver um limite diário de uso." },
        { q: "Não consigo gravar.", a: "Funciona nas versões mais recentes do Chrome, Edge, Safari e Firefox. Se o microfone estiver bloqueado, permita-o para este site nas configurações do navegador." },
      ],
    },
    "chat-starters": {
      title: "Preencher a pergunta com um exemplo inicial",
      summary: "Ao escolher um cartão de exemplo em uma nova conversa, a pergunta é preenchida no campo de mensagem. Nada é enviado antes de você enviar.",
      steps: [
        { title: "Escolher um cartão", body: "Quando disponível, toque em um cartão de “O que você pode fazer aqui”, na tela de nova conversa. Para ver mais, toque em “Ver mais sugestões”." },
        { title: "Editar", body: "Edite a frase preenchida no campo de mensagem como quiser." },
        { title: "Enviar", body: "A mensagem só é enviada quando você toca em “Enviar”. Os cartões com uma marca como “Requer login” levam ao login ou ao aviso de plano." },
      ],
      faq: [
        { q: "O texto que eu estava escrevendo é apagado?", a: "Não. O campo só muda se estiver vazio ou se ainda tiver exatamente a frase preenchida pelo cartão anterior." },
        { q: "Tocar em um cartão usa créditos?", a: "Só tocar no cartão não usa. Mas cartões que ativam a busca na web, como os de fontes, podem aumentar os créditos do próximo envio." },
      ],
    },
    // ----------------------------------------------------------------- review
    "compare-answers": {
      title: "Comparar respostas de vários modelos lado a lado",
      summary: "No Review, você envia a mesma pergunta para até 3 modelos e lê as respostas lado a lado.",
      steps: [
        { title: "Escolher os modelos", body: "No Review, abra a seleção de modelos e escolha até 3. Se já houver 3, escolha qual deles será substituído." },
        { title: "Enviar a pergunta", body: "Escreva a pergunta e toque em “Enviar”. Os modelos escolhidos respondem ao mesmo tempo." },
        { title: "Perguntar a um só modelo", body: "Para continuar com um só modelo, use “Perguntar apenas a este modelo” no painel dele." },
        { title: "Mudar a visualização", body: "Alterne entre “Foco” e “Lado a lado”. Mudar a visualização não reenvia a pergunta." },
        { title: "Tirar um modelo", body: "Toque em “Remover da comparação”. Você pode voltar atrás com “Desfazer”." },
      ],
      faq: [
        { q: "Os créditos são cobrados por modelo?", a: "Sim. Cada modelo escolhido usa os créditos da resposta." },
        { q: "Dá para comparar sem entrar?", a: "Quando disponível, convidados também podem comparar até 3 modelos." },
      ],
    },
    "read-ai-review": {
      title: "Executar e ler o AI Review",
      summary: "Quando 2 ou mais respostas estiverem prontas, um modelo revisor separado resume o que têm em comum, as diferenças, as contradições, o que falta e o que vale conferir.",
      steps: [
        { title: "Ter as respostas prontas", body: "Confirme que 2 ou mais respostas à mesma pergunta já terminaram." },
        { title: "Executar", body: "Toque em “Revisão cruzada das respostas por IA” (no Studio para computador, “Analisar com Tomverse”)." },
        { title: "Escolher o critério", body: "Se a tela permitir escolher o critério, selecione “Equilibrado”, “Evidências” ou “Ação” e toque em “Executar revisão cruzada”." },
        { title: "Ler o resultado", body: "Leia nesta ordem: o que as respostas têm em comum, as diferenças importantes, o que se contradiz, o que falta e o que precisa ser conferido." },
        { title: "Dar sua opinião", body: "Em cada item, você pode tocar em “Útil”, “Incorreto”, “Pouco claro” ou “Falta um ponto importante”." },
      ],
      faq: [
        { q: "O AI Review dá a resposta certa?", a: "Não. Ele só compara as respostas recebidas e não faz busca na web nem checagem de fatos externa." },
        { q: "E os créditos se falhar?", a: "Se não terminar, os créditos reservados são devolvidos. O custo aparece na tela antes de executar." },
        { q: "Existe limite de uso?", a: "Convidados e o plano Free têm um limite mensal de execuções. Veja quantas restam na tela." },
      ],
    },
    "follow-citations": {
      title: "Seguir as citações de um item da revisão",
      summary: "Abra a citação do texto original em cada item da revisão e veja de qual trecho da resposta ela vem.",
      steps: [
        { title: "Escolher um item", body: "Em “Constatações da revisão”, escolha um item. Acima da citação aparece de qual resposta (A/B/C) ela vem." },
        { title: "Ver a marca de verificação", body: "Uma marca mostra se a citação foi confirmada no texto original ou se não foi confirmada e pede mais cuidado." },
        { title: "Ir ao texto original", body: "Toque em “Ver na resposta original”, abaixo da citação, para ir ao trecho da resposta." },
        { title: "Conferir na web (opcional)", body: "Se precisar, toque em “Verificar com busca na web” só naquele item. A verificação roda à parte, usa créditos e não altera a revisão original." },
      ],
      faq: [
        { q: "Uma citação “Respaldado” significa que é verdade?", a: "Não. Significa apenas que esse trecho existe na resposta, sem garantia de que o conteúdo esteja correto." },
        { q: "A correspondência com a fonte é uma medida de precisão?", a: "Não. Ela mostra apenas o quanto a citação coincide com o texto original." },
      ],
    },
    "save-share-review": {
      title: "Salvar, compartilhar e exportar comparações e análises",
      summary: "Quando você está logado, a conversa e a análise ficam salvas. Dá para compartilhar a análise por um link somente de leitura ou exportá-la em arquivo.",
      steps: [
        { title: "Entrar e comparar", body: "Se você comparar logado, a conversa e a análise ficam salvas na sua conta. A análise de convidado some ao recarregar a página." },
        { title: "Compartilhar a análise", body: "Abaixo do resultado da análise, toque em “Compartilhar análise”, confira o que será publicado e toque em “Publicar link”." },
        { title: "Enviar ou parar o link", body: "Envie com “Copiar link”. Para parar de compartilhar, toque em “Revogar link”." },
        { title: "Baixar como arquivo", body: "Toque em “Exportar” e escolha o formato do arquivo (PDF, Word, TXT, Markdown)." },
      ],
      faq: [
        { q: "E o link de compartilhamento que a conversa já tinha, se eu compartilhar a análise?", a: "O link de compartilhamento anterior desta conversa é substituído pelo novo link." },
        { q: "O que vai no arquivo exportado?", a: "A análise completa, a pergunta, a origem de cada modelo e se as citações coincidem. As respostas completas dos modelos e os anexos não vão." },
      ],
    },
    // ----------------------------------------------------------------- images
    "create-image": {
      title: "Criar imagens no Chat",
      summary: "Descreva a cena no Chat e envie. Se for entendido como pedido de imagem, a resposta vem como imagem na mesma conversa.",
      steps: [
        { title: "Escrever o pedido", body: "No campo de mensagem do Chat, descreva a cena que quer, por exemplo “Crie uma imagem: …”." },
        { title: "Enviar", body: "Envie a mensagem. Nenhuma confirmação extra é pedida, e no lugar da resposta aparece “Criando a imagem…”." },
        { title: "Ver o resultado", body: "Quando termina, aparece um selo de qualidade (“Qualidade de rascunho”, “Qualidade padrão” ou “Alta qualidade”). Para mais qualidade, envie “Gera novamente esta imagem em alta qualidade”." },
        { title: "Continuar ajustando", body: "Envie algo como “Deixe mais azul” e a imagem é refeita a partir da anterior." },
      ],
      faq: [
        { q: "Quando os créditos são usados?", a: "Quando o Chat responde com uma imagem, os créditos de imagem são usados na hora, sem confirmação. Gerar de novo em alta qualidade também usa créditos." },
        { q: "E se não for entendido como pedido de imagem?", a: "A resposta vem como texto comum." },
        { q: "Se eu compartilhar ou exportar a conversa, a imagem vai junto?", a: "Não. Só vai a frase dizendo que uma imagem foi criada." },
      ],
    },
    "compare-image-models": {
      title: "Comparar imagens de vários modelos",
      summary: "Na tela de imagens, envie uma descrição a vários modelos ao mesmo tempo e compare os resultados lado a lado.",
      steps: [
        { title: "Abrir a tela de imagens", body: "Na barra lateral, ao lado de “Novo chat”, abra “Novo…” e escolha “Nova imagem”. Você também pode escolher o modelo na aba “Imagem” do seletor de modelos." },
        { title: "Escolher os modelos", body: "Em “Modelos”, escolha os modelos a comparar. A tela mostra quantos dá para escolher de uma vez." },
        { title: "Qualidade e tamanho", body: "Escolha a “Qualidade” (Rascunho, Padrão, Final) e o “Tamanho” (Quadrada, Paisagem, Retrato)." },
        { title: "Descrever e gerar", body: "Descreva a imagem, confira o preço de cada modelo e o total de créditos e toque em “Gerar”." },
        { title: "Receber o resultado", body: "Toque em “Tamanho original” ou “Baixar”. Se algum modelo falhar, você pode usar “Repetir este modelo” só nele." },
      ],
      faq: [
        { q: "Sair da página cancela a geração?", a: "Não. Pode levar até cerca de 2 minutos, e a geração continua mesmo que você saia da página." },
        { q: "O link de “Tamanho original” não abre.", a: "O link do original vale só por alguns minutos. Toque de novo depois de um instante para gerar um link novo." },
      ],
    },
    "edit-photo": {
      title: "Editar uma foto anexada",
      summary: "Anexe uma foto no Chat e descreva o que mudar. Se for entendido como pedido de edição, a resposta vem como a imagem editada.",
      steps: [
        { title: "Anexar a foto", body: "Em “Adicionar e ferramentas”, no campo de mensagem, use “Adicionar um ficheiro” para anexar a foto (PNG, JPEG, WebP, GIF)." },
        { title: "Descrever a mudança", body: "Escreva o que mudar, como “Troque o fundo por uma praia ao entardecer”." },
        { title: "Enviar", body: "Se for um pedido de edição, a resposta vem como a imagem editada. Se não for, vem uma resposta comum sobre a foto." },
      ],
      faq: [
        { q: "A foto original é alterada?", a: "Não. A foto enviada fica como está e uma nova imagem é criada." },
        { q: "E se eu anexar várias fotos?", a: "A primeira das fotos anexadas é a que será editada." },
        { q: "Quantos créditos usa?", a: "Os créditos de geração de imagem, e pode haver um acréscimo de edição que depende do modelo." },
      ],
    },
    "image-credits": {
      title: "Créditos de imagem e reembolso",
      summary: "Cada imagem usa um número fixo de créditos conforme a qualidade e o tamanho. Se a geração falhar, todos os créditos reservados são devolvidos.",
      steps: [
        { title: "Ver o preço", body: "Na tela de imagens, confira o preço de cada modelo e o total de créditos." },
        { title: "Gerar", body: "Ao tocar em “Gerar”, os créditos são reservados primeiro." },
        { title: "Acerto de contas", body: "Se der certo, os créditos mostrados são usados. Se falhar, os créditos reservados são devolvidos." },
      ],
      faq: [
        { q: "Em quais planos posso usar?", a: "Logado, você pode usar nos planos Free, Pro e Max, dentro dos créditos que tiver." },
        { q: "Quando recebo os créditos de volta?", a: "Quando a imagem não é criada por recusa do provedor, bloqueio de segurança, erro ou tempo esgotado." },
        { q: "Aparece “Os créditos do plano de hoje acabaram”.", a: "Imagens também usam os créditos diários do plano. Se você tiver créditos comprados, pode continuar usando." },
      ],
    },
    // --------------------------------------------------------------- research
    "deep-research": {
      title: "Começar uma pesquisa com o Deep Research",
      summary: "Escreva a pergunta e inicie o “Deep Research”: ele monta um relatório a partir de várias fontes da web ao longo de alguns minutos.",
      steps: [
        { title: "Escrever a pergunta", body: "Primeiro, escreva no campo de mensagem a pergunta que quer pesquisar." },
        { title: "Abrir o Deep Research", body: "No menu “Adicionar e ferramentas”, toque em “Deep Research”." },
        { title: "Escolher o escopo", body: "Escolha entre “Rápido”, “Padrão” e “Profundo” e confira o tempo estimado e o uso estimado." },
        { title: "Iniciar", body: "Toque em “Iniciar a pesquisa”. O andamento aparece na ordem: busca de fontes e redação do relatório." },
        { title: "Começar pelo cartão de sugestão", body: "Se abaixo de uma resposta comum aparecer o cartão “Ampliar com Deep Research”, você pode tocar nele para começar direto com o escopo padrão." },
      ],
      faq: [
        { q: "Em quais planos posso usar?", a: "Logado, nos planos Pro e Max." },
        { q: "Se eu remover o indicador de andamento, a pesquisa é cancelada?", a: "Não. A pesquisa continua em segundo plano." },
        { q: "Tocar no cartão de sugestão já usa créditos?", a: "Sim. Ele não pergunta o escopo e começa direto com o escopo padrão." },
      ],
    },
    "web-search": {
      title: "Ativar a busca na web e conferir as fontes",
      summary: "Com a busca na web ativada, o Tomverse pesquisa sozinho quando a pergunta pede informação recente ou fontes e mostra os links abaixo da resposta.",
      steps: [
        { title: "Ativar a busca na web", body: "No menu “Adicionar e ferramentas”, ligue a chave “Pesquisa web”." },
        { title: "Ver o estado", body: "Toque no indicador “Pesquisa web ativada”, no campo de mensagem, para ver quantos dos modelos escolhidos aceitam busca." },
        { title: "Abrir as fontes", body: "Os links da lista “Fontes”, abaixo da resposta, abrem em uma nova aba." },
        { title: "Sugestão de nova busca", body: "Se a busca estiver desligada e a pergunta pedir informação recente, aparece o cartão “Verificar na web”. Ao tocar, a mesma pergunta é reenviada com busca." },
      ],
      faq: [
        { q: "Há créditos extras?", a: "Cada modelo que realmente fez a busca recebe um acréscimo fixo de créditos, e os modelos que não buscaram têm esse valor devolvido." },
        { q: "Aparece “Os modelos que responderam não conseguem buscar na web”.", a: "Nenhum dos modelos escolhidos aceita busca. Adicione um modelo que aceite." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Anexar arquivos: formatos e tamanhos aceitos",
      summary: "Você pode anexar vários arquivos por mensagem: imagens, PDF, Office, HWP, texto, código e ZIP.",
      steps: [
        { title: "Adicionar os arquivos", body: "Em “Adicionar e ferramentas”, no campo de mensagem, toque em “Adicionar um ficheiro” → “Escolher do computador”, ou arraste os arquivos para o campo de mensagem." },
        { title: "Esperar a verificação", body: "Espere até os avisos “Enviando” e “Verificando” terminarem." },
        { title: "Enviar", body: "Envie a mensagem." },
      ],
      faq: [
        { q: "Quantos arquivos e de que tamanho?", a: "Logado, até 5 por mensagem e 10 MB por arquivo. Convidado: 1 arquivo de até 5 MB. Os limites podem mudar, então confira o aviso na tela." },
        { q: "Quais arquivos não são aceitos?", a: "Executáveis, compactados que não sejam ZIP (RAR, 7Z etc.), áudio e vídeo, HEIC e TIFF, GIFs animados e documentos protegidos por senha." },
        { q: "Por quanto tempo o arquivo anexado fica guardado?", a: "Anexos de quem está logado ficam guardados junto com a conversa e são apagados quando a conversa ou a conta é excluída. Arquivos de convidado ficam guardados por pouco tempo e depois são apagados automaticamente." },
      ],
    },
    "google-drive": {
      title: "Anexar arquivos do Google Drive",
      summary: "Escolha no Drive documentos, planilhas e apresentações do Google e anexe à conversa.",
      steps: [
        { title: "Abrir o Drive", body: "Em “Adicionar e ferramentas”, toque em “Adicionar um ficheiro” → “Anexar do Google Drive”." },
        { title: "Permitir o acesso", body: "Se a janela de permissão do Google aparecer, permita. É uma permissão de acesso apenas aos arquivos que você escolher." },
        { title: "Escolher os arquivos", body: "Na janela de seleção do Google, escolha os arquivos. Dá para escolher vários, mas não pastas." },
        { title: "Enviar", body: "Quando os indicadores de anexo aparecerem, envie a mensagem." },
      ],
      faq: [
        { q: "Preciso estar logado?", a: "Sim. O Google Drive só pode ser usado depois de entrar." },
        { q: "Quais arquivos aparecem?", a: "Documentos, planilhas e apresentações do Google. Eles são anexados convertidos em texto, xlsx e pptx, respectivamente." },
      ],
    },
    "generated-files": {
      title: "Baixar arquivos criados pela IA",
      summary: "Peça algo como “Crie em Excel” e abaixo da resposta aparece um cartão “Arquivo gerado”, de onde você baixa o arquivo.",
      steps: [
        { title: "Dizer o formato", body: "Na conversa, peça o arquivo dizendo o formato que quer (Excel, Word, PDF, PowerPoint, CSV etc.)." },
        { title: "Esperar", body: "Enquanto o arquivo é criado, aparece “Criando o arquivo…”." },
        { title: "Baixar", body: "No cartão “Arquivo gerado”, abaixo da resposta, toque em “Baixar”. Se falhar, toque em “Criar o arquivo novamente”." },
        { title: "Pedir ajustes", body: "Ao tocar em “Criar uma revisão”, um rascunho com o arquivo anexado é preenchido no campo de mensagem. Você precisa enviá-lo, e o resultado é uma nova versão." },
      ],
      faq: [
        { q: "Preciso estar logado?", a: "Sim. Logado, você pode usar em qualquer plano." },
        { q: "Aparece “Desbloqueie esta conversa para baixar o arquivo.”", a: "Os arquivos de uma conversa bloqueada só podem ser baixados depois de desbloqueá-la." },
        { q: "Pedir ajustes sobrescreve o arquivo original?", a: "Não. Uma nova versão é criada, e você vê as anteriores na lista “Versões do arquivo”." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Criar seu assistente e adicionar arquivos de conhecimento",
      summary: "Reúna nome, instruções, modelo e arquivos de conhecimento em um assistente só seu e escolha-o nas conversas.",
      steps: [
        { title: "Começar a criar", body: "Quando disponível, em “Configurações”, na aba “Assistentes de IA”, toque em “Novo assistente”. Você também pode começar por “Assistente”, no menu de ferramentas da conversa." },
        { title: "Nome e instruções", body: "Preencha “Nome” e “Instruções personalizadas” e toque em “Criar assistente”." },
        { title: "Adicionar arquivos de conhecimento", body: "Em “Arquivos de conhecimento que esta revisão pode usar”, toque em “Adicionar um ficheiro” e espere até ficar “pronto”." },
        { title: "Salvar", body: "Toque em “Guardar instruções, modelos e ficheiros”. Cada vez que você salva, uma nova revisão é criada." },
        { title: "Usar na conversa", body: "Toque em “Conversar com este assistente” ou escolha-o em “Assistente”, no menu de ferramentas da conversa." },
      ],
      faq: [
        { q: "Quais arquivos posso usar como conhecimento?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods e odp. Imagens não podem ser usadas." },
        { q: "Mudar as instruções vale para conversas em andamento?", a: "Não. Na conversa, é preciso tocar em “Usar a revisão mais recente aqui” para que a mudança valha." },
        { q: "Outras pessoas podem ver meu assistente?", a: "Não. O assistente só é usado na sua conta e não é compartilhado." },
      ],
    },
    "manage-memory": {
      title: "Ver, desligar e apagar a memória",
      summary: "Veja e edite as memórias salvas, desligue-as para tudo ou por conversa e apague uma a uma ou todas.",
      steps: [
        { title: "Abrir a gestão da memória", body: "Em “Configurações”, na aba “Personalização da IA”, na linha “Memória da conta”, toque em “Gerir memória”." },
        { title: "Ver e editar", body: "Em “Memórias em uso”, toque em “Editar”, “Fixar” ou “Excluir”. A exclusão só se conclui com um segundo toque." },
        { title: "Desligar para tudo", body: "Em “Configurações de uso da memória”, desligue “Usar a memória em todos os chats”. As memórias salvas não são apagadas." },
        { title: "Desligar por conversa", body: "Em “Adicionar e ferramentas”, no campo de mensagem, abra “Memória da conta” e escolha “Não usar nesta conversa”." },
        { title: "Apagar tudo", body: "Se precisar, primeiro faça um backup com “Baixar tudo (JSON)” e depois apague com “Excluir todas as memórias”, digitando o texto de confirmação. Não dá para desfazer." },
      ],
      faq: [
        { q: "De onde vêm as memórias?", a: "Do que foi organizado a partir de conversas importadas de outros serviços de IA e do que você adiciona em “Adicionar uma memória manualmente”." },
        { q: "As memórias são enviadas ao provedor de IA?", a: "Nas respostas que usam memória, elas são enviadas como material de referência ao provedor de IA que gera a resposta." },
        { q: "Apagar todas as memórias apaga também as conversas importadas?", a: "Não. As conversas importadas são apagadas à parte, em Gerir importações." },
      ],
    },
    // --------------------------------------------------------------- projects
    "organise-projects": {
      title: "Organizar conversas em projetos",
      summary: "Agrupe conversas relacionadas como se fossem pastas. As conversas de um mesmo projeto não compartilham conteúdo nem arquivos entre si.",
      steps: [
        { title: "Criar um projeto", body: "Na barra lateral, ao lado de “Projetos”, toque em “Novo” (na primeira vez, “Criar o primeiro projeto”) e digite o nome." },
        { title: "Mover conversas", body: "No menu ⋮ da conversa, em “Mover para projeto”, escolha o projeto." },
        { title: "Tirar e renomear", body: "Use “Remover do projeto” para tirar a conversa e o botão de lápis para renomear o projeto." },
        { title: "Excluir um projeto", body: "Toque em “Excluir projeto” e confirme mais uma vez. As conversas só vão para “Sem categoria” e não são apagadas." },
      ],
      faq: [
        { q: "Posso colocar instruções ou arquivos comuns em um projeto?", a: "Não. O projeto é só uma pasta de organização. Para instruções e arquivos comuns, use um assistente." },
        { q: "Quantos projetos posso criar?", a: "Até 24 por conta." },
      ],
    },
    "lock-conversation": {
      title: "Bloquear uma conversa (senha)",
      summary: "Ao colocar senha em uma conversa, ela é conferida antes de abrir, compartilhar, baixar, editar ou excluir.",
      steps: [
        { title: "Começar o bloqueio", body: "No menu ⋮ da conversa, toque em “Bloquear chat”." },
        { title: "Definir a senha", body: "Digite uma senha de 8 a 128 caracteres." },
        { title: "Abrir uma conversa bloqueada", body: "Ao abrir uma conversa bloqueada, a senha é pedida. Depois de confirmar, ela não é pedida de novo por um tempo." },
        { title: "Remover o bloqueio", body: "No menu, toque em “Desbloquear” e digite a senha." },
      ],
      faq: [
        { q: "E se eu esquecer a senha?", a: "O Tomverse não consegue mostrar nem recuperar a senha. Fale com o suporte." },
        { q: "O bloqueio criptografa a conversa?", a: "Não. É só um bloqueio que impede abrir a conversa. Ao gerar uma resposta, o conteúdo é enviado ao provedor de IA." },
      ],
    },
    "share-link": {
      title: "Criar e parar um link de compartilhamento",
      summary: "Transforma a conversa atual em uma página pública somente de leitura. Quem tiver o link pode ver sem entrar.",
      steps: [
        { title: "Abrir o compartilhamento", body: "No menu ⋮ da conversa, toque em “Compartilhar”. Se a conversa estiver bloqueada, desbloqueie primeiro." },
        { title: "Criar o link", body: "Leia o aviso e toque em “Criar link”. O link é copiado." },
        { title: "Incluir o conteúdo mais recente", body: "Mensagens enviadas depois de compartilhar não entram automaticamente. Para incluí-las, toque em “Gerar novo link de compartilhamento”." },
        { title: "Parar de compartilhar", body: "Toque em “Parar compartilhamento”. O link anterior deixa de funcionar na hora." },
      ],
      faq: [
        { q: "Por quanto tempo o link vale?", a: "Ele expira depois de um prazo definido, e a data de expiração aparece na página compartilhada." },
        { q: "Minha memória (Memory) também é compartilhada?", a: "Não. O conteúdo da memória não é compartilhado. Apague o que for sensível antes de compartilhar." },
      ],
    },
    // ---------------------------------------------------------------- imports
    "import-chatgpt": {
      title: "Importar conversas do ChatGPT",
      summary: "Envie o arquivo de exportação de dados do ChatGPT para salvar suas conversas antigas na conta do Tomverse. O arquivo original é lido apenas dentro do seu navegador.",
      steps: [
        { title: "Exportar pelo ChatGPT", body: "No ChatGPT, vá em Configurações → Controles de dados, peça para exportar os dados e baixe o arquivo ZIP pelo link recebido por e-mail. Não precisa descompactar." },
        { title: "Abrir a tela de importação", body: "No Tomverse, em “Configurações”, na aba “Dados”, na linha “Importar de outro serviço de IA”, toque em “Gerir importações” e depois em “Começar uma nova importação”. Você também chega pelo cartão “Continuar um chat de outra IA”, na tela inicial de um novo Chat." },
        { title: "Escolher o serviço e o arquivo", body: "Em “Onde está sua conversa?”, escolha “ChatGPT” e, em “Escolher arquivo de exportação”, selecione o arquivo .zip ou .json." },
        { title: "Escolher as conversas", body: "Filtre por título ou por data, use “Selecionar todas as conversas normais” ou escolha uma a uma e toque em “Revisar os chats selecionados (N)”." },
        { title: "Importar", body: "Em “Revisar antes de importar”, toque em “Importar N conversas”. Não feche a tela até terminar de salvar." },
      ],
      faq: [
        { q: "Imagens e anexos também são importados?", a: "Não. Imagens, áudios e anexos não são importados; só o texto é salvo." },
        { q: "O arquivo de exportação é enviado ao servidor?", a: "O arquivo original não sai do seu dispositivo. Só o texto das conversas escolhidas é salvo na conta." },
        { q: "Se eu enviar o mesmo arquivo de novo, há duplicatas?", a: "As conversas que já estão na conta são puladas como duplicadas." },
      ],
    },
    "import-claude": {
      title: "Importar conversas do Claude",
      summary: "Envie o arquivo de exportação de dados do Claude (ZIP ou JSON) para salvar as conversas na sua conta.",
      steps: [
        { title: "Exportar pelo Claude", body: "No Claude, vá em Configurações → Privacidade, peça para exportar os dados e baixe o arquivo pelo link do e-mail. Tanto ZIP quanto JSON servem como estão." },
        { title: "Abrir a tela de importação", body: "Toque em “Configurações” → “Dados” → “Importar de outro serviço de IA” → “Gerir importações” → “Começar uma nova importação”." },
        { title: "Escolher Claude", body: "Em “Onde está sua conversa?”, escolha “Claude” e selecione o arquivo em “Escolher arquivo de exportação”." },
        { title: "Escolher e importar", body: "Escolha as conversas, toque em “Revisar os chats selecionados (N)” e depois em “Importar N conversas”." },
      ],
      faq: [
        { q: "Escolhi o serviço errado.", a: "Sem problema. Depois que o arquivo é aberto, o formato real é verificado automaticamente e a importação segue por ele." },
        { q: "O que acontece com mensagens muito longas?", a: "Mensagens maiores que o limite de armazenamento, se você concordar, são salvas encurtadas, mantendo só o começo e o fim. Conversas com mensagens longas demais aparecem como impossíveis de importar." },
        { q: "Quanto posso importar?", a: "Cada conta tem um limite de quantidade de texto e de conversas. Se o que você escolheu for maior que o espaço restante, reduza a seleção com “Ajustar a seleção”." },
      ],
    },
    "continue-imported": {
      title: "Continuar no Tomverse uma conversa importada",
      summary: "Comece uma nova conversa do Tomverse a partir de uma conversa importada. O original continua somente para leitura.",
      steps: [
        { title: "Começar a continuar", body: "Na tela de importação concluída, toque em “Continuar esta conversa”, ou toque em “Continuar” na lista de “Gerir importações”. O botão “Continuar no Tomverse”, na parte de baixo do original, também serve." },
        { title: "Ler o aviso", body: "Confirme que uma nova conversa será criada e o original ficará como está, que não há anexos e só uma parte recente é usada como contexto, e que cada resposta usa créditos." },
        { title: "Criar a conversa", body: "Toque em “Criar a conversa”." },
        { title: "Escolher trechos do original (opcional)", body: "Se quiser, escolha você mesmo os trechos em “Escolher trechos do original” e toque em “Usar os trechos selecionados”." },
      ],
      faq: [
        { q: "Posso criar imagens em uma conversa continuada?", a: "Não. Comece uma nova imagem pela barra lateral." },
        { q: "Posso compartilhar publicamente uma conversa continuada?", a: "Ainda não." },
        { q: "E se eu apagar o original?", a: "As mensagens do Tomverse ficam e aparece a marca “Original excluído”." },
      ],
    },
    "import-guest-conversations": {
      title: "Salvar na conta as conversas feitas como convidado",
      summary: "Passe para a sua conta as conversas de convidado que você teve neste navegador antes de entrar.",
      steps: [
        { title: "Entrar", body: "Ao entrar, aparece a janela “Importar suas conversas de convidado?”." },
        { title: "Escolher o que importar", body: "Toque em “Importar apenas a conversa atual” ou em “Importar todas as N conversas de convidado”. Para pular, toque em “Começar sem importar”." },
        { title: "Importar depois", body: "Se você pulou, dá para fazer depois em “Configurações” → aba “Dados”, em “Importar as conversas de convidado deste navegador”." },
      ],
      faq: [
        { q: "E se eu limpar os dados do navegador?", a: "Se você limpar os dados do navegador ou usar outro navegador ou dispositivo, as conversas de convidado não podem ser recuperadas." },
        { q: "Só uma parte falhou.", a: "A quantidade de falhas é exibida e você pode tocar em “Tentar novamente”." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Conectar um plugin e escolher as permissões",
      summary: "Conecte um serviço externo como plugin e escolha você mesmo as permissões e as ferramentas que ele pode usar. Aparece nas contas que têm este recurso ativado.",
      steps: [
        { title: "Abrir a tela de plugins", body: "No campo de mensagem do Chat, toque no botão de quebra-cabeça e depois em “Gerenciar plugins”." },
        { title: "Iniciar a conexão", body: "Toque em “Adicionar conexão MCP” ou em “Conectar”, no cartão do serviço. Serviços marcados com “Configuração do servidor necessária” ainda não podem ser conectados." },
        { title: "Escolher as permissões", body: "Para serviços com login, marque na lista “Permissões a conceder” só o que for necessário e toque em “Conectar”. Ao voltar do login do serviço, aparece “Conectados”." },
        { title: "Salvar as ferramentas a usar", body: "Em “Gerenciar acesso”, marque em “Selecionar ferramentas” as que quiser e toque em “Salvar acesso”. As ferramentas só podem ser escolhidas no Chat depois de salvas." },
      ],
      faq: [
        { q: "Quero mudar as permissões.", a: "Em “Gerenciar acesso”, toque em “Autenticar novamente” e escolha de novo." },
        { q: "O conteúdo da minha conversa vai para o serviço?", a: "Só são enviados os termos de busca e os valores necessários para a execução. A conversa inteira e a memória não são compartilhadas automaticamente." },
        { q: "E se eu desconectar?", a: "Depois de “Desconectar”, novas chamadas são bloqueadas e as credenciais salvas são apagadas. O que já entrou em respostas permanece." },
      ],
    },
    "custom-mcp-server": {
      title: "Adicionar o endereço do seu servidor MCP",
      summary: "Conecte um servidor MCP remoto em que você confia informando o endereço HTTPS público dele.",
      steps: [
        { title: "Abrir o MCP personalizado", body: "Na tela de “Plugins”, toque em “Conectar” no cartão “Servidor MCP personalizado”." },
        { title: "Digitar o endereço", body: "Em “URL do servidor (HTTPS)”, digite o endereço do servidor e, se quiser, preencha o “Nome de exibição”." },
        { title: "Escolher a autenticação", body: "Escolha “Sem autenticação”, “Token Bearer” ou “OAuth (registro dinâmico de cliente)”. Para o token Bearer, use um token de permissão mínima emitido à parte por esse serviço." },
        { title: "Conectar e salvar as ferramentas", body: "Toque em “Conectar”, escolha as ferramentas em “Gerenciar acesso” e toque em “Salvar acesso”." },
      ],
      faq: [
        { q: "Aparece “Este endereço não pode ser usado”.", a: "Só endereços HTTPS públicos funcionam. Endereços de rede interna, portas diferentes de 443 e parâmetros no final do endereço não são aceitos." },
        { q: "O OAuth não funciona.", a: "O servidor não aceita registro dinâmico de cliente. Tente conectar com um token Bearer." },
        { q: "Preciso aprovar toda vez que uma ferramenta for usada?", a: "Sim. A execução de ferramentas de um servidor personalizado é aprovada a cada vez." },
      ],
    },
    "use-plugin-in-chat": {
      title: "Usar plugins na conversa e aprovar as execuções",
      summary: "No Chat, escolha o plugin conectado e, para ações que enviam algo para fora, confira o conteúdo e aprove.",
      steps: [
        { title: "Escolher o plugin", body: "No campo de mensagem do Chat, toque no botão de quebra-cabeça e escolha a conexão que quer usar nesta conversa." },
        { title: "Enviar a pergunta", body: "Pergunte como de costume. O modelo usa as ferramentas de que precisar." },
        { title: "Aprovar a execução", body: "Para ações que escrevem em um serviço externo, aparece “Revisar esta ação em Plugins”. Em “Aprovações”, confira o que será enviado e toque em “Aprovar esta ação” ou “Rejeitar”." },
      ],
      faq: [
        { q: "Conectei, mas não aparece na lista.", a: "É preciso salvar pelo menos uma ferramenta em “Gerenciar acesso” para a conexão aparecer na lista." },
        { q: "Dá para usar no Review também?", a: "A escolha de plugins fica no campo de mensagem do Chat." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "Criar e revogar chaves de API",
      summary: "Crie chaves de API do Tomverse para usar em ferramentas de código, mude o limite e o nome e revogue as que não usa mais. Aparece nas contas com a API liberada.",
      steps: [
        { title: "Abrir a tela de chaves de API", body: "Em “Configurações”, na aba “Conta”, na linha “Chaves de API”, toque em “Gerenciar”." },
        { title: "Criar a chave", body: "Preencha o “Nome”, defina, se quiser, o “Limite de créditos” e “Expira” (padrão de 90 dias) e toque em “Criar chave”." },
        { title: "Guardar a chave", body: "Em “Copie sua chave agora”, toque em “Copiar”, guarde em um lugar seguro e toque em “Já salvei”. A chave só aparece essa vez." },
        { title: "Gerenciar", body: "Na lista “Suas chaves”, use “Renomear”, “Alterar limite” e “Solicitações recentes”." },
        { title: "Revogar e trocar", body: "Ao tocar em “Revogar”, as ferramentas que usam essa chave param na hora, e não dá para desfazer. Para trocar, crie uma nova chave, coloque-a na ferramenta e só então revogue a antiga." },
      ],
      faq: [
        { q: "Perdi a chave.", a: "Não dá para vê-la de novo. O Tomverse guarda apenas uma impressão digital da chave. Crie uma nova e revogue a antiga." },
        { q: "Quantas chaves posso criar?", a: "Até 10 chaves em uso por conta." },
        { q: "Aparece “A API da Tomverse ainda não está disponível para esta conta.”", a: "A API está sendo liberada por etapas. Quando estiver disponível, você poderá criar chaves nesta tela." },
      ],
    },
    "connect-claude-code": {
      title: "Conectar o Claude Code ao Tomverse",
      summary: "No terminal ou na extensão oficial do VS Code, com poucas linhas de configuração o Claude Code passa a usar os modelos e os créditos do Tomverse.",
      steps: [
        { title: "Preparar a chave", body: "Crie e guarde uma chave seguindo o guia “Criar e revogar chaves de API”." },
        { title: "Escolher o modelo", body: "Na tela de chaves de API, em “Ferramentas de programação”, escolha o “Modelo” no cartão “Configurar o Claude Code”. A lista só mostra modelos compatíveis com a ferramenta." },
        { title: "Usar no terminal", body: "Use “Copiar” no bloco do PowerShell ou do macOS / Linux e cole no terminal. O comando claude, na última linha, inicia o Claude Code conectado ao Tomverse." },
        { title: "Usar na extensão do VS Code", body: "Coloque o bloco “settings.json de usuário do VS Code” no settings.json de usuário e reinicie o VS Code." },
        { title: "Colocar a chave", body: "Na configuração copiada, troque <YOUR_TOMVERSE_API_KEY> pela chave que você guardou." },
      ],
      faq: [
        { q: "Como volto para a minha conta original do Claude?", a: "Feche o terminal ou apague do settings.json a configuração que você colocou e reinicie o VS Code." },
        { q: "A busca na web não funciona.", a: "Ferramentas que rodam nos servidores da Anthropic, como a busca na web, não podem ser usadas na conexão com o Tomverse." },
        { q: "A chave fica escrita no settings.json?", a: "Sim. A extensão do Claude Code lê a chave de uma variável de ambiente, então ela fica gravada no arquivo. Não compartilhe esse arquivo." },
      ],
    },
    "connect-codex": {
      title: "Conectar o Codex ao Tomverse",
      summary: "Adicione o Tomverse como provedor no arquivo de configuração do Codex e execute com --profile tomverse. Sua conta habitual do Codex não é alterada.",
      steps: [
        { title: "Preparar a chave e o modelo", body: "Crie uma chave e, na tela de chaves de API, em “Ferramentas de programação” → “Configurar o Codex”, escolha o “Modelo”." },
        { title: "Adicionar o provedor", body: "Cole o bloco “Adicione a ~/.codex/config.toml” em ~/.codex/config.toml." },
        { title: "Salvar o perfil", body: "Salve o bloco seguinte como ~/.codex/tomverse.config.toml." },
        { title: "Colocar a chave e iniciar", body: "No bloco “Defina a chave onde o Codex é iniciado”, troque <YOUR_TOMVERSE_API_KEY> pela sua chave e execute. A última linha, codex --profile tomverse, inicia o Codex no Tomverse." },
        { title: "Se você usa a extensão do VS Code", body: "A extensão só lê o config.toml, então coloque no início do config.toml o bloco “Na extensão do VS Code…” mostrado na tela." },
      ],
      faq: [
        { q: "Isso afeta minha conta habitual do Codex?", a: "Sem --profile tomverse, o Codex continua usando a conta original." },
        { q: "Como desfaço a configuração da extensão do VS Code?", a: "Apague a linha model_provider que você colocou no início do config.toml." },
        { q: "Algum recurso não funciona?", a: "Busca na web hospedada, conversas salvas e respostas em segundo plano não podem ser usadas." },
      ],
    },
    "api-usage": {
      title: "Ver o uso e os limites da API",
      summary: "As solicitações feitas com uma chave usam os mesmos créditos da conta que o Chat, e você pode definir um limite de créditos para cada chave.",
      steps: [
        { title: "Ver o uso por chave", body: "Em “Suas chaves”, na tela de chaves de API, veja os créditos usados por cada chave e os reservados para solicitações em andamento." },
        { title: "Ver as solicitações recentes", body: "Toque em “Solicitações recentes” para ver, por solicitação, o modelo, os créditos, os tokens de entrada e saída e o ID da solicitação." },
        { title: "Ver o saldo da conta", body: "Toque em “Saldo e uso da conta” para abrir a aba “Plano”." },
        { title: "Créditos por modelo", body: "Em “Modelos disponíveis”, veja os créditos por solicitação de cada modelo." },
      ],
      faq: [
        { q: "As solicitações falham com 401, 403, 404 ou 429.", a: "401: a chave está errada, expirou ou foi revogada. 403: a API está desligada na conta. 404: modelo não disponível (copie a configuração de novo). 429: o limite da chave, os créditos ou o limite de velocidade de solicitações foi atingido." },
        { q: "Solicitações que falham também usam créditos?", a: "Se falharem antes de gerar qualquer saída, não usam." },
        { q: "A ferramenta faz várias solicitações.", a: "As etapas depois da execução de uma ferramenta e a compactação da conversa também contam como uma solicitação cada." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "Configurar notificações por e-mail",
      summary: "Escolha os tipos de e-mail que quer receber. Os e-mails de marketing só começam depois de você confirmar o país de residência e tocar no link do e-mail de confirmação.",
      steps: [
        { title: "Abrir as notificações por e-mail", body: "Em “Configurações”, na aba “Conta”, toque em “Notificações por e-mail” → “Abrir notificações por e-mail”." },
        { title: "Ligar e desligar itens", body: "“Segurança e conta” e “Cobrança” ficam sempre ligados. “Status do serviço” pode ser desligado, e “Novidades do produto”, “Boletim” e “Ofertas” começam desligados." },
        { title: "Receber e-mails de marketing", body: "Para ligar um item de marketing, escolha primeiro o “País de residência” e toque em “Confirmar país”." },
        { title: "E-mail de confirmação", body: "O envio só começa depois que você tocar no link do e-mail de confirmação. Se precisar, toque em “Reenviar e-mail de confirmação”." },
        { title: "Desligar tudo de uma vez", body: "Toque em “Desligar todos os e-mails de marketing”." },
      ],
      faq: [
        { q: "Não dá para desligar os e-mails de segurança?", a: "São avisos obrigatórios de proteção da conta, então não dá para desligar. Os e-mails de cobrança também não." },
        { q: "Liguei a chave, mas ela continua desligada.", a: "O e-mail de confirmação foi enviado. Ao tocar no link dele, a chave é ligada." },
        { q: "Dá para parar de receber sem entrar?", a: "Dá pelo link de cancelamento no rodapé do e-mail. Para ligar de novo, é preciso entrar." },
      ],
    },
    "use-on-mobile": {
      title: "Usar no navegador do celular",
      summary: "No celular, a lista de conversas abre como uma gaveta à esquerda e o campo de mensagem fica na parte de baixo da tela.",
      steps: [
        { title: "Abrir o menu", body: "Toque no botão de menu no canto superior esquerdo para abrir a gaveta. Nela ficam o novo chat, a busca e a lista de conversas e, embaixo, o uso, o idioma, o menu da conta e o feedback." },
        { title: "Enviar", body: "No teclado do celular, o Enter quebra a linha. Para enviar, toque no botão de enviar." },
        { title: "Adicionar à tela inicial", body: "No menu da conta, toque em “Instalar Tomverse”. No iPhone, no Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”." },
      ],
      faq: [
        { q: "Dá para enviar arquivos pelo celular?", a: "Dá. Sem login, 1 arquivo de até 5 MB; logado, você envia mais e também pode usar o Google Drive." },
        { q: "Dá para importar conversas pelo celular?", a: "Dá. Mas, se o arquivo de exportação for grande, é melhor fazer pelo computador." },
      ],
    },
    // ---------------------------------------------------------------- account
    "manage-login-methods": {
      title: "Adicionar e remover métodos de login",
      summary: "Você pode vincular ou tirar o login por e-mail, Google e Microsoft da conta. É preciso sempre manter pelo menos um método de login.",
      steps: [
        { title: "Abrir as configurações", body: "Toque no botão da conta, na parte de baixo da barra lateral, e em “Configurações” no menu da conta." },
        { title: "Achar o cartão de métodos de login", body: "Na aba “Conta”, abra o cartão “Métodos de login”." },
        { title: "Vincular", body: "Toque em “Adicionar” na linha do método que quer vincular. O e-mail usa verificação por código, e o Google e a Microsoft levam ao login desses serviços." },
        { title: "Remover", body: "Toque em “Remover” na linha do método que quer tirar e, quando o botão mudar, toque de novo em “Clique novamente para remover”." },
        { title: "Entrar de novo", body: "Ao remover, você é desconectado de todos os dispositivos, então entre de novo com um dos métodos que sobraram." },
      ],
      faq: [
        { q: "Posso excluir o último método de login?", a: "Não. A conta precisa ter pelo menos um método de login." },
        { q: "Aparece “Esse e-mail já está em uso por outro método de login”.", a: "Entre com o método usado no primeiro cadastro (Google, Microsoft ou e-mail) e depois adicione o novo método nas configurações." },
        { q: "Aparece que a conta que quero vincular já está vinculada a outra conta do Tomverse.", a: "Uma conta externa só pode ser vinculada a uma conta do Tomverse." },
      ],
    },
    "export-account-data": {
      title: "Baixar os dados da sua conta",
      summary: "Baixe em um único arquivo as conversas, memórias, registros importados, pagamentos e uso. Também dá para baixar só as conversas em texto.",
      steps: [
        { title: "Abrir a aba de dados", body: "No menu da conta, abra “Configurações” e a aba “Dados”." },
        { title: "Começar o download", body: "Em “Gestão de dados”, na linha “Os dados da sua conta”, toque em “Baixar seus dados”." },
        { title: "Preparar o arquivo", body: "Toque em “Preparar um download”. Se você não entrou recentemente, entre mais uma vez e volte." },
        { title: "Baixar o arquivo", body: "Toque em “Baixar o arquivo”. O link só pode ser usado uma vez e expira em 5 minutos; se expirar, toque em “Preparar um novo download”." },
        { title: "Se só precisar das conversas", body: "Na aba de dados, em “Exportar suas conversas”, toque em “Baixar todos os chats como .txt”. As conversas bloqueadas ficam de fora desse arquivo." },
      ],
      faq: [
        { q: "Algum dado fica de fora?", a: "Itens que não são dados do usuário, como registros operacionais, ficam de fora. O que entrou e o que saiu, com o motivo, está descrito dentro do arquivo." },
        { q: "Posso ver o histórico de downloads?", a: "Em “Histórico de downloads”, você vê por 90 dias os registros de pedidos, downloads e recusas." },
      ],
    },
    "delete-account": {
      title: "Excluir a conta",
      summary: "Ao pedir a exclusão, você é desconectado na hora e, depois de 7 dias de carência, os dados, incluindo conversas e arquivos, são apagados de forma permanente.",
      steps: [
        { title: "Antes, baixar (recomendado)", body: "Se quiser guardar algum dado, baixe-o antes seguindo o guia “Baixar os dados da sua conta”." },
        { title: "Abrir a zona de risco", body: "Em “Configurações”, na parte de baixo da aba “Conta”, em “Zona de risco”, toque em “Excluir conta”." },
        { title: "Digitar a confirmação", body: "Marque a caixa de concordância e digite exatamente DELETE MY ACCOUNT." },
        { title: "Enviar o pedido", body: "Toque em “Excluir conta” e, depois, mais uma vez em “Solicitar exclusão da conta”. Se aparecer o aviso para entrar de novo, entre e repita." },
        { title: "Encerrar assinaturas das lojas", body: "Se você pagou pela App Store ou pelo Google Play, excluir a conta não cancela a assinatura. Cancele à parte em cada loja." },
      ],
      faq: [
        { q: "Dá para cancelar a exclusão?", a: "Não pela tela. Escreva em até 7 dias para support@tomverse.app. Mesmo que a conta seja restaurada, o plano vale só até a data de vencimento original e a renovação automática não é religada." },
        { q: "O plano que paguei é reembolsado?", a: "Em assinaturas pagas pela web, só a renovação automática é interrompida; não há reembolso." },
        { q: "Qual a diferença para “Excluir todos os chats”?", a: "“Excluir todos os chats” fica na aba de dados, apaga só as conversas e mantém a conta. Não dá para desfazer." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "Como os créditos são descontados",
      summary: "Cada modelo tem um crédito base por resposta, entradas longas recebem um multiplicador, e a busca na web e as imagens são calculadas à parte.",
      steps: [
        { title: "Ver o crédito base de cada modelo", body: "No seletor de modelos, confira o crédito base de cada modelo. Os valores podem mudar, então vale o número que aparece na tela." },
        { title: "Estimativa antes de enviar", body: "O valor exibido antes de enviar é o crédito base estimado." },
        { title: "Multiplicador para conversas e arquivos longos", body: "Se a conversa for longa ou o arquivo for grande, pode ser aplicado um multiplicador de 1,5x, 2x ou 3x conforme o tamanho da entrada." },
        { title: "Busca na web e imagens", body: "Com a busca na web sempre ligada, um valor fixo é acrescentado e devolvido se não houve busca de fato. A geração de imagem tem créditos fixos por qualidade." },
        { title: "Ordem de desconto", body: "Primeiro são usados os créditos do plano do mês e, depois, os créditos comprados, começando pelos que vencem antes." },
      ],
      faq: [
        { q: "Descontou mais do que o valor mostrado.", a: "Conversas e arquivos longos podem receber o multiplicador de tamanho da entrada." },
        { q: "Se a resposta falhar, os créditos são descontados?", a: "Se falhar antes de gerar uma resposta utilizável, ou se vier vazia, normalmente os créditos são devolvidos automaticamente. Se você interromper durante a resposta, a parte já gerada pode ser descontada." },
        { q: "Aparece “Uma verificação de segurança interna pausou este pedido”.", a: "Nesse caso, nenhum crédito é descontado. Tente de novo em instantes ou escolha um modelo mais barato." },
      ],
    },
    "check-credits": {
      title: "Ver os créditos restantes e a data de vencimento",
      summary: "No menu da conta e na aba “Plano”, você vê o uso de hoje e do mês, os créditos restantes, o ciclo de cobrança e a data de vencimento.",
      steps: [
        { title: "Abrir o menu da conta", body: "Toque no botão da conta, na parte de baixo da barra lateral. O medidor “Uso atual” e o horário da próxima reposição aparecem ali." },
        { title: "Ir para a aba Plano", body: "Toque em “Utilização e plano” para abrir a aba “Plano”, nas configurações." },
        { title: "Conferir o plano atual", body: "No cartão “Plano atual”, veja o ciclo de cobrança (mensal/anual) e “Expira” (o fim do período de cobrança atual)." },
        { title: "Conferir os créditos restantes", body: "Veja os cartões “Créditos de respostas de IA hoje”, “Créditos de respostas de IA neste mês” e “Créditos comprados restantes”. Os créditos adicionais também mostram a data de vencimento mais próxima." },
      ],
      faq: [
        { q: "Quando os créditos são repostos?", a: "Os créditos diários são repostos à meia-noite do “Fuso horário da reposição diária”, nas Preferências, e os créditos mensais do plano, todo dia 1º às 00:00 UTC. Eles não se acumulam." },
        { q: "Os créditos extras comprados também somem no começo do mês?", a: "Não. Eles são mantidos à parte dos créditos mensais e vencem 365 dias depois da compra." },
        { q: "Logo depois de pagar, o plano não mudou.", a: "O processamento do pagamento pode levar um instante. Na aba Plano, confira de novo o plano atual e a data de vencimento." },
      ],
    },
    "change-plan": {
      title: "Trocar entre Pro e Max",
      summary: "A troca é feita na página de preços. O upgrade vale assim que o pagamento é concluído, e o downgrade vale quando o período de cobrança atual termina.",
      steps: [
        { title: "Abrir a página de preços", body: "Vá para a página de preços." },
        { title: "Iniciar a troca", body: "Se você usa o Pro, toque em “Atualizar para Max”. Se usa o Max, toque em “Mudar para Pro”." },
        { title: "Conferir valor e créditos", body: "Na tela de troca, confira o valor de “A pagar hoje” e quantos créditos do plano deste mês restam depois da troca." },
        { title: "Concluir o upgrade", body: "Toque em “Pagar e mudar para Max”. Até o pagamento ser concluído, aparece “A aguardar o pagamento”." },
        { title: "Agendar o downgrade", body: "Toque em “Agendar Pro”. Até a data de início, você pode desfazer em “Cancelar esta alteração”." },
      ],
      faq: [
        { q: "Ao fazer o upgrade, ganho créditos novos?", a: "O limite do mês passa a ser o do Max e o que você já usou continua contando. Nenhum crédito extra é dado à parte." },
        { q: "Dá para trocar de mensal para anual?", a: "Só é possível trocar entre planos do mesmo ciclo de cobrança. Para mudar de mensal para anual ou o contrário, fale com o suporte." },
        { q: "E se o pagamento falhar?", a: "O plano atual continua como está e nada é cobrado." },
      ],
    },
    "cancel-subscription": {
      title: "Cancelar a assinatura (parar a renovação automática)",
      summary: "O cancelamento vale quando o período de cobrança atual termina, e até lá você continua usando o plano de hoje.",
      steps: [
        { title: "Abrir a aba Plano", body: "No menu da conta, toque em “Utilização e plano” para abrir a aba “Plano”." },
        { title: "Agendar o cancelamento", body: "No cartão “Cancelar plano”, toque em “Cancelar ao fim do período”." },
        { title: "Conferir o resultado", body: "Confirme que o botão mudou para “Cancelamento agendado” e que aparece o aviso de que a próxima cobrança não será feita." },
      ],
      faq: [
        { q: "Ao cancelar, viro Free na hora?", a: "Não. O plano atual continua até a data de vencimento exibida e só depois passa a Free." },
        { q: "Os créditos extras que comprei desaparecem?", a: "Não. Eles ficam até o vencimento, mas só podem ser usados nos modelos disponíveis no plano que passar a valer." },
        { q: "Paguei pela loja de aplicativos.", a: "Assinaturas da App Store e do Google Play são canceladas em cada loja." },
      ],
    },
    "request-refund": {
      title: "Pedir reembolso",
      summary: "Peça pela aba Plano ou por e-mail e a equipe de operações analisa cada caso. Arrependimento simples e créditos não usados, em regra, não dão direito a reembolso.",
      steps: [
        { title: "Escrever o motivo", body: "Escreva o motivo no cartão “Solicitação de reembolso”, na aba “Plano”." },
        { title: "Enviar o pedido", body: "Ao tocar em “Solicitar reembolso”, aparecem “Solicitação de reembolso recebida” e a data de recebimento." },
        { title: "Se pedir por e-mail", body: "Se o cartão não aparecer, envie para support@tomverse.app o e-mail da conta, o nome do plano ou do pacote de créditos, a data do pagamento, o número do recibo e o motivo." },
      ],
      faq: [
        { q: "Em que casos há reembolso?", a: "Em casos que pedem correção depois da análise, como cobrança duplicada, não autorizada ou com valor errado, plano ou créditos não entregues e falha grave do serviço. Veja os critérios na página da política de reembolso." },
        { q: "Pedir reembolso também cancela a assinatura?", a: "Só o pedido não cancela. Se for aprovado, a assinatura paga é cancelada e a conta passa a Free." },
        { q: "Quando o dinheiro volta?", a: "Depende do prazo de processamento do seu meio de pagamento." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "Quando a resposta para ou vem vazia",
      summary: "Tente de novo uma vez, escolha outro modelo ou envie sem anexos. Se continuar, veja o status do serviço e reporte o erro.",
      steps: [
        { title: "Ler o aviso", body: "Veja o aviso no cartão da resposta que falhou e “Ver informações de diagnóstico”. O ID de rastreamento aparece junto." },
        { title: "Tentar de novo", body: "Toque em “Tentar novamente” ou escolha “Escolher outro modelo” ou “Reduzir o número de modelos”." },
        { title: "Se o problema for o anexo", body: "Se o problema for o anexo, toque em “Tentar novamente sem arquivos”." },
        { title: "Se for o limite de tamanho", body: "Se aparecer “A resposta parou no limite de comprimento de saída.”, peça de novo para ele continuar de onde parou." },
        { title: "Se ainda não resolver", body: "Veja a página de status do serviço e toque em “Reportar erro”, no mesmo cartão." },
      ],
      faq: [
        { q: "Aparece “Já está a ser gerada uma resposta”.", a: "Espere a resposta em andamento terminar ou parar e tente de novo." },
        { q: "Aparece “Os créditos do plano deste mês foram esgotados”.", a: "Compre créditos adicionais ou faça upgrade do plano para continuar." },
        { q: "Respostas que falham também descontam créditos?", a: "Os créditos reservados para respostas vazias ou que falharam normalmente são devolvidos." },
      ],
    },
    "file-upload-failed": {
      title: "Quando o envio de um arquivo falha",
      summary: "Confira o formato, o tamanho, a senha e se há texto legível, e tente de novo com um arquivo só.",
      steps: [
        { title: "Ver a mensagem de erro", body: "Veja mensagens como “Cada arquivo deve ter 10 MB ou menos.”, “Este documento está protegido por senha.” e “Nenhum texto legível foi encontrado neste arquivo.”." },
        { title: "Corrigir o arquivo", body: "Remova a senha, salve de novo como PDF ou reduza o tamanho." },
        { title: "Tentar um por vez", body: "Anexe só um arquivo e envie de novo. Se tiver pressa, cole o conteúdo principal no campo de mensagem." },
        { title: "Se for erro de imagem", body: "Escolha um modelo que leia imagens ou toque em “Remover modelos incompatíveis”." },
      ],
      faq: [
        { q: "Quantos arquivos e de que tamanho posso enviar?", a: "Logado, até 5 por mensagem, 10 MB por arquivo e 25 MB no total. Sem login, 1 arquivo de até 5 MB. Os limites podem mudar, então vale o que a tela indicar." },
        { q: "Quais formatos são aceitos?", a: "PNG, JPEG, WebP, PDF, texto, Word, Excel, PowerPoint, OpenDocument e arquivos compatíveis do Google Drive. GIFs animados e ZIPs com senha não são aceitos." },
        { q: "Diz que não consegue ler um arquivo que enviei antes.", a: "É o caso de um arquivo que não está mais guardado. Anexe de novo ou toque em “Continuar sem o arquivo”." },
      ],
    },
    "report-a-problem": {
      title: "Reportar erros e enviar feedback",
      summary: "Com “Reportar erro” em uma resposta que falhou, os detalhes do erro e o ID de rastreamento seguem juntos. Opiniões em geral vão por “Feedback”.",
      steps: [
        { title: "Abrir a janela de relato", body: "No cartão da resposta que falhou, toque em “Reportar erro”. Para uma opinião em geral, toque em “Feedback”, na barra lateral." },
        { title: "Escolher o tipo", body: "Escolha “Relatar problema”, “Solicitar recurso”, “Cobrança” ou “Outro” e escreva o conteúdo. O relato de erro pode ser enviado sem descrição." },
        { title: "Conferir o que vai junto", body: "Em “Ver os detalhes do erro que serão anexados”, confira as informações de diagnóstico. Valores que parecem credenciais são ocultados automaticamente." },
        { title: "Enviar", body: "Para receber o andamento, marque “Receber o estado por e-mail” e toque em “Enviar”. O número de recebimento é exibido." },
      ],
      faq: [
        { q: "Preciso informar o ID de rastreamento?", a: "É opcional. O relato é recebido mesmo sem ele." },
        { q: "O envio falhou.", a: "O que você escreveu continua lá, então envie de novo. Não coloque senhas nem números de cartão no relato." },
      ],
    },
    "sign-in-problems": {
      title: "Quando não consigo entrar",
      summary: "Tente de novo com o e-mail e o método de login do primeiro cadastro, no mesmo navegador.",
      steps: [
        { title: "Conferir como você se cadastrou", body: "Confirme que é o e-mail e o método de login usados no cadastro (código por e-mail, Google, Microsoft etc.)." },
        { title: "Pedir o código de novo", body: "Se o código do e-mail expirou, toque em “Enviar um novo código”. Você também pode tocar no link de login que veio no e-mail." },
        { title: "Se houver solicitações demais", body: "Se aparecer “Muitas solicitações”, espere o tempo indicado. Se passou do limite diário, tente de novo no dia seguinte." },
        { title: "No mesmo navegador", body: "Continue no mesmo navegador em que você iniciou o login. Se a verificação de segurança falhar, recarregue a página e tente de novo." },
        { title: "Avisar o suporte", body: "Se continuar sem funcionar, envie ao suporte o método de login e o texto do erro que aparece na tela." },
      ],
      faq: [
        { q: "Aparece “Esse e-mail já está em uso por outro método de login”.", a: "Esse e-mail foi cadastrado por outro método. Entre pelo método do primeiro cadastro." },
        { q: "Diz que o login foi bloqueado.", a: "Se a exclusão da conta estiver agendada, o login fica bloqueado. Para cancelar, fale com o suporte em até 7 dias." },
      ],
    },
    "service-status": {
      title: "Ver o status do serviço",
      summary: "Na página de status, você vê o estado de cada provedor de IA e as evidências que levaram a essa conclusão.",
      steps: [
        { title: "Abrir a página de status", body: "Abra tomverse.app/status. Não precisa estar logado." },
        { title: "Ver o resumo", body: "Confira o resumo do topo e o horário “Dados de” (UTC)." },
        { title: "Ver o estado por provedor", body: "Em “Status dos provedores”, veja se cada um está Operacional, com Desempenho reduzido, com Incidente ou Desconhecido, e quais modelos são afetados." },
      ],
      faq: [
        { q: "“Desconhecido” significa que há uma falha?", a: "Não. Significa que não há evidência para avaliar o estado, e ele também não é presumido como normal." },
        { q: "Se aparecer um aviso, meus créditos acabaram?", a: "Esse aviso, por si só, não significa que solicitações falharam nem que os créditos acabaram." },
      ],
    },
    "contact-support": {
      title: "Falar com o suporte",
      summary: "Use o formulário da página de suporte ou escreva para support@tomverse.app. Normalmente respondemos em 1 a 2 dias úteis.",
      steps: [
        { title: "Abrir a página de suporte", body: "Abra a página de suporte." },
        { title: "Escolher o tipo", body: "Escolha entre “Suporte geral”, “Problema ou bug”, “Cobrança”, “Pedido de recurso” e “Outro”." },
        { title: "Escrever a mensagem", body: "Preencha o endereço de e-mail e a mensagem. Se a tela mostrou um ID de rastreamento, inclua-o." },
        { title: "Enviar", body: "Ao tocar em “Enviar solicitação”, aparece o aviso de que foi recebida. O formulário não aceita capturas de tela, então envie-as à parte para o e-mail de suporte." },
      ],
      faq: [
        { q: "O que é bom enviar junto?", a: "O e-mail da conta, o horário aproximado do problema, o produto e o modelo, o navegador, se havia anexo e o ID de rastreamento da tela. Não envie senhas nem números de cartão." },
        { q: "Há atendimento por telefone?", a: "Não. O atendimento é por e-mail e pelo formulário." },
      ],
    },
  },
};
