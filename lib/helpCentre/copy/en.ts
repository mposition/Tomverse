import type { HelpLocaleCopy } from "../types";

/**
 * English copy, translated from the Korean source (`ko.ts`). Quoted screen
 * names follow the English product wording; numbers that Admin or the database
 * can change are described as "shown on screen" rather than quoted.
 */
export const en: HelpLocaleCopy = {
  ui: {
    metaTitle: "Tomverse Help Centre | Ask a question, get an answer",
    metaDescription: "Step-by-step guides and a help assistant for Chat, Review, images, research, files, assistants, imports, connectors, coding tools, plans and credits.",
    eyebrow: "Help Centre",
    heroTitleLead: "What can we",
    heroTitleAccent: "help with?",
    heroSubtitle: "Ask your question in your own words. The assistant finds the answer in the Tomverse help articles, replies step by step and points you to the right screen.",
    askPlaceholder: "e.g. How do I change only the background after creating an image?",
    askButton: "Ask",
    askMetaLead: "Help assistant · Answers from the help articles and shows its sources",
    askMetaPrivacy: "Does not read your chats · No credits used",
    askSignIn: "Sign in to ask the help assistant. For now, you can search the guides.",
    askSignInButton: "Sign in",
    askUnavailable: "Searches guide titles and content directly",
    askThinking: "Searching the help articles…",
    askError: "We couldn't get an answer just now. Try again in a moment, or check the guides below.",
    askFollowUp: "Ask a follow-up…",
    suggestions: [
      "Compare 3 answers in Review",
      "Where can I see my remaining credits?",
      "Import my ChatGPT chats",
      "Connect Tomverse to Claude Code",
      "My file won't upload",
      "The answer stopped partway",
    ],
    searchPlaceholder: "Search guides, e.g. credits, image editing, delete account",
    searchEmpty: "No matching guides found. Try different words, or contact support.",
    commonTasks: "Common tasks",
    allGuides: "All guides",
    byFeature: "Help by feature",
    guideCount: "{count} guides",
    stepsAndMinutes: "{steps} steps · about {minutes} min",
    newBadge: "NEW",
    noAnswerTitle: "If you can't find the answer",
    contactTitle: "Can't find what you need?",
    contactBody: "If the help assistant and the guides don't solve it, contact support. We usually reply within 1-2 business days.",
    contactButton: "Contact support",
    statusButton: "Service status",
    reportButton: "Report an error",
    assistantName: "Help assistant",
    foundIn: "✓ Found in {count} help articles",
    notFound: "We couldn't find an answer in the help articles.",
    notFoundBody: "We don't guess. If you contact support, a person will check it for you.",
    sources: "Sources",
    helpful: "Was this helpful?",
    thanks: "Thanks for letting us know",
    disclaimer: "The help assistant reads only the public help articles. It doesn't read or change your chats, files or billing details. Answers can be wrong, so check the linked guide for important decisions.",
    openGuide: "View the step-by-step guide",
    relatedGuides: "Related guides",
    requirements: "To use this feature",
    signInRequired: "Sign-in required",
    signInNotRequired: "No sign-in needed",
    planLabel: "Plan",
    allPlans: "All plans",
    paidPlans: "Paid plans",
    breadcrumbHome: "Help Centre",
    stepLabel: "Step {n}",
    previous: "Previous",
    next: "Next step",
    faqTitle: "Frequently asked questions",
    stuckTitle: "Stuck on this step?",
    stuckBody: "The help assistant answers based on the guide you're viewing.",
    stuckPlaceholder: "e.g. I can't see the button",
    tryItTitle: "Try it now",
    tryItBody: "Open it in a new tab and keep this guide beside it to follow along.",
    tryItButton: "Try it now",
    onThisPage: "On this page",
    stepsSection: "Follow along step by step",
    nextGuides: "Read next",
    backToHelp: "Back to the Help Centre",
    newQuestion: "New question",
    formatsTitle: "Supported formats",
    formatGroups: {
      image: "Images (static GIF only)",
      document: "Documents",
      data: "Data",
      markup: "Text and markup",
      code: "Source code (read as text)",
      archive: "Archives (contents must pass file checks)",
    },
    formatsSignedInOnly: "Signed-in only: {list}",
    formatsGuestLimits: "Without signing in: {files} file per message, up to {mb} MB.",
  },
  categories: {
    "getting-started": { title: "Getting started", description: "Create an account and send your first question." },
    chat: { title: "Chat", description: "Talk with one model, choose a model or use Auto, improve your question and type with your voice." },
    review: { title: "Review · AI Review", description: "Read several models' answers side by side and see the differences with AI Review." },
    images: { title: "Images", description: "Create images, edit part of a photo and compare results from different models." },
    research: { title: "Research · Web search", description: "Find current information with web search and get a report with Deep Research." },
    files: { title: "Files · Generated files", description: "Upload files, use Google Drive and download files the AI creates." },
    assistants: { title: "Assistants · Memory", description: "Your own assistants and knowledge files, and managing Memory." },
    imports: { title: "Import · Continue", description: "Bring in chats from other AI services and carry on with them here." },
    connectors: { title: "Connectors · MCP", description: "Connect outside services and MCP servers." },
    coding: { title: "Coding tools · API keys", description: "Use Tomverse in coding tools such as Claude Code and Codex." },
    projects: { title: "Projects · Sharing", description: "Organise chats into projects, lock them and share them." },
    billing: { title: "Plans · Credits · Billing", description: "How credits are used, changing plans, cancelling and refunds." },
    account: { title: "Account · Privacy", description: "Sign-in methods, downloading your data and deleting your account." },
    notifications: { title: "Notifications · Mobile", description: "Email notifications and using Tomverse on your phone." },
    troubleshooting: { title: "Troubleshooting", description: "When answers stop, uploads fail, reporting errors, service status and contact." },
  },
  guides: {
    // -------------------------------------------------------- getting started
    "create-account": {
      title: "Create an account and sign in",
      summary: "Create a free account with a Google, Microsoft or Apple account, or with a 6-digit code sent to your email, and sign in.",
      steps: [
        { title: "Open the sign-in screen", body: "Select \"Login / Sign Up\" on the screen." },
        { title: "Choose a method", body: "Select a button such as \"Continue with Google\" or \"Continue with Microsoft\", or enter your \"Email address\" and select \"Get login code\". The buttons you see may differ by environment." },
        { title: "Enter the code", body: "Enter the 6-digit code from your email in \"Enter code\" and select \"Verify\". You can also select the sign-in link in the email." },
        { title: "If you're new", body: "If the email isn't registered yet, select \"Sign up with this address\"." },
        { title: "If the code doesn't arrive", body: "Select \"Send a new code\", or change the address with \"Use a different email\"." },
      ],
      faq: [
        { q: "How long is the code valid?", a: "Only for a few minutes. If it expires, select \"Send a new code\". If you enter a wrong code too many times, sign-in is locked for a short while." },
        { q: "Can I use it without signing in?", a: "Where available, you can try it as a guest. Guest chats are saved only in this browser and aren't kept on the server." },
      ],
    },
    "tour-workspace": {
      title: "Tour the main screen",
      summary: "Find New Chat, search, organizer tools, projects, the chat menu and Help in the sidebar.",
      steps: [
        { title: "New chat", body: "Use \"New Chat\" at the top of the sidebar to open a new chat." },
        { title: "Search chats", body: "Use \"Search chats\" to find a title. When you're signed in, it also finds the text of saved messages." },
        { title: "Organizer tools", body: "Expand \"Organizer tools\" to see the \"Password lock\" and \"Share link active\" filters and \"Projects\"." },
        { title: "Chat menu", body: "From the ⋮ menu next to a chat, choose \"Rename\", \"Pin chat\", \"Move to project\", \"Share\", \"Download (.txt)\", \"Lock Chat\" or \"Delete\"." },
        { title: "Help", body: "Use \"Help\" in the sidebar to replay the sidebar tour or open the full help." },
      ],
      faq: [
        { q: "What do the \"Locked\" and \"Shared\" labels mean?", a: "Locked means the chat needs a password check. Shared means a read-only public link is turned on for that chat." },
        { q: "Do pinned chats show on my other devices?", a: "If you're signed in, pins are saved to your account, so they're the same on other devices. If you're not signed in, they stay in this browser only." },
      ],
    },
    "chat-vs-review": {
      title: "The difference between Chat and Review",
      summary: "Chat is where you keep a conversation going with one model. Review is where you compare the answers of several models you choose, side by side.",
      steps: [
        { title: "Choose a product", body: "In the product selector at the top of the screen, choose \"Chat\" or \"Review\"." },
        { title: "Chat", body: "In Chat, one model answers at a time. If you choose another model, the model that answers changes." },
        { title: "From Chat to Review", body: "To see a Chat answer from several models, select \"Compare in Review\". A new Review opens with this question." },
        { title: "From Review to Chat", body: "In a Review analysis, select \"Continue in Chat\" to carry on from a Chat draft." },
      ],
      faq: [
        { q: "Can I move an existing chat to the other product?", a: "A chat opens in the product where it was created. Comparing or continuing creates a new chat." },
        { q: "What's the difference between \"Easy\" and \"Professional\" in Review?", a: "Where available, with Easy you choose only the providers and a model is picked for each question; with Professional you choose the models to compare yourself." },
      ],
    },
    // ------------------------------------------------------------------- chat
    "choose-model-auto": {
      title: "Choose a model and use Smart Adaptive",
      summary: "With Smart Adaptive on, a model is chosen for each message. With it off, the one model you picked answers.",
      steps: [
        { title: "Check Smart Adaptive", body: "If your account has it, the message box has a \"Smart Adaptive\" switch, and it's on at first in an empty Chat." },
        { title: "Choose directly", body: "Open the model picker and select a model in the \"Chat\" tab. Smart Adaptive turns off and the model you chose answers." },
        { title: "See which model answered", body: "Check the \"Auto · model name\" badge under the answer to see the model that actually answered." },
        { title: "See the message Auto understood", body: "If Auto restated your message, you can expand \"How Auto read your message\" under the badge." },
      ],
      faq: [
        { q: "How many credits does it use?", a: "With Smart Adaptive, credits depend on the model that answers. When you choose a model yourself, the base credits shown in the model picker apply." },
        { q: "Is the message I sent changed when it's saved?", a: "No. Your message is saved exactly as you wrote it." },
        { q: "Will I be unable to turn Smart Adaptive off?", a: "No. You can turn it off at any time by choosing a model yourself." },
      ],
    },
    "prompt-refiner": {
      title: "Use a suggestion to improve your question",
      summary: "\"Improve wording\" suggests clearer wording without sending your question. You decide whether to use it.",
      steps: [
        { title: "Get a suggestion", body: "Where available, write your question in the message box and select \"Improve wording\"." },
        { title: "Compare", body: "The \"Original\" and the \"Suggested wording\" appear side by side." },
        { title: "Choose", body: "Select \"Use this wording\" or \"Keep original\". Neither one sends your message yet." },
        { title: "Send", body: "Select \"Send\" as usual. If it fails, select \"Try again\"; your original isn't changed." },
      ],
      faq: [
        { q: "What if I edit while a suggestion is loading?", a: "If even one character changes, that suggestion disappears. Select \"Improve wording\" again." },
        { q: "Does it read my files or chat history too?", a: "It reads only the wording you've just typed. It doesn't use your chat history, attachments or memories." },
      ],
    },
    "voice-input": {
      title: "Type with your voice",
      summary: "Speak into the microphone and your words are turned into text in the message box, so you can edit them before sending.",
      steps: [
        { title: "Start recording", body: "Where available, select the microphone (\"Record voice input\") below the message box. If your browser asks for microphone permission, allow it." },
        { title: "Speak", body: "While you speak, \"Recording\" and the time are shown above the message box." },
        { title: "Turn it into text", body: "Select the same button again, and once the conversion finishes the text appears in the message box." },
        { title: "Edit and send", body: "Edit the text, then \"Send\". To throw the recording away, select \"Discard\"." },
      ],
      faq: [
        { q: "Is my recording saved?", a: "Tomverse doesn't save recordings. A recording is sent to the speech-recognition provider only to be turned into text, and a recording you discard isn't sent." },
        { q: "Does it use credits?", a: "Voice input doesn't use credits. There may be a daily usage limit." },
        { q: "Recording doesn't work.", a: "It works in recent versions of Chrome, Edge, Safari and Firefox. If the microphone is blocked, allow it for this site in your browser settings." },
      ],
    },
    "chat-starters": {
      title: "Fill in your question from a starter",
      summary: "Choose an example card on a new chat and your message box is filled with a question. Nothing is sent until you send it.",
      steps: [
        { title: "Choose a card", body: "Where available, select a card under \"What you can do here\" on the new chat screen. Select \"More suggestions\" to see more." },
        { title: "Edit it", body: "Change the text in the message box however you like." },
        { title: "Send", body: "It's only sent when you select \"Send\". A card with a badge such as \"Sign in required\" takes you to sign-in or plan information." },
      ],
      faq: [
        { q: "Will my own text be erased?", a: "No. The text changes only when the message box is empty or still has exactly what the previous card filled in." },
        { q: "Do cards use credits?", a: "Selecting a card alone doesn't. But a card that turns on web search, such as the sources card, can increase the credits for your next send." },
      ],
    },
    // ----------------------------------------------------------------- review
    "compare-answers": {
      title: "Compare several models' answers side by side",
      summary: "In Review, send the same question to up to 3 models and read the answers side by side.",
      steps: [
        { title: "Choose models", body: "In Review, open the model selection and choose up to 3. If you already have 3, choose the one to swap in." },
        { title: "Send your question", body: "Write your question and select \"Send\". The models you chose answer at the same time." },
        { title: "Ask only one model", body: "To follow up with just one model, use \"Ask only this model\" in its panel." },
        { title: "Change the view", body: "Switch between \"Focus\" and \"Side by side\". Changing the view doesn't send anything again." },
        { title: "Remove a model", body: "Select \"Remove from comparison\". You can bring it back with \"Undo\"." },
      ],
      faq: [
        { q: "Does each model use credits?", a: "Yes. Each model you choose uses its own answer credits." },
        { q: "Can I compare without signing in?", a: "Where available, guests can compare up to 3 models too." },
      ],
    },
    "read-ai-review": {
      title: "Run and read an AI Review",
      summary: "Once 2 or more answers are complete, a separate review model sets out what they agree on, where they differ, contradictions, what's missing and what to check.",
      steps: [
        { title: "Get the answers ready", body: "Check that 2 or more answers to the same question have finished." },
        { title: "Run it", body: "Select \"AI answer cross-review\" (in the desktop Studio, \"Analyze answers with Tomverse\")." },
        { title: "Choose a focus", body: "If the screen lets you choose a focus, pick \"Balanced\", \"Evidence\" or \"Action\", then select \"Run cross-review\"." },
        { title: "Read the result", body: "Read in this order: what they agree on, important differences, contradictions, what's missing and what needs checking." },
        { title: "Leave feedback", body: "On each item you can select \"Helpful\", \"Incorrect\", \"Unclear\" or \"Misses an important point\"." },
      ],
      faq: [
        { q: "Does AI Review tell me the right answer?", a: "No. It compares only the answers you received, and it doesn't search the web or check facts outside them." },
        { q: "What happens to my credits if it fails?", a: "If it can't finish, the credits held for it are returned. The cost is shown on screen before you run it." },
        { q: "Is there a limit on how many times I can use it?", a: "Guests and Free have a monthly limit. Check the screen to see how many you have left." },
      ],
    },
    "follow-citations": {
      title: "Follow the quotes in a review finding",
      summary: "Open the quoted text attached to each finding to see exactly which part of the real answer it comes from.",
      steps: [
        { title: "Choose a finding", body: "Pick one under \"Review findings\". Above each quote you can see which answer (A/B/C) it's from." },
        { title: "See the check mark", body: "A mark shows whether the quote was found in the original, or wasn't and needs more care." },
        { title: "Go to the original", body: "Select \"View in original answer\" under the quote to jump to that part of the answer." },
        { title: "Check with the web (optional)", body: "If needed, select \"Check with web search\" for just that finding. It runs separately, uses credits, and doesn't change the original review." },
      ],
      faq: [
        { q: "If a quote says \"Supported\", is it true?", a: "No. It only means the answer contains that wording; it doesn't guarantee the content is correct." },
        { q: "Is the source match a measure of accuracy?", a: "No. It only shows how closely the quoted wording matches the original." },
      ],
    },
    "save-share-review": {
      title: "Save, share and export a comparison and analysis",
      summary: "When you're signed in, chats and analyses are saved. You can share an analysis as a read-only link or export it as a file.",
      steps: [
        { title: "Sign in and compare", body: "If you compare while signed in, the chat and the analysis are saved to your account. A guest analysis disappears when you refresh." },
        { title: "Share the analysis", body: "Select \"Share analysis\" below the result, check what will be made public, then select \"Publish link\"." },
        { title: "Send or stop the link", body: "Send it with \"Copy link\". To stop, select \"Revoke link\"." },
        { title: "Get a file", body: "Select \"Export\" and choose a file format (PDF, Word, TXT, Markdown)." },
      ],
      faq: [
        { q: "What happens to the chat's existing share link if I share an analysis?", a: "This chat's existing share link is replaced by the new one." },
        { q: "What's in an exported file?", a: "It includes the full analysis along with the question, model sources and quote-match status. The models' full answers and attachments are left out." },
      ],
    },
    // ----------------------------------------------------------------- images
    "create-image": {
      title: "Create an image in chat",
      summary: "Describe the scene in chat and send it. When it's judged to be an image request, the answer comes back as an image in the same chat.",
      steps: [
        { title: "Write your request", body: "In the Chat message box, describe the scene you want, for example \"Create an image: …\"." },
        { title: "Send", body: "Send the message. It doesn't ask you to confirm, and \"Creating the image…\" shows where the answer will appear." },
        { title: "See the result", body: "When it's done, a quality badge (Draft, Standard or High quality) appears. If you want higher quality, send \"Regenerate this image in high quality\"." },
        { title: "Keep adjusting", body: "Send a follow-up such as \"Make it bluer\" and it draws a new image based on the previous one." },
      ],
      faq: [
        { q: "When are credits used?", a: "When Chat answers with an image, image credits are used straight away, without a confirmation. Regenerating in high quality also uses credits." },
        { q: "What if it isn't judged to be an image request?", a: "It answers with an ordinary text reply." },
        { q: "If I share or export the chat, are the images included?", a: "No. Only the sentence saying an image was made is included." },
      ],
    },
    "compare-image-models": {
      title: "Compare results from several image models",
      summary: "On the image screen, send one description to several models at once and compare the results side by side.",
      steps: [
        { title: "Open the image screen", body: "In the \"New…\" menu next to \"New Chat\" in the sidebar, choose \"New Image\". You can also pick a model in the \"Image\" tab of the model picker." },
        { title: "Choose models", body: "Choose the models to compare under \"Models\". The number you can choose at once is shown." },
        { title: "Quality and size", body: "Choose \"Quality\" (Draft, Standard, Final) and \"Size\" (Square, Landscape, Portrait)." },
        { title: "Describe and generate", body: "Describe the image you want, check each model's price and the total credits, then select \"Generate\"." },
        { title: "Get the results", body: "Select \"Full size\" or \"Download\". You can \"Retry this model\" for only the models that failed." },
      ],
      faq: [
        { q: "Does leaving the page cancel generation?", a: "No. It can take up to about 2 minutes, and it keeps going if you leave the page." },
        { q: "The \"Full size\" link won't open.", a: "The original link is valid for only a few minutes. Select it again after a moment and a new link is made." },
      ],
    },
    "edit-photo": {
      title: "Edit a photo you attached",
      summary: "Attach a photo in chat and describe what to change. When it's judged to be an edit request, the answer is the edited image.",
      steps: [
        { title: "Attach a photo", body: "Attach a photo (PNG, JPEG, WebP, GIF) with \"Add a file\" under \"Add and tools\" in the message box." },
        { title: "Describe the change", body: "Describe what to change, for example \"Change the background to a beach at sunset\"." },
        { title: "Send", body: "If it's an edit request you get the edited image; if not, you get an ordinary answer that looked at the photo." },
      ],
      faq: [
        { q: "Does my original photo change?", a: "No. Your uploaded photo is left as it is, and a new image is made." },
        { q: "What if I attach several photos?", a: "It edits the first of the photos you attached." },
        { q: "How many credits does it use?", a: "Model-specific editing credits may be added to the image generation credits." },
      ],
    },
    "image-credits": {
      title: "Image credits and refunds",
      summary: "Images use a set number of credits by quality and size, and if generation fails, all the credits held are returned.",
      steps: [
        { title: "See the price", body: "On the image screen, check each model's price and the total credits." },
        { title: "Generate", body: "When you select \"Generate\", the credits are held first." },
        { title: "Settlement", body: "If it succeeds, the credits shown are used; if it fails, the credits held are returned." },
      ],
      faq: [
        { q: "Which plans can use it?", a: "When signed in, Free, Pro and Max can all use it within the credits they have." },
        { q: "When are credits returned?", a: "When no image was made because the provider declined, a safety block, an error or a timeout." },
        { q: "I see \"Today's plan credits are used up\".", a: "Images use your daily plan credits too. If you have purchased credits, you can keep going." },
      ],
    },
    // --------------------------------------------------------------- research
    "deep-research": {
      title: "Start Deep Research",
      summary: "Write your question and run \"Deep Research\", and a report is built from several web sources over a few minutes.",
      steps: [
        { title: "Write your question", body: "First write the question to research in the message box." },
        { title: "Open Deep Research", body: "Select \"Deep Research\" in the \"Add and tools\" menu of the message box." },
        { title: "Choose the scope", body: "Choose \"Quick\", \"Standard\" or \"Deep\", and check the estimated time and estimated cost." },
        { title: "Start", body: "Select \"Start research\". Progress is shown, from searching sources to writing the report." },
        { title: "Start from a suggestion card", body: "If an \"Expand with Deep Research\" card appears under an ordinary answer, you can select it to start straight away at the Standard scope." },
      ],
      faq: [
        { q: "Which plans can use it?", a: "Signed-in Pro and Max." },
        { q: "If I remove the progress chip, is the research cancelled?", a: "No. The research keeps going in the background." },
        { q: "Does selecting the suggestion card use credits straight away?", a: "Yes. It doesn't ask for a scope and starts straight away at the Standard scope." },
      ],
    },
    "web-search": {
      title: "Turn on web search and check sources",
      summary: "With web search on, it searches the web automatically when you need current information or sources, and shows source links under the answer.",
      steps: [
        { title: "Turn on web search", body: "In the \"Add and tools\" menu of the message box, turn on the \"Web search\" switch." },
        { title: "See the status", body: "Select the \"Web search on\" chip in the message box to see how many of your chosen models support search." },
        { title: "Open a source", body: "Select a link in the \"Sources\" list under the answer to open it in a new tab." },
        { title: "Search suggestion", body: "If you ask something that needs current information while search is off, a \"Check the web\" card appears. Selecting it sends the same question again with a search." },
      ],
      faq: [
        { q: "Does it use extra credits?", a: "Each model that actually ran a search gets a set number of credits added, and models that didn't search get them returned." },
        { q: "I see \"The models answering this can't search the web\".", a: "None of the models you chose supports search. Add a model that supports search." },
      ],
    },
    // ------------------------------------------------------------------ files
    "attach-files": {
      title: "Attach files: supported formats and sizes",
      summary: "You can attach images, PDF, Office, Hangul, text, code and ZIP files, several in one message.",
      steps: [
        { title: "Add a file", body: "In \"Add and tools\" in the message box, select \"Add a file\" → \"Choose from your computer\", or drag a file into the message box." },
        { title: "Wait for the check", body: "Wait until the \"Uploading\" and \"Checking\" labels finish." },
        { title: "Send", body: "Send your message." },
      ],
      faq: [
        { q: "How many files, and how large?", a: "Signed in, up to 5 files per message, 10 MB each and 25 MB in total. The limits without signing in, and every accepted format, are in the supported formats list below." },
        { q: "Which files aren't accepted?", a: "Executables, archives other than ZIP (RAR, 7Z and so on), audio and video, HEIC and TIFF, animated GIFs and password-protected documents." },
        { q: "How long are attached files kept?", a: "Files attached while signed in are kept with the chat and deleted when you delete the chat or your account. Guest files are kept briefly and then deleted automatically." },
      ],
    },
    "google-drive": {
      title: "Attach files from Google Drive",
      summary: "Choose Google Docs, Sheets and Slides from Drive and attach them to a chat.",
      steps: [
        { title: "Open Drive", body: "Select \"Add and tools\" → \"Add a file\" → \"Attach from Google Drive\"." },
        { title: "Allow access", body: "If the Google permission window appears, allow it. It gives access only to the files you choose." },
        { title: "Choose files", body: "Choose files in the Google picker. You can choose several, but not folders." },
        { title: "Send", body: "When the attachment chips appear, send your message." },
      ],
      faq: [
        { q: "Do I need to be signed in?", a: "Yes. Google Drive can be used only after you sign in." },
        { q: "Which files do I see?", a: "You see Google Docs, Sheets and Slides, which are converted to text, xlsx and pptx when attached." },
      ],
    },
    "generated-files": {
      title: "Download files the AI creates",
      summary: "Ask for something like \"Make it as an Excel file\" and a \"Generated file\" card appears under the answer, where you download it.",
      steps: [
        { title: "Name the format", body: "In the chat, ask for a file in the format you want (Excel, Word, PDF, PowerPoint, CSV and so on)." },
        { title: "Wait", body: "While it's being made, \"Creating the file…\" is shown." },
        { title: "Download", body: "On the \"Generated file\" card under the answer, select \"Download\". If it fails, select \"Create the file again\"." },
        { title: "Ask for changes", body: "Select \"Make a revision\" and a draft with the file attached fills the message box. You have to send it yourself, and it's made as a new version." },
      ],
      faq: [
        { q: "Do I need to be signed in?", a: "Yes. Once signed in, you can use it on any plan." },
        { q: "I see \"Unlock this conversation to download the file\".", a: "Files in a locked chat can be downloaded only after you unlock it." },
        { q: "If I ask for changes, is the original file overwritten?", a: "No. A new version is made, and you can see earlier versions in the \"File versions\" list." },
      ],
    },
    // ------------------------------------------------------------- assistants
    "create-assistant": {
      title: "Create your own assistant and add knowledge files",
      summary: "Bundle a name, instructions, models and knowledge files into an assistant only you use, and choose it in a chat.",
      steps: [
        { title: "Start creating", body: "Where available, in \"Settings\" open the \"AI assistants\" tab and select \"New assistant\". You can also start from \"Assistant\" in the chat tools menu." },
        { title: "Name and instructions", body: "Write the \"Name\" and \"Custom instructions\", then select \"Create assistant\"." },
        { title: "Add knowledge files", body: "Under \"Knowledge files this revision may use\", select \"Add a file\" and wait until it shows \"ready\"." },
        { title: "Save", body: "Select \"Save instructions, models and files\". Each save makes a new revision." },
        { title: "Use it in chat", body: "Select \"Chat with this assistant\", or choose it under \"Assistant\" in the chat tools menu." },
      ],
      faq: [
        { q: "Which files can I add as knowledge?", a: "txt, md, csv, json, pdf, docx, xlsx, pptx, odt, ods and odp. Images can't be added." },
        { q: "If I change the instructions, does it apply to chats already under way?", a: "No. It changes only when you select \"Use the newest revision here\" in the chat." },
        { q: "Can other people see my assistant?", a: "No. An assistant is used only in your own account and isn't shared." },
      ],
    },
    "manage-memory": {
      title: "View, turn off and delete Memory",
      summary: "You can view and edit saved memories, turn them off for all chats or per chat, and delete them one at a time or all at once.",
      steps: [
        { title: "Open memory management", body: "In \"Settings\", open the \"AI personalization\" tab and select \"Manage memory\" on the \"Account memory\" row." },
        { title: "View and edit", body: "Under \"Memories in use\", select \"Edit\", \"Pin\" or \"Delete\". Delete takes one more selection to confirm." },
        { title: "Turn off for everything", body: "Under \"Memory usage settings\", turn off \"Use memory across all chats\". Saved memories aren't deleted." },
        { title: "Turn off per chat", body: "Under \"Account memory\" in \"Add and tools\" in the message box, choose \"Do not use in this conversation\"." },
        { title: "Delete everything", body: "If needed, first back up with \"Download all (JSON)\", then type the confirmation phrase in \"Delete all memories\" to delete. This can't be undone." },
      ],
      faq: [
        { q: "Where do memories come from?", a: "They're organised from chats you import from other AI services, plus ones you add with \"Add a memory yourself\"." },
        { q: "Are memories passed to the AI provider?", a: "In answers that use memory, they're passed as reference material to the AI provider that writes the answer." },
        { q: "If I delete all memories, are imported chats deleted too?", a: "No. Imported chats are deleted separately under import management." },
      ],
    },
    // --------------------------------------------------------------- projects
    "organise-projects": {
      title: "Organise chats with projects",
      summary: "Group related chats like folders. Chats in the same project don't share content or files with each other.",
      steps: [
        { title: "Create a project", body: "Select \"New\" (or \"Create first project\" the first time) next to \"Projects\" in the sidebar and enter a name." },
        { title: "Move chats", body: "In a chat's ⋮ menu, choose a project under \"Move to project\"." },
        { title: "Remove or rename", body: "Take a chat out with \"Remove from project\", and rename a project with the pencil button." },
        { title: "Delete a project", body: "Select \"Delete project\" and confirm once more. Its chats just move to \"Uncategorized\" and aren't deleted." },
      ],
      faq: [
        { q: "Can I add shared instructions or files to a project?", a: "No. A project is a folder for organising. For shared instructions and files, use an assistant." },
        { q: "How many can I create?", a: "Up to 24 per account." },
      ],
    },
    "lock-conversation": {
      title: "Lock a chat (password)",
      summary: "Put a password on a chat and it's checked before you open, share, download, edit or delete it.",
      steps: [
        { title: "Start the lock", body: "Select \"Lock Chat\" in the chat's ⋮ menu." },
        { title: "Choose a password", body: "Enter a password of 8 to 128 characters." },
        { title: "Open a locked chat", body: "Opening a locked chat asks for the password. Once you've confirmed it, it doesn't ask again for a while." },
        { title: "Unlock", body: "Select \"Unlock\" in the menu and enter the password." },
      ],
      faq: [
        { q: "What if I forget the password?", a: "Tomverse can't show or recover a password. Contact support." },
        { q: "Does locking encrypt the chat?", a: "No. It's only a lock that blocks viewing, and the content is passed to the AI provider when an answer is made." },
      ],
    },
    "share-link": {
      title: "Create and stop a share link",
      summary: "Turn the current chat into a read-only public page. Anyone with the link can view it without signing in.",
      steps: [
        { title: "Open sharing", body: "Select \"Share\" in the chat's ⋮ menu. For a locked chat, unlock it first." },
        { title: "Create the link", body: "Read the notice and select \"Create share link\"; the link is copied." },
        { title: "Include the latest", body: "Messages sent after sharing aren't added automatically. To include them, select \"Regenerate share link\"." },
        { title: "Stop sharing", body: "Select \"Stop sharing\" and the existing link stops working straight away." },
      ],
      faq: [
        { q: "How long is the link valid?", a: "It expires after a set period, and the expiry date is shown on the share page." },
        { q: "Is my Memory shared too?", a: "No. Memory content isn't shared. Remove anything sensitive before sharing." },
      ],
    },
    // ---------------------------------------------------------------- imports
    "import-chatgpt": {
      title: "Import your ChatGPT chats",
      summary: "Upload your ChatGPT data export file to save past chats to your Tomverse account. The original file is read only in your browser.",
      steps: [
        { title: "Export from ChatGPT", body: "In ChatGPT, go to Settings → Data controls, request a data export, and download the ZIP file from the link emailed to you. You don't need to unzip it." },
        { title: "Open the import screen", body: "In Tomverse \"Settings\", open the \"Data\" tab, select \"Manage imports\" on the \"Import from another AI service\" row, then select \"Start a new import\". You can also get there from the \"Continue a chat from another AI\" card on the first screen of a new Chat." },
        { title: "Choose the service and file", body: "Under \"Where is your conversation?\" choose \"ChatGPT\", then choose the .zip or .json file with \"Choose export file\"." },
        { title: "Choose chats", body: "Narrow the list by title search or date, then either \"Select all normal conversations\" or pick chats one by one, and select \"Review selected chats (N)\"." },
        { title: "Import", body: "Under \"Review before importing\", select \"Import N conversations\". Don't close the screen until saving finishes." },
      ],
      faq: [
        { q: "Are images and attachments imported too?", a: "No. Images, audio and attachments aren't imported; only text is saved." },
        { q: "Is the export file uploaded to a server?", a: "The original file never leaves your device. Only the text of the chats you choose is saved to your account." },
        { q: "If I upload the same file again, will there be duplicates?", a: "Chats already in your account are left out as duplicates." },
      ],
    },
    "import-claude": {
      title: "Import your Claude chats",
      summary: "Upload your Claude data export file (ZIP or JSON) to save your chats to your account.",
      steps: [
        { title: "Export from Claude", body: "In Claude, go to Settings → Privacy, request a data export, and download the file from the link emailed to you. You can use the ZIP or the JSON as it is." },
        { title: "Open the import screen", body: "Select \"Settings\" → \"Data\" → \"Import from another AI service\" → \"Manage imports\" → \"Start a new import\"." },
        { title: "Choose Claude", body: "Under \"Where is your conversation?\" choose \"Claude\", then choose the file with \"Choose export file\"." },
        { title: "Choose chats and import", body: "Choose the chats to import and select \"Review selected chats (N)\", then \"Import N conversations\"." },
      ],
      faq: [
        { q: "I chose the wrong service.", a: "That's fine. After opening the file, Tomverse checks the real format automatically and goes by that." },
        { q: "What happens to very long messages?", a: "A message longer than the storage limit is saved shortened, keeping only the beginning and end, if you agree. Chats with a message that's too long can't be imported, and are marked as such." },
        { q: "How much can I import?", a: "Each account has a limit on how much text and how many chats it can import. If your selection is larger than the space left, reduce it with \"Adjust the selection\"." },
      ],
    },
    "continue-imported": {
      title: "Continue an imported chat in Tomverse",
      summary: "Start a new Tomverse chat from an imported chat. The original stays read-only.",
      steps: [
        { title: "Start continuing", body: "On the import-complete screen select \"Continue this conversation\", or select \"Continue\" in the \"Manage imports\" list. You can also use the \"Continue in Tomverse\" button at the bottom of the original." },
        { title: "Read the notice", body: "Check that a new chat is made and the original is left as it is, that there are no attachments and only a recent part is used as context, and that each answer uses credits." },
        { title: "Create the chat", body: "Select \"Create the conversation\"." },
        { title: "Choose source text to use (optional)", body: "If needed, pick passages of the original with \"Choose source excerpts\" and select \"Use selected excerpts\"." },
      ],
      faq: [
        { q: "Can I create images in a continued chat?", a: "No. Start a new image from the sidebar." },
        { q: "Can I share a continued chat publicly?", a: "Not yet." },
        { q: "What happens to the continued chat if I delete the original?", a: "The Tomverse messages stay, and an \"Original deleted\" label is added." },
      ],
    },
    "import-guest-conversations": {
      title: "Save guest chats to your account",
      summary: "Move the guest chats you had in this browser before signing in to your account.",
      steps: [
        { title: "Sign in", body: "When you sign in, an \"Import your guest conversations?\" window appears." },
        { title: "Choose how much", body: "Select \"Import current conversation only\" or \"Import all N guest conversations\". To skip, select \"Start without importing\"." },
        { title: "Import later", body: "If you skipped, you can do it under \"Import this browser's guest conversations\" on the \"Data\" tab of \"Settings\"." },
      ],
      faq: [
        { q: "What if I clear my browser data?", a: "If you clear browser data or use a different browser or device, guest chats can't be recovered." },
        { q: "Only some failed.", a: "The number that failed is shown, and you can select \"Retry\"." },
      ],
    },
    // ------------------------------------------------------------- connectors
    "connect-plugin": {
      title: "Connect a plugin and choose permissions",
      summary: "Connect an outside service as a plugin, and choose the permissions you allow and the tools it can use. It shows on accounts where this feature is on.",
      steps: [
        { title: "Open the plugins screen", body: "Select the puzzle button in the Chat message box, then \"Manage plugins\"." },
        { title: "Start connecting", body: "Select \"Add MCP connection\", or \"Connect\" on a service card. A service marked \"Server configuration required\" can't be connected yet." },
        { title: "Choose permissions", body: "For a service that uses sign-in, tick only the ones you need under \"Permissions to grant\" and select \"Connect\". When you return after signing in to the service, \"Connected\" is shown." },
        { title: "Save the tools to use", body: "In \"Manage access\", tick \"Select tools\" and select \"Save access\". You have to save the tools before you can pick them in Chat." },
      ],
      faq: [
        { q: "I want to change permissions.", a: "In \"Manage access\", select \"Reauthenticate\" and choose again." },
        { q: "Does my chat go to the service?", a: "Only the search terms and the values needed to run are sent. Your full chat and memory aren't shared automatically." },
        { q: "What happens if I disconnect?", a: "After \"Disconnect\", new calls are blocked and the saved credentials are erased. Content already in an answer stays." },
      ],
    },
    "custom-mcp-server": {
      title: "Add your own MCP server address",
      summary: "Connect by entering the public HTTPS address of a remote MCP server you trust.",
      steps: [
        { title: "Open Custom MCP", body: "On the \"Plugins\" screen, select \"Connect\" on the \"Custom MCP server\" card." },
        { title: "Enter the address", body: "Enter the server address in \"Server URL (HTTPS)\", and a \"Display name (optional)\" if you like." },
        { title: "Choose an authentication method", body: "Choose \"No authentication\", \"Bearer token\" or \"OAuth (dynamic client registration)\". For a bearer token, enter a minimum-permission token you issued separately on that service." },
        { title: "Connect and save the tools", body: "Select \"Connect\", choose the tools to use in \"Manage access\", then select \"Save access\"." },
      ],
      faq: [
        { q: "I see \"This address cannot be used\".", a: "Only public HTTPS addresses work. Internal network addresses, ports other than 443 and queries after the address aren't allowed." },
        { q: "OAuth doesn't work.", a: "That server doesn't support dynamic client registration. Try connecting with a bearer token." },
        { q: "Do I have to approve every time I use a tool?", a: "Yes. Tool runs on a custom server are approved every time." },
      ],
    },
    "use-plugin-in-chat": {
      title: "Use a plugin in chat and approve actions",
      summary: "Choose a connected plugin in Chat, and check the content before you approve anything that goes outside.",
      steps: [
        { title: "Choose a plugin", body: "Select the puzzle button in the Chat message box and choose the connection to use in this chat." },
        { title: "Send your question", body: "Ask as usual. The model uses the tools it needs." },
        { title: "Approve the action", body: "For an action that writes outside, \"Review this action in Plugins\" appears. In the \"Approval queue\", check what will be sent, then select \"Approve this action\" or \"Reject\"." },
      ],
      faq: [
        { q: "I connected it but it's not in the list.", a: "It appears in the list only after you save at least one tool to use in \"Manage access\"." },
        { q: "Can I use it in Review too?", a: "Plugin selection is in the Chat message box." },
      ],
    },
    // ----------------------------------------------------------------- coding
    "manage-api-keys": {
      title: "Create and revoke API keys",
      summary: "Create a Tomverse API key for coding tools, change its limit and name, and revoke keys you no longer use. It shows on accounts where the API is open.",
      steps: [
        { title: "Open the API keys screen", body: "In \"Settings\", on the \"Account\" tab, select \"Manage\" on the \"API keys\" row." },
        { title: "Create a key", body: "Enter a \"Name\", set a \"Credit limit (optional)\" and \"Expires\" (90 days by default) if you want, then select \"Create key\"." },
        { title: "Save the key", body: "Under \"Copy your key now\", select \"Copy\", store it somewhere safe and select \"I've saved it\". The key is shown only once, at this point." },
        { title: "Manage it", body: "In the \"Your keys\" list, use \"Rename\", \"Change limit\" and \"Recent requests\"." },
        { title: "Revoke or replace", body: "Selecting \"Revoke\" stops tools using that key at once and can't be undone. To replace a key, create a new one, put it in your tools, then revoke the old one." },
      ],
      faq: [
        { q: "I lost my key.", a: "It can't be shown again. Tomverse keeps only a fingerprint of the key. Create a new key and revoke the old one." },
        { q: "How many keys can I create?", a: "Up to 10 keys in use per account." },
        { q: "I see \"The Tomverse API is not available for this account yet\".", a: "We're opening the API in stages. When it's available to you, you can create keys on this screen." },
      ],
    },
    "connect-claude-code": {
      title: "Connect Claude Code to Tomverse",
      summary: "With a few lines of settings in the terminal or the official VS Code extension, Claude Code uses Tomverse models and credits.",
      steps: [
        { title: "Get a key ready", body: "Create and save a key as described in the \"Create and revoke API keys\" guide." },
        { title: "Choose a model", body: "On the API keys screen, under \"Coding tools\", choose the \"Model\" on the \"Claude Code\" card. Only models that suit this tool are listed." },
        { title: "Use it in the terminal", body: "\"Copy\" the PowerShell or macOS / Linux block and paste it into your terminal. The last line, claude, starts Claude Code connected to Tomverse." },
        { title: "Use it in the VS Code extension", body: "Put the \"VS Code user settings.json\" block in your user settings.json and restart VS Code." },
        { title: "Put in your key", body: "In the settings you copied, replace <YOUR_TOMVERSE_API_KEY> with the key you saved." },
      ],
      faq: [
        { q: "How do I go back to my usual Claude account?", a: "Close the terminal, or remove the settings you added to settings.json and restart VS Code." },
        { q: "Web search doesn't work.", a: "Tools that run on Anthropic's servers, such as web search, can't be used through a Tomverse connection." },
        { q: "Does the key go into settings.json as it is?", a: "Yes. The Claude Code extension reads the key from an environment variable value, so the key ends up in the file. Don't share that file." },
      ],
    },
    "connect-codex": {
      title: "Connect Codex to Tomverse",
      summary: "Add the Tomverse provider to your Codex settings file and run with --profile tomverse. Your usual Codex account is left alone.",
      steps: [
        { title: "Get a key and model ready", body: "Create a key, then choose the \"Model\" under \"Coding tools\" → \"Codex\" on the API keys screen." },
        { title: "Add the provider", body: "Paste the \"Add to ~/.codex/config.toml\" block into ~/.codex/config.toml." },
        { title: "Save the profile", body: "Save the next block as ~/.codex/tomverse.config.toml." },
        { title: "Put in the key and start", body: "Replace <YOUR_TOMVERSE_API_KEY> in the \"Set the key where Codex starts\" block with your key and run it. The last line, codex --profile tomverse, starts with Tomverse." },
        { title: "If you use the VS Code extension", body: "The extension reads only config.toml, so put the \"For the VS Code extension…\" block from the screen at the very top of config.toml." },
      ],
      faq: [
        { q: "Does it affect my usual Codex account?", a: "If you run without --profile tomverse, Codex uses your original account as before." },
        { q: "How do I undo the VS Code extension setting?", a: "Delete the model_provider line you put at the top of config.toml." },
        { q: "Is anything not supported?", a: "Hosted web search, saved conversations and background responses can't be used." },
      ],
    },
    "api-usage": {
      title: "Check API usage and limits",
      summary: "Requests sent with a key use the same account credits as Chat, and you can set a credit limit on each key.",
      steps: [
        { title: "See usage by key", body: "On the API keys screen, under \"Your keys\", see the credits each key has used and the credits held for requests in progress." },
        { title: "See recent requests", body: "Select \"Recent requests\" to see each request's model, credits, input and output tokens, and request ID." },
        { title: "See your account balance", body: "Select \"Account balance and usage\" and the \"Plan\" tab opens." },
        { title: "Credits per model", body: "Under \"Available models\", check the credits per request for each model." },
      ],
      faq: [
        { q: "Requests fail with 401, 403, 404 or 429.", a: "401 means the key is wrong, expired or revoked; 403 means the API is off for your account; 404 means the model isn't available (copy the settings again); 429 means a key limit, credits or the request rate limit was reached." },
        { q: "Do failed requests use credits?", a: "Not if they fail before any output." },
        { q: "My tool makes several requests.", a: "Each step after a tool runs, and conversation compaction, also counts as its own request." },
      ],
    },
    // ---------------------------------------------------------- notifications
    "email-notifications": {
      title: "Set up email notifications",
      summary: "Choose which emails you receive. Marketing emails start only after you confirm your country of residence and select the link in a confirmation email.",
      steps: [
        { title: "Open email notifications", body: "In \"Settings\", on the \"Account\" tab, select \"Email notifications\" → \"Open email notifications\"." },
        { title: "Turn items on and off", body: "\"Security and account\" and \"Billing\" are always on. \"Service status\" can be turned off, and \"Product updates\", \"Newsletter\" and \"Offers\" are off at first." },
        { title: "Get marketing emails", body: "To turn on a marketing item, first choose your \"Country of residence\" and select \"Confirm country\"." },
        { title: "Confirmation email", body: "Sending starts only after you select the link in the confirmation email. If needed, select \"Resend confirmation email\"." },
        { title: "Turn them all off", body: "Select \"Turn off all marketing email\"." },
      ],
      faq: [
        { q: "Can't I turn off security emails?", a: "They're required notices that protect your account, so they can't be turned off. The same goes for billing emails." },
        { q: "I turned the switch on but it's still off.", a: "A confirmation email has been sent. It turns on when you select the link in that email." },
        { q: "Can I unsubscribe without signing in?", a: "You can, with the unsubscribe link at the bottom of the email. To turn them back on, you need to sign in." },
      ],
    },
    "use-on-mobile": {
      title: "Use Tomverse in your phone's browser",
      summary: "On a phone, the chat list opens as a drawer on the left, and the message box is at the bottom of the screen.",
      steps: [
        { title: "Open the menu", body: "Select the menu button at the top left to open the drawer. It has New Chat, chat search and the list, and at the bottom usage, language, the account menu and feedback." },
        { title: "Send", body: "Enter on a phone keyboard makes a new line. Select the send button to send." },
        { title: "Add to Home Screen", body: "Select \"Install Tomverse\" in the account menu. On iPhone, in Safari choose the Share button → \"Add to Home Screen\"." },
      ],
      faq: [
        { q: "Can I upload files from my phone?", a: "Yes. Without signing in you can attach fewer and smaller files; signed in, you can also use Google Drive. The limits are in the file attachment guide." },
        { q: "Can I import chats on my phone?", a: "Yes. But if the export file is large, we recommend doing it on a computer." },
      ],
    },
    // ---------------------------------------------------------------- account
    "manage-login-methods": {
      title: "Add and remove sign-in methods",
      summary: "You can link or remove email, Google and Microsoft sign-in on your account. At least one sign-in method must remain.",
      steps: [
        { title: "Open Settings", body: "Select the account button at the bottom of the sidebar, then \"Settings\" in the account menu." },
        { title: "Find the Login methods card", body: "On the \"Account\" tab, open the \"Login methods\" card." },
        { title: "Link a method", body: "Select \"Add\" on the row of the method to link. Email goes through code verification; Google and Microsoft go to that service's sign-in." },
        { title: "Remove one", body: "Select \"Remove\" on the method to remove, and when the button changes, select \"Click again to remove\" once more." },
        { title: "Sign in again", body: "Removing one signs you out on all devices, so sign in again with a method that's left." },
      ],
      faq: [
        { q: "Can I remove my last sign-in method?", a: "No. An account needs at least one sign-in method." },
        { q: "I see \"That email is already used by a different sign-in method\".", a: "Sign in with the method you first signed up with (Google, Microsoft or email), then add the new method in Settings." },
        { q: "It says the account I'm linking is already linked to a different Tomverse account.", a: "One outside account can be linked to only one Tomverse account." },
      ],
    },
    "export-account-data": {
      title: "Download your account data",
      summary: "Download your chats, memory, imported records, billing and usage as a single file. You can also get just your chats as text.",
      steps: [
        { title: "Open the Data tab", body: "In \"Settings\" from the account menu, open the \"Data\" tab." },
        { title: "Start the download", body: "On the \"Your account data\" row under \"Data management\", select \"Download your data\"." },
        { title: "Prepare the file", body: "Select \"Prepare a download\". If you haven't signed in recently, sign in once more and come back." },
        { title: "Get the file", body: "Select \"Download the file\". The link works once and expires after 5 minutes; when it does, select \"Prepare a new download\"." },
        { title: "If you only need chats", body: "On the Data tab under \"Export your conversations\", select \"Download all chats as .txt\". Locked chats are left out of this file." },
      ],
      faq: [
        { q: "Is anything left out?", a: "Items that aren't user data, such as operational records, are left out. What's included and left out, and why, is written inside the file." },
        { q: "Can I see a download history?", a: "Under \"Download history\", you can see requests, downloads and refusals for 90 days." },
      ],
    },
    "delete-account": {
      title: "Delete your account",
      summary: "When you request deletion you're signed out at once, and after a 7-day grace period your data, including chats and files, is permanently deleted.",
      steps: [
        { title: "Download first (recommended)", body: "If there's data you want to keep, download it first as described in the \"Download your account data\" guide." },
        { title: "Open the danger zone", body: "In \"Settings\", on the \"Account\" tab, select \"Delete account\" under \"Danger zone\" near the bottom." },
        { title: "Type to confirm", body: "Tick the consent checkbox and type DELETE MY ACCOUNT exactly." },
        { title: "Send the request", body: "Select \"Delete account\", then select \"Request account deletion\" once more. If you're asked to sign in again, sign in and repeat." },
        { title: "Sort out app store subscriptions", body: "If you paid through the App Store or Google Play, deleting your account doesn't stop the subscription, so cancel it separately in each store." },
      ],
      faq: [
        { q: "Can I cancel the deletion?", a: "You can't cancel it on screen. Email support@tomverse.app within 7 days. If it's restored, your plan stays only until its original expiry date and auto-renewal isn't turned back on." },
        { q: "Is my paid plan refunded?", a: "For subscriptions paid on the web, only auto-renewal stops; it isn't refunded." },
        { q: "How is it different from \"Delete all chats\"?", a: "\"Delete all chats\" is on the Data tab and deletes only your chats; your account stays. It can't be undone." },
      ],
    },
    // ---------------------------------------------------------------- billing
    "how-credits-work": {
      title: "How credits are used",
      summary: "Each model has a base number of credits per answer, a multiplier applies to long input, and web search and images are counted separately.",
      steps: [
        { title: "See each model's base credits", body: "In the model picker, check each model's base credits. Values can change, so go by the numbers on screen." },
        { title: "Estimate before sending", body: "The value shown before you send is the base estimate of credits." },
        { title: "Long chat and file multiplier", body: "If a chat is long or a file is large, a 1.5×, 2× or 3× multiplier may apply, depending on input length." },
        { title: "Web search and images", body: "With web search always on, a set number of credits is added, and returned if no search actually ran. Image generation uses a fixed number of credits by quality." },
        { title: "Order of use", body: "This month's plan credits are used first, then purchased credits, starting with the ones closest to expiry." },
      ],
      faq: [
        { q: "More was taken than the credits shown.", a: "An input-length multiplier can apply to long chats and files." },
        { q: "Are credits taken if an answer fails?", a: "If it fails before a usable answer or the response is empty, they're usually returned automatically. If you stop an answer yourself while it's coming, what was generated may be charged." },
        { q: "I see \"An internal safety check paused this request\".", a: "In that case no credits are taken. Try again after a moment, or choose a cheaper model." },
      ],
    },
    "check-credits": {
      title: "Check your remaining credits and expiry",
      summary: "In the account menu and the \"Plan\" tab, see today's and this month's usage, remaining credits, your billing cycle and expiry date.",
      steps: [
        { title: "Open the account menu", body: "Select the account button at the bottom of the sidebar to see the \"Current usage\" gauge and the next reset time." },
        { title: "Go to the Plan tab", body: "Select \"Usage & plan\" and the \"Plan\" tab in Settings opens." },
        { title: "Check your current plan", body: "On the \"Current plan\" card, check your billing cycle (monthly/yearly) and the expiry (the end of the current billing period)." },
        { title: "Check remaining credits", body: "See the \"AI response credits today\", \"AI response credits this month\" and \"Purchased credits remaining\" cards. Purchased credits also show their earliest expiry date." },
      ],
      faq: [
        { q: "When do credits reset?", a: "Daily credits reset at midnight in your \"Daily reset time zone\" under Preferences, and monthly plan credits reset at 00:00 UTC on the 1st of each month and don't roll over." },
        { q: "Do credits I bought disappear at the start of the month too?", a: "No. They're kept separately from monthly credits and expire 365 days after purchase." },
        { q: "My plan didn't change right after I paid.", a: "Processing the payment can take a moment. Check your current plan and expiry again on the Plan tab." },
      ],
    },
    "change-plan": {
      title: "Change between Pro and Max",
      summary: "Change on the pricing page. An upgrade applies as soon as payment finishes; a downgrade applies when the current billing period ends.",
      steps: [
        { title: "Open the pricing page", body: "Go to the pricing page." },
        { title: "Start the change", body: "If you're on Pro, select \"Upgrade to Max\"; if you're on Max, select \"Move to Pro\"." },
        { title: "Check the amount and credits", body: "On the change screen, check the \"Due today\" amount and how much of this month's plan credits you'll have left after the change." },
        { title: "Finish an upgrade", body: "Select \"Pay and move to Max\". \"Waiting for your payment\" is shown until payment finishes." },
        { title: "Schedule a downgrade", body: "Select \"Schedule Pro\". Until it takes effect you can undo it with \"Cancel this change\"." },
      ],
      faq: [
        { q: "Do I get new credits when I upgrade?", a: "This month's limit changes to the Max amount and what you've already used still counts. No extra credits are given." },
        { q: "Can I switch from monthly to yearly?", a: "You can change only between plans with the same billing cycle. For a monthly↔yearly change, contact support." },
        { q: "What if payment fails?", a: "Your current plan stays as it is and you aren't charged." },
      ],
    },
    "cancel-subscription": {
      title: "Cancel your subscription (stop auto-renewal)",
      summary: "Cancellation takes effect when the current billing period ends, and you keep your current plan until then.",
      steps: [
        { title: "Open the Plan tab", body: "In the account menu, select \"Usage & plan\" to open the \"Plan\" tab." },
        { title: "Schedule the cancellation", body: "On the \"Cancel plan\" card, select \"Cancel at period end\"." },
        { title: "Check the result", body: "Check that the button changes to \"Cancellation scheduled\" and a notice says the next payment won't be charged." },
      ],
      faq: [
        { q: "Do I become Free straight away?", a: "No. Your current plan stays until the expiry date shown, then it changes to Free." },
        { q: "Do the credits I bought disappear?", a: "No. They stay until their expiry date, but can only be used on models available on the plan you've changed to." },
        { q: "I paid through an app store.", a: "App Store and Google Play subscriptions are cancelled in each store." },
      ],
    },
    "request-refund": {
      title: "Request a refund",
      summary: "Request on the Plan tab or by email, and the operations team reviews each one. A change of mind or unused credits are generally not eligible.",
      steps: [
        { title: "Write the reason", body: "On the \"Refund request\" card on the \"Plan\" tab, write your reason." },
        { title: "Send the request", body: "Select \"Request refund\" and \"Refund request received\" and the date received are shown." },
        { title: "If you request by email", body: "If the card isn't shown, email support@tomverse.app with your account email, the plan or credit pack name, payment date, receipt number and reason." },
      ],
      faq: [
        { q: "When is a refund given?", a: "When a review shows a correction is needed, such as a duplicate, unauthorised or wrong-amount charge, a plan or credits not delivered, or a serious service outage. Check the Refund Policy page for details." },
        { q: "Does requesting also cancel my subscription?", a: "A request alone doesn't cancel it. If it's approved, the paid subscription is cancelled and you move to Free." },
        { q: "When does the refund arrive?", a: "It depends on your payment method's processing time." },
      ],
    },
    // -------------------------------------------------------- troubleshooting
    "answer-stopped": {
      title: "When an answer stops or is empty",
      summary: "Try once more, choose another model or send without attachments. If it keeps happening, check the service status and report the error.",
      steps: [
        { title: "Read the notice", body: "Check the notice on the failed answer card and \"Show diagnostic info\". A trace ID is shown with it." },
        { title: "Try again", body: "Select \"Retry\", or choose \"Choose another model\" or \"Reduce the number of models\"." },
        { title: "If it's the attachment", body: "If an attachment is the problem, select \"Retry without files\"." },
        { title: "If it hit the length limit", body: "If you see \"The response stopped at the output length limit\", ask again and ask it to continue." },
        { title: "If it still doesn't work", body: "Check the service status page, and select \"Report error\" on the same card." },
      ],
      faq: [
        { q: "I see \"A response is already being generated\".", a: "Try again after the running answer finishes or is stopped." },
        { q: "I see \"This month's plan credits are used up\".", a: "Buy extra credits or upgrade your plan to keep going." },
        { q: "Are credits taken for a failed answer?", a: "Credits held for an empty or failed response are usually returned." },
      ],
    },
    "file-upload-failed": {
      title: "When a file upload fails",
      summary: "Check the format, size, password and that there's readable text, and try again with a single file.",
      steps: [
        { title: "Read the error text", body: "Check the wording, such as \"Each file must be 10 MB or smaller\", \"This document is password-protected\" or \"No readable text was found in this file\"." },
        { title: "Fix the file", body: "Remove the password, or save it again as a PDF, and make it smaller." },
        { title: "Try one at a time", body: "Attach just one file and send again. If you're in a hurry, paste the key content into the message box." },
        { title: "If it's an image error", body: "Choose a model that can read images, or select \"Remove incompatible models\"." },
      ],
      faq: [
        { q: "How many files, and how large, can I upload?", a: "Signed in, up to 5 files per message, 10 MB each and 25 MB in total. The limits without signing in are in the supported formats list of the file attachment guide." },
        { q: "Which formats are supported?", a: "Every accepted format is in the supported formats list of the file attachment guide. Animated GIFs and password-protected ZIP files are not accepted." },
        { q: "It says an earlier file can't be read.", a: "The file is no longer stored. Attach it again, or select \"Continue without the file\"." },
      ],
    },
    "report-a-problem": {
      title: "Report an error and send feedback",
      summary: "Using \"Report error\" on a failed answer sends the error details and trace ID with it. Send general comments with \"Feedback\".",
      steps: [
        { title: "Open the report window", body: "Select \"Report error\" on a failed answer card. For general comments, select \"Feedback\" in the sidebar." },
        { title: "Choose a type", body: "Choose \"Problem report\", \"Feature request\", \"Billing\" or \"Other\" and write your message. An error report can be sent without a description." },
        { title: "Check what's sent with it", body: "Check the diagnostic details under \"See the error details that will be attached\". Values that look like credentials are hidden automatically." },
        { title: "Send", body: "To get the outcome, select \"Email me status updates\", then select \"Send\". A reference number is shown." },
      ],
      faq: [
        { q: "Do I have to enter the trace ID?", a: "It's optional. Your report is received without it." },
        { q: "Sending failed.", a: "What you wrote is still there, so send it again. Don't put passwords or card numbers in a report." },
      ],
    },
    "sign-in-problems": {
      title: "When you can't sign in",
      summary: "Try again in the same browser, with the email and sign-in method you first signed up with.",
      steps: [
        { title: "Check how you signed up", body: "Check that it's the email and sign-in method you used to sign up (email code, Google, Microsoft and so on)." },
        { title: "Get the code again", body: "If your email code has expired, select \"Send a new code\". You can also select the sign-in link in the email." },
        { title: "If there are too many requests", body: "If you see \"Too many requests\", wait for the time shown. If you've passed the daily limit, try again the next day." },
        { title: "In the same browser", body: "Continue in the browser where you started signing in. If security verification fails, refresh and try again." },
        { title: "Tell support", body: "If it still doesn't work, send support your sign-in method and the error text on screen." },
      ],
      faq: [
        { q: "I see \"That email is already used by a different sign-in method\".", a: "That email was signed up with another method. Sign in with the method you first used." },
        { q: "It says sign-in is blocked.", a: "Sign-in is blocked if deletion is scheduled for the account. To cancel it, contact support within 7 days." },
      ],
    },
    "service-status": {
      title: "Check the service status",
      summary: "On the status page, check the status of each AI provider and the evidence behind it.",
      steps: [
        { title: "Open the status page", body: "Open tomverse.app/status. You don't need to sign in." },
        { title: "Check the summary", body: "Check the summary at the top and \"Data as of\" (UTC)." },
        { title: "See each provider's status", body: "Under \"Provider status\", see Operational, Degraded, Incident or Unknown, and the affected models." },
      ],
      faq: [
        { q: "Is \"Unknown\" an outage?", a: "No. It means there's no evidence to judge the status, and it isn't assumed to be operational either." },
        { q: "If a warning appears, have my credits run out?", a: "That label alone doesn't mean a request failed or credits were used up." },
      ],
    },
    "contact-support": {
      title: "Contact support",
      summary: "Contact us through the form on the support page or at support@tomverse.app. We usually reply within 1-2 business days.",
      steps: [
        { title: "Open the support page", body: "Open the support page." },
        { title: "Choose a type", body: "Choose \"General support\", \"Problem or bug\", \"Billing\", \"Feature request\" or \"Other\"." },
        { title: "Write your message", body: "Enter your email address and message. If a trace ID was on screen, include it." },
        { title: "Send", body: "Select \"Send request\" and a notice says it was received. You can't attach screenshots to the form, so email them separately to the support address." },
      ],
      faq: [
        { q: "What should I send with it?", a: "Your account email, roughly when it happened, the product and model, your browser, whether there was an attachment, and the trace ID on screen. Don't send passwords or card numbers." },
        { q: "Is there phone support?", a: "No. We take email and the form." },
      ],
    },
  },
};
