import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Scheduled jobs panel under Automation. */
export const adminScheduledJobsMessages = defineAdminMessages({
  en: {
    never: "Never",
    unknown: "Unknown",
    loadFailed: "Could not load scheduled jobs.",
    loadFailedDetail: "The jobs may be running fine. Only this page could not read them.",
    title: "Scheduled jobs",
    description:
      "A job is marked delayed when Railway has not called it within its expected interval.",
    refresh: "Refresh",
    columns: {
      job: "Job",
      schedule: "When",
      lastRun: "Last run",
      lastSuccess: "Last success",
      nextRun: "Next run",
      status: "Status",
    },
    processed: (count: number) => `${count} handled`,
    status: {
      succeeded: "Succeeded",
      failed: "Failed",
      running: "Running",
      delayed: "Late",
      stuck: "Stuck",
      not_run: "Not run yet",
    },
    failedInARow: (count: number) => `${count} in a row failed`,
    empty: { title: "No scheduled jobs are defined.", detail: "Nothing here is waiting on a timer." },
    explainer: {
      title: (name: string, count: number) =>
        count === 1 ? `${name} failed on its last run` : `${name} failed ${count} times in a row`,
      detail: (lastFailure: string, nextRun: string) =>
        `The last failure was ${lastFailure}. The next run is ${nextRun}.`,
      errorSummary: "Error from the last failure",
    },
  },
  ko: {
    never: "없음",
    unknown: "알 수 없음",
    loadFailed: "예약 작업을 불러오지 못했어요.",
    loadFailedDetail: "작업은 잘 돌고 있을 수 있어요. 이 화면이 읽지 못한 것뿐이에요.",
    title: "예약 작업",
    description:
      "Railway가 예상한 주기 안에 작업을 부르지 않으면 늦은 작업으로 표시해요.",
    refresh: "새로고침",
    columns: {
      job: "작업",
      schedule: "언제",
      lastRun: "마지막 실행",
      lastSuccess: "마지막 성공",
      nextRun: "다음 실행",
      status: "상태",
    },
    processed: (count: number) => `${count}건 처리`,
    status: {
      succeeded: "성공",
      failed: "실패",
      running: "실행 중",
      delayed: "늦음",
      stuck: "멈춤",
      not_run: "아직 안 돌았어요",
    },
    failedInARow: (count: number) => `${count}번 연속 실패`,
    empty: { title: "정해진 예약 작업이 없어요.", detail: "타이머를 기다리는 작업이 없어요." },
    explainer: {
      title: (name: string, count: number) =>
        count === 1 ? `${name}이(가) 마지막 실행에서 실패했어요` : `${name}이(가) ${count}번 연속 실패했어요`,
      detail: (lastFailure: string, nextRun: string) =>
        `마지막 실패는 ${lastFailure}이고, 다음 실행은 ${nextRun}이에요.`,
      errorSummary: "마지막 실패의 오류 내용",
    },
  },
});
