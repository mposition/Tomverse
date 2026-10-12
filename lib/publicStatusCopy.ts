import { isLanguage, type Language } from "@/lib/language";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";
import type {
  MonitoredStatusSummary,
  PublicProviderStatus,
  PublicStatusReasonCode,
} from "@/lib/providerPublicStatusCore";
import type { ProbeSchedulerJobSummary } from "@/lib/statusPageEvidence";

type Translations = Record<Language, string>;
const translations = (
  ko: string, en: string, zh: string, fr: string, de: string, es: string, pt: string
): Translations => ({ ko, en, zh, fr, de, es, pt });

const labels = {
  metadataTitle: translations("서비스 상태", "Service Status", "服务状态", "État du service", "Servicestatus", "Estado del servicio", "Status do serviço"),
  metadataDescription: translations(
    "Tomverse가 모니터링하는 AI 공급자의 현재 상태와 서비스 영향 장애, 상태 판단에 사용된 확인 자료를 살펴보세요.",
    "Check the current status of AI providers monitored by Tomverse, service-impacting incidents and the evidence behind each status.",
    "查看 Tomverse 监测的 AI 供应商当前状态、影响服务的事件，以及各状态的确认依据。",
    "Consultez l’état des fournisseurs IA suivis par Tomverse, les incidents affectant le service et les éléments qui fondent chaque statut.",
    "Prüfen Sie den aktuellen Status der von Tomverse überwachten KI-Anbieter, Störungen und die Belege für jeden Status.",
    "Consulta el estado de los proveedores de IA supervisados por Tomverse, los incidentes del servicio y las evidencias de cada estado.",
    "Confira o status dos provedores de IA monitorados pelo Tomverse, os incidentes do serviço e as evidências de cada status."
  ),
  backHome: translations("Tomverse 홈페이지로", "Back to Tomverse homepage", "返回 Tomverse 首页", "Retour à l’accueil Tomverse", "Zur Tomverse-Startseite", "Volver al inicio de Tomverse", "Voltar à página inicial do Tomverse"),
  eyebrow: translations("서비스 상태", "Public status", "公开服务状态", "État public du service", "Öffentlicher Servicestatus", "Estado público del servicio", "Status público do serviço"),
  providerTitle: translations("공급자별 상태", "Provider status", "供应商状态", "État des fournisseurs", "Anbieterstatus", "Estado de los proveedores", "Status dos provedores"),
  introduction: translations(
    "실제 사용자 요청, 자동 확인과 운영자 확인 자료를 구분해 현재 상태를 보여줍니다. 정상으로 표시하려면 최근 성공 확인이 필요합니다. 장애가 기록되지 않았다는 사실만으로 정상이라고 판단하지 않습니다.",
    "This page distinguishes real user requests, automated checks and operator checks. Operational status requires recent evidence of success. The absence of a recorded incident alone does not mean a provider is working.",
    "本页区分真实用户请求、自动检查与运营人员检查。正常状态需要近期成功依据；仅仅没有记录事件，不代表供应商运行正常。",
    "Cette page distingue les demandes réelles, les contrôles automatiques et ceux des opérateurs. Un statut opérationnel exige une réussite récente. L’absence d’incident enregistré ne suffit pas à confirmer le bon fonctionnement.",
    "Diese Seite unterscheidet echte Nutzeranfragen, automatische Prüfungen und Prüfungen durch den Betreiber. Betriebsbereit setzt einen aktuellen Erfolgsbeleg voraus. Allein das Fehlen einer gemeldeten Störung belegt keinen normalen Betrieb.",
    "Esta página distingue solicitudes reales, comprobaciones automáticas y comprobaciones del equipo. El estado operativo requiere una evidencia reciente de éxito. La ausencia de un incidente registrado no confirma por sí sola el funcionamiento.",
    "Esta página distingue solicitações reais, verificações automáticas e verificações da equipe. O status operacional exige uma evidência recente de sucesso. A ausência de um incidente registrado, por si só, não confirma o funcionamento."
  ),
  dataUnavailable: translations(
    "현재 공급자 상태 자료를 불러오지 못했습니다. 확인되지 않은 상태를 정상으로 추정하지 않고 ‘확인 자료 없음’으로 안내합니다.",
    "Provider health data could not be loaded. Unverified statuses remain Unknown; they are not assumed to be operational.",
    "暂时无法加载供应商状态资料。未经确认的状态保持为“未知”，不会推定为正常。",
    "Les données des fournisseurs n’ont pas pu être chargées. Les statuts non vérifiés restent inconnus, sans supposer un fonctionnement normal.",
    "Die Anbieterdaten konnten nicht geladen werden. Unbestätigte Zustände bleiben Unbekannt und werden nicht als betriebsbereit angenommen.",
    "No se pudieron cargar los datos de los proveedores. Los estados sin verificar siguen como Desconocido; no se supone que funcionen con normalidad.",
    "Não foi possível carregar os dados dos provedores. Os estados não verificados continuam como Desconhecido, sem presumir funcionamento normal."
  ),
  dataUnavailableHeadline: translations("서비스 상태를 확인할 자료가 없습니다", "Service status data is unavailable", "暂无可确认服务状态的资料", "Données d’état du service indisponibles", "Servicestatusdaten sind nicht verfügbar", "Datos del estado del servicio no disponibles", "Dados do status do serviço indisponíveis"),
  dataAsOf: translations("자료 기준 시각", "Data as of", "资料时间", "Données au", "Datenstand", "Datos a fecha de", "Dados de"),
  pageGeneratedAt: translations("페이지 표시 시각", "Page generated at", "页面生成时间", "Page générée le", "Seite erstellt am", "Página generada el", "Página gerada em"),
  lastSuccess: translations("마지막 실제 요청 성공", "Last successful user request", "最近一次真实请求成功", "Dernière demande réelle réussie", "Letzte erfolgreiche Nutzeranfrage", "Última solicitud real correcta", "Última solicitação real bem-sucedida"),
  lastTraffic: translations("마지막 실제 요청 확인", "Last real-request check", "最近一次真实请求检查", "Dernier contrôle de demande réelle", "Letzte Prüfung einer Nutzeranfrage", "Última comprobación de solicitud real", "Última verificação de solicitação real"),
  lastProbe: translations("마지막 자동 확인", "Last automated check", "最近一次自动检查", "Dernier contrôle automatique", "Letzte automatische Prüfung", "Última comprobación automática", "Última verificação automática"),
  lastManual: translations("마지막 운영자 확인", "Last operator check", "最近一次运营人员检查", "Dernier contrôle par un opérateur", "Letzte Prüfung durch den Betreiber", "Última comprobación del equipo", "Última verificação da equipe"),
  unrecorded: translations("기록 없음", "Not recorded", "无记录", "Non enregistré", "Nicht aufgezeichnet", "Sin registro", "Sem registro"),
  never: translations("확인 기록 없음", "No check recorded", "无检查记录", "Aucun contrôle enregistré", "Keine Prüfung aufgezeichnet", "Sin comprobación registrada", "Sem verificação registrada"),
  empty: translations("현재 모니터링 중인 공급자가 없습니다.", "No providers are currently monitored.", "当前没有正在监测的供应商。", "Aucun fournisseur n’est actuellement suivi.", "Derzeit werden keine Anbieter überwacht.", "Actualmente no se supervisa ningún proveedor.", "Nenhum provedor está sendo monitorado no momento."),
  emptyUnavailable: translations("공급자별 상태를 표시할 자료가 없습니다.", "Provider status details are unavailable.", "暂无可显示的供应商状态资料。", "Les détails d’état des fournisseurs sont indisponibles.", "Die Statusdetails der Anbieter sind nicht verfügbar.", "Los detalles del estado de los proveedores no están disponibles.", "Os detalhes do status dos provedores estão indisponíveis."),
  emptyHeadline: translations("모니터링 중인 공급자가 없습니다", "No providers are currently monitored", "当前没有正在监测的供应商", "Aucun fournisseur actuellement suivi", "Derzeit werden keine Anbieter überwacht", "No se supervisa ningún proveedor actualmente", "Nenhum provedor monitorado no momento"),
  affectedModels: translations(
    "이 공급자의 다음 모델에서 최근 실패가 집중되어 있습니다: {models}.",
    "Recent failures are concentrated in these models from this provider: {models}.",
    "该供应商的近期失败主要集中在以下模型：{models}。",
    "Les échecs récents concernent principalement ces modèles du fournisseur : {models}.",
    "Aktuelle Fehler betreffen vor allem diese Modelle des Anbieters: {models}.",
    "Los fallos recientes se concentran en estos modelos del proveedor: {models}.",
    "As falhas recentes se concentram nestes modelos do provedor: {models}."
  ),
  schedulerDelayed: translations(
    "예정된 자동 확인이 지연되고 있습니다. 마지막 시작 시각: {lastRun}. 모니터링 일정의 지연이며 공급자 장애의 근거는 아닙니다. 아래 상태는 평소보다 오래된 자료를 반영할 수 있습니다.",
    "Scheduled automatic checks are delayed. Last start: {lastRun}. This is a monitoring delay, not evidence of a provider outage. The statuses below may reflect older evidence than usual.",
    "计划中的自动检查已延迟。最近启动时间：{lastRun}。这是监测延迟，不是供应商故障的依据；以下状态可能反映较旧的资料。",
    "Les contrôles automatiques planifiés sont en retard. Dernier démarrage : {lastRun}. Ce retard de suivi ne prouve pas une panne du fournisseur. Les statuts peuvent reposer sur des éléments plus anciens.",
    "Geplante automatische Prüfungen sind verspätet. Letzter Start: {lastRun}. Das ist eine Verzögerung der Überwachung, kein Beleg für einen Anbieterausfall. Die Statusangaben können auf älteren Belegen beruhen.",
    "Las comprobaciones automáticas programadas van con retraso. Último inicio: {lastRun}. Es un retraso de supervisión, no una evidencia de fallo del proveedor. Los estados pueden reflejar datos más antiguos.",
    "As verificações automáticas programadas estão atrasadas. Último início: {lastRun}. É um atraso do monitoramento, não uma evidência de falha do provedor. Os status podem refletir dados mais antigos."
  ),
  schedulerNever: translations(
    "예정된 자동 확인이 아직 실행되지 않았습니다. 아래 상태는 현재 확보된 확인 자료를 바탕으로 표시합니다. 자동 확인이 없는 것은 모니터링 공백이며 공급자 장애의 근거는 아닙니다.",
    "Scheduled automatic checks have not run yet. The statuses below use the evidence currently available. Missing automatic checks are a monitoring gap, not evidence of a provider outage.",
    "计划中的自动检查尚未运行。以下状态基于当前已有的确认资料；缺少自动检查是监测空缺，不是供应商故障的依据。",
    "Les contrôles automatiques planifiés n’ont pas encore eu lieu. Les statuts reposent sur les éléments disponibles. L’absence de contrôle est une lacune de suivi, pas une preuve de panne.",
    "Geplante automatische Prüfungen wurden noch nicht ausgeführt. Die Statusangaben beruhen auf den vorhandenen Belegen. Fehlende Prüfungen sind eine Überwachungslücke, kein Beleg für einen Anbieterausfall.",
    "Las comprobaciones automáticas programadas aún no se han ejecutado. Los estados usan las evidencias disponibles. La falta de comprobaciones es una laguna de supervisión, no una prueba de fallo del proveedor.",
    "As verificações automáticas programadas ainda não foram executadas. Os status usam as evidências disponíveis. A falta de verificações é uma lacuna do monitoramento, não uma prova de falha do provedor."
  ),
};

const statusLabels: Record<PublicProviderStatus, Translations> = {
  operational: translations("정상", "Operational", "正常", "Opérationnel", "Betriebsbereit", "Operativo", "Operacional"),
  degraded: translations("성능 저하", "Degraded", "性能下降", "Service dégradé", "Eingeschränkt", "Rendimiento reducido", "Desempenho reduzido"),
  incident: translations("장애", "Incident", "服务事件", "Incident", "Störung", "Incidente", "Incidente"),
  unknown: translations("확인 자료 없음", "Unknown", "未知", "Inconnu", "Unbekannt", "Desconocido", "Desconhecido"),
};
const summaryLabels: Record<PublicProviderStatus, Translations> = {
  operational: translations("모니터링 중인 모든 공급자가 정상입니다", "All monitored providers are operational", "所有受监测供应商运行正常", "Tous les fournisseurs suivis sont opérationnels", "Alle überwachten Anbieter sind betriebsbereit", "Todos los proveedores supervisados están operativos", "Todos os provedores monitorados estão operacionais"),
  degraded: translations("일부 공급자의 성능이 저하되어 있습니다", "Some providers are experiencing degraded performance", "部分供应商性能下降", "Certains fournisseurs ont un service dégradé", "Einige Anbieter haben eingeschränkte Leistung", "Algunos proveedores tienen un rendimiento reducido", "Alguns provedores apresentam desempenho reduzido"),
  incident: translations("하나 이상의 공급자에서 장애가 발생했습니다", "One or more providers are experiencing an incident", "一个或多个供应商发生服务事件", "Un ou plusieurs fournisseurs connaissent un incident", "Bei mindestens einem Anbieter liegt eine Störung vor", "Uno o más proveedores presentan un incidente", "Um ou mais provedores apresentam um incidente"),
  unknown: translations("일부 공급자의 현재 상태를 확인하지 못했습니다", "Some provider statuses are currently unverified", "部分供应商当前状态尚未确认", "Certains statuts de fournisseurs ne sont pas vérifiés", "Einige Anbieterzustände sind derzeit unbestätigt", "Algunos estados de proveedores no están verificados", "Alguns status de provedores não estão verificados"),
};

const reasonLabels: Record<PublicStatusReasonCode, Translations> = {
  PUBLIC_INCIDENT_DECLARED: translations("Tomverse 운영자가 이 공급자의 공개 장애를 알렸습니다.", "A Tomverse operator has declared an incident for this provider.", "Tomverse 运营人员已公布该供应商的服务事件。", "Un opérateur Tomverse a déclaré un incident pour ce fournisseur.", "Ein Tomverse-Betreiber hat eine Störung dieses Anbieters gemeldet.", "El equipo de Tomverse ha declarado un incidente de este proveedor.", "A equipe do Tomverse declarou um incidente deste provedor."),
  INTERNAL_OUTAGE_DETECTED: translations("모니터링에서 장애 수준의 요청 실패 또는 서비스 이용을 막는 조건이 확인됐습니다.", "Monitoring found an outage-level request failure rate or a condition preventing access to the service.", "监测发现达到故障级别的请求失败率，或阻止使用服务的条件。", "Le suivi a détecté un taux d’échec élevé ou une condition empêchant l’accès au service.", "Die Überwachung hat eine ausfallrelevante Fehlerrate oder ein Hindernis für den Dienstzugriff erkannt.", "La supervisión detectó una tasa de fallos grave o una condición que impide acceder al servicio.", "O monitoramento detectou uma taxa grave de falhas ou uma condição que impede o acesso ao serviço."),
  CONSECUTIVE_FAILURES_THRESHOLD: translations("마지막 성공 기록 이후 실제 요청이 연속 {failures}회 실패했습니다.", "{failures} consecutive user requests have failed since the last recorded success.", "自最近成功记录以来，真实请求已连续失败 {failures} 次。", "{failures} demandes réelles consécutives ont échoué depuis la dernière réussite enregistrée.", "Seit dem letzten aufgezeichneten Erfolg sind {failures} Nutzeranfragen in Folge fehlgeschlagen.", "Han fallado {failures} solicitudes reales consecutivas desde el último éxito registrado.", "{failures} solicitações reais consecutivas falharam desde o último sucesso registrado."),
  DEGRADED_PERFORMANCE: translations("모니터링에서 이 공급자 서비스의 운영 주의 신호가 확인됐습니다.", "Monitoring identified a warning affecting this provider’s service operation.", "监测发现该供应商服务运行的警告信号。", "Le suivi a détecté un avertissement concernant le fonctionnement du service de ce fournisseur.", "Die Überwachung hat eine Warnung zum Dienstbetrieb dieses Anbieters erkannt.", "La supervisión detectó una advertencia sobre el funcionamiento del servicio del proveedor.", "O monitoramento detectou um aviso sobre a operação do serviço deste provedor."),
  RECENT_FAILURE_EVIDENCE: translations("이 공급자의 가장 최근 실제 요청 결과는 실패였습니다.", "The most recent recorded user-request outcome for this provider was a failure.", "该供应商最近记录的真实请求结果为失败。", "La dernière demande réelle enregistrée pour ce fournisseur a échoué.", "Das zuletzt aufgezeichnete Ergebnis einer Nutzeranfrage war ein Fehler.", "La última solicitud real registrada de este proveedor falló.", "A última solicitação real registrada deste provedor falhou."),
  ELEVATED_LATENCY: translations("최근 실제 요청은 성공하고 있지만 예상보다 응답이 느립니다.", "Recent user requests are succeeding but responding slower than expected.", "近期真实请求成功，但响应比预期慢。", "Les demandes réelles récentes réussissent, mais répondent plus lentement que prévu.", "Aktuelle Nutzeranfragen sind erfolgreich, antworten aber langsamer als erwartet.", "Las solicitudes reales recientes funcionan, pero responden más despacio de lo esperado.", "As solicitações reais recentes funcionam, mas respondem mais devagar do que o esperado."),
  RECENT_SUCCESS_CONFIRMED: translations("최근 {minutes}분 안에 실제 사용자 요청의 성공이 기록됐습니다.", "A successful user request was recorded within the last {minutes} minutes.", "最近 {minutes} 分钟内记录了真实用户请求的成功。", "Une demande réelle a réussi au cours des {minutes} dernières minutes.", "In den letzten {minutes} Minuten wurde eine erfolgreiche Nutzeranfrage aufgezeichnet.", "Se registró una solicitud real correcta en los últimos {minutes} minutos.", "Uma solicitação real bem-sucedida foi registrada nos últimos {minutes} minutos."),
  PROBE_SUCCESS_CONFIRMED: translations("최근 {minutes}분 안에 자동 확인이 성공했습니다. 실제 사용자 요청의 성공 기록과는 별개입니다.", "An automatic check succeeded within the last {minutes} minutes. This is separate from a successful real user request.", "最近 {minutes} 分钟内自动检查成功。这与真实用户请求的成功记录不同。", "Un contrôle automatique a réussi au cours des {minutes} dernières minutes. Ce n’est pas une demande réelle d’un utilisateur.", "In den letzten {minutes} Minuten war eine automatische Prüfung erfolgreich. Das ist kein Erfolgsbeleg einer echten Nutzeranfrage.", "Una comprobación automática tuvo éxito en los últimos {minutes} minutos. Es distinta de una solicitud real de un usuario.", "Uma verificação automática teve sucesso nos últimos {minutes} minutos. Isso é diferente de uma solicitação real de um usuário."),
  PROBE_REPEATED_FAILURE: translations("자동 확인이 연속 {probeFailures}회 실패했습니다. 이와 상반되는 최근 실제 요청 성공 기록이 없습니다.", "{probeFailures} automatic checks have failed consecutively, with no recent successful user request to contradict them.", "自动检查已连续失败 {probeFailures} 次，且没有与之相反的近期真实请求成功记录。", "{probeFailures} contrôles automatiques ont échoué de suite, sans réussite récente d’une demande réelle pour les contredire.", "{probeFailures} automatische Prüfungen sind in Folge fehlgeschlagen; ein aktueller erfolgreicher Nutzerzugriff liegt nicht als Gegenbeleg vor.", "Han fallado {probeFailures} comprobaciones automáticas consecutivas, sin una solicitud real reciente correcta que las contradiga.", "{probeFailures} verificações automáticas falharam consecutivamente, sem uma solicitação real recente bem-sucedida que as contradiga."),
  PROBE_FAILURE_STALE: translations("마지막 자동 확인 실패가 {minutes}분의 유효 확인 기간보다 오래돼 현재 공급자 상태를 판단할 수 없습니다.", "The last failed automatic check is older than the {minutes}-minute evidence window and cannot establish the provider’s current state.", "最近一次自动检查失败已超过 {minutes} 分钟的有效确认期，无法据此判断当前供应商状态。", "Le dernier contrôle automatique échoué dépasse la fenêtre de {minutes} minutes et ne permet pas d’établir l’état actuel du fournisseur.", "Die letzte fehlgeschlagene automatische Prüfung ist älter als das {minutes}-Minuten-Zeitfenster und belegt keinen aktuellen Zustand.", "La última comprobación automática fallida supera la ventana de {minutes} minutos y no permite determinar el estado actual.", "A última verificação automática com falha está fora da janela de {minutes} minutos e não permite determinar o estado atual."),
  REAL_FAILURE_STALE: translations("마지막 실제 요청 실패가 {minutes}분의 유효 확인 기간보다 오래돼 현재 공급자 상태를 판단할 수 없습니다.", "The last failed user request is older than the {minutes}-minute evidence window and cannot establish the provider’s current state.", "最近一次真实请求失败已超过 {minutes} 分钟的有效确认期，无法据此判断当前供应商状态。", "La dernière demande réelle échouée dépasse la fenêtre de {minutes} minutes et ne permet pas d’établir l’état actuel du fournisseur.", "Die letzte fehlgeschlagene Nutzeranfrage ist älter als das {minutes}-Minuten-Zeitfenster und belegt keinen aktuellen Zustand.", "La última solicitud real fallida supera la ventana de {minutes} minutos y no permite determinar el estado actual.", "A última solicitação real com falha está fora da janela de {minutes} minutos e não permite determinar o estado atual."),
  ADMIN_VERIFICATION_SUCCESS: translations("최근 {minutes}분 안에 Tomverse 운영자의 확인 요청이 성공했습니다. 실제 사용자 요청의 성공 기록과는 별개입니다.", "An operator check succeeded within the last {minutes} minutes. This is separate from a successful real user request.", "最近 {minutes} 分钟内 Tomverse 运营人员的检查成功。这与真实用户请求的成功记录不同。", "Un contrôle par un opérateur a réussi au cours des {minutes} dernières minutes. Ce n’est pas une demande réelle d’un utilisateur.", "In den letzten {minutes} Minuten war eine Betreiberprüfung erfolgreich. Das ist kein Erfolgsbeleg einer echten Nutzeranfrage.", "Una comprobación del equipo tuvo éxito en los últimos {minutes} minutos. Es distinta de una solicitud real de un usuario.", "Uma verificação da equipe teve sucesso nos últimos {minutes} minutos. Isso é diferente de uma solicitação real de um usuário."),
  RECOVERY_VERIFICATION_FAILED: translations("이 공급자에 대한 가장 최근 Tomverse 운영자 확인 요청이 실패했습니다.", "The most recent operator check for this provider failed.", "对该供应商最近一次 Tomverse 运营人员检查失败。", "Le dernier contrôle de ce fournisseur par un opérateur a échoué.", "Die letzte Betreiberprüfung dieses Anbieters ist fehlgeschlagen.", "La última comprobación del equipo de este proveedor falló.", "A última verificação da equipe deste provedor falhou."),
  NO_SUCCESS_RECORDED: translations("이 공급자의 실제 요청이나 자동 확인 성공이 아직 기록되지 않았습니다.", "No successful real request or automatic check has been recorded for this provider yet.", "尚未记录该供应商的真实请求或自动检查成功。", "Aucune demande réelle ou contrôle automatique réussi n’a encore été enregistré pour ce fournisseur.", "Für diesen Anbieter wurde noch keine erfolgreiche Nutzeranfrage oder automatische Prüfung aufgezeichnet.", "Aún no se ha registrado una solicitud real o comprobación automática correcta de este proveedor.", "Ainda não foi registrada uma solicitação real ou verificação automática bem-sucedida deste provedor."),
  SUCCESS_STALE: translations("마지막 성공 기록이 {minutes}분의 유효 확인 기간보다 오래됐습니다. 현재 정상 작동한다고 확인할 수 없습니다.", "The last recorded success is older than the {minutes}-minute evidence window. It does not confirm current operational status.", "最近成功记录已超过 {minutes} 分钟的有效确认期，无法确认当前运行正常。", "La dernière réussite enregistrée dépasse la fenêtre de {minutes} minutes. Elle ne confirme pas le fonctionnement actuel.", "Der letzte aufgezeichnete Erfolg ist älter als das {minutes}-Minuten-Zeitfenster und bestätigt keinen aktuellen Normalbetrieb.", "El último éxito registrado supera la ventana de {minutes} minutos y no confirma el funcionamiento actual.", "O último sucesso registrado está fora da janela de {minutes} minutos e não confirma o funcionamento atual."),
  HEALTH_DATA_UNAVAILABLE: translations("공급자 상태 자료를 불러오지 못해 현재 상태를 확인할 수 없습니다.", "Provider health data could not be loaded, so the current state cannot be verified.", "无法加载供应商状态资料，因此无法确认当前状态。", "Les données du fournisseur n’ont pas pu être chargées ; son état actuel ne peut pas être vérifié.", "Die Anbieterdaten konnten nicht geladen werden; der aktuelle Zustand ist unbestätigt.", "No se pudieron cargar los datos del proveedor y no se puede verificar su estado actual.", "Não foi possível carregar os dados do provedor, portanto o estado atual não pode ser verificado."),
};

const reasonVariants = {
  elevatedFailureRate: translations("최근 실제 요청의 실패율이 높아졌지만 장애 판정 기준에는 도달하지 않았습니다.", "The recent user-request failure rate is elevated but has not reached the incident threshold.", "近期真实请求失败率上升，但尚未达到事件判定阈值。", "Le taux d’échec des demandes réelles a augmenté, sans atteindre le seuil d’incident.", "Die Fehlerrate aktueller Nutzeranfragen ist erhöht, hat aber die Störungsschwelle nicht erreicht.", "La tasa de fallos de solicitudes reales ha aumentado, pero no alcanza el umbral de incidente.", "A taxa de falhas de solicitações reais aumentou, mas não atingiu o limite de incidente."),
  operatingUsageWarning: translations("공급자 서비스의 운영 사용량이 주의 구간에 도달했습니다. 사용자 플랜 크레딧 소진을 뜻하지 않습니다.", "Service operating usage has reached a warning level. This does not mean user plan credits have run out.", "供应商服务的运营用量达到警告区间。这不表示用户套餐积分已用完。", "L’usage lié à l’exploitation du service atteint un niveau d’alerte. Cela ne signifie pas que les crédits de votre offre sont épuisés.", "Die betriebliche Dienstnutzung hat eine Warnstufe erreicht. Das bedeutet nicht, dass die Credits Ihres Tarifs aufgebraucht sind.", "El uso operativo del servicio alcanzó un nivel de advertencia. Esto no significa que se hayan agotado los créditos de tu plan.", "O uso operacional do serviço atingiu um nível de aviso. Isso não significa que os créditos do seu plano acabaram."),
  modelIncident: translations("현재 확인 기간에 이 공급자의 일부 모델에서 반복된 실패가 기록됐습니다.", "Repeated failures have been recorded for some models from this provider in the current monitoring window.", "当前监测期间记录了该供应商部分模型的重复失败。", "Des échecs répétés de certains modèles ont été enregistrés dans la période de suivi actuelle.", "Im aktuellen Überwachungszeitraum wurden wiederholte Fehler bei Modellen dieses Anbieters aufgezeichnet.", "Se registraron fallos repetidos de algunos modelos de este proveedor en la ventana actual.", "Foram registradas falhas repetidas de alguns modelos deste provedor na janela atual."),
  probeBelowIncidentThreshold: translations("아직 장애 판정 기준에는 도달하지 않았습니다.", "This has not reached the incident threshold.", "尚未达到事件判定阈值。", "Le seuil d’incident n’est pas atteint.", "Die Störungsschwelle ist noch nicht erreicht.", "No se ha alcanzado el umbral de incidente.", "O limite de incidente ainda não foi atingido."),
  probeWithoutTimestamp: translations("자동 확인 실패가 {probeFailures}회 기록됐지만 사용 가능한 확인 시각이 없어 현재 상태를 판단할 수 없습니다.", "{probeFailures} failed automatic checks are recorded, but there is no usable timestamp to establish the current state.", "记录了 {probeFailures} 次自动检查失败，但没有可用的检查时间，无法判断当前状态。", "{probeFailures} contrôles automatiques échoués sont enregistrés, sans horodatage utilisable pour établir l’état actuel.", "{probeFailures} fehlgeschlagene automatische Prüfungen sind aufgezeichnet, jedoch ohne nutzbaren Zeitstempel für den aktuellen Zustand.", "Hay {probeFailures} comprobaciones automáticas fallidas registradas, pero no una fecha utilizable para determinar el estado actual.", "Há {probeFailures} verificações automáticas com falha registradas, mas sem um horário utilizável para determinar o estado atual."),
  trafficWithoutTimestamp: translations("연속된 실제 요청 실패가 {failures}회 기록됐지만 사용 가능한 확인 시각이 없어 현재 상태를 판단할 수 없습니다.", "{failures} consecutive failed user requests are recorded, but there is no usable timestamp to establish the current state.", "记录了 {failures} 次连续真实请求失败，但没有可用的检查时间，无法判断当前状态。", "{failures} demandes réelles échouées de suite sont enregistrées, sans horodatage utilisable pour établir l’état actuel.", "{failures} fehlgeschlagene Nutzeranfragen in Folge sind aufgezeichnet, jedoch ohne nutzbaren Zeitstempel für den aktuellen Zustand.", "Hay {failures} solicitudes reales fallidas consecutivas registradas, pero no una fecha utilizable para determinar el estado actual.", "Há {failures} solicitações reais consecutivas com falha registradas, mas sem um horário utilizável para determinar o estado atual."),
};

export type PublicStatusEvidenceSource = "traffic" | "probe" | "manual" | "declared" | "monitoring" | "mixed" | "none";
const sourceLabels: Record<PublicStatusEvidenceSource, Translations> = {
  traffic: translations("근거: 실제 사용자 요청 기록", "Evidence: real user requests", "依据：真实用户请求记录", "Éléments : demandes réelles d’utilisateurs", "Belege: echte Nutzeranfragen", "Evidencia: solicitudes reales de usuarios", "Evidência: solicitações reais de usuários"),
  probe: translations("근거: 자동 확인 · 실제 사용자 요청과 별개", "Evidence: automatic checks, separate from real user requests", "依据：自动检查，与真实用户请求不同", "Éléments : contrôles automatiques, distincts des demandes réelles", "Belege: automatische Prüfungen, getrennt von echten Nutzeranfragen", "Evidencia: comprobaciones automáticas, distintas de solicitudes reales", "Evidência: verificações automáticas, distintas de solicitações reais"),
  manual: translations("근거: 운영자 확인 · 실제 사용자 요청과 별개", "Evidence: operator checks, separate from real user requests", "依据：运营人员检查，与真实用户请求不同", "Éléments : contrôles par un opérateur, distincts des demandes réelles", "Belege: Betreiberprüfungen, getrennt von echten Nutzeranfragen", "Evidencia: comprobaciones del equipo, distintas de solicitudes reales", "Evidência: verificações da equipe, distintas de solicitações reais"),
  declared: translations("근거: Tomverse 운영자의 장애 공지", "Evidence: incident declared by a Tomverse operator", "依据：Tomverse 运营人员发布的事件公告", "Éléments : incident déclaré par un opérateur Tomverse", "Belege: Störungsmeldung des Tomverse-Betreibers", "Evidencia: incidente declarado por el equipo de Tomverse", "Evidência: incidente declarado pela equipe do Tomverse"),
  monitoring: translations("근거: 요청 실패율과 서비스 이용 조건의 모니터링", "Evidence: monitoring of request failures and service-access conditions", "依据：请求失败率与服务使用条件监测", "Éléments : suivi des échecs et des conditions d’accès au service", "Belege: Überwachung von Anfragefehlern und Zugangsbedingungen", "Evidencia: supervisión de fallos y condiciones de acceso al servicio", "Evidência: monitoramento de falhas e condições de acesso ao serviço"),
  mixed: translations("근거: 과거 실제 요청 및 자동 확인 기록", "Evidence: past user-request and automatic-check records", "依据：过去的真实请求和自动检查记录", "Éléments : anciens relevés de demandes réelles et de contrôles automatiques", "Belege: frühere Nutzeranfragen und automatische Prüfungen", "Evidencia: registros anteriores de solicitudes reales y comprobaciones automáticas", "Evidência: registros anteriores de solicitações reais e verificações automáticas"),
  none: translations("근거: 현재 상태를 확인할 자료 없음", "Evidence: no data confirming the current state", "依据：没有可确认当前状态的资料", "Éléments : aucune donnée confirmant l’état actuel", "Belege: keine Daten zur Bestätigung des aktuellen Zustands", "Evidencia: sin datos que confirmen el estado actual", "Evidência: sem dados que confirmem o estado atual"),
};

export type PublicStatusEvidence = {
  publicStatus: PublicProviderStatus;
  publicStatusReasonCode: PublicStatusReasonCode;
  publicStatusFreshnessMinutes: number;
  consecutiveFailures: number;
  consecutiveProbeFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastProbeSuccessAt: string | null;
  lastProbeFailureAt: string | null;
  status?: "available" | "limited" | "outage";
  statusReasons?: Array<{ code: string }>;
  modelIncidents?: Array<{ scope: "provider" | "model" | "none" }>;
};

const localizeRecord = <Key extends string>(record: Record<Key, Translations>, language: Language): Record<Key, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, (value as Translations)[language]])) as Record<Key, string>;

export const getPublicStatusCopy = (language: Language) => ({
  ...localizeRecord(labels, language),
  statuses: localizeRecord(statusLabels, language),
});

export const resolvePublicStatusLanguage = ({
  searchLanguage, documentLanguage, acceptLanguage,
}: {
  searchLanguage?: string | string[];
  documentLanguage?: string | null;
  acceptLanguage?: string | null;
}): Language => {
  const explicitLanguage = Array.isArray(searchLanguage) ? searchLanguage[0] : searchLanguage;
  if (isLanguage(explicitLanguage)) return explicitLanguage;
  if (isLanguage(documentLanguage)) return documentLanguage;
  return resolveDocumentLanguage({ acceptLanguage }).language;
};

export const localizePublicStatusSummary = (
  summary: MonitoredStatusSummary,
  language: Language,
  { providerCount, dataUnavailable }: { providerCount: number; dataUnavailable: boolean }
): MonitoredStatusSummary => ({
  tone: summary.tone,
  headline: dataUnavailable
    ? labels.dataUnavailableHeadline[language]
    : providerCount === 0
      ? labels.emptyHeadline[language]
      : summaryLabels[summary.tone][language],
});

const hasUsableTimestamp = (timestamp: string | null, now: Date): boolean => {
  if (!timestamp) return false;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && value <= now.getTime();
};

/** Labels evidence already selected by the core; this helper never decides health. */
export const publicStatusEvidenceSource = (evidence: PublicStatusEvidence, now: Date): PublicStatusEvidenceSource => {
  switch (evidence.publicStatusReasonCode) {
    case "PUBLIC_INCIDENT_DECLARED": return "declared";
    case "PROBE_SUCCESS_CONFIRMED":
    case "PROBE_REPEATED_FAILURE":
    case "PROBE_FAILURE_STALE": return "probe";
    case "ADMIN_VERIFICATION_SUCCESS":
    case "RECOVERY_VERIFICATION_FAILED": return "manual";
    case "HEALTH_DATA_UNAVAILABLE":
    case "NO_SUCCESS_RECORDED": return "none";
    case "INTERNAL_OUTAGE_DETECTED": return "monitoring";
    case "DEGRADED_PERFORMANCE":
      return evidence.statusReasons?.some((reason) => reason.code === "RECENT_PROVIDER_FAILURES") && !evidence.statusReasons.some((reason) => reason.code === "MONTHLY_BUDGET_WARNING") ? "traffic" : "monitoring";
    case "SUCCESS_STALE": {
      const traffic = hasUsableTimestamp(evidence.lastSuccessAt, now);
      const probe = hasUsableTimestamp(evidence.lastProbeSuccessAt, now);
      return traffic && probe ? "mixed" : traffic ? "traffic" : probe ? "probe" : "none";
    }
    case "CONSECUTIVE_FAILURES_THRESHOLD":
    case "RECENT_FAILURE_EVIDENCE":
    case "ELEVATED_LATENCY":
    case "RECENT_SUCCESS_CONFIRMED":
    case "REAL_FAILURE_STALE": return "traffic";
  }
};

const formatMessage = (text: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), text);

export const formatPublicStatusUtc = (value: string): string => `${value.replace("T", " ").slice(0, 16)} UTC`;

/** Translates typed reason codes and structured fields, never the server's English prose. */
export const describePublicStatusEvidence = (evidence: PublicStatusEvidence, language: Language, now: Date) => {
  let reason = reasonLabels[evidence.publicStatusReasonCode][language];
  if (evidence.publicStatusReasonCode === "DEGRADED_PERFORMANCE") {
    const failures = evidence.statusReasons?.some((entry) => entry.code === "RECENT_PROVIDER_FAILURES");
    const usageWarning = evidence.statusReasons?.some((entry) => entry.code === "MONTHLY_BUDGET_WARNING");
    if (failures) reason = reasonVariants.elevatedFailureRate[language];
    if (usageWarning) reason = failures ? `${reason} ${reasonVariants.operatingUsageWarning[language]}` : reasonVariants.operatingUsageWarning[language];
  }
  if (evidence.publicStatusReasonCode === "INTERNAL_OUTAGE_DETECTED" && evidence.status !== "outage" && evidence.modelIncidents?.some((incident) => incident.scope === "provider")) {
    reason = reasonVariants.modelIncident[language];
  }
  if (evidence.publicStatusReasonCode === "PROBE_FAILURE_STALE" && !hasUsableTimestamp(evidence.lastProbeFailureAt, now)) reason = reasonVariants.probeWithoutTimestamp[language];
  if (evidence.publicStatusReasonCode === "REAL_FAILURE_STALE" && !hasUsableTimestamp(evidence.lastFailureAt, now)) reason = reasonVariants.trafficWithoutTimestamp[language];
  if (evidence.publicStatusReasonCode === "PROBE_REPEATED_FAILURE" && evidence.publicStatus === "degraded") reason += ` ${reasonVariants.probeBelowIncidentThreshold[language]}`;
  const formatter = new Intl.NumberFormat(language);
  return {
    reason: formatMessage(reason, {
      minutes: formatter.format(evidence.publicStatusFreshnessMinutes),
      failures: formatter.format(Math.max(0, Math.floor(evidence.consecutiveFailures))),
      probeFailures: formatter.format(Math.max(0, Math.floor(evidence.consecutiveProbeFailures))),
    }),
    source: sourceLabels[publicStatusEvidenceSource(evidence, now)][language],
  };
};

export const publicStatusSchedulerNotice = (
  delay: "delayed_with_history" | "delayed_never_run" | null,
  job: ProbeSchedulerJobSummary | null,
  language: Language
): string | null => {
  if (!delay) return null;
  if (delay === "delayed_never_run") return labels.schedulerNever[language];
  return formatMessage(labels.schedulerDelayed[language], {
    lastRun: job?.lastRunAt ? formatPublicStatusUtc(job.lastRunAt) : labels.unrecorded[language],
  });
};

export const describePublicStatusAffectedModels = (models: string[], language: Language): string =>
  formatMessage(labels.affectedModels[language], { models: models.join(", ") });
