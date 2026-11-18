import type { HelpLocaleCopy } from "../types";

/**
 * German copy. Translated from the Korean source (`ko.ts`); screen names use the
 * German strings the product shows, found in `locales/de.ts` and the per-feature
 * copy files. Where no German screen text exists the name is translated
 * naturally and kept identical across the file.
 */
export const de: HelpLocaleCopy = {
  ui: {
    metaTitle: "Tomverse Hilfecenter | Fragen stellen, Antworten erhalten",
    metaDescription: "Chat, Review, Bilder, Recherche, Dateien, Assistenten, Import, Konnektoren, Programmierwerkzeuge sowie Tarife und Credits: mit Schritt-für-Schritt-Anleitungen und dem Hilfe-Assistenten schnell zur Lösung.",
    eyebrow: "Hilfecenter",
    heroTitleLead: "Wobei können wir",
    heroTitleAccent: "Ihnen helfen?",
    heroSubtitle: "Stellen Sie Ihre Frage einfach so, wie sie Ihnen einfällt. Wir suchen die Antwort in den Tomverse-Hilfeartikeln, erklären sie Schritt für Schritt und zeigen Ihnen den passenden Bildschirm.",
    askPlaceholder: "z. B. Wie ändere ich nur den Hintergrund eines erstellten Bildes?",
    askButton: "Frage stellen",
    askMetaLead: "Hilfe-Assistent · antwortet anhand der Hilfeartikel und zeigt die Quellen",
    askMetaPrivacy: "Ihre Chats werden nicht gelesen · keine Credits werden abgezogen",
    askSignIn: "Wenn Sie sich anmelden, können Sie den Hilfe-Assistenten fragen. Bis dahin durchsuchen wir die Anleitungen.",
    askSignInButton: "Anmelden",
    askUnavailable: "Titel und Inhalt der Anleitungen werden direkt durchsucht",
    askThinking: "Die Hilfeartikel werden durchsucht…",
    askError: "Die Antwort konnte gerade nicht abgerufen werden. Versuchen Sie es gleich noch einmal oder sehen Sie sich die Anleitungen unten an.",
    askFollowUp: "Weiter fragen…",
    suggestions: [
      "Drei Antworten in Review vergleichen",
      "Wo sehe ich meine verbleibenden Credits?",
      "ChatGPT-Unterhaltungen importieren",
      "Claude Code mit Tomverse verbinden",
      "Meine Datei lässt sich nicht hochladen",
      "Die Antwort bricht mittendrin ab",
    ],
    searchPlaceholder: "Anleitungen durchsuchen, z. B. Credits, Bildbearbeitung, Konto löschen",
    searchEmpty: "Es wurde keine passende Anleitung gefunden. Suchen Sie mit anderen Wörtern oder wenden Sie sich an den Support.",
    commonTasks: "Häufige Aufgaben",
    allGuides: "Alle Anleitungen",
    byFeature: "Hilfe nach Funktion",
    guideCount: "{count} Anleitungen",
    stepsAndMinutes: "{steps} Schritte · ca. {minutes} Min.",
    newBadge: "NEU",
    noAnswerTitle: "Wenn Sie keine Antwort finden",
    contactTitle: "Keine passende Antwort gefunden?",
    contactBody: "Wenn der Hilfe-Assistent und die Anleitungen nicht weiterhelfen, wenden Sie sich an den Support. In der Regel antworten wir innerhalb von 1–2 Werktagen.",
    contactButton: "Support kontaktieren",
    statusButton: "Servicestatus",
    reportButton: "Fehler melden",
    assistantName: "Hilfe-Assistent",
    foundIn: "✓ In {count} Hilfeartikeln gefunden",
    notFound: "In den Hilfeartikeln wurde keine Antwort gefunden.",
    notFoundBody: "Wir raten nicht. Wenn Sie sich an den Support wenden, prüft das ein Mensch.",
    sources: "Quellen",
    helpful: "War das hilfreich?",
    thanks: "Danke für Ihre Rückmeldung",
    disclaimer: "Der Hilfe-Assistent liest nur die öffentlichen Hilfeartikel. Er liest oder ändert weder Ihre Chats und Dateien noch Ihre Zahlungsdaten. Antworten können fehlerhaft sein; prüfen Sie wichtige Entscheidungen in den verlinkten Anleitungen.",
    openGuide: "Als Schritt-für-Schritt-Anleitung öffnen",
    relatedGuides: "Verwandte Anleitungen",
    requirements: "Voraussetzungen für diese Funktion",
    signInRequired: "Anmeldung erforderlich",
    signInNotRequired: "Ohne Anmeldung möglich",
    planLabel: "Tarif",
    allPlans: "Alle Tarife",
    paidPlans: "Bezahlte Tarife",
    breadcrumbHome: "Hilfecenter",
    stepLabel: "Schritt {n}",
    previous: "Zurück",
    next: "Nächster Schritt",
    faqTitle: "Häufige Fragen",
    stuckTitle: "Hängen Sie bei diesem Schritt fest?",
    stuckBody: "Der Hilfe-Assistent antwortet anhand der Anleitung, die Sie gerade lesen.",
    stuckPlaceholder: "z. B. Ich sehe die Schaltfläche nicht",
    tryItTitle: "Gleich ausprobieren",
    tryItBody: "Öffnen Sie es in einem neuen Tab und folgen Sie dieser Anleitung daneben.",
    tryItButton: "Gleich ausprobieren",
    onThisPage: "Auf dieser Seite",
    stepsSection: "Schritt für Schritt",
    nextGuides: "Als Nächstes lesen",
    backToHelp: "Zurück zum Hilfecenter",
    newQuestion: "Neue Frage",
  },
  categories: {
    "getting-started": { title: "Erste Schritte", description: "Vom Anlegen des Kontos bis zur ersten Frage." },
    chat: { title: "Chat", description: "Mit einem Modell chatten, Modelle wählen und Auto, Fragen verbessern, Spracheingabe." },
    review: { title: "Review · AI Review", description: "Antworten mehrerer Modelle nebeneinander lesen und mit AI Review die Unterschiede prüfen." },
    images: { title: "Bilder", description: "Bilder erstellen, Teile eines Fotos ändern und Ergebnisse verschiedener Modelle vergleichen." },
    research: { title: "Recherche · Websuche", description: "Aktuelle Informationen per Websuche finden und mit Deep Research einen Bericht erhalten." },
    files: { title: "Dateien · Erzeugte Dateien", description: "Dateien hochladen, Google Drive und von der KI erstellte Dateien herunterladen." },
    assistants: { title: "Assistenten · Memory", description: "Eigene Assistenten mit Wissensdateien und das Gedächtnis (Memory) verwalten." },
    imports: { title: "Import · Fortsetzen", description: "Unterhaltungen aus anderen KI-Diensten importieren und weiterführen." },
    connectors: { title: "Konnektoren · MCP", description: "Externe Dienste und MCP-Server verbinden." },
    coding: { title: "Programmierwerkzeuge · API-Schlüssel", description: "Tomverse in Programmierwerkzeuge wie Claude Code und Codex nutzen." },
    projects: { title: "Projekte · Teilen", description: "Unterhaltungen in Projekten ordnen, sperren und teilen." },
    billing: { title: "Tarif · Credits · Abrechnung", description: "Wie Credits verbraucht werden, Tarifwechsel, Kündigung und Rückerstattung." },
    account: { title: "Konto · Datenschutz", description: "Anmeldemethoden, Daten herunterladen, Konto löschen." },
    notifications: { title: "Benachrichtigungen · Mobil", description: "E-Mail-Benachrichtigungen und Nutzung auf dem Smartphone." },
    troubleshooting: { title: "Fehlerbehebung", description: "Abgebrochene Antworten, fehlgeschlagene Uploads, Fehler melden, Servicestatus, Kontakt." },
  },
  guides: {
    // -------------------------------------------------------- getting started
    "create-account": {
      title: "Konto anlegen und anmelden",
      summary: "Legen Sie ein kostenloses Konto mit Ihrem Google-, Microsoft- oder Apple-Konto oder mit einem 6-stelligen Code per E-Mail an und melden Sie sich an.",
      steps: [
        { title: "Anmeldeseite öffnen", body: "Klicken Sie auf „Anmelden / Registrieren“." },
        { title: "Methode wählen", body: "Klicken Sie auf eine Schaltfläche wie „Mit Google fortfahren“ oder „Mit Microsoft fortfahren“, oder geben Sie Ihre „E-Mail-Adresse“ ein und klicken Sie auf „Anmeldecode anfordern“. Welche Schaltflächen Sie sehen, kann je nach Umgebung variieren." },
        { title: "Code eingeben", body: "Geben Sie den 6-stelligen Code aus der E-Mail unter „Code eingeben“ ein und klicken Sie auf „Bestätigen“. Sie können auch auf den Anmeldelink in der E-Mail klicken." },
        { title: "Wenn Sie neu sind", body: "Wenn die E-Mail-Adresse noch nicht registriert ist, klicken Sie auf „Mit dieser Adresse registrieren“." },
        { title: "Wenn kein Code ankommt", body: "Klicken Sie auf „Neuen Code senden“ oder ändern Sie die Adresse über „Andere E-Mail verwenden“." },
      ],
      faq: [
        { q: "Wie lange ist der Code gültig?", a: "Nur wenige Minuten. Ist er abgelaufen, klicken Sie auf „Neuen Code senden“. Wenn Sie mehrmals einen falschen Code eingeben, wird die Eingabe kurz gesperrt." },
        { q: "Kann ich Tomverse ohne Anmeldung nutzen?", a: "Falls angeboten, können Sie es als Gast ausprobieren. Gast-Unterhaltungen werden nur in diesem Browser gespeichert und nicht auf dem Server." },
      ],
    },
    "tour-workspace": {
      title: "Die Startseite kennenlernen",
      summary: "Lernen Sie in der Seitenleiste „Neuer Chat“, die Suche, die Ordnungswerkzeuge, Projekte, das Chat-Menü und den Hilfebereich kennen.",
      steps: [
        { title: "Neuer Chat", body: "Mit „Neuer Chat“ ganz oben in der Seitenleiste öffnen Sie eine neue Unterhaltung." },
        { title: "Chats suchen", body: "Mit „Chats suchen“ finden Sie Unterhaltungen anhand des Titels. Wenn Sie angemeldet sind, werden auch gespeicherte Nachrichteninhalte durchsucht." },
        { title: "Organisation", body: "Klappen Sie „Organisation“ auf, dann sehen Sie die Filter „Passwortschutz“ und „Aktiver Freigabelink“ sowie „Projekte“." },
        { title: "Chat-Menü", body: "Im Menü ⋮ neben einem Chat wählen Sie „Umbenennen“, „Chat anheften“, „In Projekt verschieben“, „Teilen“, „Herunterladen (.txt)“, „Chat sperren“ oder „Löschen“." },
        { title: "Hilfe", body: "Unter „Hilfe“ in der Seitenleiste können Sie die Einführung zur Seitenleiste noch einmal ansehen oder die vollständige Hilfe öffnen." },
      ],
      faq: [
        { q: "Was bedeuten die Markierungen „Gesperrt“ und „Geteilt“?", a: "„Gesperrt“ bedeutet, dass für die Unterhaltung eine Passwortbestätigung nötig ist. „Geteilt“ bedeutet, dass ein öffentlicher Nur-Lese-Link aktiv ist." },
        { q: "Sehe ich angeheftete Chats auch auf anderen Geräten?", a: "Wenn Sie angemeldet sind, werden sie im Konto gespeichert und sind auf anderen Geräten gleich. Ohne Anmeldung bleiben sie nur in diesem Browser." },
      ],
    },
    "chat-vs-review": {
      title: "Der Unterschied zwischen Chat und Review",
      summary: "In Chat führen Sie eine Unterhaltung mit einem Modell. In Review vergleichen Sie die Antworten mehrerer ausgewählter Modelle nebeneinander.",
      steps: [
        { title: "Produkt wählen", body: "Wählen Sie oben auf dem Bildschirm in der Produktauswahl „Chat“ oder „Modellvergleich“ (Review)." },
        { title: "Chat", body: "In Chat antwortet jeweils ein Modell. Wenn Sie ein anderes Modell wählen, antwortet künftig dieses." },
        { title: "Von Chat zum Vergleich", body: "Wenn Sie eine Chat-Antwort mit mehreren Modellen sehen möchten, klicken Sie auf „In Review vergleichen“. Mit dieser Frage wird ein neues Review geöffnet." },
        { title: "Von Review zu Chat", body: "Klicken Sie im Review-Analyseergebnis auf „Im Chat fortsetzen“, um als Entwurf in Chat weiterzumachen." },
      ],
      faq: [
        { q: "Kann ich eine bestehende Unterhaltung in ein anderes Produkt verschieben?", a: "Eine Unterhaltung wird in dem Produkt geöffnet, in dem sie erstellt wurde. Vergleichen oder Fortsetzen legt jeweils eine neue Unterhaltung an." },
        { q: "Was ist der Unterschied zwischen „Easy“ und „Professional“ in Review?", a: "Falls angeboten, wählen Sie bei Easy nur die Anbieter und Tomverse wählt je Frage die Modelle. Bei Professional wählen Sie die Modelle selbst." },
      ],
    },
    // ------------------------------------------------------------------- chat
    "choose-model-auto": {
      title: "Modelle wählen und die intelligente Automatik",
      summary: "Ist die intelligente Automatik an, wird für jede Nachricht ein Modell gewählt. Ist sie aus, antwortet das Modell, das Sie selbst gewählt haben.",
      steps: [
        { title: "Intelligente Automatik prüfen", body: "Wenn Ihr Konto sie anbietet, gibt es im Eingabefeld den Schalter „Intelligente Automatik“. In einem leeren Chat ist er zunächst eingeschaltet." },
        { title: "Selbst wählen", body: "Öffnen Sie die Modellauswahl und klicken Sie im Tab „Chat“ auf ein Modell. Die intelligente Automatik wird dann ausgeschaltet und das gewählte Modell antwortet." },
        { title: "Antwortendes Modell sehen", body: "Am Etikett „Automatisch · Modellname“ unter der Antwort sehen Sie, welches Modell tatsächlich geantwortet hat." },
        { title: "Verstandene Nachricht ansehen", body: "Hat Auto Ihre Nachricht umformuliert, können Sie unter dem Etikett „So hat Auto Ihre Nachricht gelesen“ aufklappen." },
      ],
      faq: [
        { q: "Wie viele Credits werden verbraucht?", a: "Bei der intelligenten Automatik hängen die Credits vom antwortenden Modell ab. Wenn Sie selbst wählen, gelten die Basis-Credits, die in der Modellauswahl angezeigt werden." },
        { q: "Wird meine gesendete Nachricht verändert gespeichert?", a: "Nein. Ihre Nachricht wird so gespeichert, wie Sie sie geschrieben haben." },
        { q: "Kann die intelligente Automatik nicht mehr ausgeschaltet werden?", a: "Doch. Sie können sie jederzeit ausschalten, indem Sie selbst ein Modell wählen." },
      ],
    },
    "prompt-refiner": {
      title: "Vorschläge zur Verbesserung von Fragen nutzen",
      summary: "„Formulierung verbessern“ schlägt eine klarere Formulierung vor, ohne Ihre Frage zu senden. Ob Sie sie verwenden, entscheiden Sie selbst.",
      steps: [
        { title: "Vorschlag anfordern", body: "Falls angeboten, schreiben Sie Ihre Frage ins Eingabefeld und klicken Sie auf „Formulierung verbessern“." },
        { title: "Vergleichen", body: "„Original“ und „Vorgeschlagene Formulierung“ werden nebeneinander angezeigt." },
        { title: "Auswählen", body: "Klicken Sie auf „Diese Formulierung verwenden“ oder „Original behalten“. Mit beiden wird noch nichts gesendet." },
        { title: "Senden", body: "Klicken Sie wie gewohnt auf „Senden“. Schlägt es fehl, klicken Sie auf „Erneut versuchen“; Ihr Original bleibt unverändert." },
      ],
      faq: [
        { q: "Was passiert, wenn ich meinen Text ändere, während der Vorschlag erstellt wird?", a: "Schon bei einer Änderung um ein einziges Zeichen verfällt der Vorschlag. Klicken Sie dann erneut auf „Formulierung verbessern“." },
        { q: "Werden auch meine Dateien oder mein Chatverlauf gelesen?", a: "Nur der Text, den Sie gerade eingegeben haben. Chatverlauf, Anhänge und Gedächtnis werden nicht verwendet." },
      ],
    },
    "voice-input": {
      title: "Per Sprache eingeben",
      summary: "Sie sprechen ins Mikrofon, der Text erscheint im Eingabefeld und Sie können ihn vor dem Senden korrigieren.",
      steps: [
        { title: "Aufnahme starten", body: "Falls angeboten, klicken Sie unter dem Eingabefeld auf das Mikrofon („Spracheingabe aufnehmen“). Wenn der Browser nach der Mikrofonberechtigung fragt, erlauben Sie sie." },
        { title: "Sprechen", body: "Während Sie sprechen, werden über dem Eingabefeld „Aufnahme“ und die Zeit angezeigt." },
        { title: "In Text umwandeln", body: "Wenn Sie dieselbe Schaltfläche noch einmal anklicken, erscheint der Text nach der Umwandlung im Eingabefeld." },
        { title: "Korrigieren und senden", body: "Korrigieren Sie den Text und klicken Sie dann auf „Senden“. Zum Verwerfen klicken Sie auf „Verwerfen“." },
      ],
      faq: [
        { q: "Wird die Aufnahme gespeichert?", a: "Tomverse speichert keine Aufnahmen. Die Aufnahme wird nur zur Umwandlung in Text an einen Anbieter für Spracherkennung gesendet; verworfene Aufnahmen werden nicht gesendet." },
        { q: "Werden Credits verbraucht?", a: "Die Spracheingabe zieht keine Credits ab. Es kann jedoch ein Tageslimit geben." },
        { q: "Die Aufnahme funktioniert nicht.", a: "Sie funktioniert in aktuellen Versionen von Chrome, Edge, Safari und Firefox. Ist das Mikrofon blockiert, erlauben Sie es für diese Website in den Browsereinstellungen." },
      ],
    },
    "chat-starters": {
      title: "Fragen mit Startvorschlägen ausfüllen",
      summary: "Wenn Sie in einem neuen Chat eine Beispielkarte wählen, wird die Frage ins Eingabefeld eingetragen. Vor dem Senden wird nichts übertragen.",
      steps: [
        { title: "Karte wählen", body: "Falls angeboten, klicken Sie im neuen Chat auf eine Karte unter „Was hier möglich ist“. Mit „Weitere Vorschläge“ sehen Sie mehr." },
        { title: "Anpassen", body: "Ändern Sie den eingetragenen Text nach Ihren Wünschen." },
        { title: "Senden", body: "Erst mit „Senden“ wird wirklich gesendet. Karten mit Markierungen wie „Anmeldung nötig“ führen beim Anklicken zur Anmeldung oder zu den Tarifinformationen." },
      ],
      faq: [
        { q: "Wird mein bereits geschriebener Text gelöscht?", a: "Nein. Der Text wird nur ersetzt, wenn das Eingabefeld leer ist oder noch genau den Text der zuvor gewählten Karte enthält." },
        { q: "Kostet das Anklicken einer Karte Credits?", a: "Allein durch das Anklicken nicht. Karten, die die Websuche einschalten, etwa Quellenkarten, können beim nächsten Senden jedoch mehr Credits kosten." },
      ],
    },
    // ----------------------------------------------------------------- review
    "compare-answers": {
      title: "Antworten mehrerer Modelle nebeneinander vergleichen",
      summary: "Senden Sie in Review dieselbe Frage an bis zu 3 Modelle und lesen Sie die Antworten nebeneinander.",
      steps: [
        { title: "Modelle wählen", body: "Öffnen Sie in Review die Modellauswahl und wählen Sie bis zu 3 Modelle. Sind es schon 3, wählen Sie das Modell, das Sie ersetzen möchten." },
        { title: "Frage senden", body: "Schreiben Sie Ihre Frage und klicken Sie auf „Senden“. Die gewählten Modelle antworten gleichzeitig." },
        { title: "Nur ein Modell fragen", body: "Wenn Sie nur ein Modell weiterfragen möchten, nutzen Sie in dessen Bereich „Nur dieses Modell fragen“." },
        { title: "Ansicht wechseln", body: "Wechseln Sie zwischen „Fokus“ und „Nebeneinander“. Beim Wechseln der Ansicht wird nichts erneut gesendet." },
        { title: "Modell entfernen", body: "Klicken Sie auf „Aus dem Vergleich entfernen“. Mit „Rückgängig“ machen Sie das rückgängig." },
      ],
      faq: [
        { q: "Werden Credits pro Modell berechnet?", a: "Ja. Für jedes gewählte Modell werden Credits für die Antwort berechnet." },
        { q: "Kann ich auch ohne Anmeldung vergleichen?", a: "Falls angeboten, können auch Gäste bis zu 3 Modelle vergleichen." },
      ],
    },
    "read-ai-review": {
      title: "AI Review starten und lesen",
      summary: "Sobald mindestens 2 Antworten fertig sind, fasst ein eigenes Prüfmodell Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken und Prüfbedarf zusammen.",
      steps: [
        { title: "Antworten bereithalten", body: "Prüfen Sie, dass mindestens 2 Antworten auf dieselbe Frage fertig sind." },
        { title: "Starten", body: "Klicken Sie auf „KI-Gegenprüfung der Antworten“ (im Desktop-Studio „Antworten mit Tomverse analysieren“)." },
        { title: "Maßstab wählen", body: "Wenn Sie den Maßstab wählen können, wählen Sie „Ausgewogen“, „Belege“ oder „Handlung“ und klicken Sie auf „Gegenprüfung starten“." },
        { title: "Ergebnis lesen", body: "Lesen Sie in dieser Reihenfolge: Gemeinsamkeiten, wichtige Unterschiede, Widersprüche, Lücken und Punkte, die geprüft werden sollten." },
        { title: "Rückmeldung geben", body: "Zu jedem Punkt können Sie „Hilfreich“, „Falsch“, „Unklar“ oder „Wichtiger Punkt fehlt“ wählen." },
      ],
      faq: [
        { q: "Sagt mir AI Review die richtige Antwort?", a: "Nein. Es vergleicht nur die vorliegenden Antworten miteinander und führt weder eine Websuche noch eine externe Faktenprüfung durch." },
        { q: "Was geschieht mit den Credits, wenn es fehlschlägt?", a: "Wenn es nicht abgeschlossen werden kann, werden reservierte Credits zurückgegeben. Die Kosten werden vor dem Start auf dem Bildschirm angezeigt." },
        { q: "Gibt es eine Begrenzung der Anzahl?", a: "Für Gäste und Free gibt es ein monatliches Limit. Die verbleibende Anzahl sehen Sie auf dem Bildschirm." },
      ],
    },
    "follow-citations": {
      title: "Zitaten zu den Prüfergebnissen folgen",
      summary: "Öffnen Sie das Originalzitat zu einem Prüfergebnis und sehen Sie, welche Stelle der tatsächlichen Antwort gemeint ist.",
      steps: [
        { title: "Punkt wählen", body: "Wählen Sie unter „Prüfergebnisse“ einen Punkt. Über dem Zitat steht, aus welcher Antwort (A/B/C) es stammt." },
        { title: "Prüfmarkierung ansehen", body: "Es wird angezeigt, ob das Zitat im Original bestätigt wurde oder nicht bestätigt und daher mit mehr Vorsicht zu lesen ist." },
        { title: "Zum Original springen", body: "Mit „In der Originalantwort ansehen“ unter dem Zitat gelangen Sie an diese Stelle im Originaltext der Antwort." },
        { title: "Im Web prüfen (optional)", body: "Bei Bedarf klicken Sie nur für diesen Punkt auf „Mit Websuche prüfen“. Das läuft separat, kostet Credits und ändert die ursprüngliche Prüfung nicht." },
      ],
      faq: [
        { q: "Ist ein Zitat mit „Belegt“ wahr?", a: "Nein. Es bedeutet nur, dass diese Formulierung in der Antwort steht; es ist keine Garantie, dass der Inhalt stimmt." },
        { q: "Ist die Quellenübereinstimmung ein Maß für Genauigkeit?", a: "Nein. Sie zeigt nur, wie gut die Zitatformulierung mit dem Original übereinstimmt." },
      ],
    },
    "save-share-review": {
      title: "Vergleiche und Analysen speichern, teilen und exportieren",
      summary: "Wenn Sie angemeldet sind, werden Unterhaltung und Analyse gespeichert. Die Analyse können Sie über einen Nur-Lese-Link teilen oder als Datei exportieren.",
      steps: [
        { title: "Anmelden und vergleichen", body: "Wenn Sie angemeldet vergleichen, werden Unterhaltung und Analyseergebnis in Ihrem Konto gespeichert. Die Analyse eines Gastes verschwindet beim Neuladen." },
        { title: "Analyse teilen", body: "Klicken Sie unter dem Analyseergebnis auf „Analyse teilen“, prüfen Sie, was veröffentlicht wird, und klicken Sie auf „Link veröffentlichen“." },
        { title: "Link senden und beenden", body: "Senden Sie den Link mit „Link kopieren“. Zum Beenden klicken Sie auf „Link widerrufen“." },
        { title: "Als Datei speichern", body: "Klicken Sie auf „Exportieren“ und wählen Sie das Dateiformat (PDF, Word, TXT, Markdown)." },
      ],
      faq: [
        { q: "Was geschieht mit dem bisherigen Freigabelink der Unterhaltung, wenn ich die Analyse teile?", a: "Der bisherige Freigabelink dieser Unterhaltung wird durch den neuen Link ersetzt." },
        { q: "Was enthält die exportierte Datei?", a: "Sie enthält die gesamte Analyse, die Frage, die Herkunft nach Modell und ob die Zitate übereinstimmen. Die vollständigen Modellantworten und Anhänge sind nicht enthalten." },
      ],
    },
    // ----------------------------------------------------------------- images
    "create-image": {
      title: "Bilder im Chat erstellen",
      summary: "Beschreiben Sie im Chat die gewünschte Szene. Wird die Nachricht als Bildanfrage erkannt, antwortet Tomverse in derselben Unterhaltung mit einem Bild.",
      steps: [
        { title: "Anfrage schreiben", body: "Schreiben Sie in das Chat-Eingabefeld die gewünschte Szene, zum Beispiel „Erstellen Sie bitte ein Bild: …“." },
        { title: "Senden", body: "Senden Sie die Nachricht. Es gibt keine Rückfrage; an der Stelle der Antwort erscheint „Bild wird erstellt…“." },
        { title: "Ergebnis ansehen", body: "Nach der Fertigstellung erscheint eine Qualitätsmarkierung (Entwurf, Standard, Hohe Qualität). Brauchen Sie mehr Qualität, senden Sie „Erstellen Sie dieses Bild bitte in hoher Qualität neu“." },
        { title: "Weiter anpassen", body: "Wenn Sie zum Beispiel „Machen Sie es bitte blauer“ senden, wird auf Basis des vorigen Bildes neu gezeichnet." },
      ],
      faq: [
        { q: "Wann werden Credits verbraucht?", a: "Wenn Chat mit einem Bild antwortet, werden ohne Rückfrage sofort Bild-Credits verbraucht. Auch beim Neuerstellen in hoher Qualität fallen Credits an." },
        { q: "Was ist, wenn die Nachricht nicht als Bildanfrage erkannt wird?", a: "Dann erhalten Sie eine normale Textantwort." },
        { q: "Sind Bilder enthalten, wenn ich die Unterhaltung teile oder exportiere?", a: "Nein. Es steht nur ein Satz, dass ein Bild erstellt wurde." },
      ],
    },
    "compare-image-models": {
      title: "Bildergebnisse mehrerer Modelle vergleichen",
      summary: "Senden Sie auf dem Bildbildschirm eine Beschreibung gleichzeitig an mehrere Modelle und vergleichen Sie die Ergebnisse nebeneinander.",
      steps: [
        { title: "Bildbildschirm öffnen", body: "Wählen Sie in der Seitenleiste neben „Neuer Chat“ unter „Neu…“ den Eintrag „Neues Bild“. Sie können auch in der Modellauswahl im Tab „Bild“ ein Modell wählen." },
        { title: "Modelle wählen", body: "Wählen Sie unter „Modelle“ die Modelle für den Vergleich. Wie viele Sie auf einmal wählen können, wird angezeigt." },
        { title: "Qualität und Größe", body: "Wählen Sie „Qualität“ (Entwurf, Standard, Final) und „Größe“ (Quadratisch, Querformat, Hochformat)." },
        { title: "Beschreiben und generieren", body: "Beschreiben Sie das gewünschte Bild, prüfen Sie den Preis je Modell und die Gesamtsumme der Credits und klicken Sie auf „Generieren“." },
        { title: "Ergebnis speichern", body: "Klicken Sie auf „Originalgröße“ oder „Herunterladen“. Für ein fehlgeschlagenes Modell können Sie nur dieses mit „Dieses Modell erneut versuchen“ wiederholen." },
      ],
      faq: [
        { q: "Wird die Erstellung abgebrochen, wenn ich die Seite verlasse?", a: "Nein. Sie kann bis zu etwa 2 Minuten dauern und läuft auch weiter, wenn Sie die Seite verlassen." },
        { q: "Der Link „Originalgröße“ lässt sich nicht öffnen.", a: "Der Link zum Original ist nur wenige Minuten gültig. Klicken Sie nach kurzer Zeit erneut, dann wird ein neuer Link erstellt." },
      ],
    },
    "edit-photo": {
      title: "Ein angehängtes Foto bearbeiten",
      summary: "Hängen Sie im Chat ein Foto an und beschreiben Sie die Änderung. Wird dies als Bearbeitungsanfrage erkannt, antwortet Tomverse mit dem bearbeiteten Bild.",
      steps: [
        { title: "Foto anhängen", body: "Hängen Sie unter „Hinzufügen und Werkzeuge“ des Eingabefelds über „Datei hinzufügen“ ein Foto an (PNG, JPEG, WebP, GIF)." },
        { title: "Änderung beschreiben", body: "Schreiben Sie, was geändert werden soll, zum Beispiel „Ersetzen Sie den Hintergrund durch einen Strand bei Sonnenuntergang“." },
        { title: "Senden", body: "Bei einer Bearbeitungsanfrage erhalten Sie das bearbeitete Bild, sonst eine normale Antwort auf das Foto." },
      ],
      faq: [
        { q: "Wird das Originalfoto verändert?", a: "Nein. Ihr hochgeladenes Foto bleibt unverändert und es wird ein neues Bild erstellt." },
        { q: "Was passiert, wenn ich mehrere Fotos anhänge?", a: "Bearbeitet wird das erste der angehängten Fotos." },
        { q: "Wie viele Credits werden verbraucht?", a: "Zu den Credits für die Bilderstellung können modellabhängige Credits für die Bearbeitung hinzukommen." },
      ],
    },
    "image-credits": {
      title: "Bild-Credits und Rückgabe",
      summary: "Bilder verbrauchen je nach Qualität und Größe festgelegte Credits. Schlägt die Erstellung fehl, werden alle reservierten Credits zurückgegeben.",
      steps: [
        { title: "Preis ansehen", body: "Prüfen Sie auf dem Bildbildschirm den Preis je Modell und die Gesamtsumme der Credits." },
        { title: "Generieren", body: "Wenn Sie auf „Generieren“ klicken, werden die Credits zuerst reserviert." },
        { title: "Abrechnung", body: "Bei Erfolg werden die angezeigten Credits verbraucht, bei Misserfolg erhalten Sie die reservierten Credits zurück." },
      ],
      faq: [
        { q: "In welchen Tarifen kann ich das nutzen?", a: "Wenn Sie angemeldet sind, können Free, Pro und Max es im Rahmen ihrer Credits nutzen." },
        { q: "Wann bekomme ich Credits zurück?", a: "Wenn wegen einer Ablehnung durch den Anbieter, einer Sicherheitssperre, eines Fehlers oder einer Zeitüberschreitung kein Bild erstellt wurde." },
        { q: "Es erscheint „Die heutigen Plan-Credits sind aufgebraucht“.", a: "Auch Bilder verbrauchen die täglichen Plan-Credits. Wenn Sie gekaufte Credits haben, können Sie weiterarbeiten." },
      ],
    },
    // --------------------------------------------------------------- research
    "deep-research": {
      title: "Deep Research starten",
      summary: "Schreiben Sie eine Frage und starten Sie „Deep Research“. Aus mehreren Webquellen wird über einige Minuten ein Bericht erstellt.",
      steps: [
        { title: "Frage schreiben", body: "Schreiben Sie zuerst die Frage, die recherchiert werden soll, ins Eingabefeld." },
        { title: "Deep Research öffnen", body: "Klicken Sie im Menü „Hinzufügen und Werkzeuge“ des Eingabefelds auf „Deep Research“." },
        { title: "Umfang wählen", body: "Wählen Sie den Umfang („Schnell“, „Standard“ oder „Tief“) und prüfen Sie die geschätzte Dauer und die geschätzte Nutzung." },
        { title: "Starten", body: "Klicken Sie auf „Recherche starten“. Der Fortschritt wird in der Reihenfolge Materialsuche, Berichtserstellung angezeigt." },
        { title: "Mit einer Vorschlagskarte starten", body: "Erscheint unter einer normalen Antwort die Karte „Mit Deep Research vertiefen“, können Sie darauf klicken und direkt im Umfang „Standard“ starten." },
      ],
      faq: [
        { q: "In welchen Tarifen kann ich das nutzen?", a: "Mit Anmeldung in Pro und Max." },
        { q: "Wird die Recherche abgebrochen, wenn ich den Fortschrittschip entferne?", a: "Nein. Die Recherche läuft im Hintergrund weiter." },
        { q: "Werden beim Klick auf die Vorschlagskarte sofort Credits verbraucht?", a: "Ja. Es wird ohne Rückfrage zum Umfang direkt im Umfang „Standard“ gestartet." },
      ],
    },
    "web-search": {
      title: "Websuche einschalten und Quellen prüfen",
      summary: "Wenn die Websuche an ist, wird bei Bedarf an aktuellen Informationen oder Quellen automatisch gesucht und unter der Antwort werden Quellenlinks angezeigt.",
      steps: [
        { title: "Websuche einschalten", body: "Schalten Sie im Menü „Hinzufügen und Werkzeuge“ des Eingabefelds den Schalter „Websuche“ ein." },
        { title: "Status ansehen", body: "Wenn Sie im Eingabefeld auf den Chip „Websuche an“ klicken, sehen Sie, wie viele der gewählten Modelle die Suche unterstützen." },
        { title: "Quellen öffnen", body: "Ein Klick auf einen Link in der Liste „Quellen“ unter der Antwort öffnet ihn in einem neuen Tab." },
        { title: "Erneute Suche vorschlagen lassen", body: "Wenn Sie bei ausgeschalteter Suche eine Frage stellen, die aktuelle Informationen braucht, erscheint die Karte „Im Web nachsehen“. Ein Klick sendet dieselbe Frage erneut, diesmal mit Suche." },
      ],
      faq: [
        { q: "Entstehen zusätzliche Credits?", a: "Für jedes Modell, das tatsächlich gesucht hat, fallen festgelegte Credits an; für Modelle ohne Suche werden sie zurückgegeben." },
        { q: "Es erscheint „Die antwortenden Modelle können nicht im Web suchen“.", a: "Keines der gewählten Modelle unterstützt die Suche. Fügen Sie ein Modell hinzu, das die Suche unterstützt." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Dateien anhängen: Formate und Größe",
      summary: "Sie können Bilder, PDF, Office-, Hangul-, Text-, Code- und ZIP-Dateien zu mehreren pro Nachricht anhängen.",
      steps: [
        { title: "Datei hinzufügen", body: "Klicken Sie unter „Hinzufügen und Werkzeuge“ des Eingabefelds auf „Datei hinzufügen“ → „Vom Computer auswählen“, oder ziehen Sie die Datei in das Eingabefeld." },
        { title: "Prüfung abwarten", body: "Warten Sie, bis die Anzeigen „Wird hochgeladen“ und „Wird geprüft“ verschwunden sind." },
        { title: "Senden", body: "Senden Sie die Nachricht." },
      ],
      faq: [
        { q: "Wie viele und wie große Dateien sind möglich?", a: "Angemeldet bis zu 5 Dateien pro Nachricht und 10 MB pro Datei. Als Gast 1 Datei mit 5 MB. Die Limits können sich ändern; maßgeblich sind die Hinweise auf dem Bildschirm." },
        { q: "Welche Dateien werden nicht akzeptiert?", a: "Ausführbare Dateien, andere Archive als ZIP (RAR, 7Z usw.), Audio und Video, HEIC und TIFF, animierte GIFs sowie passwortgeschützte Dokumente." },
        { q: "Wie lange werden angehängte Dateien aufbewahrt?", a: "Anhänge angemeldeter Nutzer werden zusammen mit der Unterhaltung aufbewahrt und beim Löschen der Unterhaltung oder des Kontos mitgelöscht. Gastdateien werden kurz aufbewahrt und dann automatisch gelöscht." },
      ],
    },
    "google-drive": {
      title: "Dateien aus Google Drive anhängen",
      summary: "Wählen Sie Google Docs, Tabellen und Präsentationen aus Drive und hängen Sie sie an die Unterhaltung an.",
      steps: [
        { title: "Drive öffnen", body: "Klicken Sie unter „Hinzufügen und Werkzeuge“ des Eingabefelds auf „Datei hinzufügen“ → „Aus Google Drive anhängen“." },
        { title: "Berechtigung erteilen", body: "Wenn das Google-Berechtigungsfenster erscheint, erlauben Sie den Zugriff. Er gilt nur für die Dateien, die Sie auswählen." },
        { title: "Datei wählen", body: "Wählen Sie im Google-Auswahlfenster die Dateien aus. Sie können mehrere wählen, Ordner jedoch nicht." },
        { title: "Senden", body: "Sobald der Anhangchip erscheint, senden Sie die Nachricht." },
      ],
      faq: [
        { q: "Muss ich angemeldet sein?", a: "Ja. Google Drive können Sie erst nach der Anmeldung nutzen." },
        { q: "Welche Dateien werden angezeigt?", a: "Google Docs, Tabellen und Präsentationen werden angezeigt und jeweils als Text, xlsx und pptx umgewandelt angehängt." },
      ],
    },
    "generated-files": {
      title: "Von der KI erstellte Dateien herunterladen",
      summary: "Wenn Sie zum Beispiel „Erstelle das als Excel-Datei“ anfragen, erscheint unter der Antwort eine Karte „Erzeugte Datei“, über die Sie sie herunterladen.",
      steps: [
        { title: "Format nennen", body: "Fordern Sie die Datei im Chat an und nennen Sie das gewünschte Format (Excel, Word, PDF, PowerPoint, CSV usw.)." },
        { title: "Abwarten", body: "Während der Erstellung wird „… wird erstellt…“ angezeigt." },
        { title: "Herunterladen", body: "Klicken Sie auf der Karte „Erzeugte Datei“ unter der Antwort auf „Herunterladen“. Schlägt es fehl, klicken Sie auf „Datei erneut erstellen“." },
        { title: "Änderungen anfordern", body: "Mit „Überarbeitete Datei erstellen“ wird im Eingabefeld ein Entwurf mit der angehängten Datei ausgefüllt. Sie müssen ihn selbst senden; es wird eine neue Version erstellt." },
      ],
      faq: [
        { q: "Muss ich angemeldet sein?", a: "Ja. Angemeldet können Sie es unabhängig vom Tarif nutzen." },
        { q: "Es erscheint „Entsperren Sie diese Unterhaltung, um die Datei herunterzuladen“.", a: "Dateien aus gesperrten Unterhaltungen lassen sich erst nach dem Entsperren herunterladen." },
        { q: "Wird die ursprüngliche Datei überschrieben, wenn ich Änderungen anfordere?", a: "Nein. Es entsteht eine neue Version und in der Liste „Dateiversionen“ sehen Sie die früheren Versionen." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Eigenen Assistenten anlegen und Wissensdateien hinzufügen",
      summary: "Fassen Sie Name, Anweisungen, Modell und Wissensdateien zu einem Assistenten zusammen, den nur Sie nutzen, und wählen Sie ihn im Chat aus.",
      steps: [
        { title: "Anlegen beginnen", body: "Falls angeboten, klicken Sie in den „Einstellungen“ im Tab „KI-Assistenten“ auf „Neuer Assistent“. Sie können auch im Werkzeugmenü des Chats unter „Assistent“ beginnen." },
        { title: "Name und Anweisungen", body: "Geben Sie „Name“ und „Eigene Anweisungen“ ein und klicken Sie auf „Assistent anlegen“." },
        { title: "Wissensdateien hinzufügen", body: "Klicken Sie unter „Wissensdateien, die diese Revision nutzen darf“ auf „Datei hinzufügen“ und warten Sie, bis „bereit“ angezeigt wird." },
        { title: "Speichern", body: "Klicken Sie auf „Anweisungen, Modelle und Dateien speichern“. Bei jedem Speichern entsteht eine neue Revision." },
        { title: "Im Chat nutzen", body: "Klicken Sie auf „Mit diesem Assistenten chatten“ oder wählen Sie ihn im Werkzeugmenü des Chats unter „Assistent“." },
      ],
      faq: [
        { q: "Welche Dateien kann ich als Wissen hinzufügen?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods und odp. Bilder können nicht hinzugefügt werden." },
        { q: "Gilt eine geänderte Anweisung auch für laufende Unterhaltungen?", a: "Nein. Sie ändert sich erst, wenn Sie im Chat auf „Hier die neueste Revision verwenden“ klicken." },
        { q: "Können andere meinen Assistenten sehen?", a: "Nein. Assistenten werden nur in Ihrem Konto verwendet und nicht geteilt." },
      ],
    },
    "manage-memory": {
      title: "Gedächtnis (Memory) ansehen, ausschalten und löschen",
      summary: "Sie können gespeicherte Erinnerungen ansehen und ändern, sie insgesamt oder pro Unterhaltung ausschalten und einzeln oder alle löschen.",
      steps: [
        { title: "Gedächtnisverwaltung öffnen", body: "Klicken Sie in den „Einstellungen“ im Tab „KI-Personalisierung“ in der Zeile „Konto-Langzeitgedächtnis“ auf „Gedächtnis verwalten“." },
        { title: "Ansehen und ändern", body: "Klicken Sie unter „Verwendete Erinnerungen“ auf „Bearbeiten“, „Fixieren“ oder „Löschen“. Zum Löschen müssen Sie ein zweites Mal klicken." },
        { title: "Insgesamt ausschalten", body: "Schalten Sie unter „Einstellungen zur Gedächtnisnutzung“ die Option „Erinnerungen in allen Chats verwenden“ aus. Gespeicherte Erinnerungen werden dadurch nicht gelöscht." },
        { title: "Pro Unterhaltung ausschalten", body: "Wählen Sie unter „Hinzufügen und Werkzeuge“ des Eingabefelds bei „Kontogedächtnis“ die Option „In dieser Unterhaltung nicht verwenden“." },
        { title: "Alles löschen", body: "Sichern Sie bei Bedarf zuerst mit „Alles herunterladen (JSON)“ und löschen Sie dann mit „Alle Erinnerungen löschen“, indem Sie den Bestätigungstext eingeben. Das kann nicht rückgängig gemacht werden." },
      ],
      faq: [
        { q: "Woher kommen Erinnerungen?", a: "Aus importierten Unterhaltungen anderer KI-Dienste zusammengefasste Inhalte sowie solche, die Sie über „Erinnerung selbst hinzufügen“ eingeben." },
        { q: "Werden Erinnerungen an KI-Anbieter weitergegeben?", a: "Bei Antworten, die Erinnerungen verwenden, werden sie als Referenz an den KI-Anbieter weitergegeben, der die Antwort erstellt." },
        { q: "Werden importierte Unterhaltungen mitgelöscht, wenn ich alle Erinnerungen lösche?", a: "Nein. Importierte Unterhaltungen löschen Sie gesondert unter „Importe verwalten“." },
      ],
    },
    // --------------------------------------------------------------- projects
    "organise-projects": {
      title: "Unterhaltungen mit Projekten ordnen",
      summary: "Fassen Sie zusammengehörige Unterhaltungen wie in Ordnern zusammen. Unterhaltungen im selben Projekt teilen weder Inhalte noch Dateien miteinander.",
      steps: [
        { title: "Projekt anlegen", body: "Klicken Sie in der Seitenleiste neben „Projekte“ auf „Neu“ (beim ersten Mal auf „Erstes Projekt erstellen“) und geben Sie einen Namen ein." },
        { title: "Unterhaltung verschieben", body: "Wählen Sie im Menü ⋮ der Unterhaltung unter „In Projekt verschieben“ das Projekt." },
        { title: "Entfernen und umbenennen", body: "Mit „Aus Projekt entfernen“ nehmen Sie eine Unterhaltung heraus, mit der Stiftschaltfläche benennen Sie das Projekt um." },
        { title: "Projekt löschen", body: "Klicken Sie auf „Projekt löschen“ und bestätigen Sie noch einmal. Die Unterhaltungen werden nur nach „Nicht kategorisiert“ verschoben und nicht gelöscht." },
      ],
      faq: [
        { q: "Kann ich einem Projekt gemeinsame Anweisungen oder Dateien hinzufügen?", a: "Nein. Ein Projekt ist ein Ordner zum Ordnen. Gemeinsame Anweisungen und Dateien erhalten Sie mit einem Assistenten." },
        { q: "Wie viele Projekte kann ich anlegen?", a: "Bis zu 24 pro Konto." },
      ],
    },
    "lock-conversation": {
      title: "Unterhaltung sperren (Passwort)",
      summary: "Mit einem Passwort wird vor dem Öffnen, Teilen, Herunterladen, Bearbeiten und Löschen einer Unterhaltung das Passwort abgefragt.",
      steps: [
        { title: "Sperre beginnen", body: "Klicken Sie im Menü ⋮ der Unterhaltung auf „Chat sperren“." },
        { title: "Passwort festlegen", body: "Geben Sie ein Passwort mit 8 bis 128 Zeichen ein." },
        { title: "Gesperrte Unterhaltung öffnen", body: "Beim Öffnen einer gesperrten Unterhaltung wird nach dem Passwort gefragt. Nach der Bestätigung wird eine Zeit lang nicht erneut gefragt." },
        { title: "Sperre aufheben", body: "Klicken Sie im Menü auf „Entsperren“ und geben Sie das Passwort ein." },
      ],
      faq: [
        { q: "Was ist, wenn ich das Passwort vergesse?", a: "Tomverse kann Ihnen das Passwort weder anzeigen noch wiederherstellen. Wenden Sie sich an den Support." },
        { q: "Wird die Unterhaltung durch die Sperre verschlüsselt?", a: "Nein. Es ist nur eine Zugriffssperre. Beim Erzeugen einer Antwort wird der Inhalt an den KI-Anbieter weitergegeben." },
      ],
    },
    "share-link": {
      title: "Freigabelink erstellen und beenden",
      summary: "Die aktuelle Unterhaltung wird zu einer öffentlichen Nur-Lese-Seite. Wer den Link hat, kann sie ohne Anmeldung ansehen.",
      steps: [
        { title: "Teilen öffnen", body: "Klicken Sie im Menü ⋮ der Unterhaltung auf „Teilen“. Eine gesperrte Unterhaltung entsperren Sie zuerst." },
        { title: "Link erstellen", body: "Lesen Sie den Hinweis und klicken Sie auf „Freigabelink erstellen“. Der Link wird dann kopiert." },
        { title: "Aktuellen Stand übernehmen", body: "Nach dem Teilen gesendete Nachrichten werden nicht automatisch ergänzt. Zum Übernehmen klicken Sie auf „Freigabelink neu erstellen“." },
        { title: "Teilen beenden", body: "Wenn Sie auf „Freigabe beenden“ klicken, funktioniert der bisherige Link sofort nicht mehr." },
      ],
      faq: [
        { q: "Wie lange ist der Link gültig?", a: "Er läuft nach einer festgelegten Zeit ab. Das Ablaufdatum steht auf der Freigabeseite." },
        { q: "Wird auch mein Gedächtnis (Memory) geteilt?", a: "Nein. Inhalte des Gedächtnisses werden nicht geteilt. Löschen Sie sensible Inhalte vor dem Teilen." },
      ],
    },
    // ---------------------------------------------------------------- imports
    "import-chatgpt": {
      title: "ChatGPT-Unterhaltungen importieren",
      summary: "Laden Sie die Datenexport-Datei von ChatGPT hoch, um frühere Unterhaltungen in Ihrem Tomverse-Konto zu speichern. Die Originaldatei wird nur im Browser gelesen.",
      steps: [
        { title: "In ChatGPT exportieren", body: "Fordern Sie in ChatGPT unter Einstellungen → Datenkontrolle den Datenexport an und laden Sie die ZIP-Datei über den Link in der E-Mail herunter. Sie müssen sie nicht entpacken." },
        { title: "Importbildschirm öffnen", body: "Klicken Sie in den Tomverse-„Einstellungen“ im Tab „Daten“ in der Zeile „Aus einem anderen KI-Dienst importieren“ auf „Importe verwalten“ und dann auf „Neuen Import starten“. Sie erreichen ihn auch über die Karte „Einen Chat aus einer anderen KI fortsetzen“ auf dem Startbildschirm eines neuen Chats." },
        { title: "Dienst und Datei wählen", body: "Wählen Sie unter „Wo befindet sich Ihre Unterhaltung?“ „ChatGPT“ und über „Exportdatei auswählen“ eine .zip- oder .json-Datei." },
        { title: "Unterhaltungen wählen", body: "Grenzen Sie per Titelsuche oder Datum ein, wählen Sie „Alle normalen Unterhaltungen auswählen“ oder einzelne Unterhaltungen und klicken Sie auf „Ausgewählte Chats prüfen (N)“." },
        { title: "Importieren", body: "Klicken Sie unter „Vor dem Import prüfen“ auf „N Unterhaltungen importieren“. Schließen Sie den Bildschirm nicht, bis das Speichern beendet ist." },
      ],
      faq: [
        { q: "Werden auch Bilder und Anhänge importiert?", a: "Nein. Bilder, Audio und Anhänge werden nicht importiert, nur der Text wird gespeichert." },
        { q: "Wird die Exportdatei auf den Server hochgeladen?", a: "Die Originaldatei verlässt Ihr Gerät nicht. Nur der Text der gewählten Unterhaltungen wird in Ihrem Konto gespeichert." },
        { q: "Werden Unterhaltungen doppelt gespeichert, wenn ich dieselbe Datei erneut hochlade?", a: "Unterhaltungen, die bereits in Ihrem Konto sind, werden als Duplikate übersprungen." },
      ],
    },
    "import-claude": {
      title: "Claude-Unterhaltungen importieren",
      summary: "Laden Sie die Datenexport-Datei von Claude (ZIP oder JSON) hoch, um Unterhaltungen in Ihrem Konto zu speichern.",
      steps: [
        { title: "In Claude exportieren", body: "Fordern Sie in Claude unter Einstellungen → Datenschutz den Datenexport an und laden Sie die Datei über den Link in der E-Mail herunter. ZIP und JSON können Sie unverändert verwenden." },
        { title: "Importbildschirm öffnen", body: "Klicken Sie auf „Einstellungen“ → „Daten“ → „Aus einem anderen KI-Dienst importieren“ → „Importe verwalten“ → „Neuen Import starten“." },
        { title: "Claude wählen", body: "Wählen Sie unter „Wo befindet sich Ihre Unterhaltung?“ „Claude“ und über „Exportdatei auswählen“ die Datei." },
        { title: "Unterhaltungen wählen und importieren", body: "Wählen Sie die zu importierenden Unterhaltungen, klicken Sie auf „Ausgewählte Chats prüfen (N)“ und danach auf „N Unterhaltungen importieren“." },
      ],
      faq: [
        { q: "Ich habe den falschen Dienst gewählt.", a: "Kein Problem. Nach dem Öffnen der Datei wird das tatsächliche Format automatisch erkannt und der Import danach fortgesetzt." },
        { q: "Was passiert mit sehr langen Nachrichten?", a: "Nachrichten, die das Speicherlimit überschreiten, werden mit Ihrer Zustimmung auf Anfang und Ende gekürzt gespeichert. Unterhaltungen mit zu langen Nachrichten werden als nicht importierbar markiert." },
        { q: "Wie viel kann ich importieren?", a: "Pro Konto gibt es Limits für die Textmenge und die Anzahl der Unterhaltungen. Ist Ihre Auswahl größer als der verbleibende Platz, verkleinern Sie sie mit „Auswahl anpassen“." },
      ],
    },
    "continue-imported": {
      title: "Importierte Unterhaltung in Tomverse fortsetzen",
      summary: "Aus einer importierten Unterhaltung starten Sie eine neue Tomverse-Unterhaltung. Das Original bleibt schreibgeschützt erhalten.",
      steps: [
        { title: "Fortsetzen beginnen", body: "Klicken Sie auf dem Bildschirm nach dem Import auf „Diese Unterhaltung fortsetzen“ oder in der Liste unter „Importe verwalten“ auf „Fortsetzen“. Auch die Schaltfläche „In Tomverse fortsetzen“ unten im Original funktioniert." },
        { title: "Hinweis prüfen", body: "Beachten Sie: Es wird eine neue Unterhaltung angelegt und das Original bleibt unverändert, Anhänge sind nicht dabei und nur ein jüngerer Teil dient als Kontext, und jede Antwort kostet Credits." },
        { title: "Unterhaltung anlegen", body: "Klicken Sie auf „Unterhaltung anlegen“." },
        { title: "Originalstellen wählen (optional)", body: "Bei Bedarf wählen Sie über „Originalstellen auswählen“ selbst Abschnitte des Originals aus und klicken auf „Ausgewählte Stellen verwenden“." },
      ],
      faq: [
        { q: "Kann ich in einer fortgesetzten Unterhaltung Bilder erstellen?", a: "Nein. Starten Sie in der Seitenleiste ein neues Bild." },
        { q: "Kann ich eine fortgesetzte Unterhaltung öffentlich teilen?", a: "Noch nicht." },
        { q: "Was geschieht mit der fortgesetzten Unterhaltung, wenn ich das Original lösche?", a: "Die Tomverse-Nachrichten bleiben erhalten und werden mit „Original gelöscht“ gekennzeichnet." },
      ],
    },
    "import-guest-conversations": {
      title: "Als Gast geführte Unterhaltungen im Konto speichern",
      summary: "Übertragen Sie Gast-Unterhaltungen, die Sie vor der Anmeldung in diesem Browser geführt haben, in Ihr Konto.",
      steps: [
        { title: "Anmelden", body: "Nach der Anmeldung erscheint das Fenster „Gast-Unterhaltungen importieren?“." },
        { title: "Umfang wählen", body: "Klicken Sie auf „Nur die aktuelle Unterhaltung importieren“ oder „Alle N Gast-Unterhaltungen importieren“. Zum Überspringen klicken Sie auf „Ohne Import starten“." },
        { title: "Später importieren", body: "Wenn Sie übersprungen haben, können Sie es unter „Einstellungen“ → Tab „Daten“ über „Gastgespräche dieses Browsers importieren“ nachholen." },
      ],
      faq: [
        { q: "Was passiert, wenn ich Browserdaten lösche?", a: "Wenn Sie Browserdaten löschen oder einen anderen Browser oder ein anderes Gerät verwenden, lassen sich Gast-Unterhaltungen nicht wiederherstellen." },
        { q: "Nur ein Teil ist fehlgeschlagen.", a: "Die Anzahl der fehlgeschlagenen wird angezeigt und Sie können auf „Erneut versuchen“ klicken." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Plugin verbinden und Berechtigungen wählen",
      summary: "Verbinden Sie externe Dienste als Plugin und wählen Sie selbst, welche Berechtigungen erteilt und welche Tools genutzt werden. Sichtbar in Konten, für die diese Funktion eingeschaltet ist.",
      steps: [
        { title: "Plugin-Bildschirm öffnen", body: "Klicken Sie im Chat-Eingabefeld auf die Puzzle-Schaltfläche und dann auf „Plugins verwalten“." },
        { title: "Verbindung starten", body: "Klicken Sie auf „MCP-Verbindung hinzufügen“ oder auf der Dienstkarte auf „Verbinden“. Dienste mit der Anzeige „Serverkonfiguration erforderlich“ lassen sich noch nicht verbinden." },
        { title: "Berechtigungen wählen", body: "Bei Diensten mit Anmeldung haken Sie in der Liste „Zu erteilende Berechtigungen“ nur das Nötige an und klicken auf „Verbinden“. Nach der Anmeldung beim Dienst erscheint bei Ihrer Rückkehr „Verbunden“." },
        { title: "Zu nutzende Tools speichern", body: "Haken Sie unter „Zugriff verwalten“ bei „Tools auswählen“ die Tools an und klicken Sie auf „Zugriff speichern“. Erst gespeicherte Tools können Sie im Chat auswählen." },
      ],
      faq: [
        { q: "Ich möchte die Berechtigungen ändern.", a: "Klicken Sie unter „Zugriff verwalten“ auf „Erneut anmelden“ und wählen Sie erneut." },
        { q: "Wird der Inhalt meiner Unterhaltung an den Dienst übertragen?", a: "Es werden nur die Suchanfrage und die für die Ausführung nötigen Werte gesendet. Die gesamte Unterhaltung und das Gedächtnis werden nicht automatisch geteilt." },
        { q: "Was passiert, wenn ich die Verbindung trenne?", a: "Nach „Trennen“ werden neue Aufrufe blockiert und gespeicherte Zugangsdaten gelöscht. Inhalte, die schon in Antworten enthalten sind, bleiben erhalten." },
      ],
    },
    "custom-mcp-server": {
      title: "Adresse eines eigenen MCP-Servers hinzufügen",
      summary: "Verbinden Sie einen vertrauenswürdigen Remote-MCP-Server, indem Sie seine öffentliche HTTPS-Adresse direkt eingeben.",
      steps: [
        { title: "Eigenen MCP-Server öffnen", body: "Klicken Sie auf dem Bildschirm „Plugins“ bei der Karte „Eigener MCP-Server“ auf „Verbinden“." },
        { title: "Adresse eingeben", body: "Geben Sie unter „Server-URL (HTTPS)“ die Serveradresse ein und schreiben Sie bei Bedarf einen „Anzeigename (optional)“." },
        { title: "Authentifizierung wählen", body: "Wählen Sie „Keine Authentifizierung“, „Bearer-Token“ oder „OAuth (dynamische Client-Registrierung)“. Für ein Bearer-Token tragen Sie ein separat bei diesem Dienst ausgestelltes Token mit minimalen Rechten ein." },
        { title: "Verbinden und Tools speichern", body: "Klicken Sie auf „Verbinden“, wählen Sie unter „Zugriff verwalten“ die zu nutzenden Tools und klicken Sie auf „Zugriff speichern“." },
      ],
      faq: [
        { q: "Es erscheint „Diese Adresse kann nicht verwendet werden“.", a: "Es sind nur öffentliche HTTPS-Adressen erlaubt. Adressen im internen Netz, andere Ports als 443 und Adressen mit Abfrageteil (Query) werden nicht akzeptiert." },
        { q: "OAuth funktioniert nicht.", a: "Der Server unterstützt keine dynamische Client-Registrierung. Versuchen Sie, ihn mit einem Bearer-Token zu verbinden." },
        { q: "Muss ich jeden Tool-Aufruf freigeben?", a: "Ja. Die Ausführung von Tools eigener Server wird jedes Mal freigegeben." },
      ],
    },
    "use-plugin-in-chat": {
      title: "Plugins im Chat nutzen und Aktionen freigeben",
      summary: "Wählen Sie im Chat ein verbundenes Plugin aus und geben Sie Aktionen, die nach außen gesendet werden, erst nach Prüfung des Inhalts frei.",
      steps: [
        { title: "Plugin wählen", body: "Klicken Sie im Chat-Eingabefeld auf die Puzzle-Schaltfläche und wählen Sie die Verbindung, die in dieser Unterhaltung genutzt werden soll." },
        { title: "Frage senden", body: "Fragen Sie wie gewohnt. Das Modell nutzt die benötigten Tools." },
        { title: "Aktion freigeben", body: "Bei Aktionen, die extern schreiben, erscheint „Aktion unter Plugins prüfen“. Prüfen Sie den zu sendenden Inhalt unter „Freigaben“ und klicken Sie auf „Aktion freigeben“ oder „Ablehnen“." },
      ],
      faq: [
        { q: "Ich habe verbunden, aber es steht nicht in der Liste.", a: "Erst wenn Sie unter „Zugriff verwalten“ mindestens ein zu nutzendes Tool gespeichert haben, erscheint es in der Liste." },
        { q: "Kann ich es auch in Review nutzen?", a: "Die Plugin-Auswahl befindet sich im Chat-Eingabefeld." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "API-Schlüssel erstellen und widerrufen",
      summary: "Erstellen Sie Tomverse-API-Schlüssel für Programmierwerkzeuge, ändern Sie Limit und Namen und widerrufen Sie nicht mehr genutzte Schlüssel. Sichtbar in Konten, für die die API freigeschaltet ist.",
      steps: [
        { title: "API-Schlüssel-Bildschirm öffnen", body: "Klicken Sie in den „Einstellungen“ im Tab „Konto“ in der Zeile „API-Schlüssel“ auf „Verwalten“." },
        { title: "Schlüssel erstellen", body: "Geben Sie einen „Name“ ein, legen Sie bei Bedarf ein „Credit-Limit (optional)“ und den „Ablauf“ fest (Standard 90 Tage) und klicken Sie auf „Schlüssel erstellen“." },
        { title: "Schlüssel speichern", body: "Klicken Sie unter „Kopieren Sie Ihren Schlüssel jetzt“ auf „Kopieren“, speichern Sie ihn an einem sicheren Ort und klicken Sie auf „Ich habe ihn gespeichert“. Der Schlüssel wird nur dieses eine Mal angezeigt." },
        { title: "Verwalten", body: "Nutzen Sie in der Liste „Ihre Schlüssel“ „Umbenennen“, „Limit ändern“ und „Letzte Anfragen“." },
        { title: "Widerrufen und ersetzen", body: "Mit „Widerrufen“ hören Tools, die diesen Schlüssel nutzen, sofort auf zu funktionieren; das kann nicht rückgängig gemacht werden. Zum Ersetzen erstellen Sie einen neuen Schlüssel, tragen ihn im Tool ein und widerrufen dann den alten." },
      ],
      faq: [
        { q: "Ich habe den Schlüssel verloren.", a: "Er kann nicht erneut angezeigt werden. Tomverse speichert nur den Fingerabdruck des Schlüssels. Erstellen Sie einen neuen Schlüssel und widerrufen Sie den alten." },
        { q: "Wie viele Schlüssel kann ich erstellen?", a: "Bis zu 10 aktive Schlüssel pro Konto." },
        { q: "Es erscheint „Die Tomverse-API ist für dieses Konto noch nicht verfügbar“.", a: "Die API wird derzeit schrittweise freigeschaltet. Sobald sie für Sie verfügbar ist, können Sie auf diesem Bildschirm Schlüssel erstellen." },
      ],
    },
    "connect-claude-code": {
      title: "Claude Code mit Tomverse verbinden",
      summary: "Mit wenigen Konfigurationszeilen im Terminal oder in der offiziellen VS-Code-Erweiterung nutzt Claude Code die Modelle und Credits von Tomverse.",
      steps: [
        { title: "Schlüssel vorbereiten", body: "Erstellen und speichern Sie einen Schlüssel wie in der Anleitung „API-Schlüssel erstellen und widerrufen“." },
        { title: "Modell wählen", body: "Wählen Sie auf dem API-Schlüssel-Bildschirm unter „Programmierwerkzeuge“ auf der Karte „Claude Code einrichten“ das „Modell“. In der Liste erscheinen nur Modelle, die zu diesem Tool passen." },
        { title: "Im Terminal nutzen", body: "„Kopieren“ Sie den PowerShell- oder den macOS-/Linux-Block und fügen Sie ihn im Terminal ein. Die letzte Zeile, claude, startet das mit Tomverse verbundene Claude Code." },
        { title: "In der VS-Code-Erweiterung nutzen", body: "Fügen Sie den Block „VS-Code-Benutzer-settings.json“ in Ihre Benutzer-settings.json ein und starten Sie VS Code neu." },
        { title: "Schlüssel einsetzen", body: "Ersetzen Sie in der kopierten Konfiguration <YOUR_TOMVERSE_API_KEY> durch Ihren gespeicherten Schlüssel." },
      ],
      faq: [
        { q: "Wie komme ich zurück zu meinem ursprünglichen Claude-Konto?", a: "Schließen Sie das Terminal oder entfernen Sie die Einstellungen, die Sie in settings.json eingetragen haben, und starten Sie VS Code neu." },
        { q: "Die Websuche funktioniert nicht.", a: "Tools, die auf Anthropic-Servern laufen, wie die Websuche, lassen sich über die Tomverse-Verbindung nicht nutzen." },
        { q: "Steht der Schlüssel unverändert in settings.json?", a: "Ja. Die Claude-Code-Erweiterung liest den Schlüssel als Wert einer Umgebungsvariablen, daher steht der Schlüssel in der Datei. Geben Sie diese Datei nicht weiter." },
      ],
    },
    "connect-codex": {
      title: "Codex mit Tomverse verbinden",
      summary: "Fügen Sie der Codex-Konfigurationsdatei den Tomverse-Anbieter hinzu und starten Sie mit --profile tomverse. Ihr gewohntes Codex-Konto bleibt unverändert.",
      steps: [
        { title: "Schlüssel und Modell vorbereiten", body: "Erstellen Sie einen Schlüssel und wählen Sie auf dem API-Schlüssel-Bildschirm unter „Programmierwerkzeuge“ → „Codex einrichten“ das „Modell“." },
        { title: "Anbieter hinzufügen", body: "Fügen Sie den Block „In ~/.codex/config.toml ergänzen“ in ~/.codex/config.toml ein." },
        { title: "Profil speichern", body: "Speichern Sie den folgenden Block als ~/.codex/tomverse.config.toml." },
        { title: "Schlüssel eintragen und starten", body: "Ersetzen Sie im Block „Den Schlüssel dort setzen, wo Codex startet“ <YOUR_TOMVERSE_API_KEY> durch Ihren Schlüssel und führen Sie ihn aus. Die letzte Zeile, codex --profile tomverse, startet mit Tomverse." },
        { title: "Bei der VS-Code-Erweiterung", body: "Die Erweiterung liest nur config.toml. Fügen Sie daher den Block „In der VS-Code-Erweiterung …“ vom Bildschirm ganz oben in config.toml ein." },
      ],
      faq: [
        { q: "Hat das Auswirkungen auf mein gewohntes Codex-Konto?", a: "Wenn Sie ohne --profile tomverse starten, verwendet Codex weiterhin Ihr ursprüngliches Konto." },
        { q: "Wie mache ich die Einstellung der VS-Code-Erweiterung rückgängig?", a: "Löschen Sie die Zeile model_provider, die Sie ganz oben in config.toml eingefügt haben." },
        { q: "Gibt es Funktionen, die nicht funktionieren?", a: "Gehostete Websuche, gespeicherte Unterhaltungen und Hintergrundantworten sind nicht nutzbar." },
      ],
    },
    "api-usage": {
      title: "API-Nutzung und Limits prüfen",
      summary: "Anfragen mit einem Schlüssel verbrauchen dieselben Konto-Credits wie Chat, und Sie können pro Schlüssel ein Credit-Limit festlegen.",
      steps: [
        { title: "Nutzung pro Schlüssel ansehen", body: "Unter „Ihre Schlüssel“ auf dem API-Schlüssel-Bildschirm sehen Sie für jeden Schlüssel die verbrauchten Credits und die für laufende Anfragen reservierten Credits." },
        { title: "Letzte Anfragen ansehen", body: "Mit „Letzte Anfragen“ sehen Sie je Anfrage Modell, Credits, Eingabe- und Ausgabe-Tokens und die Anfrage-ID." },
        { title: "Kontoguthaben ansehen", body: "Mit „Kontoguthaben und Nutzung“ öffnen Sie den Tab „Tarif“." },
        { title: "Credits pro Modell", body: "Prüfen Sie unter „Verfügbare Modelle“ die Credits pro Anfrage für jedes Modell." },
      ],
      faq: [
        { q: "Anfragen schlagen mit 401, 403, 404 oder 429 fehl.", a: "401 bedeutet, dass der Schlüssel falsch, abgelaufen oder widerrufen ist. 403: Die API ist für das Konto ausgeschaltet. 404: Das Modell wird nicht angeboten (kopieren Sie die Einstellungen erneut). 429: Das Schlüssellimit, die Credits oder das Anfragetempo-Limit ist erreicht." },
        { q: "Kosten auch fehlgeschlagene Anfragen Credits?", a: "Schlägt eine Anfrage vor der Ausgabe fehl, entstehen keine Kosten." },
        { q: "Das Tool sendet mehrere Anfragen.", a: "Auch die Schritte nach einer Tool-Ausführung und die Komprimierung der Unterhaltung zählen jeweils als eigene Anfrage." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "E-Mail-Benachrichtigungen einstellen",
      summary: "Wählen Sie, welche E-Mails Sie erhalten. Marketing-E-Mails beginnen erst, nachdem Sie Ihr Wohnsitzland bestätigt und auf den Link in der Bestätigungs-E-Mail geklickt haben.",
      steps: [
        { title: "E-Mail-Benachrichtigungen öffnen", body: "Klicken Sie in den „Einstellungen“ im Tab „Konto“ auf „E-Mail-Benachrichtigungen“ → „E-Mail-Benachrichtigungen öffnen“." },
        { title: "Einträge ein- und ausschalten", body: "„Sicherheit und Konto“ und „Abrechnung“ sind immer eingeschaltet. „Servicestatus“ können Sie ausschalten; „Produkt-Updates“, „Newsletter“ und „Angebote“ sind zunächst ausgeschaltet." },
        { title: "Marketing-E-Mails erhalten", body: "Um einen Marketing-Eintrag einzuschalten, wählen Sie zuerst das „Wohnsitzland“ und klicken Sie auf „Land bestätigen“." },
        { title: "Bestätigungs-E-Mail", body: "Erst wenn Sie auf den Link in der erhaltenen Bestätigungs-E-Mail klicken, beginnt der Versand. Klicken Sie bei Bedarf auf „Bestätigungs-E-Mail erneut senden“." },
        { title: "Alles auf einmal ausschalten", body: "Klicken Sie auf „Alle Marketing-E-Mails abschalten“." },
      ],
      faq: [
        { q: "Kann ich Sicherheits-E-Mails nicht ausschalten?", a: "Es sind notwendige Hinweise zum Schutz Ihres Kontos und daher nicht abschaltbar. Dasselbe gilt für Abrechnungs-E-Mails." },
        { q: "Ich habe den Schalter eingeschaltet, aber er ist immer noch aus.", a: "Eine Bestätigungs-E-Mail wurde gesendet. Klicken Sie auf den Link in der E-Mail, dann wird er eingeschaltet." },
        { q: "Kann ich mich ohne Anmeldung abmelden?", a: "Ja, über den Abmeldelink unten in der E-Mail. Zum erneuten Einschalten müssen Sie sich anmelden." },
      ],
    },
    "use-on-mobile": {
      title: "Im Browser auf dem Smartphone nutzen",
      summary: "Auf dem Smartphone öffnet sich die Chatliste als Leiste von links und das Eingabefeld befindet sich unten auf dem Bildschirm.",
      steps: [
        { title: "Menü öffnen", body: "Tippen Sie oben links auf die Menüschaltfläche, dann öffnet sich die Leiste. Dort finden Sie „Neuer Chat“, die Suche und Liste der Chats, unten Nutzung, Sprache, Kontomenü und Feedback." },
        { title: "Senden", body: "Die Eingabetaste der Smartphone-Tastatur macht einen Zeilenumbruch. Zum Senden tippen Sie auf die Sendeschaltfläche." },
        { title: "Zum Home-Bildschirm hinzufügen", body: "Tippen Sie im Kontomenü auf „Tomverse installieren“. Auf dem iPhone wählen Sie in Safari „Teilen“ → „Zum Home-Bildschirm“." },
      ],
      faq: [
        { q: "Kann ich auch auf dem Smartphone Dateien hochladen?", a: "Ja. Ohne Anmeldung 1 Datei mit 5 MB, mit Anmeldung mehr, und auch Google Drive ist möglich." },
        { q: "Kann ich auf dem Smartphone Unterhaltungen importieren?", a: "Ja. Bei großen Exportdateien empfehlen wir jedoch, es am Computer zu tun." },
      ],
    },
    // ---------------------------------------------------------------- account
    "manage-login-methods": {
      title: "Anmeldemethoden hinzufügen und entfernen",
      summary: "Sie können E-Mail-, Google- und Microsoft-Anmeldung mit Ihrem Konto verknüpfen oder entfernen. Mindestens eine Anmeldemethode muss erhalten bleiben.",
      steps: [
        { title: "Einstellungen öffnen", body: "Klicken Sie unten in der Seitenleiste auf die Kontoschaltfläche und im Kontomenü auf „Einstellungen“." },
        { title: "Karte „Anmeldemethoden“ finden", body: "Öffnen Sie im Tab „Konto“ die Karte „Anmeldemethoden“." },
        { title: "Verknüpfen", body: "Klicken Sie in der Zeile der gewünschten Methode auf „Hinzufügen“. E-Mail läuft über eine Codebestätigung, Google und Microsoft über die Anmeldung beim jeweiligen Dienst." },
        { title: "Entfernen", body: "Klicken Sie in der Zeile der zu entfernenden Methode auf „Entfernen“ und, wenn sich die Schaltfläche ändert, noch einmal auf „Erneut klicken zum Entfernen“." },
        { title: "Erneut anmelden", body: "Nach dem Entfernen werden Sie auf allen Geräten abgemeldet; melden Sie sich daher mit einer verbliebenen Methode wieder an." },
      ],
      faq: [
        { q: "Kann ich die letzte Anmeldemethode löschen?", a: "Nein. Ein Konto muss mindestens eine Anmeldemethode haben." },
        { q: "Es erscheint „Diese E-Mail wird bereits von einer anderen Anmeldemethode verwendet“.", a: "Melden Sie sich mit der Methode an, mit der Sie sich ursprünglich registriert haben (Google, Microsoft oder E-Mail), und fügen Sie dann in den Einstellungen die neue Methode hinzu." },
        { q: "Es heißt, das Konto, das ich verknüpfen möchte, sei bereits mit einem anderen Tomverse-Konto verknüpft.", a: "Ein externes Konto kann nur mit einem einzigen Tomverse-Konto verknüpft werden." },
      ],
    },
    "export-account-data": {
      title: "Eigene Kontodaten herunterladen",
      summary: "Laden Sie Unterhaltungen, Gedächtnis, importierte Verläufe, Zahlungen und Nutzung als eine Datei herunter. Es gibt auch die Möglichkeit, nur die Unterhaltungen als Text zu speichern.",
      steps: [
        { title: "Tab „Daten“ öffnen", body: "Öffnen Sie im Kontomenü unter „Einstellungen“ den Tab „Daten“." },
        { title: "Download beginnen", body: "Klicken Sie unter „Datenverwaltung“ in der Zeile „Ihre Kontodaten“ auf „Daten herunterladen“." },
        { title: "Datei vorbereiten", body: "Klicken Sie auf „Download vorbereiten“. Wenn Sie sich kürzlich nicht angemeldet haben, melden Sie sich einmal erneut an und kehren Sie zurück." },
        { title: "Datei herunterladen", body: "Klicken Sie auf „Datei herunterladen“. Der Link ist nur einmal nutzbar und läuft nach 5 Minuten ab; dann klicken Sie auf „Neuen Download vorbereiten“." },
        { title: "Wenn Sie nur Unterhaltungen brauchen", body: "Klicken Sie im Tab „Daten“ unter „Unterhaltungen exportieren“ auf „Alle Chats als .txt herunterladen“. Gesperrte Unterhaltungen sind in dieser Datei nicht enthalten." },
      ],
      faq: [
        { q: "Fehlen Daten?", a: "Elemente, die keine Nutzerdaten sind, etwa Betriebsprotokolle, fehlen. In der Datei steht, was enthalten ist und was nicht, mit Begründung." },
        { q: "Kann ich den Download-Verlauf sehen?", a: "Unter „Download-Verlauf“ sehen Sie 90 Tage lang Anfragen, Downloads und Ablehnungen." },
      ],
    },
    "delete-account": {
      title: "Konto löschen",
      summary: "Nach der Löschanfrage werden Sie sofort abgemeldet, und nach einer Frist von 7 Tagen werden Ihre Daten einschließlich Unterhaltungen und Dateien dauerhaft gelöscht.",
      steps: [
        { title: "Zuerst herunterladen (empfohlen)", body: "Wenn Sie Daten behalten möchten, laden Sie sie zuerst wie in der Anleitung „Eigene Kontodaten herunterladen“ herunter." },
        { title: "Gefahrenbereich öffnen", body: "Klicken Sie in den „Einstellungen“ im Tab „Konto“ weiter unten im „Gefahrenbereich“ auf „Konto löschen“." },
        { title: "Bestätigung eingeben", body: "Setzen Sie den Haken bei der Zustimmung und geben Sie genau DELETE MY ACCOUNT ein." },
        { title: "Anfrage senden", body: "Klicken Sie auf „Konto löschen“ und dann noch einmal auf „Dauerhafte Löschung bestätigen“. Erscheint der Hinweis, sich erneut anzumelden, melden Sie sich an und wiederholen Sie den Vorgang." },
        { title: "Abos in App-Stores beenden", body: "Wenn Sie über den App Store oder Google Play bezahlt haben, endet das Abo auch nach dem Löschen des Kontos nicht; kündigen Sie es separat im jeweiligen Store." },
      ],
      faq: [
        { q: "Kann ich die Löschung abbrechen?", a: "Auf dem Bildschirm nicht. Wenden Sie sich innerhalb von 7 Tagen an support@tomverse.app. Auch bei einer Wiederherstellung bleibt der Tarif nur bis zum ursprünglichen Ablaufdatum bestehen und die automatische Verlängerung wird nicht wieder eingeschaltet." },
        { q: "Wird der bezahlte Tarif erstattet?", a: "Bei einem über das Web bezahlten Abo wird nur die automatische Verlängerung gestoppt; eine Erstattung erfolgt nicht." },
        { q: "Was ist der Unterschied zu „Alle Chats löschen“?", a: "„Alle Chats löschen“ befindet sich im Tab „Daten“, löscht nur die Unterhaltungen und lässt das Konto bestehen. Das kann nicht rückgängig gemacht werden." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "Wie Credits verbraucht werden",
      summary: "Für jedes Modell ist ein Basiswert an Credits pro Antwort festgelegt, bei langen Eingaben kommt ein Faktor hinzu, und Websuche und Bilder werden gesondert berechnet.",
      steps: [
        { title: "Basis-Credits je Modell ansehen", body: "Prüfen Sie in der Modellauswahl die Basis-Credits jedes Modells. Die Werte können sich ändern; maßgeblich sind die Zahlen auf dem Bildschirm." },
        { title: "Schätzung vor dem Senden", body: "Der Wert, den Sie vor dem Senden sehen, ist die geschätzte Basis-Credit-Zahl." },
        { title: "Faktor bei langen Unterhaltungen und Dateien", body: "Bei langen Unterhaltungen oder großen Dateien kann je nach Eingabelänge der Faktor 1,5, 2 oder 3 gelten." },
        { title: "Websuche und Bilder", body: "Ist die Websuche dauerhaft eingeschaltet, kommen festgelegte Credits hinzu; wurde nicht gesucht, werden sie zurückgegeben. Die Bildgenerierung hat feste Credits je Qualität." },
        { title: "Reihenfolge des Abzugs", body: "Zuerst werden die Plan-Credits dieses Monats verbraucht, danach zusätzlich gekaufte Credits, beginnend mit denen, die zuerst ablaufen." },
      ],
      faq: [
        { q: "Es wurden mehr Credits abgezogen als angezeigt.", a: "Bei langen Unterhaltungen und Dateien kann ein Faktor je nach Eingabelänge gelten." },
        { q: "Werden Credits abgezogen, wenn die Antwort fehlschlägt?", a: "Schlägt es fehl, bevor eine brauchbare Antwort entsteht, oder ist die Antwort leer, werden sie in der Regel automatisch zurückgegeben. Wenn Sie die Antwort selbst während der Erzeugung anhalten, kann das bereits Erzeugte berechnet werden." },
        { q: "Es erscheint „Eine interne Sicherheitsprüfung hat diese Anfrage pausiert“.", a: "In diesem Fall werden keine Credits abgezogen. Versuchen Sie es in Kürze erneut oder wählen Sie ein günstigeres Modell." },
      ],
    },
    "check-credits": {
      title: "Verbleibende Credits und Ablaufdatum prüfen",
      summary: "Im Kontomenü und im Tab „Tarif“ sehen Sie die Nutzung heute und in diesem Monat, die verbleibenden Credits, den Abrechnungszeitraum und das Ablaufdatum.",
      steps: [
        { title: "Kontomenü öffnen", body: "Wenn Sie unten in der Seitenleiste auf die Kontoschaltfläche klicken, sehen Sie die Anzeige „Aktuelle Nutzung“ und den Zeitpunkt der nächsten Zurücksetzung." },
        { title: "Zum Tab „Tarif“", body: "Mit „Nutzung und Tarif“ öffnen Sie in den Einstellungen den Tab „Tarif“." },
        { title: "Aktuellen Tarif prüfen", body: "Auf der Karte „Aktueller Tarif“ sehen Sie den Abrechnungszeitraum (monatlich/jährlich) und bei „Läuft ab“ das Ende des aktuellen Abrechnungszeitraums." },
        { title: "Verbleibende Credits prüfen", body: "Sehen Sie sich die Karten „KI-Antwort-Credits heute“, „KI-Antwort-Credits diesen Monat“ und „Verbleibendes Zusatzguthaben“ an. Bei Zusatz-Credits wird auch das früheste Ablaufdatum angezeigt." },
      ],
      faq: [
        { q: "Wann werden Credits zurückgesetzt?", a: "Tägliche Credits werden um Mitternacht in der „Zeitzone für tägliche Zurücksetzung“ aus den Einstellungen zurückgesetzt, monatliche Plan-Credits am 1. jedes Monats um 00:00 UTC. Sie werden nicht übertragen." },
        { q: "Verfallen auch zusätzlich gekaufte Credits zu Monatsbeginn?", a: "Nein. Sie bestehen getrennt von den Monats-Credits und laufen 365 Tage nach dem Kauf ab." },
        { q: "Direkt nach der Zahlung hat sich der Tarif nicht sofort geändert.", a: "Die Zahlungsabwicklung kann kurz dauern. Prüfen Sie im Tab „Tarif“ erneut den aktuellen Tarif und das Ablaufdatum." },
      ],
    },
    "change-plan": {
      title: "Zwischen Pro und Max wechseln",
      summary: "Der Wechsel erfolgt auf der Tarifseite. Ein Upgrade gilt sofort nach der Zahlung, ein Downgrade am Ende des aktuellen Abrechnungszeitraums.",
      steps: [
        { title: "Tarifseite öffnen", body: "Gehen Sie zur Tarifseite." },
        { title: "Wechsel beginnen", body: "Wenn Sie Pro nutzen, klicken Sie auf „Auf Max upgraden“, wenn Sie Max nutzen, auf „Zu Pro wechseln“." },
        { title: "Betrag und Credits prüfen", body: "Prüfen Sie im Wechselbildschirm den Betrag unter „Heute fällig“ und wie viele Plan-Credits dieses Monats nach dem Wechsel übrig sind." },
        { title: "Upgrade abschließen", body: "Klicken Sie auf „Bezahlen und zu Max wechseln“. Bis die Zahlung abgeschlossen ist, wird „Zahlung wird erwartet“ angezeigt." },
        { title: "Downgrade vormerken", body: "Klicken Sie auf „Pro vormerken“. Bis zum Stichtag können Sie es mit „Wechsel abbrechen“ rückgängig machen." },
      ],
      faq: [
        { q: "Erhalte ich beim Upgrade neue Credits?", a: "Das Limit dieses Monats wird auf Max umgestellt und bereits Verbrauchtes wird weiter angerechnet. Zusätzliche Credits werden nicht gutgeschrieben." },
        { q: "Kann ich von monatlich auf jährlich wechseln?", a: "Ein Wechsel ist nur innerhalb desselben Abrechnungszeitraums möglich. Für einen Wechsel zwischen monatlich und jährlich wenden Sie sich an den Support." },
        { q: "Was passiert, wenn die Zahlung fehlschlägt?", a: "Ihr aktueller Tarif bleibt unverändert, und es wird nichts abgebucht." },
      ],
    },
    "cancel-subscription": {
      title: "Abo kündigen (automatische Verlängerung stoppen)",
      summary: "Die Kündigung gilt zum Ende des aktuellen Abrechnungszeitraums; bis dahin nutzen Sie Ihren Tarif weiter.",
      steps: [
        { title: "Tab „Tarif“ öffnen", body: "Klicken Sie im Kontomenü auf „Nutzung und Tarif“, um den Tab „Tarif“ zu öffnen." },
        { title: "Kündigung vormerken", body: "Klicken Sie auf der Karte „Tarif kündigen“ auf „Zum Periodenende kündigen“." },
        { title: "Ergebnis prüfen", body: "Prüfen Sie, dass die Schaltfläche zu „Kündigung geplant“ wechselt und ein Hinweis erscheint, dass keine weitere Zahlung erfolgt." },
      ],
      faq: [
        { q: "Bin ich nach der Kündigung sofort Free?", a: "Nein. Ihr Tarif bleibt bis zum angezeigten Ablaufdatum bestehen und wechselt danach zu Free." },
        { q: "Verfallen zusätzlich gekaufte Credits?", a: "Nein. Sie bleiben bis zum Ablaufdatum erhalten, können aber nur für Modelle genutzt werden, die im geänderten Tarif verfügbar sind." },
        { q: "Ich habe über einen App-Store bezahlt.", a: "Abos aus dem App Store und von Google Play kündigen Sie im jeweiligen Store." },
      ],
    },
    "request-refund": {
      title: "Rückerstattung anfragen",
      summary: "Wenn Sie im Tab „Tarif“ oder per E-Mail anfragen, prüft das Team jeden Fall einzeln. Ein bloßer Sinneswandel oder nicht genutzte Credits sind grundsätzlich nicht erstattungsfähig.",
      steps: [
        { title: "Grund eintragen", body: "Tragen Sie den Grund auf der Karte „Rückerstattungsanfrage“ im Tab „Tarif“ ein." },
        { title: "Anfrage senden", body: "Wenn Sie auf „Rückerstattung anfragen“ klicken, werden „Rückerstattungsanfrage erhalten“ und das Eingangsdatum angezeigt." },
        { title: "Anfrage per E-Mail", body: "Wenn die Karte nicht sichtbar ist, senden Sie an support@tomverse.app Ihre Konto-E-Mail, den Namen des Tarifs oder Credit-Pakets, das Zahlungsdatum, die Belegnummer und den Grund." },
      ],
      faq: [
        { q: "In welchen Fällen wird erstattet?", a: "Bei doppelter, unbefugter oder falscher Abbuchung, bei nicht gutgeschriebenem Tarif oder Credits und bei schweren Serviceausfällen, also wenn nach einer Prüfung eine Korrektur nötig ist. Die genauen Kriterien finden Sie auf der Seite zur Rückerstattungsrichtlinie." },
        { q: "Wird mein Abo auch gekündigt, wenn ich anfrage?", a: "Allein durch die Anfrage nicht. Bei Genehmigung wird das bezahlte Abo gekündigt und Sie wechseln zu Free." },
        { q: "Wann kommt der Erstattungsbetrag an?", a: "Das hängt von der Bearbeitungszeit Ihres Zahlungsmittels ab." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "Wenn eine Antwort abbricht oder leer ist",
      summary: "Versuchen Sie es einmal erneut, wählen Sie ein anderes Modell oder senden Sie ohne Anhang. Besteht das Problem weiter, prüfen Sie den Servicestatus und melden Sie den Fehler.",
      steps: [
        { title: "Hinweis lesen", body: "Lesen Sie den Hinweis auf der Karte der fehlgeschlagenen Antwort und prüfen Sie „Diagnoseinformationen anzeigen“. Die Trace-ID wird mit angezeigt." },
        { title: "Erneut versuchen", body: "Klicken Sie auf „Erneut versuchen“ oder wählen Sie „Anderes Modell wählen“ oder „Anzahl der Modelle verringern“." },
        { title: "Wenn es am Anhang liegt", body: "Liegt das Problem am Anhang, klicken Sie auf „Ohne Dateien erneut versuchen“." },
        { title: "Bei Längenbegrenzung", body: "Wenn „Die Antwort wurde durch das Ausgabelängenlimit beendet“ erscheint, bitten Sie in einer weiteren Frage darum, fortzufahren." },
        { title: "Wenn es dennoch nicht klappt", body: "Prüfen Sie die Statusseite zum Servicestatus und klicken Sie auf derselben Karte auf „Fehler melden“." },
      ],
      faq: [
        { q: "Es erscheint „Es wird bereits eine Antwort erzeugt“.", a: "Versuchen Sie es erneut, sobald die laufende Antwort fertig oder gestoppt ist." },
        { q: "Es erscheint „Die Plan-Credits dieses Monats sind aufgebraucht“.", a: "Mit zusätzlichen Credits oder einem höheren Tarif können Sie weiterarbeiten." },
        { q: "Werden auch für fehlgeschlagene Antworten Credits abgezogen?", a: "Für leere oder fehlgeschlagene Antworten reservierte Credits werden in der Regel zurückgegeben." },
      ],
    },
    "file-upload-failed": {
      title: "Wenn ein Datei-Upload fehlschlägt",
      summary: "Prüfen Sie Format, Größe, Passwort und ob lesbarer Text vorhanden ist, und versuchen Sie es mit einer einzelnen Datei erneut.",
      steps: [
        { title: "Fehlermeldung prüfen", body: "Achten Sie auf Meldungen wie „Jede Datei darf höchstens 10 MB groß sein“, „Dieses Dokument ist passwortgeschützt“ oder „In dieser Datei wurde kein lesbarer Text gefunden“." },
        { title: "Datei korrigieren", body: "Entfernen Sie das Passwort oder speichern Sie die Datei erneut als PDF und verkleinern Sie sie." },
        { title: "Einzeln erneut versuchen", body: "Hängen Sie nur eine Datei an und senden Sie erneut. Wenn es eilt, fügen Sie die wichtigsten Inhalte in das Eingabefeld ein." },
        { title: "Bei Bildfehlern", body: "Wählen Sie ein Modell, das Bilder lesen kann, oder klicken Sie auf „Nicht kompatible Modelle entfernen“." },
      ],
      faq: [
        { q: "Wie viele und wie große Dateien kann ich hochladen?", a: "Angemeldet bis zu 5 Dateien pro Nachricht, 10 MB pro Datei und insgesamt 25 MB. Ohne Anmeldung 1 Datei mit bis zu 5 MB. Die Limits können sich ändern; maßgeblich sind die Hinweise auf dem Bildschirm." },
        { q: "Welche Formate werden unterstützt?", a: "PNG, JPEG, WebP, PDF, Text, Word, Excel, PowerPoint, OpenDocument und unterstützte Google-Drive-Dateien. Animierte GIFs und passwortgeschützte ZIP-Dateien werden nicht unterstützt." },
        { q: "Es heißt, eine früher hochgeladene Datei könne nicht gelesen werden.", a: "Dann ist die Datei nicht mehr gespeichert. Hängen Sie sie erneut an oder klicken Sie auf „Ohne die Datei fortfahren“." },
      ],
    },
    "report-a-problem": {
      title: "Fehler melden und Feedback senden",
      summary: "Mit „Fehler melden“ bei einer fehlgeschlagenen Antwort werden Fehlerdetails und Trace-ID mitgesendet. Allgemeine Meinungen senden Sie über „Feedback“.",
      steps: [
        { title: "Meldefenster öffnen", body: "Klicken Sie auf der Karte einer fehlgeschlagenen Antwort auf „Fehler melden“. Allgemeine Meinungen senden Sie über „Feedback“ in der Seitenleiste." },
        { title: "Art wählen", body: "Wählen Sie „Problem melden“, „Funktionswunsch“, „Abrechnung“ oder „Sonstiges“ und schreiben Sie Ihren Text. Eine Fehlermeldung können Sie auch ohne Beschreibung senden." },
        { title: "Mitgesendete Angaben prüfen", body: "Prüfen Sie die Diagnoseinformationen unter „Angehängte Fehlerdetails ansehen“. Werte, die wie Zugangsdaten aussehen, werden automatisch ausgeblendet." },
        { title: "Senden", body: "Wenn Sie über das Ergebnis informiert werden möchten, wählen Sie „Statusupdates per E-Mail erhalten“ und klicken Sie auf „Senden“. Es wird eine Eingangsnummer angezeigt." },
      ],
      faq: [
        { q: "Muss ich unbedingt die Trace-ID angeben?", a: "Nein, sie ist optional. Die Meldung wird auch ohne sie angenommen." },
        { q: "Das Senden ist fehlgeschlagen.", a: "Ihr Text bleibt erhalten, senden Sie ihn einfach erneut. Geben Sie in der Meldung keine Passwörter oder Kartennummern an." },
      ],
    },
    "sign-in-problems": {
      title: "Wenn die Anmeldung nicht klappt",
      summary: "Versuchen Sie es mit der E-Mail-Adresse und der Anmeldemethode der ersten Registrierung noch einmal, im selben Browser.",
      steps: [
        { title: "Registrierungsmethode prüfen", body: "Prüfen Sie, ob Sie die E-Mail-Adresse und die Anmeldemethode (E-Mail-Code, Google, Microsoft usw.) der Registrierung verwenden." },
        { title: "Code erneut anfordern", body: "Ist der E-Mail-Code abgelaufen, klicken Sie auf „Neuen Code senden“. Sie können auch auf den Anmeldelink in der E-Mail klicken." },
        { title: "Bei zu vielen Anfragen", body: "Wenn „Zu viele Anfragen“ erscheint, warten Sie die angegebene Zeit ab. Wurde das Tageslimit überschritten, versuchen Sie es am nächsten Tag erneut." },
        { title: "Im selben Browser", body: "Setzen Sie die Anmeldung in dem Browser fort, in dem Sie sie begonnen haben. Schlägt die Sicherheitsprüfung fehl, laden Sie die Seite neu und versuchen Sie es erneut." },
        { title: "Support informieren", body: "Wenn es weiterhin nicht klappt, senden Sie dem Support Ihre Anmeldemethode und die Fehlermeldung auf dem Bildschirm." },
      ],
      faq: [
        { q: "Es erscheint „Diese E-Mail wird bereits von einer anderen Anmeldemethode verwendet“.", a: "Diese E-Mail-Adresse wurde mit einer anderen Methode registriert. Melden Sie sich mit der Methode der ersten Registrierung an." },
        { q: "Es heißt, die Anmeldung sei blockiert.", a: "Ist die Löschung des Kontos vorgemerkt, wird die Anmeldung blockiert. Um sie abzubrechen, wenden Sie sich innerhalb von 7 Tagen an den Support." },
      ],
    },
    "service-status": {
      title: "Servicestatus prüfen",
      summary: "Auf der Statusseite sehen Sie den Status je KI-Anbieter und die Grundlage dieser Einschätzung.",
      steps: [
        { title: "Statusseite öffnen", body: "Öffnen Sie tomverse.app/status. Eine Anmeldung ist nicht nötig." },
        { title: "Zusammenfassung prüfen", body: "Prüfen Sie die Zusammenfassung ganz oben und den „Datenstand“ (UTC)." },
        { title: "Status je Anbieter ansehen", body: "Sehen Sie unter „Anbieterstatus“ nach, ob der Anbieter „Betriebsbereit“, „Eingeschränkt“ oder „Störung“ gemeldet ist oder „Unbekannt“ ist, sowie welche Modelle betroffen sind." },
      ],
      faq: [
        { q: "Ist „Unbekannt“ eine Störung?", a: "Nein. Es bedeutet, dass es keine Grundlage zur Beurteilung des Status gibt; es wird auch nicht als betriebsbereit angenommen." },
        { q: "Sind die Credits aufgebraucht, wenn ein Warnhinweis erscheint?", a: "Dieser Hinweis allein bedeutet weder, dass Anfragen fehlschlagen, noch dass Credits aufgebraucht sind." },
      ],
    },
    "contact-support": {
      title: "Support kontaktieren",
      summary: "Wenden Sie sich über das Formular auf der Support-Seite oder an support@tomverse.app. In der Regel antworten wir innerhalb von 1–2 Werktagen.",
      steps: [
        { title: "Support-Seite öffnen", body: "Öffnen Sie die Support-Seite." },
        { title: "Art der Anfrage wählen", body: "Wählen Sie „Allgemeiner Support“, „Problem oder Fehler“, „Abrechnung“, „Feature-Wunsch“ oder „Sonstiges“." },
        { title: "Text schreiben", body: "Geben Sie E-Mail-Adresse und Text ein. Falls auf dem Bildschirm eine Trace-ID stand, schreiben Sie sie dazu." },
        { title: "Senden", body: "Wenn Sie auf „Anfrage senden“ klicken, erscheint die Bestätigung des Eingangs. Screenshots lassen sich nicht an das Formular anhängen; senden Sie sie separat an die Support-E-Mail." },
      ],
      faq: [
        { q: "Was sollte ich mitsenden?", a: "Konto-E-Mail, ungefähre Uhrzeit des Vorfalls, Produkt und Modell, Browser, ob es einen Anhang gab, und die Trace-ID auf dem Bildschirm. Senden Sie keine Passwörter oder Kartennummern." },
        { q: "Gibt es telefonischen Support?", a: "Nein. Wir nehmen Anfragen per E-Mail und über das Formular entgegen." },
      ],
    },
  },
};
