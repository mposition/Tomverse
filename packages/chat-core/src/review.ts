export type ReviewMode = "balanced" | "evidence" | "action";

export type ReviewSetup = {
  source?: { question: string; responses: Array<{ messageId: string; content: string }> };
  storedReview?: ComparisonReview;
  available: boolean;
  reason?: string;
  promptMessageId?: string;
  assistantMessageIds?: string[];
  responses?: Array<{
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  estimatedCredits?: number;
  dualReview?: boolean;
  reviewerClass?: string;
  freeMonthlyReviews?: number | null;
  disclaimer?: string;
  /** Guest-only fields, all server-computed. Never sent back on the run. */
  guest?: boolean;
  guestTrial?: { limit: number; used: number; remaining: number };
  creditsAvailable?: number;
  webVerificationAvailable?: boolean;
  persisted?: boolean;
};

export type Citation = { responseId: "A" | "B" | "C"; quote: string; verified: boolean };
export type GroundedClaim = { text: string; citations: Citation[]; verified: boolean };

export type SingleReviewResult = {
  consensus: GroundedClaim[];
  differences: Array<{
    issue: string;
    positions: Array<{
      responseId: "A" | "B" | "C";
      position: string;
      quote: string;
      verified: boolean;
    }>;
  }>;
  contradictions: GroundedClaim[];
  missingPoints: string[];
  verificationNeeded: string[];
  modelAssessments: Array<{
    responseId: "A" | "B" | "C";
    strengths: string[];
    cautions: string[];
  }>;
  synthesis: string;
  confidence: "low" | "medium" | "high";
  limitations: string[];
  groundingStats: { totalCitations: number; verifiedCitations: number };
};

export type ReviewAgreement = {
  confidenceMatches: boolean;
  primaryConfidence: "low" | "medium" | "high";
  secondaryConfidence: "low" | "medium" | "high";
  sharedVerifiedQuoteCount: number;
};

export type ComparisonReview = {
  id: string;
  result: {
    primary: { reviewerModelId: string; result: SingleReviewResult };
    secondary: { reviewerModelId: string; result: SingleReviewResult } | null;
    agreement: ReviewAgreement | null;
  };
  responseMap: Array<{
    responseId: "A" | "B" | "C";
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  reviewerModelId: string;
  usageCredits: number;
  originalUsageCredits?: number;
  cached: boolean;
  disclaimer: string;
  /**
   * Per-claim identifiers for the feedback control, derived on the server
   * (lib/comparisonReviewItemFeedback.ts) and never recomputed here: the
   * derivation hashes, and a second implementation in the browser would be a
   * second place for the two to stop agreeing. Absent on a guest review,
   * which is not stored and therefore has nothing to attach a verdict to.
   */
  reviewItems?: Array<{
    id: string;
    reviewer: "primary" | "secondary";
    section: string;
    ordinal: number;
  }>;
  guest?: boolean;
  persisted?: boolean;
  webVerificationAvailable?: boolean;
};
