/**
 * The one place a Conversation row is created.
 *
 * Product boundary decision record v1.2, §6.
 *
 * ## Why a service and not just the constraints
 *
 * `20260822090000_conversation_product_key_expand` added three CHECKs, and all
 * three pass `productKey IS NULL` -- the transition requires it. So a writer
 * that simply forgets the column writes a row every constraint accepts, stored
 * as NULL, and the migration's step 2 ("every writer names a productKey")
 * becomes a claim nobody can check.
 *
 * The constraints stop wrong combinations. This function, the static check
 * against direct `conversation.create` calls, and the writer coverage tests
 * stop omissions. All four are needed and none replaces another.
 *
 * ## Why it takes a transaction client and does not open one
 *
 * All three production writers already run inside `prisma.$transaction`, and
 * each has work that must land with the conversation or not at all -- a
 * capacity assertion, the imported messages, the image reservation and its
 * budget rows. A service that opened its own transaction would put the
 * conversation outside the caller's, so a caller that rolled back would leave
 * an orphan conversation behind. It takes `Prisma.TransactionClient` for that
 * reason, and the type is what stops it being called with the bare client.
 *
 * ## Why productKey is a required argument
 *
 * Not optional with a default. An optional product would be the same
 * substitution the column's missing DB default exists to prevent: a caller
 * that did not think about it would look like a caller that chose Review.
 * Every call site has to say which product it is creating, and the compiler
 * is what asks.
 */

import type { Prisma } from "@prisma/client";

import {
  conversationProductViolation,
  PRODUCT_MODALITY,
  type ConversationProductKey,
} from "@/lib/conversationProduct";

export type CreateConversationInput = {
  userId: string;
  title: string;
  /**
   * Which product is creating this conversation.
   *
   * Server-decided at every call site. It never comes from a request body, a
   * `Referer`, or any other header: those are the client's claim about which
   * screen it was on, and a product identity derived from a claim is not
   * server-derived at all. The product-specific endpoints hold it as a module
   * constant instead.
   */
  productKey: ConversationProductKey;
  /**
   * Defaults to the product's own modality. Passing one that disagrees is a
   * programming error, refused here rather than left to the database, so the
   * stack trace names the call site.
   */
  kind?: "chat" | "image";
  selectionMode?: "manual" | "auto";
  selectedModels?: string;
  disabledPanels?: string;
  webSearchMode?: string;
  projectId?: string | null;
  assistantProfileVersionId?: string | null;
  importedGuestKey?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export class ConversationProductError extends Error {
  constructor(
    readonly violation: NonNullable<ReturnType<typeof conversationProductViolation>>,
    message: string
  ) {
    super(message);
    this.name = "ConversationProductError";
  }
}

/**
 * Creates the row, with the product written into it in the same statement.
 *
 * Atomic by construction rather than by discipline: there is no window in
 * which the conversation exists without its product, so no reader has to
 * handle one.
 */
/**
 * Overloaded rather than generic over the select: a caller that passes no
 * select gets the full row's type, and one that passes `{ id: true }` gets
 * exactly that. A single conditional signature collapsed both to a union and
 * every field read downstream became an error.
 */
export async function createConversation(
  tx: Prisma.TransactionClient,
  input: CreateConversationInput
): Promise<Prisma.ConversationGetPayload<object>>;
export async function createConversation<TSelect extends Prisma.ConversationSelect>(
  tx: Prisma.TransactionClient,
  input: CreateConversationInput,
  select: TSelect
): Promise<Prisma.ConversationGetPayload<{ select: TSelect }>>;
export async function createConversation(
  tx: Prisma.TransactionClient,
  input: CreateConversationInput,
  select?: Prisma.ConversationSelect
): Promise<unknown> {
  const kind = input.kind ?? PRODUCT_MODALITY[input.productKey];
  const selectionMode = input.selectionMode ?? "manual";

  // Refused here as well as by the CHECK. The database's message names a
  // constraint; this one names the product and the modality that disagreed,
  // which is the sentence somebody reading a 500 actually needs.
  const violation = conversationProductViolation({
    productKey: input.productKey,
    kind,
    selectionMode,
  });
  if (violation) {
    throw new ConversationProductError(
      violation,
      `Refusing to create a ${input.productKey} conversation with kind=${kind} ` +
        `and selectionMode=${selectionMode}: ${violation}.`
    );
  }

  const data = {
    userId: input.userId,
    title: input.title,
    productKey: input.productKey,
    kind,
    selectionMode,
    ...(input.selectedModels === undefined ? {} : { selectedModels: input.selectedModels }),
    ...(input.disabledPanels === undefined ? {} : { disabledPanels: input.disabledPanels }),
    ...(input.webSearchMode === undefined ? {} : { webSearchMode: input.webSearchMode }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.assistantProfileVersionId === undefined
      ? {}
      : { assistantProfileVersionId: input.assistantProfileVersionId }),
    ...(input.importedGuestKey === undefined
      ? {}
      : { importedGuestKey: input.importedGuestKey }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  } satisfies Prisma.ConversationUncheckedCreateInput;

  return select
    ? tx.conversation.create({ data, select })
    : tx.conversation.create({ data });
}
