import type { HelpLocaleCopy } from "../types";

/**
 * French translation of the Korean source (`ko.ts`). Quoted screen names use
 * the French UI strings from `locales/fr.ts` and the `*Copy.ts` files where
 * they exist; the rest are translated naturally and kept identical across
 * this file.
 */
export const fr: HelpLocaleCopy = {
  ui: {
    metaTitle: "Centre d’aide Tomverse | Posez votre question, obtenez une réponse",
    metaDescription: "Chat, Review, images, recherche, fichiers, assistants, import, connecteurs, outils de code, offres et crédits : des guides pas à pas et un assistant d’aide pour tout résoudre rapidement.",
    eyebrow: "Centre d’aide",
    heroTitleLead: "Comment pouvons-nous",
    heroTitleAccent: "vous aider ?",
    heroSubtitle: "Posez votre question telle quelle. L’assistant cherche dans les articles d’aide Tomverse, vous répond étape par étape et vous indique l’écran à ouvrir.",
    askPlaceholder: "Ex. : comment changer seulement l’arrière-plan d’une image que j’ai créée ?",
    askButton: "Poser la question",
    askMetaLead: "Assistant d’aide · répond à partir des articles d’aide et cite ses sources",
    askMetaPrivacy: "Vos conversations ne sont pas lues · aucun crédit débité",
    askSignIn: "Connectez-vous pour poser une question à l’assistant d’aide. En attendant, la recherche porte sur les guides.",
    askSignInButton: "Se connecter",
    askUnavailable: "Recherche directe dans les titres et le contenu des guides",
    askThinking: "Recherche dans les articles d’aide…",
    askError: "Impossible d’obtenir une réponse pour le moment. Réessayez dans un instant ou consultez les guides ci-dessous.",
    askFollowUp: "Poser une question de suivi…",
    suggestions: [
      "Comparer 3 réponses dans Review",
      "Où voir mes crédits restants ?",
      "Importer mes conversations ChatGPT",
      "Connecter Tomverse à Claude Code",
      "Impossible d’envoyer mon fichier",
      "La réponse s’est arrêtée en cours de route",
    ],
    searchPlaceholder: "Rechercher un guide : crédits, retouche d’image, suppression du compte",
    searchEmpty: "Aucun guide correspondant. Essayez d’autres mots ou contactez le support.",
    commonTasks: "Tâches courantes",
    allGuides: "Tous les guides",
    byFeature: "Aide par fonctionnalité",
    guideCount: "{count} guides",
    stepsAndMinutes: "{steps} étapes · environ {minutes} min",
    newBadge: "NOUVEAU",
    noAnswerTitle: "Si vous ne trouvez pas la réponse",
    contactTitle: "Vous ne trouvez pas votre réponse ?",
    contactBody: "Si l’assistant d’aide et les guides ne suffisent pas, contactez le support. Nous répondons en général sous 1 à 2 jours ouvrés.",
    contactButton: "Contacter le support",
    statusButton: "État du service",
    reportButton: "Signaler une erreur",
    assistantName: "Assistant d’aide",
    foundIn: "✓ Trouvé dans {count} article(s) d’aide",
    notFound: "Aucune réponse trouvée dans les articles d’aide.",
    notFoundBody: "Nous ne répondons pas au hasard. Contactez le support : une personne vérifiera pour vous.",
    sources: "Sources",
    helpful: "Cette réponse vous a-t-elle aidé ?",
    thanks: "Merci pour votre retour",
    disclaimer: "L’assistant d’aide ne lit que les articles d’aide publics. Il ne lit ni ne modifie vos conversations, vos fichiers ou vos informations de paiement. Il peut se tromper : pour une décision importante, vérifiez le guide lié.",
    openGuide: "Voir le guide pas à pas",
    relatedGuides: "Guides associés",
    requirements: "Pour utiliser cette fonctionnalité",
    signInRequired: "Connexion requise",
    signInNotRequired: "Sans connexion",
    planLabel: "Offre",
    allPlans: "Toutes les offres",
    paidPlans: "Offres payantes",
    breadcrumbHome: "Centre d’aide",
    stepLabel: "Étape {n}",
    previous: "Précédent",
    next: "Étape suivante",
    faqTitle: "Questions fréquentes",
    stuckTitle: "Vous êtes bloqué à cette étape ?",
    stuckBody: "L’assistant d’aide répond à partir du guide que vous consultez.",
    stuckPlaceholder: "Ex. : je ne vois pas le bouton",
    tryItTitle: "Essayer maintenant",
    tryItBody: "Ouvrez-le dans un nouvel onglet et gardez ce guide à côté pour suivre les étapes.",
    tryItButton: "Essayer maintenant",
    onThisPage: "Sur cette page",
    stepsSection: "Suivre pas à pas",
    nextGuides: "À lire ensuite",
    backToHelp: "Retour au centre d’aide",
    newQuestion: "Nouvelle question",
    formatsTitle: "Formats pris en charge",
    formatGroups: {
      image: "Images (GIF fixes uniquement)",
      document: "Documents",
      data: "Données",
      markup: "Texte et balisage",
      code: "Code source (lu comme du texte)",
      archive: "Archives (leur contenu doit passer les contrôles)",
    },
    formatsSignedInOnly: "Réservé aux comptes connectés : {list}",
    formatsGuestLimits: "Sans connexion : {files} fichier par message, {mb} Mo au maximum.",
    formatsSignedInLimits: "Connecté : jusqu’à {files} fichiers par message, {mb} Mo chacun et {total} Mo au total.",
  },
  categories: {
    "getting-started": { title: "Premiers pas", description: "De la création du compte à votre première question." },
    chat: { title: "Chat", description: "Discuter avec un modèle, choisir un modèle et l’adaptation intelligente, reformulation automatique des questions, saisie vocale, conversation vocale et position actuelle." },
    review: { title: "Review · AI Review", description: "Lisez les réponses de plusieurs modèles côte à côte et repérez les écarts avec AI Review." },
    images: { title: "Images", description: "Créez des images, retouchez une partie d’une photo et comparez les résultats par modèle." },
    research: { title: "Recherche · Recherche web", description: "Trouvez des informations récentes avec la recherche web et obtenez un rapport avec Deep Research." },
    files: { title: "Fichiers · Fichiers générés", description: "Joindre des fichiers, Google Drive, conversion de fichiers et récupération des fichiers créés par l’IA." },
    assistants: { title: "Assistants · Memory", description: "Vos propres assistants, leurs fichiers de connaissances et la gestion de la mémoire." },
    imports: { title: "Import · Reprise", description: "Importez des conversations d’autres services d’IA et poursuivez-les ici." },
    connectors: { title: "Connecteurs · MCP", description: "Connectez des services externes et des serveurs MCP." },
    coding: { title: "Outils de développement · Clés API", description: "Utilisez Tomverse dans des outils de code comme Claude Code, Codex ou Cursor. Disponible à partir de l’offre Pro." },
    projects: { title: "Projets · Partage", description: "Rangez vos conversations dans des projets, verrouillez-les et partagez-les." },
    billing: { title: "Offre · Crédits · Paiement", description: "Comment les crédits sont utilisés, changer d’offre, résiliation et remboursement." },
    account: { title: "Compte · Confidentialité", description: "Méthodes de connexion, téléchargement des données, suppression du compte." },
    notifications: { title: "Notifications · Mobile", description: "Notifications par e-mail et utilisation sur téléphone." },
    troubleshooting: { title: "Dépannage", description: "Réponse interrompue, échec d’envoi de fichier, signalement d’erreur, état du service, contact." },
  },
  guides: {
    // -------------------------------------------------------- getting started
    "create-account": {
      title: "Créer un compte et se connecter",
      summary: "Créez un compte gratuit avec Google, Microsoft, Apple ou un code à 6 chiffres reçu par e-mail, puis connectez-vous.",
      steps: [
        { title: "Ouvrir l’écran de connexion", body: "Cliquez sur « Connexion / Inscription »." },
        { title: "Choisir une méthode", body: "Cliquez sur « Continuer avec Google », « Continuer avec Microsoft » ou « Continuer avec Apple », ou saisissez votre « Adresse e-mail » et cliquez sur « Recevoir un code de connexion ». Les boutons affichés peuvent varier selon l’environnement." },
        { title: "Saisir le code", body: "Saisissez le code à 6 chiffres reçu par e-mail dans « Entrez le code », puis cliquez sur « Vérifier ». Vous pouvez aussi cliquer sur le lien de connexion contenu dans l’e-mail." },
        { title: "Si c’est votre première fois", body: "Si l’adresse n’est pas encore inscrite, cliquez sur « M'inscrire avec cette adresse »." },
        { title: "Si le code n’arrive pas", body: "Cliquez sur « Envoyer un nouveau code » ou changez d’adresse avec « Utiliser un autre e-mail »." },
      ],
      faq: [
        { q: "Combien de temps le code est-il valable ?", a: "Le code est valable 10 minutes au maximum. Une fois expiré, cliquez sur « Envoyer un nouveau code ». Après plusieurs codes erronés, la saisie est bloquée un court instant." },
        { q: "Puis-je l’utiliser sans me connecter ?", a: "Lorsque c’est proposé, vous pouvez essayer en tant qu’invité. Les conversations invité sont enregistrées uniquement dans ce navigateur, pas sur le serveur (les pièces jointes sont conservées peu de temps puis supprimées automatiquement)." },
      ],
    },
    "tour-workspace": {
      title: "Découvrir l’écran d’accueil",
      summary: "Repérez dans la barre latérale le nouveau chat, la recherche, les outils d’organisation, les projets, le menu des conversations et l’aide.",
      steps: [
        { title: "Nouveau chat", body: "Cliquez sur « Nouveau chat » en haut de la barre latérale pour ouvrir une nouvelle conversation." },
        { title: "Rechercher des conversations", body: "Utilisez « Rechercher des chats » pour trouver un titre. Une fois connecté, la recherche porte aussi sur le contenu des messages enregistrés." },
        { title: "Outils d’organisation", body: "Dépliez « Outils d’organisation » : vous y trouverez les filtres « Verrouillage par mot de passe » et « Lien de partage actif », ainsi que « Projets »." },
        { title: "Menu de la conversation", body: "Dans le menu ⋮ à côté d’une conversation, choisissez « Renommer », « Épingler le chat », « Déplacer vers un projet », « Partager », « Télécharger (.txt) », « Verrouiller le chat » ou « Supprimer »." },
        { title: "Aide", body: "Dans « Aide » de la barre latérale, revoyez la présentation de la barre latérale ou ouvrez l’aide complète." },
      ],
      faq: [
        { q: "Que signifient les badges « Verrouillé » et « Partagé » ?", a: "« Verrouillé » indique une conversation qui demande un mot de passe. « Partagé » indique une conversation dont le lien public en lecture seule est activé." },
        { q: "Une conversation épinglée apparaît-elle sur mes autres appareils ?", a: "Une fois connecté, l’épinglage est enregistré dans votre compte et identique sur tous vos appareils. Sans connexion, il reste dans ce navigateur." },
      ],
    },
    "chat-vs-review": {
      title: "Différence entre Chat et Review",
      summary: "Chat sert à poursuivre une conversation avec un seul modèle ; Review sert à comparer côte à côte les réponses de plusieurs modèles de votre choix.",
      steps: [
        { title: "Choisir le produit", body: "Dans le sélecteur de produit en haut de l’écran, choisissez « Chat » ou « Comparaison de modèles » (Review)." },
        { title: "Chat", body: "Dans Chat, un seul modèle répond à la fois. Si vous choisissez un autre modèle, c’est lui qui répond." },
        { title: "De Chat vers la comparaison", body: "Pour voir une réponse de Chat avec plusieurs modèles, cliquez sur « Comparer dans Review ». Une nouvelle conversation Review s’ouvre avec cette question." },
        { title: "De Review vers Chat", body: "Une fois connecté, sous une analyse Review enregistrée, cliquez sur « Continuer dans Chat » pour poursuivre à partir d’un brouillon dans Chat. Ce n’est pas encore disponible pour les comparaisons invité ni pour les liens de partage." },
      ],
      faq: [
        { q: "Puis-je déplacer une conversation existante vers un autre produit ?", a: "Une conversation s’ouvre dans le produit où elle a été créée. Comparer ou poursuivre crée une nouvelle conversation." },
        { q: "Quelle est la différence entre « Easy » et « Professional » dans Review ?", a: "Lorsqu’ils sont proposés, avec Easy vous ne choisissez que les fournisseurs et Tomverse choisit les modèles pour chaque question ; avec Professional, vous choisissez vous-même les modèles à comparer." },
      ],
    },
    // ------------------------------------------------------------------- chat
    "choose-model-auto": {
      title: "Choisir un modèle et l’adaptation intelligente",
      summary: "Avec l’adaptation intelligente activée, le modèle qui répond est choisi pour chaque message ; désactivée, c’est le modèle que vous avez choisi qui répond.",
      steps: [
        { title: "Vérifier l’adaptation intelligente", body: "Si votre compte la propose, le champ de saisie contient l’interrupteur « Adaptation intelligente », activé au départ dans un Chat vide." },
        { title: "Choisir soi-même", body: "Ouvrez le sélecteur de modèles et cliquez sur un modèle dans l’onglet « Discussion ». L’adaptation intelligente est alors désactivée et le modèle choisi répond." },
        { title: "Voir le modèle qui a répondu", body: "Le badge « Auto · nom du modèle » sous la réponse indique le modèle qui a réellement répondu." },
        { title: "Voir le message tel que compris", body: "Si Auto a reformulé votre message pour le lire, vous pouvez déplier « Comment Auto a lu votre message » sous le badge. Il n’apparaît pas dans une conversation qui contient des pièces jointes." },
      ],
      faq: [
        { q: "Combien de crédits cela coûte-t-il ?", a: "Avec l’adaptation intelligente, les crédits dépendent du modèle qui a répondu. Si vous choisissez vous-même, la référence est le nombre de crédits de base de ce modèle ; un multiplicateur s’ajoute si l’entrée est longue, et 8 crédits sont ajoutés par modèle lorsqu’une recherche web est exécutée." },
        { q: "Mon message est-il enregistré modifié ?", a: "Non. Votre message est enregistré tel que vous l’avez écrit." },
        { q: "Pourra-t-on encore désactiver l’adaptation intelligente ?", a: "Oui. Vous pouvez la désactiver à tout moment en choisissant un modèle vous-même." },
      ],
    },
    "prompt-refiner": {
      title: "Reformulation des questions (adaptation intelligente)",
      summary: "Dans un Chat où l’adaptation intelligente est activée, Tomverse reformule si besoin la question envoyée pour la rendre plus claire avant de la transmettre au modèle qui répond. La conversation conserve votre texte tel que vous l’avez écrit.",
      steps: [
        { title: "Vérifier l’adaptation intelligente", body: "Vérifiez que l’interrupteur « Adaptation intelligente » du champ de saisie est activé. Il l’est dès le départ dans un Chat vide." },
        { title: "Envoyer", body: "Écrivez votre question et cliquez sur « Envoyer ». Il n’y a aucun bouton supplémentaire à utiliser." },
        { title: "Voir le résultat", body: "Le badge « Auto · nom du modèle » sous la réponse indique le modèle qui a répondu. Si la question a été reformulée pour être lue, vous pouvez déplier « Comment Auto a lu votre message »." },
        { title: "Si vous voulez reformuler vous-même", body: "Une fois connecté, dans une conversation enregistrée où vous avez désactivé l’adaptation intelligente et choisi un modèle vous-même, « Clarifier le texte » propose une suggestion, et vous choisissez « Utiliser cette formulation » ou « Garder l’original »." },
      ],
      faq: [
        { q: "Mon message est-il enregistré modifié ?", a: "Non. La formulation clarifiée n’est transmise qu’au modèle qui répond, et la conversation conserve votre texte tel que vous l’avez écrit." },
        { q: "Comment envoyer sans reformulation ?", a: "Désactivez l’adaptation intelligente et choisissez vous-même un modèle." },
        { q: "Mes conversations précédentes ou mes fichiers sont-ils lus aussi ?", a: "Pour comprendre une référence à ce qui précède, comme « corrige le code ci-dessus », une partie de la dernière réponse peut être lue avec votre question. Le contenu des pièces jointes n’est pas lu, et une conversation qui contient des pièces jointes n’est pas reformulée." },
      ],
    },
    "voice-input": {
      title: "Saisir au micro",
      summary: "Parlez dans le micro : votre voix est convertie en texte et placée dans le champ de saisie, que vous pouvez corriger avant d’envoyer.",
      steps: [
        { title: "Démarrer l’enregistrement", body: "Cliquez sur le micro (« Dicter un message ») sous le champ de saisie. Si le navigateur demande l’accès au micro, autorisez-le." },
        { title: "Parler", body: "Pendant que vous parlez, « Enregistrement » et la durée s’affichent au-dessus du champ de saisie." },
        { title: "Convertir en texte", body: "Cliquez de nouveau sur le même bouton : une fois la conversion terminée, la phrase apparaît dans le champ de saisie." },
        { title: "Corriger et envoyer", body: "Corrigez la phrase puis cliquez sur « Envoyer ». Pour abandonner, cliquez sur « Annuler »." },
      ],
      faq: [
        { q: "L’enregistrement est-il conservé ?", a: "Tomverse ne conserve pas les enregistrements. L’audio est envoyé au fournisseur de reconnaissance vocale uniquement pour être converti en texte, et un enregistrement annulé n’est pas envoyé." },
        { q: "Cela consomme-t-il des crédits ?", a: "La saisie vocale ne débite aucun crédit. Une limite d’utilisation quotidienne peut s’appliquer. La « conversation vocale », qui permet d’échanger à l’oral, est facturée à part selon l’utilisation vocale." },
        { q: "L’enregistrement ne fonctionne pas.", a: "Il fonctionne avec les versions récentes de Chrome, Edge, Safari et Firefox. Si le micro est bloqué, autorisez-le pour ce site dans les paramètres du navigateur." },
      ],
    },
    "voice-conversation": {
      title: "Poursuivre la conversation à l’oral (conversation vocale)",
      summary: "Lorsque le champ de saisie est vide, le bouton de conversation vocale vous permet de poursuivre la conversation à l’oral. Vos questions et réponses restent dans ce chat, et l’utilisation vocale est débitée en crédits.",
      steps: [
        { title: "Démarrer la conversation vocale", body: "Quand le champ de saisie est vide, un bouton « Conversation vocale » apparaît à la place du bouton d’envoi. Cliquez dessus, puis sur « Démarrer la conversation vocale » : le navigateur demande l’accès au micro. Autorisez-le." },
        { title: "Parler", body: "Pendant que vous parlez, vos sous-titres et ceux de Tomverse s’affichent séparément. Vous pouvez interrompre à tout moment à l’oral." },
        { title: "Couper le micro", body: "Même après « Couper le micro », le temps de connexion continue d’être compté. Pour faire une pause, mieux vaut terminer la conversation." },
        { title: "Terminer la conversation", body: "Cliquez sur « Terminer la conversation » pour revenir à la même conversation ; vos questions et réponses y restent." },
      ],
      faq: [
        { q: "Combien de crédits cela coûte-t-il ?", a: "Même si vous cessez de parler ou coupez le micro, l’utilisation vocale est débitée en crédits pour toute la durée de connexion. Le modèle qui rédige les réponses et la recherche web sont débités à part. Avant de commencer, le maximum de crédits réservés temporairement est indiqué, et la part non utilisée vous est rendue après le règlement." },
        { q: "En quoi est-ce différent de la saisie vocale ?", a: "La saisie vocale convertit ce que vous dites en texte placé dans le champ de saisie, que vous pouvez corriger avant d’envoyer, sans consommer de crédits. La conversation vocale se fait à l’oral et l’utilisation vocale est débitée à part." },
        { q: "Peut-on l’utiliser sans connexion ?", a: "Non. Il faut être connecté, et une conversation verrouillée doit d’abord être déverrouillée. L’audio est transmis au fournisseur du service de conversation vocale ; Tomverse ne conserve pas les enregistrements." },
      ],
    },
    "use-current-location": {
      title: "Poser des questions sur les environs avec la position actuelle",
      summary: "Si vous activez « Position actuelle » dans « Ajouts et outils », une position approximative est transmise au fournisseur d’IA à chaque message pour répondre à des questions comme les lieux proches. C’est désactivé par défaut.",
      steps: [
        { title: "Activer", body: "Dans le menu « Ajouts et outils » du champ de saisie, activez « Position actuelle ». Si le navigateur ou l’appareil demande l’autorisation d’accès à la position, acceptez." },
        { title: "Vérifier l’état", body: "Tant que c’est activé, « Position activée · actualisée à chaque message » s’affiche. Aucun suivi en arrière-plan." },
        { title: "Poser la question", body: "Demandez par exemple « Trouve-moi un café près d’ici ». Si la question nécessite votre position, l’autorisation peut vous être demandée avant la réponse même si vous n’avez rien activé." },
        { title: "Désactiver", body: "Cliquez sur « Désactiver la position actuelle » ou désactivez-la dans le menu « Ajouts et outils ». Elle se désactive aussi à l’actualisation de la page ou au changement de compte." },
      ],
      faq: [
        { q: "Où ma position est-elle transmise ?", a: "Tant que c’est activé, une position approximative est transmise, à chaque message et avec cette requête, au fournisseur d’IA qui produit la réponse. Aucun historique de position distinct n’est créé." },
        { q: "Des lieux restent-ils dans la réponse ?", a: "La réponse de l’IA peut mentionner des lieux, et les réglages habituels de conservation, d’export et de partage des conversations s’appliquent à cette réponse. Vérifiez avant de partager." },
        { q: "Et si je refuse l’autorisation ?", a: "La conversation continue sans position. Vous pouvez aussi saisir un lieu vous-même ; si vous refusez ou désactivez, l’autorisation n’est pas redemandée automatiquement pendant la session en cours." },
      ],
    },
    "chat-starters": {
      title: "Remplir une question avec un exemple de départ",
      summary: "Choisissez une carte d’exemple dans une nouvelle conversation : la question se place dans le champ de saisie. Rien n’est envoyé avant que vous l’envoyiez.",
      steps: [
        { title: "Choisir une carte", body: "Lorsque c’est proposé, cliquez sur une carte de « Ce que vous pouvez faire ici » dans une nouvelle conversation. Pour en voir plus, cliquez sur « Voir plus de suggestions »." },
        { title: "Modifier", body: "Modifiez à votre guise la phrase placée dans le champ de saisie." },
        { title: "Envoyer", body: "L’envoi n’a lieu que si vous cliquez sur « Envoyer ». Une carte portant un badge comme « Connexion requise » vous mène à la connexion ou à la présentation des offres." },
      ],
      faq: [
        { q: "Mon texte en cours est-il effacé ?", a: "Non. Le champ n’est remplacé que s’il est vide ou s’il contient exactement la phrase placée par la carte précédente." },
        { q: "Cliquer sur une carte consomme-t-il des crédits ?", a: "Cliquer sur la carte seule n’en consomme pas. Mais une carte qui active la recherche web, comme une carte de sources, peut augmenter les crédits au prochain envoi." },
      ],
    },
    // ----------------------------------------------------------------- review
    "compare-answers": {
      title: "Comparer côte à côte les réponses de plusieurs modèles",
      summary: "Dans Review, envoyez la même question à 3 modèles au maximum et lisez les réponses côte à côte.",
      steps: [
        { title: "Choisir les modèles", body: "Dans Review, ouvrez le choix des modèles et sélectionnez-en 3 au maximum. S’il y en a déjà 3, choisissez celui à remplacer." },
        { title: "Envoyer la question", body: "Écrivez votre question puis cliquez sur « Comparer » (« Envoyer » dans l’écran Classic). Les modèles choisis répondent en même temps." },
        { title: "Interroger un seul modèle", body: "Pour poser une question de suivi à un seul modèle, utilisez « Demander uniquement à ce modèle » dans son panneau." },
        { title: "Changer l’affichage", body: "Passez à « Focus » ou « Côte à côte ». Changer l’affichage ne renvoie rien." },
        { title: "Retirer un modèle", body: "Cliquez sur « Retirer de la comparaison ». Vous pouvez revenir en arrière avec « Annuler »." },
      ],
      faq: [
        { q: "Les crédits sont-ils débités pour chaque modèle ?", a: "Oui. Les crédits de réponse sont débités pour chaque modèle choisi." },
        { q: "Puis-je comparer sans être connecté ?", a: "Lorsque c’est proposé, les invités peuvent aussi comparer jusqu’à 3 modèles." },
      ],
    },
    "quick-difference-summary": {
      title: "Parcourir les réponses avec le résumé rapide des différences",
      summary: "Sous les réponses comparées, cliquez sur « Résumé rapide des différences » : l’IA résume brièvement les conclusions communes, les différences importantes, les affirmations clés par modèle et ce qu’il faut vérifier.",
      steps: [
        { title: "Préparer les réponses", body: "Attendez que les réponses de plusieurs modèles à la même question soient terminées." },
        { title: "Lancer le résumé", body: "Dans l’écran de comparaison, cliquez sur « Résumé rapide des différences » (« Différences » sur un écran étroit)." },
        { title: "Exécuter", body: "Lisez l’avis « L’IA comparera N réponses complètes à la dernière question » et l’utilisation estimée, puis cliquez sur « Analyser · N crédits »." },
        { title: "Lire", body: "Lisez dans l’ordre « Conclusions communes », « Différences importantes », « Affirmations clés par modèle » et « Vérification supplémentaire requise »." },
      ],
      faq: [
        { q: "Combien de crédits cela coûte-t-il ?", a: "Environ 1 crédit pour une comparaison courte type ; les réponses longues peuvent en consommer davantage. Si l’analyse échoue, les crédits réservés sont remboursés." },
        { q: "Donne-t-il la bonne réponse ?", a: "Non. Il compare uniquement les réponses reçues, sans recherche web ni vérification externe des faits. Les citations par point et la vérification web se font dans AI Review." },
        { q: "Les invités peuvent-ils l’utiliser ?", a: "Les invités ne peuvent l’utiliser qu’une fois par jour. Une fois connecté, l’usage est illimité et l’analyse est enregistrée dans la conversation enregistrée." },
      ],
    },
    "read-ai-review": {
      title: "Lancer et lire AI Review",
      summary: "Quand au moins 2 réponses sont terminées, un modèle d’analyse distinct (en général deux analystes de fournisseurs différents) résume les points communs, les écarts, les contradictions, les oublis et les points à vérifier.",
      steps: [
        { title: "Préparer les réponses", body: "Vérifiez qu’au moins 2 réponses à la même question sont terminées." },
        { title: "Lancer", body: "Cliquez sur « Contre-analyse des réponses par IA » (« Analyse des réponses Tomverse » dans Studio sur ordinateur)." },
        { title: "Choisir le critère", body: "Si l’écran permet de choisir un critère, sélectionnez « Équilibré », « Preuves » ou « Action », puis cliquez sur « Lancer la contre-analyse »." },
        { title: "Lire le résultat", body: "Lisez dans l’ordre : ce qui est commun, les différences importantes, les contradictions, ce qui manque et ce qui reste à vérifier." },
        { title: "Donner votre avis", body: "Pour chaque point, vous pouvez cliquer sur « Utile », « Incorrect », « Peu clair » ou « Un point important manque »." },
      ],
      faq: [
        { q: "AI Review donne-t-il la bonne réponse ?", a: "Non. Il compare uniquement les réponses reçues, sans recherche web ni vérification externe des faits." },
        { q: "Et mes crédits en cas d’échec ?", a: "Si l’analyse ne peut pas aboutir, les crédits réservés vous sont rendus. Une exécution coûte en général environ 8 crédits ; si votre solde est insuffisant, les crédits nécessaires sont indiqués avant le lancement." },
        { q: "Y a-t-il une limite d’utilisation ?", a: "Les invités peuvent l’essayer une fois par mois, et le nombre d’essais restants s’affiche. L’offre Free dispose d’un nombre d’exécutions mensuel défini, et la limite mensuelle s’affiche à l’écran de lancement." },
      ],
    },
    "follow-citations": {
      title: "Suivre les citations d’un point d’analyse",
      summary: "Ouvrez la citation du texte original jointe à chaque point pour voir de quelle partie de la réponse il s’agit.",
      steps: [
        { title: "Choisir un point", body: "Choisissez un point dans « Constats de la revue ». Au-dessus de la citation, la réponse concernée (A/B/C) est indiquée." },
        { title: "Voir l’indicateur de vérification", body: "Un indicateur précise si la citation a été retrouvée dans le texte original ou si elle n’a pas pu être vérifiée et demande plus de prudence." },
        { title: "Aller au texte original", body: "Cliquez sur « Voir dans la réponse originale » sous la citation pour accéder à ce passage dans la réponse." },
        { title: "Vérifier sur le web (facultatif)", body: "Si besoin, cliquez sur « Vérifier avec la recherche web » pour ce seul point. La vérification s’exécute séparément, consomme des crédits et ne modifie pas l’analyse d’origine." },
      ],
      faq: [
        { q: "Si « Cette citation a été retrouvée dans la réponse source » s’affiche, est-ce vrai ?", a: "Non. Cela signifie seulement que cette formulation figure dans la réponse, pas que son contenu est exact. Pour vérifier les faits, utilisez « Vérifier avec la recherche web » sur ce point." },
        { q: "Le taux de correspondance des sources mesure-t-il l’exactitude ?", a: "Non. Il indique seulement dans quelle mesure la citation correspond au texte original." },
      ],
    },
    "save-share-review": {
      title: "Enregistrer, partager et exporter comparaisons et analyses",
      summary: "Une fois connecté, vos conversations et analyses sont enregistrées. Vous pouvez partager une analyse par un lien en lecture seule ou l’exporter dans un fichier.",
      steps: [
        { title: "Se connecter et comparer", body: "Si vous comparez en étant connecté, la conversation et l’analyse sont enregistrées dans votre compte. Une analyse invité disparaît si vous actualisez la page." },
        { title: "Partager l’analyse", body: "Sous le résultat, cliquez sur « Partager l’analyse », vérifiez ce qui sera rendu public, puis cliquez sur « Publier le lien »." },
        { title: "Envoyer ou arrêter le lien", body: "Envoyez-le avec « Copier le lien ». Pour l’arrêter, cliquez sur « Révoquer le lien »." },
        { title: "Obtenir un fichier", body: "Cliquez sur « Exporter » et choisissez le format de fichier (PDF, Word, TXT, Markdown)." },
      ],
      faq: [
        { q: "Et le lien de partage existant de la conversation si je partage l’analyse ?", a: "Le lien de partage existant de cette conversation est remplacé par le nouveau lien." },
        { q: "Que contient le fichier exporté ?", a: "Il contient l’analyse complète, la question, les sources des modèles et la correspondance des citations. Les réponses complètes des modèles et les pièces jointes n’y figurent pas." },
      ],
    },
    // ----------------------------------------------------------------- images
    "create-image": {
      title: "Créer une image dans le chat",
      summary: "Décrivez la scène dans le chat : si votre demande est comprise comme une demande d’image, la réponse arrive sous forme d’image dans la même conversation.",
      steps: [
        { title: "Écrire la demande", body: "Dans le champ de saisie de Chat, décrivez la scène voulue, par exemple « Crée une image : … »." },
        { title: "Envoyer", body: "Envoyez le message. Aucune confirmation n’est demandée et « Création de l'image… » s’affiche à la place de la réponse." },
        { title: "Voir le résultat", body: "Une fois l’image prête, un badge « Qualité brouillon », « Qualité standard » ou « Haute qualité » s’affiche (« Final » dans l’écran d’image correspond à la haute qualité). Si vous voulez une meilleure qualité, envoyez « Régénère cette image en haute qualité. »." },
        { title: "Retoucher à la suite", body: "Si vous envoyez par exemple « Rends-la plus bleue », l’image est redessinée à partir de la précédente." },
      ],
      faq: [
        { q: "Quand les crédits sont-ils utilisés ?", a: "Quand Chat répond par une image, les crédits d’image sont utilisés tout de suite, sans confirmation. Ils le sont aussi lorsque vous régénérez en haute qualité." },
        { q: "Et si la demande n’est pas comprise comme une image ?", a: "Vous recevez une réponse texte ordinaire." },
        { q: "L’image est-elle incluse si je partage ou exporte la conversation ?", a: "Non. Seule la phrase indiquant qu’une image a été créée y figure." },
      ],
    },
    "compare-image-models": {
      title: "Comparer les résultats de plusieurs modèles d’image",
      summary: "Dans l’écran d’image, envoyez une même description à plusieurs modèles en même temps et comparez les résultats côte à côte.",
      steps: [
        { title: "Ouvrir l’écran d’image", body: "Dans la barre latérale, cliquez sur l’icône d’image à droite du bouton « Nouveau chat » (le « + » quand la barre latérale est repliée), puis choisissez « Nouvelle image ». Vous pouvez aussi choisir un modèle dans l’onglet « Image » du sélecteur de modèles." },
        { title: "Choisir les modèles", body: "Avec la pastille de modèle au-dessus du champ de saisie, choisissez les modèles à comparer. Le nombre de modèles sélectionnables à la fois est indiqué." },
        { title: "Qualité et taille", body: "Choisissez la « Qualité » (Draft, Standard, Final) et la « Taille » (carrée, paysage, portrait). Selon le modèle, seules certaines tailles sont disponibles." },
        { title: "Décrire et générer", body: "Décrivez l’image voulue, vérifiez les crédits indiqués sur la pastille de modèle (« Total N crédits » si vous en choisissez plusieurs), puis cliquez sur « Générer »." },
        { title: "Récupérer le résultat", body: "Cliquez sur « Voir l’original » ou « Télécharger ». Pour un modèle en échec, vous pouvez cliquer sur « Réessayer ce modèle » sans relancer les autres." },
      ],
      faq: [
        { q: "Quitter la page annule-t-il la génération ?", a: "Non. Cela peut prendre environ 2 minutes et la génération continue même si vous quittez la page." },
        { q: "Le lien « Voir l’original » ne s’ouvre pas.", a: "Le lien vers l’original n’est valable que quelques minutes. Cliquez de nouveau un peu plus tard : un nouveau lien est créé." },
      ],
    },
    "edit-photo": {
      title: "Retoucher une photo jointe",
      summary: "Joignez une photo au chat et décrivez ce qu’il faut changer : si votre demande est comprise comme une retouche, la réponse est l’image retouchée.",
      steps: [
        { title: "Joindre la photo", body: "Dans « Ajouts et outils » du champ de saisie, joignez la photo (hors GIF animé) avec « Ajouter un fichier »." },
        { title: "Décrire le changement", body: "Écrivez ce que vous voulez changer, par exemple « Remplace l’arrière-plan par une plage au coucher du soleil »." },
        { title: "Envoyer", body: "S’il s’agit d’une demande de retouche, vous recevez l’image retouchée ; sinon, une réponse ordinaire qui tient compte de la photo." },
      ],
      faq: [
        { q: "La photo d’origine est-elle modifiée ?", a: "Non. La photo que vous avez envoyée reste telle quelle et une nouvelle image est créée." },
        { q: "Et si je joins plusieurs photos ?", a: "La première des photos jointes est celle qui est retouchée." },
        { q: "Combien de crédits cela coûte-t-il ?", a: "Les crédits sont débités tout de suite, sans confirmation. Des crédits de retouche propres à chaque modèle peuvent s’ajouter au prix de l’image à la taille correspondant à l’orientation de la photo." },
      ],
    },
    "image-credits": {
      title: "Crédits d’image et remboursement",
      summary: "Les images consomment un nombre de crédits fixé selon le modèle, la qualité et la taille ; si la génération échoue, tous les crédits réservés vous sont rendus.",
      steps: [
        { title: "Voir le prix", body: "Dans l’écran d’image, vérifiez le prix par modèle et le total en crédits." },
        { title: "Générer", body: "Quand vous cliquez sur « Générer », les crédits sont d’abord réservés." },
        { title: "Règlement", body: "En cas de réussite, les crédits affichés sont utilisés ; en cas d’échec, les crédits réservés vous sont rendus." },
      ],
      faq: [
        { q: "Avec quelles offres est-ce possible ?", a: "Une fois connecté, Free, Pro et Max peuvent l’utiliser dans la limite des crédits disponibles." },
        { q: "Et si Chat répond par une image ou retouche une photo ?", a: "Les crédits sont débités tout de suite, sans confirmation de prix. En cas d’échec, ils sont rendus selon la même règle." },
        { q: "Quand les crédits sont-ils rendus ?", a: "Lorsque l’image n’a pas pu être créée à cause d’un refus du fournisseur, d’un blocage de sécurité, d’une erreur ou d’un dépassement de délai." },
        { q: "« Les crédits du plan d'aujourd'hui sont épuisés » s’affiche.", a: "Les images utilisent aussi les crédits quotidiens de l’offre. Si vous avez des crédits achetés, vous pouvez continuer avec eux." },
      ],
    },
    // --------------------------------------------------------------- research
    "deep-research": {
      title: "Lancer Deep Research",
      summary: "Posez votre question et lancez « Deep Research » : un rapport est produit à partir de plusieurs sources web en quelques minutes.",
      steps: [
        { title: "Écrire la question", body: "Écrivez d’abord dans le champ de saisie la question à étudier." },
        { title: "Ouvrir Deep Research", body: "Dans le menu « Ajouts et outils » du champ de saisie, cliquez sur « Deep Research »." },
        { title: "Choisir l’ampleur", body: "Choisissez l’ampleur entre « Rapide », « Standard » et « Approfondi », puis vérifiez la durée estimée et l’utilisation estimée." },
        { title: "Démarrer", body: "Cliquez sur « Lancer la recherche ». La progression s’affiche : collecte des sources, puis rédaction du rapport." },
        { title: "Démarrer depuis la carte de suggestion", body: "Si la carte « Approfondir avec Deep Research » apparaît sous une réponse ordinaire, vous pouvez aussi cliquer dessus pour démarrer directement à l’ampleur Standard." },
      ],
      faq: [
        { q: "Avec quelles offres est-ce possible ?", a: "Disponible pour Pro et Max, une fois connecté." },
        { q: "Supprimer l’indicateur de progression annule-t-il la recherche ?", a: "Non. La recherche continue en arrière-plan." },
        { q: "Cliquer sur la carte de suggestion consomme-t-il tout de suite des crédits ?", a: "Oui. Elle démarre directement à l’ampleur Standard, sans demander l’ampleur." },
      ],
    },
    "web-search": {
      title: "Activer la recherche web et vérifier les sources",
      summary: "Avec la recherche web activée, une recherche est lancée automatiquement quand des informations récentes ou des sources sont nécessaires, et les liens des sources s’affichent sous la réponse.",
      steps: [
        { title: "Activer la recherche web", body: "Dans le menu « Ajouts et outils » du champ de saisie, activez l’interrupteur « Recherche web »." },
        { title: "Voir l’état", body: "Si vous avez choisi vous-même les modèles, cliquez sur la pastille « Recherche web activée » du champ de saisie pour voir combien de modèles choisis prennent en charge la recherche." },
        { title: "Ouvrir une source", body: "Cliquez sur un lien de la liste « Sources » sous la réponse : il s’ouvre dans un nouvel onglet." },
        { title: "Suggestion de nouvelle recherche", body: "Si vous posez, recherche désactivée, une question qui demande des informations récentes, la carte « Vérifier sur le web » apparaît. Cliquez dessus pour renvoyer la même question avec recherche." },
      ],
      faq: [
        { q: "Des crédits supplémentaires sont-ils consommés ?", a: "8 crédits s’ajoutent pour chaque modèle qui effectue une recherche web (quel que soit le nombre de recherches). Les modèles qui n’ont pas cherché récupèrent leurs 8 crédits, et les modèles Perplexity n’ont aucun crédit supplémentaire." },
        { q: "« Les modèles qui répondent ne peuvent pas chercher sur le web » s’affiche.", a: "Aucun des modèles choisis ne prend en charge la recherche. Ajoutez un modèle qui la prend en charge." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Joindre des fichiers : formats et tailles pris en charge",
      summary: "Vous pouvez joindre plusieurs fichiers par message : documents, tableaux et données, code, images et ZIP. Tous les formats acceptés figurent dans la liste ci-dessous.",
      steps: [
        { title: "Ajouter un fichier", body: "Dans « Ajouts et outils » du champ de saisie, cliquez sur « Ajouter un fichier » → « Choisir depuis votre ordinateur », ou glissez le fichier dans le champ de saisie." },
        { title: "Attendre la vérification", body: "Attendez la fin des indications « Envoi en cours » et « Vérification »." },
        { title: "Envoyer", body: "Envoyez le message." },
      ],
      faq: [
        { q: "Combien de fichiers, et de quelle taille ?", a: "Les limites de nombre et de taille, avec ou sans connexion, et tous les formats acceptés figurent dans la liste des formats ci-dessous." },
        { q: "Quels fichiers ne sont pas acceptés ?", a: "Les programmes et fichiers d’installation, les archives autres que ZIP (RAR, 7Z, etc.), l’audio et la vidéo, certaines images comme HEIC, TIFF ou BMP, les GIF animés, Keynote et PSD, ainsi que les documents et ZIP protégés par mot de passe ne sont pas acceptés." },
        { q: "Jusqu’à quand les fichiers joints sont-ils conservés ?", a: "Lorsque vous êtes connecté, les pièces jointes sont conservées avec la conversation et supprimées avec elle ou avec le compte. Les fichiers d’un invité sont conservés peu de temps puis supprimés automatiquement." },
      ],
    },
    "google-drive": {
      title: "Joindre des fichiers depuis Google Drive",
      summary: "Choisissez dans Drive des documents, feuilles de calcul ou présentations Google et joignez-les à la conversation.",
      steps: [
        { title: "Ouvrir Drive", body: "Dans « Ajouts et outils » du champ de saisie, cliquez sur « Ajouter un fichier » → « Joindre depuis Google Drive »." },
        { title: "Autoriser l’accès", body: "Si la fenêtre d’autorisation Google s’affiche, acceptez. Cette autorisation ne donne accès qu’aux fichiers que vous choisissez." },
        { title: "Choisir les fichiers", body: "Choisissez les fichiers dans la fenêtre de sélection Google. Vous pouvez en choisir plusieurs, mais pas de dossier." },
        { title: "Envoyer", body: "Une fois la pastille de pièce jointe affichée, envoyez le message." },
      ],
      faq: [
        { q: "Faut-il être connecté ?", a: "Oui. Google Drive n’est utilisable qu’une fois connecté." },
        { q: "Quels fichiers s’affichent ?", a: "Les documents, feuilles de calcul et présentations Google : ils sont convertis respectivement en texte, xlsx et pptx avant d’être joints." },
      ],
    },
    "convert-files": {
      title: "Convertir des fichiers joints",
      summary: "Groupez des photos en PDF, fusionnez ou divisez des PDF, changez le format d’un fichier de tableau : joignez le fichier et demandez-le simplement par écrit.",
      steps: [
        { title: "Joindre le fichier", body: "Dans « Ajouts et outils » du champ de saisie, joignez à ce message, avec « Ajouter un fichier », le fichier à convertir. Seuls les fichiers joints à ce message sont convertis." },
        { title: "Dire la conversion voulue", body: "Écrivez par exemple « Réunis ces deux photos dans un seul PDF », « Divise ce PDF en parties de 3 pages » ou « Convertis cet Excel en CSV ». Vous pouvez grouper photos et PDF en un seul PDF, fusionner, diviser, réorganiser ou pivoter des pages de PDF, convertir un PDF en images, changer le format ou la taille d’images, et convertir des tableaux Excel ou CSV." },
        { title: "Envoyer", body: "Envoyez le message. Pendant la création, « Création du … » s’affiche." },
        { title: "Télécharger", body: "Dans la carte « Fichier généré » sous la réponse, cliquez sur « Télécharger ». S’il y a plusieurs résultats, ils sont regroupés dans un seul ZIP." },
      ],
      faq: [
        { q: "Les fichiers envoyés précédemment sont-ils convertis aussi ?", a: "Non. La conversion porte sur les fichiers joints au message que vous envoyez maintenant. Pour transformer un fichier antérieur, joignez-le de nouveau." },
        { q: "Faut-il être connecté ? Tous les modèles conviennent-ils ?", a: "Il faut être connecté, et le modèle qui répond doit pouvoir créer des fichiers. Si le modèle que vous avez choisi ne le peut pas, un message l’indique : demandez de nouveau avec l’adaptation intelligente ou un autre modèle." },
        { q: "Peut-on convertir un document Word en PDF ?", a: "Réécrire le contenu d’un document dans un autre format n’est pas une conversion mais une nouvelle création : la mise en page d’origine n’est pas copiée telle quelle, elle est recréée." },
      ],
    },
    "generated-files": {
      title: "Récupérer un fichier créé par l’IA",
      summary: "Si vous demandez par exemple « Crée-moi un fichier Excel », une carte « Fichier généré » apparaît sous la réponse et vous pouvez le télécharger depuis celle-ci.",
      steps: [
        { title: "Indiquer le format", body: "Demandez un fichier dans la conversation en précisant le format voulu (Excel, Word, PDF, PowerPoint, CSV, etc.)." },
        { title: "Patienter", body: "Pendant la création, « Création du fichier… » s’affiche." },
        { title: "Télécharger", body: "Dans la carte « Fichier généré » sous la réponse, cliquez sur « Télécharger ». En cas d’échec, cliquez sur « Recréer le fichier »." },
        { title: "Demander une correction", body: "Cliquez sur « Créer une révision » : un brouillon avec le fichier joint est placé dans le champ de saisie. Vous devez l’envoyer vous-même, et une nouvelle version est créée." },
      ],
      faq: [
        { q: "Faut-il être connecté ?", a: "Oui. Une fois connecté, c’est utilisable quelle que soit l’offre. Si le modèle que vous avez choisi ne peut pas créer de fichiers, un message l’indique : demandez de nouveau avec l’adaptation intelligente ou un autre modèle." },
        { q: "Peut-on aussi convertir un fichier que j’ai déjà joint dans un autre format ?", a: "Oui. Pour grouper des photos en PDF, fusionner et diviser des PDF ou changer le format d’un tableau, consultez le guide « Convertir des fichiers joints »." },
        { q: "« Déverrouillez cette conversation pour télécharger le fichier. » s’affiche.", a: "Les fichiers d’une conversation verrouillée ne se téléchargent qu’après déverrouillage." },
        { q: "Demander une correction écrase-t-il le fichier d’origine ?", a: "Non. Une nouvelle version est créée et vous pouvez voir les versions précédentes dans la liste « Versions du fichier »." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Créer votre assistant et y ajouter des fichiers de connaissances",
      summary: "Réunissez nom, instructions, modèle et fichiers de connaissances dans un assistant que vous seul utilisez, puis choisissez-le dans une conversation.",
      steps: [
        { title: "Commencer la création", body: "Cliquez sur « Nouveau assistant » dans l’onglet « Assistants IA » des « Paramètres ». Vous pouvez aussi commencer depuis « Assistant » dans le menu des outils de la conversation." },
        { title: "Nom et instructions", body: "Renseignez « Nom » et « Instructions personnalisées », puis cliquez sur « Créer l'assistant »." },
        { title: "Ajouter des fichiers de connaissances", body: "Dans « Fichiers de connaissances utilisables par cette révision », cliquez sur « Ajouter un fichier » et attendez que l’état passe à « prêt »." },
        { title: "Enregistrer", body: "Cliquez sur « Enregistrer les instructions, les modèles et les fichiers ». Une nouvelle révision est créée à chaque enregistrement." },
        { title: "Utiliser dans une conversation", body: "Cliquez sur « Discuter avec cet assistant » ou choisissez-le dans « Assistant » du menu des outils de la conversation." },
      ],
      faq: [
        { q: "Quels fichiers peut-on ajouter comme connaissances ?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods et odp. Les images ne sont pas acceptées." },
        { q: "Modifier les instructions s’applique-t-il aux conversations en cours ?", a: "Non. Dans la conversation, cliquez sur « Utiliser la révision la plus récente ici » pour que le changement s’applique." },
        { q: "D’autres personnes peuvent-elles voir mon assistant ?", a: "Non. L’assistant n’est utilisable que depuis votre compte et n’est pas partagé." },
      ],
    },
    "manage-memory": {
      title: "Voir, désactiver et effacer la mémoire (Memory)",
      summary: "Vous pouvez voir et modifier les souvenirs enregistrés, désactiver la mémoire pour tout le compte ou par conversation, et les effacer un par un ou tous.",
      steps: [
        { title: "Ouvrir la gestion de la mémoire", body: "Dans l’onglet « Personnalisation de l'IA » des « Paramètres », cliquez sur « Gérer la mémoire » sur la ligne « Mémoire à long terme du compte »." },
        { title: "Voir et modifier", body: "Dans « Souvenirs en usage », cliquez sur « Modifier », « Épingler » ou « Supprimer ». Pour supprimer, un second clic est nécessaire." },
        { title: "Tout désactiver", body: "Dans « Réglages d'utilisation de la mémoire », désactivez « Utiliser la mémoire dans toutes les discussions ». Les souvenirs enregistrés ne sont pas effacés." },
        { title: "Désactiver par conversation", body: "Dans « Mémoire du compte » de « Ajouts et outils » du champ de saisie, choisissez « Ne pas utiliser dans cette conversation »." },
        { title: "Tout effacer", body: "Si besoin, sauvegardez d’abord avec « Tout télécharger (JSON) », puis effacez avec « Supprimer tous les souvenirs » en saisissant la phrase de confirmation. C’est irréversible." },
      ],
      faq: [
        { q: "D’où viennent les souvenirs ?", a: "Ils proviennent des conversations importées d’autres services d’IA, une fois organisées, et de ceux que vous ajoutez avec « Ajouter un souvenir vous-même »." },
        { q: "La mémoire est-elle transmise au fournisseur d’IA ?", a: "Pour une réponse qui utilise la mémoire, elle est transmise comme référence au fournisseur d’IA qui produit la réponse." },
        { q: "Effacer tous les souvenirs supprime-t-il aussi les conversations importées ?", a: "Non. Les conversations importées se suppriment séparément dans la gestion des imports." },
      ],
    },
    // --------------------------------------------------------------- projects
    "organise-projects": {
      title: "Ranger vos conversations dans des projets",
      summary: "Regroupez des conversations liées comme dans un dossier. Les conversations d’un même projet ne partagent ni leur contenu ni leurs fichiers.",
      steps: [
        { title: "Créer un projet", body: "Dans la barre latérale, cliquez sur « Nouveau » à côté de « Projets » (la première fois : « Créer le premier projet ») et saisissez un nom." },
        { title: "Déplacer une conversation", body: "Dans le menu ⋮ de la conversation, choisissez le projet avec « Déplacer vers un projet »." },
        { title: "Retirer et renommer", body: "Retirez-la avec « Retirer du projet » et renommez le projet avec le bouton en forme de crayon." },
        { title: "Supprimer un projet", body: "Cliquez sur « Supprimer le projet » et confirmez une seconde fois. Les conversations passent simplement dans « Non classé » ; elles ne sont pas supprimées." },
      ],
      faq: [
        { q: "Peut-on ajouter des instructions ou des fichiers communs à un projet ?", a: "Non. Un projet est un dossier de rangement. Pour des instructions et des fichiers communs, utilisez un assistant." },
        { q: "Combien de projets peut-on créer ?", a: "Jusqu’à 24 par compte." },
      ],
    },
    "lock-conversation": {
      title: "Verrouiller une conversation (mot de passe)",
      summary: "Si vous protégez une conversation par un mot de passe, il est vérifié avant de l’ouvrir, de la partager, de la télécharger, de la modifier ou de la supprimer.",
      steps: [
        { title: "Lancer le verrouillage", body: "Dans le menu ⋮ de la conversation, cliquez sur « Verrouiller le chat »." },
        { title: "Choisir le mot de passe", body: "Saisissez un mot de passe de 8 à 128 caractères." },
        { title: "Ouvrir une conversation verrouillée", body: "À l’ouverture d’une conversation verrouillée, le mot de passe est demandé. Une fois vérifié, il n’est plus redemandé pendant un moment." },
        { title: "Déverrouiller", body: "Cliquez sur « Déverrouiller » dans le menu et saisissez le mot de passe." },
      ],
      faq: [
        { q: "Et si j’oublie le mot de passe ?", a: "Tomverse ne peut ni afficher ni réinitialiser le mot de passe : si vous l’oubliez, vous ne pourrez plus rouvrir cette conversation." },
        { q: "Le verrouillage chiffre-t-il la conversation ?", a: "Non. C’est seulement un verrou qui empêche la consultation ; le contenu est transmis au fournisseur d’IA pour produire une réponse." },
      ],
    },
    "share-link": {
      title: "Créer et arrêter un lien de partage",
      summary: "La conversation actuelle devient une page publique en lecture seule. Toute personne ayant le lien peut la voir sans se connecter.",
      steps: [
        { title: "Ouvrir le partage", body: "Dans le menu ⋮ de la conversation, cliquez sur « Partager ». Pour une conversation verrouillée, déverrouillez-la d’abord." },
        { title: "Créer le lien", body: "Lisez les informations puis cliquez sur « Créer le lien » : le lien est copié." },
        { title: "Mettre à jour le contenu", body: "Les messages envoyés après le partage n’y sont pas ajoutés automatiquement. Pour les inclure, cliquez sur « Régénérer le lien de partage »." },
        { title: "Arrêter le partage", body: "Cliquez sur « Arrêter le partage » : l’ancien lien ne fonctionne plus aussitôt." },
      ],
      faq: [
        { q: "Jusqu’à quand le lien est-il valable ?", a: "Il expire 30 jours après sa création, et la date d’expiration est indiquée sur la page de partage." },
        { q: "Certaines conversations ne peuvent-elles pas être partagées ?", a: "Les conversations poursuivies à partir d’une conversation importée et celles de l’écran d’image ne peuvent pas être partagées. La page de partage n’inclut ni les fichiers générés ni les images." },
        { q: "Ma mémoire (Memory) est-elle partagée aussi ?", a: "Non. Le contenu de la mémoire n’est pas partagé. Supprimez le contenu sensible avant de partager." },
      ],
    },
    // ---------------------------------------------------------------- imports
    "import-chatgpt": {
      title: "Importer vos conversations ChatGPT",
      summary: "Chargez le fichier d’export de vos données ChatGPT pour enregistrer vos anciennes conversations dans votre compte Tomverse. Le fichier d’origine n’est lu que dans votre navigateur.",
      steps: [
        { title: "Exporter depuis ChatGPT", body: "Dans ChatGPT, ouvrez Paramètres → Contrôle des données (Data controls), demandez l’export des données, puis téléchargez le fichier ZIP depuis le lien reçu par e-mail. Inutile de le décompresser." },
        { title: "Ouvrir l’écran d’import", body: "Dans l’onglet « Données » des « Paramètres » de Tomverse, cliquez sur « Gérer les imports » sur la ligne « Importer depuis un autre service d'IA », puis sur « Démarrer un nouvel import ». Vous pouvez aussi y accéder par la carte « Reprendre une discussion avec une autre IA » de l’écran d’accueil d’un nouveau Chat." },
        { title: "Choisir le service et le fichier", body: "Dans « Où se trouve votre conversation ? », choisissez « ChatGPT », puis sélectionnez le fichier .zip ou .json avec « Choisir le fichier d'export »." },
        { title: "Choisir les conversations", body: "Affinez par recherche de titre ou par date, puis cliquez sur « Sélectionner toutes les conversations normales » ou choisissez conversation par conversation, et cliquez sur « Vérifier les discussions sélectionnées (N) »." },
        { title: "Importer", body: "Dans « Vérifier avant d’importer », cliquez sur « Importer N conversations ». Ne fermez pas l’écran avant la fin de l’enregistrement." },
      ],
      faq: [
        { q: "Les images et les pièces jointes sont-elles importées ?", a: "Non. Les images, l’audio et les pièces jointes ne sont pas importés ; seul le texte est enregistré." },
        { q: "Le fichier d’export est-il envoyé au serveur ?", a: "Le fichier d’origine ne quitte pas votre appareil. Seul le texte des conversations choisies est enregistré dans votre compte." },
        { q: "Si je charge de nouveau le même fichier, y a-t-il des doublons ?", a: "Les conversations déjà présentes dans le compte sont écartées comme doublons." },
      ],
    },
    "import-claude": {
      title: "Importer vos conversations Claude",
      summary: "Chargez le fichier d’export de vos données Claude (ZIP ou JSON) pour enregistrer vos conversations dans votre compte.",
      steps: [
        { title: "Exporter depuis Claude", body: "Dans Claude, ouvrez Paramètres → Confidentialité, demandez l’export des données, puis téléchargez le fichier depuis le lien de l’e-mail. Le ZIP comme le JSON s’utilisent tels quels." },
        { title: "Ouvrir l’écran d’import", body: "Cliquez sur « Paramètres » → « Données » → « Importer depuis un autre service d'IA » → « Gérer les imports » → « Démarrer un nouvel import »." },
        { title: "Choisir Claude", body: "Dans « Où se trouve votre conversation ? », choisissez « Claude », puis sélectionnez le fichier avec « Choisir le fichier d'export »." },
        { title: "Choisir les conversations et importer", body: "Choisissez les conversations à importer, cliquez sur « Vérifier les discussions sélectionnées (N) », puis sur « Importer N conversations »." },
      ],
      faq: [
        { q: "Je me suis trompé de service.", a: "Ce n’est pas grave. Après l’ouverture du fichier, son format réel est détecté automatiquement et l’import se poursuit sur cette base." },
        { q: "Que deviennent les messages très longs ?", a: "Si un message dépasse la limite de stockage, il est enregistré raccourci (début et fin conservés) avec votre accord. Une conversation contenant un message trop long est signalée comme impossible à importer." },
        { q: "Combien puis-je importer ?", a: "Chaque compte a une limite de volume de texte et de nombre de conversations importables. Si votre sélection dépasse l’espace restant, réduisez-la avec « Ajuster la sélection »." },
      ],
    },
    "continue-imported": {
      title: "Poursuivre une conversation importée dans Tomverse",
      summary: "Démarrez une nouvelle conversation Tomverse à partir d’une conversation importée. L’original reste en lecture seule.",
      steps: [
        { title: "Commencer la reprise", body: "Sur l’écran de fin d’import, cliquez sur « Poursuivre cette conversation », ou sur « Poursuivre » dans la liste de « Gérer les imports ». Le bouton « Poursuivre dans Tomverse » en bas de l’original fonctionne aussi." },
        { title: "Lire les informations", body: "Vérifiez qu’une nouvelle conversation est créée et que l’original reste intact, qu’il n’y a pas de pièces jointes et que seule une partie récente sert de contexte, et que chaque réponse consomme des crédits." },
        { title: "Créer la conversation", body: "Cliquez sur « Créer la conversation »." },
        { title: "Choisir les passages de référence (facultatif)", body: "Si besoin, choisissez vous-même les passages de l’original avec « Choisir des extraits de l’original », puis cliquez sur « Utiliser les extraits sélectionnés »." },
      ],
      faq: [
        { q: "Peut-on créer des images dans une conversation reprise ?", a: "Non. Démarrez une nouvelle image depuis la barre latérale." },
        { q: "Peut-on partager publiquement une conversation reprise ?", a: "Pas encore." },
        { q: "Et la conversation reprise si je supprime l’original ?", a: "Les messages Tomverse restent et l’indication « Original supprimé » s’affiche." },
      ],
    },
    "import-gemini": {
      title: "Importer vos conversations Gemini",
      summary: "Importez le fichier JSON exporté via Google Takeout depuis l’activité de l’application Gemini pour enregistrer vos anciennes conversations dans votre compte Tomverse. Le fichier d’origine n’est lu que dans votre navigateur.",
      steps: [
        { title: "Ouvrir Takeout et tout désélectionner", body: "Ouvrez Google Takeout et désélectionnez tout." },
        { title: "Choisir l’activité de l’application Gemini au format JSON", body: "Sélectionnez « Mon activité », puis, à l’intérieur, les applications Gemini, et réglez le format sur JSON. L’entrée « Gemini » de Takeout elle-même ne contient pas les conversations, mais les Gems." },
        { title: "Récupérer le fichier", body: "Une fois l’export terminé, téléchargez le fichier .zip avec le lien envoyé par Google. Inutile de le décompresser." },
        { title: "Ouvrir l’écran d’import", body: "Dans l’onglet « Données » des « Paramètres » de Tomverse, cliquez sur « Gérer les imports » sur la ligne « Importer depuis un autre service d'IA », puis sur « Démarrer un nouvel import »." },
        { title: "Choisir et importer", body: "Dans « Où se trouve votre conversation ? », choisissez « Gemini », puis sélectionnez le fichier avec « Choisir le fichier d'export ». Choisissez les conversations, cliquez sur « Vérifier les discussions sélectionnées (N) », puis sur « Importer N conversations »." },
      ],
      faq: [
        { q: "J’ai exporté en HTML.", a: "L’export Gemini doit être au format JSON. Le HTML ne peut pas être lu : dans Takeout, réglez le format sur JSON et exportez de nouveau." },
        { q: "Le fichier d’origine est-il envoyé au serveur ?", a: "Le fichier d’origine ne quitte pas votre appareil. Seul le texte des conversations choisies est enregistré dans votre compte ; les images, l’audio et les pièces jointes ne sont pas importés." },
        { q: "Peut-on aussi importer des conversations Perplexity ?", a: "Pas encore. Ce sera bientôt pris en charge." },
      ],
    },
    "import-guest-conversations": {
      title: "Enregistrer dans votre compte les conversations faites en invité",
      summary: "Transférez dans votre compte les conversations invité menées dans ce navigateur avant votre connexion.",
      steps: [
        { title: "Se connecter", body: "Une fois connecté, la fenêtre « Importer vos conversations invité ? » s’affiche." },
        { title: "Choisir ce qu’il faut importer", body: "Cliquez sur « Importer uniquement la conversation en cours » ou « Importer les N conversations invité ». Pour passer, cliquez sur « Commencer sans importer »." },
        { title: "Importer plus tard", body: "Si vous avez passé, vous pouvez le faire dans « Importer les conversations invité de ce navigateur » de l’onglet « Données » des « Paramètres ». Cette option n’apparaît que s’il reste dans ce navigateur des conversations invité à importer." },
      ],
      faq: [
        { q: "Et si j’efface les données du navigateur ?", a: "Si vous effacez les données du navigateur ou utilisez un autre navigateur ou appareil, les conversations invité ne peuvent pas être récupérées." },
        { q: "Une partie seulement a échoué.", a: "Le nombre d’échecs est indiqué et vous pouvez cliquer sur « Réessayer »." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Connecter une extension et choisir les autorisations",
      summary: "Connectez un service externe sous forme d’extension et choisissez vous-même les autorisations à accorder et les outils à utiliser. Une fois connecté, un bouton en forme de pièce de puzzle apparaît dans le champ de saisie de Chat.",
      steps: [
        { title: "Ouvrir l’écran des extensions", body: "Cliquez sur le bouton en forme de pièce de puzzle du champ de saisie de Chat, puis sur « Gérer les extensions »." },
        { title: "Démarrer la connexion", body: "Cliquez sur « Ajouter une connexion MCP » ou sur « Connecter » sur la carte d’un service. Un service marqué « Configuration serveur requise » ne peut pas encore être connecté." },
        { title: "Choisir les autorisations", body: "Pour un service avec connexion, quand la liste « Autorisations à accorder » s’affiche, cochez uniquement ce qui est nécessaire, puis cliquez sur « Connecter ». Au retour de la connexion au service, « Connectées » s’affiche." },
        { title: "Enregistrer les outils à utiliser", body: "Sous « Choisir les outils » dans « Gérer l’accès », cochez les outils à utiliser puis cliquez sur « Enregistrer l’accès ». Il faut enregistrer des outils pour pouvoir les choisir dans Chat." },
      ],
      faq: [
        { q: "Je veux changer les autorisations.", a: "Cliquez sur « Réauthentifier » dans « Gérer l’accès » et choisissez de nouveau." },
        { q: "Le contenu de mes conversations est-il transmis au service ?", a: "Seuls les termes de recherche et les valeurs nécessaires à l’exécution sont envoyés. Les conversations entières et la mémoire ne sont pas partagées automatiquement." },
        { q: "Que se passe-t-il si je coupe la connexion ?", a: "Après « Déconnecter », les nouveaux appels sont bloqués et les informations d’authentification enregistrées sont effacées. Ce qui figure déjà dans une réponse reste." },
      ],
    },
    "custom-mcp-server": {
      title: "Ajouter l’adresse de votre propre serveur MCP",
      summary: "Saisissez vous-même l’adresse HTTPS publique d’un serveur MCP distant de confiance pour vous y connecter.",
      steps: [
        { title: "Ouvrir le MCP personnalisé", body: "Dans l’écran « Extensions », cliquez sur « Connecter » sur la carte « Serveur MCP personnalisé »." },
        { title: "Saisir l’adresse", body: "Saisissez l’adresse du serveur dans « URL du serveur (HTTPS) » et, si besoin, un « Nom affiché »." },
        { title: "Choisir l’authentification", body: "Choisissez « Aucune authentification », « Jeton Bearer » ou « OAuth (enregistrement dynamique du client) ». Pour un jeton Bearer, saisissez un jeton aux droits minimaux émis séparément par ce service." },
        { title: "Connecter et enregistrer les outils", body: "Cliquez sur « Connecter », choisissez les outils à utiliser dans « Gérer l’accès », puis cliquez sur « Enregistrer l’accès »." },
      ],
      faq: [
        { q: "« Cette adresse ne peut pas être utilisée » s’affiche.", a: "Seules les adresses HTTPS publiques sont acceptées. Les adresses de réseau interne, les ports autres que 443 et les paramètres de requête après l’adresse ne sont pas autorisés." },
        { q: "OAuth ne fonctionne pas.", a: "Le serveur ne prend pas en charge l’enregistrement dynamique du client. Essayez de vous connecter avec un jeton Bearer." },
        { q: "Dois-je approuver chaque utilisation d’un outil ?", a: "Oui. L’exécution des outils d’un serveur personnalisé est approuvée à chaque fois." },
      ],
    },
    "use-plugin-in-chat": {
      title: "Utiliser une extension dans la conversation et approuver l’exécution",
      summary: "Dans Chat, choisissez l’extension connectée ; sauf pour un outil de lecture déjà examiné, vérifiez le contenu et approuvez avant l’exécution.",
      steps: [
        { title: "Choisir l’extension", body: "Cliquez sur le bouton en forme de pièce de puzzle du champ de saisie de Chat et choisissez la connexion à utiliser dans cette conversation." },
        { title: "Envoyer la question", body: "Posez votre question comme d’habitude. Le modèle utilise les outils nécessaires." },
        { title: "Approuver l’exécution", body: "Quand « Vérifier cette action dans Extensions » s’affiche, cliquez sur « Gérer les extensions » à côté, vérifiez dans l’onglet « Approbations » le contenu à envoyer, puis cliquez sur « Approuver cette action » ou « Refuser ». Sans approbation sous 10 minutes, l’action expire." },
      ],
      faq: [
        { q: "J’ai connecté, mais elle n’apparaît pas dans la liste.", a: "Il faut enregistrer au moins un outil à utiliser dans « Gérer l’accès » pour qu’elle apparaisse dans la liste." },
        { q: "Puis-je l’utiliser aussi dans Review ?", a: "Le choix de l’extension se trouve dans le champ de saisie de Chat." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "Créer et révoquer des clés API",
      summary: "Créez des clés API Tomverse à utiliser dans vos outils de code, modifiez leur limite et leur nom, et révoquez celles que vous n’utilisez plus. L’API et la CLI sont disponibles à partir de l’offre Pro. Les clés commencent par tvk_.",
      steps: [
        { title: "Ouvrir l’écran des clés API", body: "Dans l’onglet « Compte » des « Paramètres », cliquez sur « Gérer » sur la ligne « Clés API »." },
        { title: "Créer une clé", body: "À côté de « Vos clés », cliquez sur « Nouvelle clé », saisissez un « Nom », définissez si besoin une « Limite de crédits (facultatif) » et l’« Expiration » (90 jours par défaut), puis cliquez sur « Créer la clé »." },
        { title: "Enregistrer la clé", body: "Dans « Copiez votre clé maintenant », cliquez sur « Copier », conservez-la dans un endroit sûr, puis cliquez sur « Je l'ai enregistrée · Connecter un outil ». La clé n’est affichée qu’une seule fois." },
        { title: "Gérer", body: "Dans la liste « Vos clés », cliquez sur « ⋯ » sur la ligne d’une clé pour utiliser « Renommer », « Modifier la limite » et « Requêtes récentes »." },
        { title: "Révoquer et remplacer", body: "Quand vous cliquez sur « Révoquer » dans le menu « ⋯ » de la ligne de la clé, les outils qui utilisent cette clé s’arrêtent aussitôt et c’est irréversible. Pour remplacer une clé, créez-en une nouvelle, saisissez-la dans l’outil, puis révoquez l’ancienne." },
      ],
      faq: [
        { q: "J’ai perdu ma clé.", a: "Elle ne peut plus être affichée. Tomverse n’en conserve qu’une empreinte. Créez une nouvelle clé et révoquez l’ancienne." },
        { q: "Combien de clés puis-je créer ?", a: "Jusqu’à 10 clés actives par compte." },
        { q: "« L'API Tomverse et la CLI Tomverse nécessitent un forfait payant » s’affiche.", a: "Les clés API se créent à partir de l’offre Pro. Elles sont bloquées en Free ; en passant à Pro ou Max, vous pouvez créer des clés. Les clés déjà créées peuvent être révoquées depuis cet écran. Si « L'API Tomverse n'est pas encore disponible pour ce compte. » s’affiche, l’API n’est pas encore ouverte pour ce compte." },
      ],
    },
    "connect-claude-code": {
      title: "Connecter Claude Code à Tomverse",
      summary: "Depuis un terminal ou l’extension VS Code officielle, quelques lignes de configuration suffisent pour que Claude Code utilise les modèles Claude et les crédits de Tomverse. Disponible à partir de l’offre Pro.",
      steps: [
        { title: "Préparer la clé", body: "Créez et enregistrez une clé en suivant le guide « Créer et révoquer des clés API »." },
        { title: "Choisir le modèle", body: "Dans « Connecter un outil » de l’écran des clés API, choisissez « Claude Code », puis le « Modèle ». Claude Code n’utilise que des modèles Claude : seuls les modèles compatibles avec cet outil figurent dans la liste. Si vous choisissez « Smart Adaptive », Tomverse choisit un modèle Claude au début d’une tâche et le garde jusqu’à la fin." },
        { title: "Utiliser dans le terminal", body: "Choisissez « Ligne de commande », puis « Windows (PowerShell) » ou « macOS / Linux », utilisez « Copier » sur le bloc et collez-le dans le terminal. La dernière ligne, claude, lance Claude Code connecté à Tomverse." },
        { title: "Utiliser dans l’extension VS Code", body: "Choisissez « Extension VS Code », placez le bloc settings.json affiché dans votre settings.json utilisateur, puis redémarrez VS Code." },
        { title: "Saisir la clé", body: "Si vous venez de créer la clé, elle est déjà insérée dans la configuration tant que vous ne quittez pas cette page. Sinon, remplacez <YOUR_TOMVERSE_API_KEY> dans la configuration copiée par la clé que vous avez enregistrée." },
      ],
      faq: [
        { q: "Comment revenir à mon compte Claude d’origine ?", a: "Fermez le terminal, ou supprimez la configuration ajoutée dans settings.json et redémarrez VS Code." },
        { q: "La recherche web ne fonctionne pas.", a: "Les outils exécutés sur les serveurs d’Anthropic, comme la recherche web, ne sont pas utilisables avec la connexion Tomverse." },
        { q: "Puis-je aussi utiliser des modèles GPT ou Gemini d’autres fournisseurs ?", a: "Non. Claude Code n’utilise que des modèles Claude. Pour utiliser les modèles de tous les fournisseurs, connectez un outil compatible OpenAI comme Cursor." },
        { q: "La clé figure-t-elle telle quelle dans settings.json ?", a: "Oui. L’extension Claude Code lit la clé comme valeur d’une variable d’environnement : elle se retrouve donc dans le fichier. Ne partagez pas ce fichier." },
      ],
    },
    "connect-codex": {
      title: "Connecter Codex à Tomverse",
      summary: "Ajoutez le fournisseur Tomverse au fichier de configuration de Codex et lancez avec --profile tomverse. Codex n’utilise que des modèles OpenAI, et votre compte Codex habituel n’est pas modifié. Disponible à partir de l’offre Pro.",
      steps: [
        { title: "Préparer la clé et le modèle", body: "Créez une clé, puis, dans « Connecter un outil » de l’écran des clés API, choisissez « Codex » et le « Modèle ». Si vous choisissez « Smart Adaptive », Tomverse choisit un modèle OpenAI au début d’une tâche et le garde jusqu’à la fin." },
        { title: "Ajouter le fournisseur", body: "Collez le bloc « À ajouter à ~/.codex/config.toml » dans ~/.codex/config.toml." },
        { title: "Enregistrer le profil", body: "Enregistrez le bloc suivant sous ~/.codex/tomverse.config.toml." },
        { title: "Saisir la clé et démarrer", body: "Remplacez <YOUR_TOMVERSE_API_KEY> dans le bloc « Définissez la clé là où Codex démarre » par votre clé, puis exécutez-le. La dernière ligne, codex --profile tomverse, démarre avec Tomverse." },
        { title: "Avec l’extension VS Code", body: "Choisissez « Extension VS Code », puis placez en tête de config.toml le bloc « Pour l’extension VS Code, qui ne lit que config.toml… ». Saisissez la clé comme dans le bloc « Définissez la clé là où Codex démarre »." },
      ],
      faq: [
        { q: "Mon compte Codex habituel est-il affecté ?", a: "Sans --profile tomverse, Codex utilise votre compte d’origine comme avant." },
        { q: "Comment annuler le réglage de l’extension VS Code ?", a: "Supprimez la ligne model_provider placée en tête de config.toml." },
        { q: "Certaines fonctions ne sont-elles pas disponibles ?", a: "La recherche web hébergée, les conversations enregistrées et les réponses en arrière-plan ne sont pas utilisables." },
        { q: "Puis-je aussi utiliser des modèles Claude ou Gemini d’autres fournisseurs ?", a: "Non. Codex n’utilise que des modèles OpenAI. Pour utiliser les modèles de tous les fournisseurs, connectez un outil compatible OpenAI comme Cursor." },
      ],
    },
    "connect-cursor": {
      title: "Connecter Cursor à Tomverse",
      summary: "Saisissez Tomverse dans la clé API OpenAI de Cursor et le remplacement de l’URL de base pour que Chat et Agent utilisent les modèles et les crédits de Tomverse. Cursor est un outil compatible OpenAI : il peut utiliser les modèles de tous les fournisseurs, à partir de l’offre Pro.",
      steps: [
        { title: "Préparer la clé", body: "Créez et enregistrez une clé en suivant le guide « Créer et révoquer des clés API »." },
        { title: "Voir la configuration de Cursor", body: "Dans « Connecter un outil » de l’écran des clés API, choisissez « Cursor » : la configuration de Cursor s’affiche. Une clé que vous venez de créer y est insérée tant que vous ne quittez pas cette page." },
        { title: "Saisir dans Cursor", body: "Dans Cursor Settings > Models > API Keys, saisissez la clé Tomverse comme clé API OpenAI, activez le remplacement de l’OpenAI Base URL et saisissez l’URL de base affichée à l’écran." },
        { title: "Choisir le modèle", body: "Les modèles GPT proposés par Tomverse se choisissent directement dans la liste de modèles de Cursor. Pour tout autre modèle, comme Claude ou Smart Adaptive, saisissez son ID dans Cursor Settings › Models et choisissez Add Custom Model, une seule fois." },
      ],
      faq: [
        { q: "Où Cursor utilise-t-il cette clé ?", a: "Cette clé n’est utilisée que par Chat et Agent ; Tab, les modèles propres à Cursor et les agents cloud ne l’utilisent pas." },
        { q: "Pourquoi puis-je utiliser les modèles de tous les fournisseurs ?", a: "Cursor est un outil compatible OpenAI : vous pouvez choisir les modèles de tous les fournisseurs autorisés par l’offre de votre compte. Claude Code et Codex n’utilisent que les modèles de leur propre fournisseur." },
        { q: "Comment annuler ?", a: "Dans Cursor, désactivez la clé OpenAI et le remplacement de l’OpenAI Base URL." },
        { q: "Les requêtes partent-elles de mon ordinateur ?", a: "Non. Cursor envoie les requêtes depuis ses propres serveurs : elles arrivent chez Tomverse par Internet, et non depuis votre ordinateur." },
      ],
    },
    "api-smart-adaptive": {
      title: "Utiliser Smart Adaptive avec l’API",
      summary: "Si vous donnez smart-adaptive comme nom de modèle, Tomverse choisit le modèle qui répond à chaque requête. Le modèle qui a répondu est indiqué dans la réponse. Disponible à partir de l’offre Pro.",
      steps: [
        { title: "Copier la configuration", body: "Quand vous choisissez un outil dans l’écran des clés API, la configuration copiée contient Smart Adaptive par défaut. Inutile de la copier de nouveau quand des modèles sont ajoutés ou retirés." },
        { title: "Écrire le nom du modèle", body: "Dans un outil compatible OpenAI (Chat Completions), utilisez smart-adaptive comme nom de modèle." },
        { title: "Voir le modèle qui a répondu", body: "La valeur model de la réponse et les en-têtes x-tomverse-routed-model et x-tomverse-routed-by indiquent le modèle qui a répondu et la façon dont il a été choisi." },
        { title: "Vérifier les crédits", body: "Les crédits sont débités selon le modèle qui a répondu. Dans « Modèles autorisés par l'API » de l’écran des clés API, vous voyez la fourchette de crédits par requête." },
      ],
      faq: [
        { q: "Cela fonctionne-t-il aussi avec Claude Code et Codex ?", a: "Oui, mais seulement parmi les modèles du fournisseur de chaque outil (modèles Claude pour Claude Code, modèles OpenAI pour Codex). Un modèle est choisi au début d’une tâche et gardé jusqu’à la fin." },
        { q: "Et si je veux choisir le modèle moi-même ?", a: "Saisissez comme nom de modèle un ID de modèle affiché dans « Modèles autorisés par l'API »." },
        { q: "Cela fonctionne-t-il dans d’autres outils comme Cursor ?", a: "Toute application qui accepte un point de terminaison OpenAI Chat Completions personnalisé (URL de base, clé API, modèle) peut l’utiliser avec ces trois valeurs." },
      ],
    },
    "api-usage": {
      title: "Consulter l’utilisation et les limites de l’API",
      summary: "Les requêtes envoyées avec une clé utilisent les mêmes crédits de compte que Chat, et vous pouvez fixer une limite de crédits par clé.",
      steps: [
        { title: "Voir l’utilisation par clé", body: "Dans « Vos clés » de l’écran des clés API, consultez pour chaque clé les crédits utilisés et ceux réservés pour les requêtes en cours." },
        { title: "Voir les requêtes récentes", body: "Cliquez sur « ⋯ » → « Requêtes récentes » sur la ligne d’une clé pour voir, par requête, le modèle, les crédits, les jetons en entrée et en sortie et l’ID de requête." },
        { title: "Voir le solde du compte", body: "Cliquez sur « Solde et utilisation du compte » : l’onglet « Abonnement » s’ouvre." },
        { title: "Crédits par modèle", body: "Dans « Modèles autorisés par l'API », vérifiez les crédits par requête de chaque modèle." },
      ],
      faq: [
        { q: "Mes requêtes échouent avec 401, 403, 404 ou 429.", a: "401 : clé incorrecte, expirée ou révoquée. 403 : l’API est désactivée sur ce compte ou l’utilisation du compte est restreinte. 404 : modèle non proposé (copiez de nouveau la configuration). 429 : limite de la clé, de crédits ou de débit de requêtes atteinte." },
        { q: "Une requête en échec consomme-t-elle des crédits ?", a: "Non, si elle échoue avant toute sortie. Si vous coupez ou arrêtez en cours de réponse, la partie générée peut être débitée." },
        { q: "L’outil envoie plusieurs requêtes.", a: "Les étapes après l’exécution d’un outil et la compression de la conversation sont chacune comptées comme une requête." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "Régler les notifications par e-mail",
      summary: "Choisissez les types d’e-mails à recevoir. Les e-mails marketing ne démarrent qu’après confirmation du pays de résidence et clic sur « Confirmer l'abonnement » dans l’e-mail de confirmation.",
      steps: [
        { title: "Ouvrir les notifications par e-mail", body: "Dans l’onglet « Compte » des « Paramètres », cliquez sur « Notifications par e-mail » → « Ouvrir les notifications par e-mail »." },
        { title: "Activer ou désactiver", body: "« Sécurité et compte » et « Facturation » sont toujours activés. « État du service » peut être désactivé, tandis que « Nouveautés produit », « Newsletter » et « Offres » sont désactivés au départ." },
        { title: "Recevoir des e-mails marketing", body: "Pour activer un élément marketing, choisissez d’abord votre « Pays de résidence » (vous pouvez l’enregistrer à l’avance avec « Confirmer le pays »)." },
        { title: "E-mail de confirmation", body: "Ouvrez le lien de l’e-mail de confirmation et cliquez sur « Confirmer l'abonnement » : l’envoi ne démarre qu’ensuite. Si besoin, cliquez sur « Renvoyer l'e-mail de confirmation »." },
        { title: "Tout désactiver d’un coup", body: "Quand un élément marketing est activé, « Désactiver tous les e-mails marketing » s’affiche ; un clic les désactive tous d’un coup." },
      ],
      faq: [
        { q: "Ne peut-on pas désactiver les e-mails de sécurité ?", a: "Non : ce sont des avis indispensables à la protection du compte. Il en va de même pour les e-mails de facturation." },
        { q: "J’ai activé l’interrupteur mais il reste désactivé.", a: "Un e-mail de confirmation a été envoyé. Il s’active quand vous ouvrez le lien de l’e-mail et cliquez sur « Confirmer l'abonnement »." },
        { q: "L’interrupteur marketing ne réagit pas.", a: "Les e-mails marketing ne sont pas encore proposés dans votre pays de résidence. Les e-mails de sécurité, de facturation et d’état du service continuent d’arriver." },
        { q: "Puis-je me désabonner sans me connecter ?", a: "Oui, avec le lien de désabonnement en bas de l’e-mail. Pour réactiver, il faut vous connecter." },
      ],
    },
    "use-on-mobile": {
      title: "Utiliser Tomverse dans le navigateur d’un téléphone",
      summary: "Sur téléphone, la liste des conversations s’ouvre dans un tiroir à gauche et le champ de saisie se trouve en bas de l’écran.",
      steps: [
        { title: "Ouvrir le menu", body: "Appuyez sur le bouton de menu en haut à gauche pour ouvrir le tiroir. Vous y trouvez le nouveau chat, la recherche et la liste des conversations, et en bas l’utilisation, la langue, le menu du compte et le retour d’information." },
        { title: "Envoyer", body: "Sur le clavier du téléphone, Entrée insère un saut de ligne. Pour envoyer, appuyez sur le bouton d’envoi." },
        { title: "Ajouter à l’écran d’accueil", body: "Si « Installer Tomverse » s’affiche dans le menu du compte, appuyez dessus. Sur iPhone, suivez l’indication de ce menu : dans Safari, choisissez Partager → « Sur l’écran d’accueil ». Si le menu n’apparaît pas, l’application est déjà installée ou le navigateur ne la prend pas en charge." },
      ],
      faq: [
        { q: "Puis-je aussi envoyer des fichiers depuis un téléphone ?", a: "Oui. Sans connexion, vous pouvez joindre moins de fichiers, et plus petits ; connecté, vous pouvez aussi utiliser Google Drive. Les limites figurent dans le guide sur les pièces jointes." },
        { q: "Puis-je importer des conversations depuis un téléphone ?", a: "Oui. Mais si le fichier d’export est volumineux, nous vous conseillons de le faire depuis un ordinateur." },
      ],
    },
    // ---------------------------------------------------------------- account
    "manage-login-methods": {
      title: "Ajouter ou retirer des méthodes de connexion",
      summary: "Vous pouvez lier ou retirer la connexion par e-mail, Google ou Microsoft. Il doit toujours rester au moins une méthode de connexion.",
      steps: [
        { title: "Ouvrir les paramètres", body: "Cliquez sur le bouton du compte en bas de la barre latérale, puis sur « Paramètres » dans le menu du compte." },
        { title: "Trouver la carte des méthodes de connexion", body: "Dans l’onglet « Compte », ouvrez la carte « Méthodes de connexion »." },
        { title: "Lier", body: "Cliquez sur « Ajouter » sur la ligne de la méthode à lier. L’e-mail passe par un code de vérification, Google et Microsoft par la connexion à ce service." },
        { title: "Retirer", body: "Cliquez sur « Supprimer » sur la ligne de la méthode à retirer, puis, quand le bouton change, cliquez une seconde fois sur « Cliquez à nouveau pour supprimer ». Si un message vous demande de vous reconnecter, reconnectez-vous puis supprimez de nouveau." },
        { title: "Se reconnecter", body: "La suppression vous déconnecte de tous vos appareils : reconnectez-vous avec une méthode restante." },
      ],
      faq: [
        { q: "Puis-je supprimer la dernière méthode de connexion ?", a: "Non. Un compte doit avoir au moins une méthode de connexion." },
        { q: "Un message indique que cet e-mail est déjà utilisé avec une autre méthode de connexion.", a: "Connectez-vous avec la méthode utilisée lors de votre première inscription (Google, Microsoft, Apple ou e-mail), puis ajoutez la nouvelle méthode dans les paramètres." },
        { q: "Un message indique que le compte à lier est déjà lié à un autre compte Tomverse.", a: "Un compte externe ne peut être lié qu’à un seul compte Tomverse." },
        { q: "Je me suis inscrit avec Apple.", a: "La connexion Apple n’apparaît pas sur cette carte : vous ne pouvez ni l’ajouter ni la retirer ici. Si vous vous êtes inscrit avec Apple, ajoutez aussi l’e-mail ou Google / Microsoft." },
      ],
    },
    "export-account-data": {
      title: "Télécharger les données de votre compte",
      summary: "Téléchargez dans un seul fichier vos conversations, votre mémoire, vos historiques importés, vos paiements et votre utilisation. Vous pouvez aussi ne télécharger que les conversations en texte.",
      steps: [
        { title: "Ouvrir l’onglet Données", body: "Dans « Paramètres » du menu du compte, ouvrez l’onglet « Données »." },
        { title: "Lancer le téléchargement", body: "Dans « Gestion des données », sur la ligne « Les données de votre compte », cliquez sur « Télécharger vos données »." },
        { title: "Préparer le fichier", body: "Cliquez sur « Préparer un téléchargement ». Si vous ne vous êtes pas connecté récemment, reconnectez-vous une fois puis revenez." },
        { title: "Récupérer le fichier", body: "Cliquez sur « Télécharger le fichier ». Le lien n’est utilisable qu’une fois et expire au bout de 5 minutes ; une fois expiré, cliquez sur « Préparer un nouveau téléchargement »." },
        { title: "Si vous ne voulez que les conversations", body: "Dans « Exporter vos conversations » de l’onglet Données, cliquez sur « Télécharger tous les chats en .txt ». Les conversations verrouillées sont exclues de ce fichier." },
      ],
      faq: [
        { q: "Certaines données sont-elles exclues ?", a: "Les éléments qui ne sont pas des données utilisateur, comme les journaux d’exploitation, sont exclus. Ce qui est inclus ou exclu, et pourquoi, est indiqué dans le fichier." },
        { q: "Puis-je voir l’historique des téléchargements ?", a: "Dans « Historique des téléchargements », vous voyez pendant 90 jours les demandes, téléchargements et refus." },
      ],
    },
    "delete-account": {
      title: "Supprimer votre compte",
      summary: "Quand vous demandez la suppression, vous êtes déconnecté tout de suite ; après un délai de grâce de 7 jours, vos données, y compris conversations et fichiers, sont supprimées définitivement. Les enregistrements minimaux nécessaires aux obligations de paiement et légales, ainsi que les enregistrements de désabonnement, peuvent être conservés.",
      steps: [
        { title: "Télécharger d’abord (recommandé)", body: "Si vous souhaitez conserver des données, téléchargez-les d’abord en suivant le guide « Télécharger les données de votre compte »." },
        { title: "Ouvrir la zone sensible", body: "Dans la « Zone sensible » en bas de l’onglet « Compte » des « Paramètres », cliquez sur « Supprimer le compte »." },
        { title: "Saisir la confirmation", body: "Cochez la case de consentement et saisissez exactement DELETE MY ACCOUNT." },
        { title: "Envoyer la demande", body: "Cliquez sur « Supprimer le compte », puis encore une fois sur « Demander la suppression du compte ». Si l’on vous demande de vous reconnecter, faites-le puis recommencez." },
      ],
      faq: [
        { q: "Puis-je annuler la suppression ?", a: "Pas depuis l’écran. Contactez support@tomverse.app dans les 7 jours. Même en cas de restauration, l’offre n’est conservée que jusqu’à son échéance d’origine et le renouvellement automatique n’est pas réactivé." },
        { q: "L’offre payée est-elle remboursée ?", a: "La suppression du compte seule ne donne pas lieu à un remboursement. Si vous avez besoin d’un remboursement, envoyez votre demande avant la suppression." },
        { q: "Quelle différence avec « Supprimer tous les chats » ?", a: "« Supprimer tous les chats » se trouve dans l’onglet Données, ne supprime que les conversations et laisse le compte. C’est irréversible." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "Comment les crédits sont débités",
      summary: "Chaque modèle a un nombre de crédits de base par réponse ; une entrée longue ajoute un multiplicateur, et la recherche web et les images se comptent à part.",
      steps: [
        { title: "Voir la charge en crédits par modèle", body: "Dans le sélecteur de modèles, comparez la charge en crédits de chaque modèle avec la barre (5 niveaux) et « environ N réponses ». Le filtre « Usage » permet de choisir une tranche de 1, 4, 8 ou 12+ crédits. Les valeurs peuvent changer : prenez pour référence ce qui s’affiche à l’écran." },
        { title: "Estimation quand vous choisissez vous-même", body: "Si vous choisissez vous-même les modèles, le total des crédits « estimation de base » des modèles choisis s’affiche sous le sélecteur. Avec l’adaptation intelligente, les crédits du modèle qui a répondu sont débités." },
        { title: "Multiplicateur pour longues conversations et fichiers", body: "Si l’entrée — question actuelle, conversation précédente et contenu des fichiers joints — dépasse 16 000 jetons, le multiplicateur est de 1,5 ; il passe à 2 à 50 000 jetons et à 3 à 100 000 jetons. Les fichiers joints eux-mêmes ne coûtent rien en plus." },
        { title: "Recherche web et images", body: "Si vous activez la recherche web, 8 crédits s’ajoutent pour chaque modèle qui a effectué une recherche (sans multiplicateur de longueur d’entrée, modèles Perplexity exclus). Ils sont rendus si aucune recherche n’a eu lieu. La génération d’image coûte des crédits fixés selon le modèle, la qualité et la taille, affichés sur le bouton de génération de l’écran d’image (quand Chat répond par une image, ils sont débités sans confirmation)." },
        { title: "Ordre de débit", body: "Les crédits du forfait du mois en cours sont utilisés d’abord, puis les crédits achetés en commençant par ceux dont l’expiration est la plus proche. Les jours où vous atteignez la limite quotidienne, vous pouvez continuer avec les crédits achetés." },
      ],
      faq: [
        { q: "Il a été débité plus que prévu.", a: "Le multiplicateur pour longues conversations et fichiers (1,5, 2 ou 3) et la recherche web (+8 crédits par modèle) peuvent s’ajouter." },
        { q: "Les crédits sont-ils débités si la réponse échoue ?", a: "Dans un chat ordinaire, si la réponse échoue ou est vide, aucun crédit n’est débité. Si vous arrêtez vous-même une réponse, seule la partie reçue est débitée." },
        { q: "« Une vérification de sécurité interne a mis cette demande en pause » s’affiche.", a: "Dans ce cas, aucun crédit n’est débité. Réessayez dans un moment ou choisissez un modèle moins coûteux." },
      ],
    },
    "check-credits": {
      title: "Voir vos crédits restants et leur date d’expiration",
      summary: "Dans le menu du compte et l’onglet « Abonnement », vous voyez l’utilisation du jour et du mois, les crédits restants, la périodicité de facturation et la date d’expiration.",
      steps: [
        { title: "Ouvrir le menu du compte", body: "Cliquez sur le bouton du compte en bas de la barre latérale : la jauge « Utilisation actuelle » et l’heure de la prochaine réinitialisation s’affichent." },
        { title: "Aller à l’onglet Abonnement", body: "Cliquez sur « Utilisation et abonnement » : l’onglet « Abonnement » des paramètres s’ouvre." },
        { title: "Vérifier l’offre actuelle", body: "Dans la carte « Abonnement actuel », vérifiez la périodicité de facturation (mensuelle ou annuelle) et l’« Expiration » (fin de la période de facturation en cours)." },
        { title: "Vérifier les crédits restants", body: "Consultez les cartes « Crédits de réponses IA aujourd'hui », « Crédits de réponses IA ce mois-ci » et « Crédits achetés restants ». Pour les crédits supplémentaires, la date d’expiration la plus proche est aussi indiquée." },
      ],
      faq: [
        { q: "Quand les crédits sont-ils réinitialisés ?", a: "Les crédits quotidiens le sont à minuit dans le « Fuseau de réinitialisation quotidienne » des préférences, et les crédits mensuels du forfait le 1er de chaque mois à 00:00 UTC ; ils ne sont pas reportés." },
        { q: "Les crédits achetés disparaissent-ils aussi en début de mois ?", a: "Non. Ils sont conservés à part des crédits mensuels et expirent 365 jours après l’achat." },
        { q: "Mon offre n’a pas changé juste après le paiement.", a: "Le traitement du paiement peut prendre un moment. Revérifiez l’offre actuelle et la date d’expiration dans l’onglet Abonnement." },
      ],
    },
    "change-plan": {
      title: "Passer de Pro à Max (et inversement)",
      summary: "Le changement se fait depuis la page des tarifs. Une mise à niveau prend effet dès la fin du paiement ; une rétrogradation prend effet à la fin de la période de facturation en cours.",
      steps: [
        { title: "Ouvrir la page des tarifs", body: "Allez sur la page des tarifs." },
        { title: "Démarrer le changement", body: "Si vous êtes en Pro, cliquez sur « Passer à Max » ; si vous êtes en Max, cliquez sur « Passer à Pro »." },
        { title: "Vérifier montant et crédits", body: "Sur l’écran de changement, vérifiez le montant « À payer aujourd'hui » et ce qu’il restera de vos crédits du forfait du mois après le changement." },
        { title: "Terminer la mise à niveau", body: "Cliquez sur « Payer et démarrer Max ». « Paiement en attente » s’affiche jusqu’à la fin du paiement." },
        { title: "Programmer la rétrogradation", body: "Cliquez sur « Programmer Pro ». Jusqu’à la date d’effet, vous pouvez revenir en arrière avec « Annuler ce changement »." },
      ],
      faq: [
        { q: "Une mise à niveau donne-t-elle de nouveaux crédits ?", a: "La limite du mois passe à celle de Max et ce que vous avez déjà utilisé reste compté. Aucun crédit supplémentaire n’est ajouté en plus." },
        { q: "Puis-je passer du mensuel à l’annuel ?", a: "On ne peut changer que vers la même périodicité de facturation. Pour passer du mensuel à l’annuel ou l’inverse, contactez le support." },
        { q: "Et si le paiement échoue ?", a: "Votre offre actuelle est conservée et rien n’est payé." },
      ],
    },
    "cancel-subscription": {
      title: "Résilier votre abonnement (arrêter le renouvellement automatique)",
      summary: "La résiliation prend effet à la fin de la période de facturation en cours ; jusqu’alors, vous continuez à utiliser votre offre actuelle.",
      steps: [
        { title: "Ouvrir l’onglet Abonnement", body: "Dans le menu du compte, cliquez sur « Utilisation et abonnement » pour ouvrir l’onglet « Abonnement »." },
        { title: "Programmer la résiliation", body: "Dans la carte « Annuler l'offre », cliquez sur « Annuler à la fin de la période ». Un clic programme la résiliation aussitôt, sans fenêtre de confirmation." },
        { title: "Vérifier le résultat", body: "Vérifiez que le bouton devient « Annulation programmée » et qu’un message indique que le prochain paiement n’aura pas lieu." },
      ],
      faq: [
        { q: "Passe-t-on tout de suite en Free après la résiliation ?", a: "Non. Votre offre actuelle est conservée jusqu’à la date d’expiration affichée, puis vous passez en Free." },
        { q: "Les crédits achetés disparaissent-ils ?", a: "Non. Ils restent jusqu’à leur expiration, mais ne servent que pour les modèles utilisables avec l’offre devenue active." },
        { q: "Puis-je annuler la résiliation programmée ?", a: "Pas depuis l’écran. Pour annuler une résiliation programmée, contactez le support." },
      ],
    },
    "request-refund": {
      title: "Demander un remboursement",
      summary: "Faites la demande depuis l’onglet Abonnement ou par e-mail ; l’équipe d’exploitation l’examine au cas par cas. Un simple changement d’avis ou des crédits non utilisés ne donnent en principe pas droit à un remboursement.",
      steps: [
        { title: "Indiquer le motif", body: "Dans la carte « Demande de remboursement » de l’onglet « Abonnement », indiquez le motif." },
        { title: "Envoyer la demande", body: "Cliquez sur « Demander un remboursement » : « Demande de remboursement reçue » et la date de réception s’affichent." },
        { title: "Si vous demandez par e-mail", body: "Si la carte n’apparaît pas, envoyez à support@tomverse.app l’e-mail du compte, le nom de l’offre ou du pack de crédits, la date de paiement, le numéro de reçu et le motif. Si vous avez acheté un pack de crédits en offre Free, la carte n’apparaît pas : demandez par e-mail." },
      ],
      faq: [
        { q: "Dans quels cas rembourse-t-on ?", a: "En cas de facturation en double, non autorisée ou d’un montant erroné, d’offre ou de crédits non attribués, ou de panne de service grave, c’est-à-dire des cas qui demandent une correction après examen. Un remboursement peut aussi être accordé lorsque la loi l’impose, et un remboursement partiel selon les circonstances. Pour les critères détaillés, consultez la page de la politique de remboursement." },
        { q: "La demande résilie-t-elle aussi l’abonnement ?", a: "Non, la demande seule ne résilie pas. Si le remboursement d’un abonnement est accepté, l’abonnement payant est annulé et vous passez en Free. Pour un pack de crédits, seuls les crédits de ce pack sont repris ; la part déjà utilisée peut être compensée sur les crédits accordés ultérieurement." },
        { q: "Puis-je envoyer la demande plusieurs fois ?", a: "Une seule demande est examinée à la fois. Un e-mail de confirmation vous est envoyé à la réception." },
        { q: "Quand le remboursement arrive-t-il ?", a: "Cela dépend des délais de traitement de votre moyen de paiement." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "Quand la réponse s’arrête ou reste vide",
      summary: "Réessayez une fois, choisissez un autre modèle ou envoyez sans pièce jointe. Si le problème continue, vérifiez l’état du service et signalez l’erreur.",
      steps: [
        { title: "Lire le message", body: "Consultez le message de la carte de réponse en échec et « Afficher les informations de diagnostic ». L’ID de suivi s’y trouve aussi." },
        { title: "Réessayer", body: "Cliquez sur l’une des options affichées dans la carte : « Réessayer », « Choisir un autre modèle » ou « Réduire le nombre de modèles » (selon le type d’erreur)." },
        { title: "Si c’est à cause d’une pièce jointe", body: "Si le problème vient de la pièce jointe, cliquez sur « Réessayer sans fichiers »." },
        { title: "Si c’est une limite de longueur", body: "Si « La réponse s’est arrêtée à la limite de longueur de sortie » s’affiche, redemandez de poursuivre la rédaction." },
        { title: "Si cela ne suffit pas", body: "Consultez la page d’état du service, puis cliquez sur « Signaler l'erreur » dans la même carte." },
      ],
      faq: [
        { q: "« Une réponse est déjà en cours de génération » s’affiche.", a: "Réessayez une fois la réponse en cours terminée ou arrêtée." },
        { q: "« Les crédits du forfait pour ce mois sont épuisés » s’affiche.", a: "Achetez des crédits supplémentaires ou passez à une offre supérieure pour continuer." },
        { q: "Une réponse en échec consomme-t-elle des crédits ?", a: "Dans un chat ordinaire, si la réponse échoue ou est vide, aucun crédit n’est débité. Si vous arrêtez vous-même une réponse, seule la partie reçue est débitée." },
      ],
    },
    "file-upload-failed": {
      title: "Quand l’envoi d’un fichier échoue",
      summary: "Vérifiez le format, la taille, le mot de passe et la présence de texte lisible, puis réessayez avec un seul fichier.",
      steps: [
        { title: "Lire le message d’erreur", body: "Repérez un message comme « Chaque fichier doit faire 50 Mo ou moins. », « Ce document est protégé par mot de passe. » ou « Aucun texte lisible n'a été trouvé dans ce fichier. »." },
        { title: "Corriger le fichier", body: "Retirez le mot de passe, ré-enregistrez en PDF ou réduisez la taille." },
        { title: "Réessayer un par un", body: "Joignez un seul fichier et renvoyez. Si c’est urgent, collez l’essentiel du contenu dans le champ de saisie." },
        { title: "Si l’erreur concerne une image", body: "Choisissez un modèle capable de lire les images ou cliquez sur « Retirer les modèles incompatibles »." },
      ],
      faq: [
        { q: "Combien de fichiers, et de quelle taille ?", a: "Les limites de nombre et de taille, avec ou sans connexion, figurent dans la liste des formats du guide sur les pièces jointes." },
        { q: "Quels formats sont pris en charge ?", a: "Tous les formats acceptés figurent dans la liste des formats du guide sur les pièces jointes. Les GIF animés et les ZIP protégés par mot de passe ne sont pas acceptés." },
        { q: "Un fichier envoyé auparavant est signalé comme illisible.", a: "Le fichier n’est plus stocké. Joignez-le de nouveau ou cliquez sur « Continuer sans le fichier »." },
      ],
    },
    "report-a-problem": {
      title: "Signaler une erreur et envoyer un retour",
      summary: "Avec « Signaler l'erreur » sur une réponse en échec, le détail de l’erreur et l’ID de suivi sont transmis. Pour un avis général, utilisez « Retour ».",
      steps: [
        { title: "Ouvrir la fenêtre de signalement", body: "Cliquez sur « Signaler l'erreur » dans la carte de la réponse en échec. Pour un avis général, cliquez sur « Retour » dans la barre latérale." },
        { title: "Choisir le type", body: "Pour un avis général, choisissez « Signaler un problème », « Demande de fonctionnalité », « Facturation » ou « Autre » et rédigez au moins 5 caractères. Un signalement d’erreur peut être envoyé sans choisir de type et même sans description." },
        { title: "Vérifier les informations jointes", body: "Dans « Voir les détails d'erreur qui seront joints », vérifiez les informations de diagnostic. Les valeurs qui ressemblent à des identifiants sont masquées automatiquement." },
        { title: "Envoyer", body: "Pour recevoir par e-mail la confirmation de réception et le suivi, cochez « Recevoir le statut par e-mail » puis cliquez sur « Envoyer ». Si vous n’êtes pas connecté, cochez cette option et laissez votre adresse e-mail pour recevoir une réponse. Un numéro de référence s’affiche." },
      ],
      faq: [
        { q: "Faut-il absolument indiquer l’ID de suivi ?", a: "C’est facultatif. Le signalement est reçu même sans lui." },
        { q: "L’envoi a échoué.", a: "Ce que vous avez écrit est conservé : renvoyez-le. N’indiquez ni mot de passe ni numéro de carte dans votre signalement." },
      ],
    },
    "sign-in-problems": {
      title: "Quand la connexion ne fonctionne pas",
      summary: "Réessayez dans le même navigateur, avec l’e-mail et la méthode de connexion utilisés lors de votre première inscription.",
      steps: [
        { title: "Vérifier la méthode d’inscription", body: "Vérifiez que vous utilisez l’e-mail et la méthode de connexion (code par e-mail, Google, Microsoft, Apple) de votre inscription." },
        { title: "Redemander un code", body: "Si le code e-mail a expiré, cliquez sur « Envoyer un nouveau code ». Vous pouvez aussi cliquer sur le lien de connexion de l’e-mail." },
        { title: "Quand il y a trop de demandes", body: "Si « Trop de demandes » s’affiche, attendez le temps indiqué. Si vous avez dépassé la limite quotidienne, réessayez le lendemain." },
        { title: "Dans le même navigateur", body: "Poursuivez dans le navigateur où vous avez commencé la connexion. Si la vérification de sécurité échoue, actualisez la page et réessayez." },
        { title: "Prévenir le support", body: "Si cela ne fonctionne toujours pas, envoyez au support votre méthode de connexion et le message d’erreur affiché." },
      ],
      faq: [
        { q: "Un message indique que cet e-mail est déjà utilisé avec une autre méthode de connexion.", a: "Cet e-mail est inscrit avec une autre méthode. Connectez-vous avec celle de votre première inscription." },
        { q: "Un message indique que la connexion est bloquée.", a: "Si la suppression du compte est programmée, la connexion est bloquée. Pour l’annuler, contactez le support dans les 7 jours." },
      ],
    },
    "service-status": {
      title: "Consulter l’état du service",
      summary: "La page d’état affiche l’état de chaque fournisseur de modèles de chat et les éléments sur lesquels cette évaluation repose.",
      steps: [
        { title: "Ouvrir la page d’état", body: "Ouvrez tomverse.app/status. Aucune connexion n’est nécessaire." },
        { title: "Lire le résumé", body: "Vérifiez le résumé en haut de la page et l’heure des « Données au » (UTC)." },
        { title: "Voir l’état par fournisseur", body: "Dans « État des fournisseurs », consultez l’état (opérationnel, service dégradé, incident, inconnu). Si les échecs se concentrent sur un modèle précis, son nom s’affiche aussi." },
      ],
      faq: [
        { q: "« Inconnu » signifie-t-il une panne ?", a: "Non. Cela veut dire qu’il n’y a pas d’élément permettant d’établir l’état, et le service n’est pas non plus présumé fonctionner." },
        { q: "Si « Service dégradé » s’affiche, mes crédits sont-ils épuisés ?", a: "Cet indicateur seul n’indique ni un échec de requête ni un épuisement des crédits." },
        { q: "La génération d’images ou la recherche web apparaissent-elles aussi ?", a: "Non. Cette page n’affiche que l’état des fournisseurs de modèles de chat." },
      ],
    },
    "contact-support": {
      title: "Contacter le support",
      summary: "Écrivez via le formulaire de la page de support ou à support@tomverse.app. Nous répondons en général sous 1 à 2 jours ouvrés.",
      steps: [
        { title: "Ouvrir la page de support", body: "Ouvrez la page de support." },
        { title: "Choisir le type de demande", body: "Choisissez « Support général », « Problème ou bug », « Facturation », « Demande de fonctionnalité » ou « Autre »." },
        { title: "Rédiger le message", body: "Indiquez votre adresse e-mail et votre message. Si un ID de suivi s’affichait à l’écran, saisissez-le dans le champ « Trace ID ou référence »." },
        { title: "Envoyer", body: "Cliquez sur « Envoyer » : un message confirme la réception. Le formulaire n’accepte pas de capture d’écran : envoyez-la séparément à l’adresse e-mail du support." },
      ],
      faq: [
        { q: "Que faut-il joindre ?", a: "L’e-mail du compte, l’heure approximative du problème, le produit et le modèle, le navigateur, la présence d’une pièce jointe et l’ID de suivi affiché. N’envoyez ni mot de passe ni numéro de carte." },
        { q: "Y a-t-il un support téléphonique ?", a: "Non. Nous répondons par e-mail et via le formulaire de contact." },
      ],
    },
  },
};
