export const schemaValidAmuxRoutingCandidate = (workerName: string) => ({
  worker_name: workerName,
  provider: "codex",
  breakdown: {
    task_fit: {
      role_fit: 1,
      provider_fit: 1,
      combined: 1,
      large_task: false,
    },
    predicted_success: {
      value: 0.5,
      observed: false,
    },
    quota_remaining: {
      value: 0.5,
      observed: false,
    },
    expected_speed: {
      value: 0.5,
      observed: false,
    },
    low_rework: {
      value: 0.5,
      observed: false,
    },
    low_human_attention: {
      value: 0.5,
      observed: false,
    },
    cost_efficiency: {
      value: 0.5,
      observed: false,
    },
    selected_score: 0.7,
    intrinsic_score: 0.75,
    operationally_allowed: true,
    provider_exhausted: false,
    selected_eligible: true,
  },
});
