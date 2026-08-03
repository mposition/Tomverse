import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { isLanguage, type Language } from "@/lib/language";
import {
  feedbackEmailCategory,
  isFeedbackClosureOutcome,
  type FeedbackClosureOutcome,
  type FeedbackEmailCategory,
  type FeedbackLifecycleStage,
} from "@/lib/feedbackLifecycleCore";

/**
 * The three status emails a feedback submitter can receive, in every supported
 * language.
 *
 * Deliberately NOT `server-only`: the admin completion dialog renders its
 * preview from exactly this builder, so what the admin approves is what the
 * queue later sends. Nothing here sends mail or touches the database.
 *
 * Two contracts govern this module:
 *
 *  - Pure and deterministic for a given input. The retry queue re-renders from
 *    the immutable FeedbackLifecycleEvent snapshot, and the provider's
 *    idempotency key only suppresses a duplicate when the payload matches too.
 *  - The completed wording is decided by the closure outcome code in ONE
 *    place -- the `outcome` map below. Only `fixed` and `shipped` may claim a
 *    fix or a release; every other outcome states exactly what happened.
 *
 * What may appear in a message: the Tomverse brand, whether it was a bug
 * report or feedback, the short receipt reference the submitter already has,
 * the current stage, the closure outcome and user-facing reply, and how to
 * reach support. Never the report body, internal admin notes, the raw
 * Feedback ID, trace IDs, model diagnostics, or user agents -- the input type
 * cannot even carry them.
 */

export type FeedbackLifecycleEmailInput = {
  /** The short receipt reference the submitter was already shown. */
  reference: string;
  /** The feedback type; only its bug-vs-feedback category reaches the copy. */
  type: string;
  language: string | null | undefined;
  /** Completed stage only: how the report was resolved. */
  outcomeCode?: string | null;
  /** Completed stage only: the reply written for the submitter. */
  userReply?: string | null;
};

export const normalizeFeedbackEmailLanguage = (
  value: string | null | undefined
): Language => (isLanguage(value) ? value : "en");

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const appUrl = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

type Category = FeedbackEmailCategory;

type LifecycleCopy = {
  supportLabel: string;
  category: Record<Category, string>;
  stageName: Record<FeedbackLifecycleStage, string>;
  typeLabel: string;
  referenceLabel: string;
  stageLabel: string;
  replyLabel: string;
  supportLine: string;
  supportCta: string;
  footer: string;
  received: {
    subject: (category: Category, reference: string) => string;
    title: string;
    lead: Record<Category, string>;
  };
  reviewing: {
    subject: (category: Category, reference: string) => string;
    title: string;
    lead: Record<Category, string>;
  };
  completed: {
    subject: (
      outcome: FeedbackClosureOutcome,
      category: Category,
      reference: string
    ) => string;
    title: (outcome: FeedbackClosureOutcome) => string;
    lead: string;
    outcome: Record<FeedbackClosureOutcome, string>;
  };
};

const COPY: Record<Language, LifecycleCopy> = {
  ko: {
    supportLabel: "Tomverse 지원",
    category: { bug: "오류 신고", feedback: "피드백" },
    stageName: { received: "접수 완료", reviewing: "검토 중", completed: "처리 종료" },
    typeLabel: "유형",
    referenceLabel: "접수 번호",
    stageLabel: "현재 단계",
    replyLabel: "Tomverse 답변",
    supportLine: "추가로 궁금한 점이 있으면 언제든지 지원팀에 문의해 주세요.",
    supportCta: "지원팀 문의",
    footer:
      "이 메일은 Tomverse에 접수하신 건의 처리 상태를 안내하기 위해 발송되었습니다. 직접 접수하지 않으셨다면 지원팀에 알려 주세요.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] 오류 신고가 접수되었습니다 (${reference})`
          : `[Tomverse] 피드백이 접수되었습니다 (${reference})`,
      title: "접수가 완료되었습니다",
      lead: {
        bug: "보내주신 오류 신고가 정상적으로 접수되었습니다.",
        feedback: "보내주신 피드백이 정상적으로 접수되었습니다.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] 신고 내용을 검토하고 있습니다 (${reference})`
          : `[Tomverse] 피드백을 검토하고 있습니다 (${reference})`,
      title: "검토가 시작되었습니다",
      lead: {
        bug: "담당자가 신고해 주신 내용을 검토하고 있습니다. 처리 결과가 정해지면 다시 안내드립니다.",
        feedback:
          "담당자가 보내주신 피드백을 검토하고 있습니다. 처리 결과가 정해지면 다시 안내드립니다.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] 신고해 주신 오류를 수정했습니다 (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] 요청하신 내용이 반영되었습니다 (${reference})`;
        return category === "bug"
          ? `[Tomverse] 신고 검토 결과를 안내드립니다 (${reference})`
          : `[Tomverse] 피드백 검토 결과를 안내드립니다 (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "신고해 주신 오류를 수정했습니다"
          : outcome === "shipped"
            ? "요청하신 내용이 반영되었습니다"
            : "처리 결과를 안내드립니다",
      lead: "접수하신 건에 대한 검토가 끝나 결과를 안내드립니다.",
      outcome: {
        fixed: "신고해 주신 오류를 수정했습니다.",
        answered: "문의하신 내용에 대한 답변을 완료했습니다.",
        shipped: "요청하신 내용이 제품에 반영되어 출시되었습니다.",
        planned: "검토 결과, 보내주신 내용이 개선 계획에 반영되었습니다.",
        duplicate: "이미 접수된 동일한 건과 함께 처리하고 있습니다.",
        not_reproduced: "현재 동일한 문제를 재현하지 못했습니다.",
        not_planned:
          "검토를 완료했으나 현재 변경 계획에는 포함되지 않았습니다.",
        no_action: "검토 결과, 추가 변경 없이 종결되었습니다.",
        other: "접수하신 내용에 대한 검토가 완료되었습니다.",
      },
    },
  },
  en: {
    supportLabel: "Tomverse Support",
    category: { bug: "Bug report", feedback: "Feedback" },
    stageName: { received: "Received", reviewing: "In review", completed: "Closed" },
    typeLabel: "Type",
    referenceLabel: "Reference",
    stageLabel: "Current stage",
    replyLabel: "Reply from Tomverse",
    supportLine: "If you have any questions, you can reach our support team anytime.",
    supportCta: "Contact support",
    footer:
      "This message was sent about the status of a report you submitted to Tomverse. If you did not submit it, please let our support team know.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Your bug report has been received (${reference})`
          : `[Tomverse] Your feedback has been received (${reference})`,
      title: "We received your report",
      lead: {
        bug: "Your bug report was received and stored successfully.",
        feedback: "Your feedback was received and stored successfully.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] We are reviewing your bug report (${reference})`
          : `[Tomverse] We are reviewing your feedback (${reference})`,
      title: "Your report is being reviewed",
      lead: {
        bug: "Our team is reviewing your bug report. We will let you know once there is an outcome.",
        feedback:
          "Our team is reviewing your feedback. We will let you know once there is an outcome.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] The bug you reported has been fixed (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] The change you asked for has shipped (${reference})`;
        return category === "bug"
          ? `[Tomverse] An update on your bug report (${reference})`
          : `[Tomverse] An update on your feedback (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "The bug you reported has been fixed"
          : outcome === "shipped"
            ? "The change you asked for has shipped"
            : "An update on your report",
      lead: "Our review of your report is finished. Here is the outcome.",
      outcome: {
        fixed: "The bug you reported has been fixed.",
        answered: "We have answered your request.",
        shipped: "The change you asked for has been released.",
        planned: "After review, this has been added to our improvement plans.",
        duplicate:
          "This report is being handled together with an earlier identical report.",
        not_reproduced: "We could not reproduce the issue at this time.",
        not_planned:
          "We completed our review, but this is not part of our current plans.",
        no_action: "The review was completed and closed without further changes.",
        other: "Our review of your report is complete.",
      },
    },
  },
  zh: {
    supportLabel: "Tomverse 支持",
    category: { bug: "错误报告", feedback: "反馈" },
    stageName: { received: "已受理", reviewing: "审核中", completed: "已结案" },
    typeLabel: "类型",
    referenceLabel: "受理编号",
    stageLabel: "当前阶段",
    replyLabel: "Tomverse 回复",
    supportLine: "如有其他问题，欢迎随时联系支持团队。",
    supportCta: "联系支持团队",
    footer:
      "此邮件用于告知您提交给 Tomverse 的内容的处理状态。如果这不是您提交的，请告知支持团队。",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] 您的错误报告已受理 (${reference})`
          : `[Tomverse] 您的反馈已受理 (${reference})`,
      title: "已成功受理",
      lead: {
        bug: "您提交的错误报告已成功受理。",
        feedback: "您提交的反馈已成功受理。",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] 我们正在审核您的错误报告 (${reference})`
          : `[Tomverse] 我们正在审核您的反馈 (${reference})`,
      title: "审核已开始",
      lead: {
        bug: "我们的团队正在审核您的错误报告，有结果后会再次通知您。",
        feedback: "我们的团队正在审核您的反馈，有结果后会再次通知您。",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] 您报告的错误已修复 (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] 您请求的更改已上线 (${reference})`;
        return category === "bug"
          ? `[Tomverse] 您的错误报告审核结果 (${reference})`
          : `[Tomverse] 您的反馈审核结果 (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "您报告的错误已修复"
          : outcome === "shipped"
            ? "您请求的更改已上线"
            : "处理结果通知",
      lead: "我们已完成对您提交内容的审核，结果如下。",
      outcome: {
        fixed: "您报告的错误已修复。",
        answered: "我们已答复您的请求。",
        shipped: "您请求的更改已发布。",
        planned: "经审核，该内容已纳入改进计划。",
        duplicate: "该报告正与此前收到的相同报告一并处理。",
        not_reproduced: "我们目前未能复现该问题。",
        not_planned: "审核已完成，但目前未纳入变更计划。",
        no_action: "审核已完成，未做进一步更改即结案。",
        other: "对您提交内容的审核已完成。",
      },
    },
  },
  fr: {
    supportLabel: "Support Tomverse",
    category: { bug: "Signalement de bug", feedback: "Retour" },
    stageName: { received: "Reçu", reviewing: "En cours d'examen", completed: "Clôturé" },
    typeLabel: "Type",
    referenceLabel: "Référence",
    stageLabel: "Étape actuelle",
    replyLabel: "Réponse de Tomverse",
    supportLine:
      "Si vous avez des questions, vous pouvez contacter notre équipe de support à tout moment.",
    supportCta: "Contacter le support",
    footer:
      "Ce message concerne le statut d'un signalement que vous avez soumis à Tomverse. Si vous n'en êtes pas à l'origine, informez notre équipe de support.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Votre signalement de bug a été reçu (${reference})`
          : `[Tomverse] Votre retour a été reçu (${reference})`,
      title: "Nous avons bien reçu votre signalement",
      lead: {
        bug: "Votre signalement de bug a bien été enregistré.",
        feedback: "Votre retour a bien été enregistré.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Nous examinons votre signalement de bug (${reference})`
          : `[Tomverse] Nous examinons votre retour (${reference})`,
      title: "L'examen a commencé",
      lead: {
        bug: "Notre équipe examine votre signalement de bug. Nous vous informerons dès qu'une décision sera prise.",
        feedback:
          "Notre équipe examine votre retour. Nous vous informerons dès qu'une décision sera prise.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] Le bug que vous avez signalé a été corrigé (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] Le changement demandé a été publié (${reference})`;
        return category === "bug"
          ? `[Tomverse] Résultat de l'examen de votre signalement (${reference})`
          : `[Tomverse] Résultat de l'examen de votre retour (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "Le bug que vous avez signalé a été corrigé"
          : outcome === "shipped"
            ? "Le changement demandé a été publié"
            : "Résultat de l'examen",
      lead: "L'examen de votre signalement est terminé. Voici le résultat.",
      outcome: {
        fixed: "Le bug que vous avez signalé a été corrigé.",
        answered: "Nous avons répondu à votre demande.",
        shipped: "Le changement que vous avez demandé a été publié.",
        planned:
          "Après examen, ce point a été ajouté à nos plans d'amélioration.",
        duplicate:
          "Ce signalement est traité avec un signalement identique reçu précédemment.",
        not_reproduced:
          "Nous n'avons pas pu reproduire le problème pour le moment.",
        not_planned:
          "L'examen est terminé, mais ce point ne fait pas partie de nos plans actuels.",
        no_action:
          "L'examen est terminé et le dossier a été clôturé sans autre modification.",
        other: "L'examen de votre signalement est terminé.",
      },
    },
  },
  de: {
    supportLabel: "Tomverse Support",
    category: { bug: "Fehlerbericht", feedback: "Feedback" },
    stageName: {
      received: "Eingegangen",
      reviewing: "In Prüfung",
      completed: "Abgeschlossen",
    },
    typeLabel: "Typ",
    referenceLabel: "Vorgangsnummer",
    stageLabel: "Aktueller Stand",
    replyLabel: "Antwort von Tomverse",
    supportLine:
      "Bei Fragen können Sie sich jederzeit an unser Support-Team wenden.",
    supportCta: "Support kontaktieren",
    footer:
      "Diese Nachricht betrifft den Status einer Meldung, die Sie bei Tomverse eingereicht haben. Falls Sie diese nicht eingereicht haben, informieren Sie bitte unser Support-Team.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Ihr Fehlerbericht ist eingegangen (${reference})`
          : `[Tomverse] Ihr Feedback ist eingegangen (${reference})`,
      title: "Ihre Meldung ist eingegangen",
      lead: {
        bug: "Ihr Fehlerbericht wurde erfolgreich gespeichert.",
        feedback: "Ihr Feedback wurde erfolgreich gespeichert.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Wir prüfen Ihren Fehlerbericht (${reference})`
          : `[Tomverse] Wir prüfen Ihr Feedback (${reference})`,
      title: "Die Prüfung hat begonnen",
      lead: {
        bug: "Unser Team prüft Ihren Fehlerbericht. Wir melden uns, sobald ein Ergebnis vorliegt.",
        feedback:
          "Unser Team prüft Ihr Feedback. Wir melden uns, sobald ein Ergebnis vorliegt.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] Der gemeldete Fehler wurde behoben (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] Die gewünschte Änderung wurde veröffentlicht (${reference})`;
        return category === "bug"
          ? `[Tomverse] Ergebnis der Prüfung Ihres Fehlerberichts (${reference})`
          : `[Tomverse] Ergebnis der Prüfung Ihres Feedbacks (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "Der gemeldete Fehler wurde behoben"
          : outcome === "shipped"
            ? "Die gewünschte Änderung wurde veröffentlicht"
            : "Ergebnis der Prüfung",
      lead: "Die Prüfung Ihrer Meldung ist abgeschlossen. Hier ist das Ergebnis.",
      outcome: {
        fixed: "Der von Ihnen gemeldete Fehler wurde behoben.",
        answered: "Wir haben Ihre Anfrage beantwortet.",
        shipped: "Die von Ihnen gewünschte Änderung wurde veröffentlicht.",
        planned:
          "Nach Prüfung wurde dieser Punkt in unsere Verbesserungspläne aufgenommen.",
        duplicate:
          "Diese Meldung wird zusammen mit einer früheren identischen Meldung bearbeitet.",
        not_reproduced:
          "Wir konnten das Problem derzeit nicht reproduzieren.",
        not_planned:
          "Die Prüfung ist abgeschlossen, aber dieser Punkt ist derzeit nicht Teil unserer Pläne.",
        no_action:
          "Die Prüfung wurde abgeschlossen und der Vorgang ohne weitere Änderungen geschlossen.",
        other: "Die Prüfung Ihrer Meldung ist abgeschlossen.",
      },
    },
  },
  es: {
    supportLabel: "Soporte de Tomverse",
    category: { bug: "Informe de error", feedback: "Comentario" },
    stageName: { received: "Recibido", reviewing: "En revisión", completed: "Cerrado" },
    typeLabel: "Tipo",
    referenceLabel: "Referencia",
    stageLabel: "Etapa actual",
    replyLabel: "Respuesta de Tomverse",
    supportLine:
      "Si tienes alguna pregunta, puedes contactar con nuestro equipo de soporte en cualquier momento.",
    supportCta: "Contactar con soporte",
    footer:
      "Este mensaje se envió sobre el estado de un informe que enviaste a Tomverse. Si no lo enviaste, avisa a nuestro equipo de soporte.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Hemos recibido tu informe de error (${reference})`
          : `[Tomverse] Hemos recibido tu comentario (${reference})`,
      title: "Hemos recibido tu informe",
      lead: {
        bug: "Tu informe de error se recibió y guardó correctamente.",
        feedback: "Tu comentario se recibió y guardó correctamente.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Estamos revisando tu informe de error (${reference})`
          : `[Tomverse] Estamos revisando tu comentario (${reference})`,
      title: "La revisión ha comenzado",
      lead: {
        bug: "Nuestro equipo está revisando tu informe de error. Te avisaremos cuando haya un resultado.",
        feedback:
          "Nuestro equipo está revisando tu comentario. Te avisaremos cuando haya un resultado.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] El error que informaste se ha corregido (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] El cambio que pediste se ha publicado (${reference})`;
        return category === "bug"
          ? `[Tomverse] Resultado de la revisión de tu informe (${reference})`
          : `[Tomverse] Resultado de la revisión de tu comentario (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "El error que informaste se ha corregido"
          : outcome === "shipped"
            ? "El cambio que pediste se ha publicado"
            : "Resultado de la revisión",
      lead: "La revisión de tu informe ha terminado. Este es el resultado.",
      outcome: {
        fixed: "El error que informaste se ha corregido.",
        answered: "Hemos respondido a tu solicitud.",
        shipped: "El cambio que pediste se ha publicado.",
        planned:
          "Tras la revisión, esto se ha añadido a nuestros planes de mejora.",
        duplicate:
          "Este informe se está gestionando junto con un informe idéntico recibido antes.",
        not_reproduced:
          "No hemos podido reproducir el problema por el momento.",
        not_planned:
          "Completamos la revisión, pero esto no forma parte de nuestros planes actuales.",
        no_action:
          "La revisión se completó y se cerró sin más cambios.",
        other: "La revisión de tu informe ha finalizado.",
      },
    },
  },
  pt: {
    supportLabel: "Suporte Tomverse",
    category: { bug: "Relatório de erro", feedback: "Feedback" },
    stageName: { received: "Recebido", reviewing: "Em análise", completed: "Encerrado" },
    typeLabel: "Tipo",
    referenceLabel: "Referência",
    stageLabel: "Fase atual",
    replyLabel: "Resposta da Tomverse",
    supportLine:
      "Se tiver alguma dúvida, pode contactar a nossa equipa de suporte a qualquer momento.",
    supportCta: "Contactar o suporte",
    footer:
      "Esta mensagem foi enviada sobre o estado de um relatório que submeteu à Tomverse. Se não o submeteu, informe a nossa equipa de suporte.",
    received: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] O seu relatório de erro foi recebido (${reference})`
          : `[Tomverse] O seu feedback foi recebido (${reference})`,
      title: "Recebemos o seu relatório",
      lead: {
        bug: "O seu relatório de erro foi recebido e guardado com sucesso.",
        feedback: "O seu feedback foi recebido e guardado com sucesso.",
      },
    },
    reviewing: {
      subject: (category, reference) =>
        category === "bug"
          ? `[Tomverse] Estamos a analisar o seu relatório de erro (${reference})`
          : `[Tomverse] Estamos a analisar o seu feedback (${reference})`,
      title: "A análise começou",
      lead: {
        bug: "A nossa equipa está a analisar o seu relatório de erro. Iremos avisá-lo quando houver um resultado.",
        feedback:
          "A nossa equipa está a analisar o seu feedback. Iremos avisá-lo quando houver um resultado.",
      },
    },
    completed: {
      subject: (outcome, category, reference) => {
        if (outcome === "fixed")
          return `[Tomverse] O erro que reportou foi corrigido (${reference})`;
        if (outcome === "shipped")
          return `[Tomverse] A alteração que pediu foi publicada (${reference})`;
        return category === "bug"
          ? `[Tomverse] Resultado da análise do seu relatório (${reference})`
          : `[Tomverse] Resultado da análise do seu feedback (${reference})`;
      },
      title: (outcome) =>
        outcome === "fixed"
          ? "O erro que reportou foi corrigido"
          : outcome === "shipped"
            ? "A alteração que pediu foi publicada"
            : "Resultado da análise",
      lead: "A análise do seu relatório terminou. Este é o resultado.",
      outcome: {
        fixed: "O erro que reportou foi corrigido.",
        answered: "Respondemos ao seu pedido.",
        shipped: "A alteração que pediu foi publicada.",
        planned:
          "Após análise, este ponto foi adicionado aos nossos planos de melhoria.",
        duplicate:
          "Este relatório está a ser tratado em conjunto com um relatório idêntico recebido antes.",
        not_reproduced:
          "De momento, não conseguimos reproduzir o problema.",
        not_planned:
          "Concluímos a análise, mas este ponto não faz parte dos nossos planos atuais.",
        no_action:
          "A análise foi concluída e o caso foi encerrado sem mais alterações.",
        other: "A análise do seu relatório está concluída.",
      },
    },
  },
};

/** The single shell for every submitter-facing lifecycle email. */
const shell = (title: string, body: string, copy: LifecycleCopy) => `
  <div style="margin:0;padding:0;background:#f4f6fb;font-family:${EMAIL_FONT_STACK};color:#111827;">
    <div style="max-width:640px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;">
        <div style="padding:28px 30px;background:#0b1020;color:#ffffff;">
          <div style="font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#93c5fd;">${escapeHtml(copy.supportLabel)}</div>
          <h1 style="margin:12px 0 0;font-size:24px;line-height:1.3;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:30px;color:#374151;font-size:15px;line-height:1.7;">
          ${body}
        </div>
      </div>
      <p style="margin:18px 4px 0;color:#6b7280;font-size:12px;line-height:1.6;">
        ${escapeHtml(copy.footer)}
      </p>
    </div>
  </div>
`;

const normalizeOutcome = (
  value: string | null | undefined
): FeedbackClosureOutcome => (isFeedbackClosureOutcome(value) ? value : "other");

/**
 * Renders one lifecycle email. Everything interpolated from the input is
 * escaped; the copy itself is static.
 */
export function buildFeedbackLifecycleEmail(
  stage: FeedbackLifecycleStage,
  input: FeedbackLifecycleEmailInput
): { subject: string; text: string; html: string } {
  const language = normalizeFeedbackEmailLanguage(input.language);
  const copy = COPY[language];
  const category = feedbackEmailCategory(input.type);
  const categoryName = copy.category[category];
  const reference = input.reference.trim();
  const supportUrl = `${appUrl()}/support`;
  const stageName = copy.stageName[stage];

  let subject: string;
  let title: string;
  let lead: string;
  let outcomeLine: string | null = null;
  let userReply: string | null = null;

  if (stage === "completed") {
    const outcome = normalizeOutcome(input.outcomeCode);
    subject = copy.completed.subject(outcome, category, reference);
    title = copy.completed.title(outcome);
    lead = copy.completed.lead;
    outcomeLine = copy.completed.outcome[outcome];
    const reply = (input.userReply ?? "").trim();
    userReply = reply ? reply : null;
  } else {
    const stageCopy = stage === "received" ? copy.received : copy.reviewing;
    subject = stageCopy.subject(category, reference);
    title = stageCopy.title;
    lead = stageCopy.lead[category];
  }

  const text = [
    lead,
    outcomeLine,
    userReply ? `${copy.replyLabel}: ${userReply}` : null,
    "",
    `${copy.typeLabel}: ${categoryName}`,
    `${copy.referenceLabel}: ${reference}`,
    `${copy.stageLabel}: ${stageName}`,
    "",
    copy.supportLine,
    `${copy.supportCta}: ${supportUrl}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const html = shell(
    title,
    `
      <p>${escapeHtml(lead)}</p>
      ${outcomeLine ? `<p><strong>${escapeHtml(outcomeLine)}</strong></p>` : ""}
      ${
        userReply
          ? `<div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div style="font-size:13px;font-weight:700;color:#6b7280;margin-bottom:6px;">${escapeHtml(copy.replyLabel)}</div>
          <div style="white-space:pre-wrap;">${escapeHtml(userReply)}</div>
        </div>`
          : ""
      }
      <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
        <div style="margin-bottom:8px;"><strong>${escapeHtml(copy.typeLabel)}:</strong> ${escapeHtml(categoryName)}</div>
        <div style="margin-bottom:8px;"><strong>${escapeHtml(copy.referenceLabel)}:</strong> ${escapeHtml(reference)}</div>
        <div><strong>${escapeHtml(copy.stageLabel)}:</strong> ${escapeHtml(stageName)}</div>
      </div>
      <p>${escapeHtml(copy.supportLine)}</p>
      <p style="margin-top:24px;">
        <a href="${supportUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;border-radius:12px;padding:12px 18px;">${escapeHtml(copy.supportCta)}</a>
      </p>
    `,
    copy
  );

  return { subject, text, html };
}
