/**
 * Framework-neutral routing primitives.
 *
 * What is here is the *construction* of a ranking from criteria that may
 * abstain. What is not here, and must not arrive here, is any product
 * decision: which criteria exist, what they read, what the epsilons are, which
 * models are in the catalogue, what anything costs.
 *
 * The boundary is worth stating because the two are easy to move together. A
 * criterion list imported into this package would make it a Tomverse Chat
 * package that happens to live under `packages/`, and the next client to reuse
 * it would inherit decisions it never made.
 */

export {
    partitionByKey,
    partitionByMetric,
    partitions,
    refineToRanking,
} from "./refinement";
export type { Bucket, Partitioner } from "./refinement";
