/**
 * What a panel's transcript looks like when a turn is sent again.
 *
 * A retry is a *replacement*, not an addition. The failed user turn is still
 * on screen -- deliberately, because the draft and the attachment cards live
 * in it -- and the error sits in the assistant turn beneath it. Sending again
 * under a fresh message id left both in place and appended a second copy of
 * the same question, which is wrong in three separate ways:
 *
 *  - The same attachment reference was then named twice in one request, and
 *    `/api/chat` refused the whole transcript with `DUPLICATE_ATTACHMENT_OBJECT`
 *    -- so every retry of a turn that carried a file failed, for as many times
 *    as the button was pressed.
 *  - The provider was handed the question and the file twice, and an assistant
 *    turn whose entire content was an error sentence, to answer around.
 *  - For a signed-in account the failed turn is already a saved row, so the
 *    retry's answer was filed under a user message that was never persisted.
 *
 * Reusing the failed turn's own id fixes all three, and this is the function
 * that makes the reuse safe: everything from that id onward is dropped, so the
 * turn is rebuilt rather than duplicated. A fresh send, whose id appears
 * nowhere, is returned unchanged.
 */

/** The least a message must be for this to place it. */
type IdentifiedMessage = { id: string };

/**
 * The transcript a send should build on, given the id the send will use.
 *
 * `messages` is the pre-send snapshot in display order. When `userMessageId`
 * is already in it the send is a retry of that turn: the turn and everything
 * after it -- which is the failed exchange, and only ever that, because a
 * retry replays the last turn -- is dropped, and the caller appends the fresh
 * pair. Otherwise nothing is dropped.
 */
export const transcriptBeforeSend = <T extends IdentifiedMessage>(
  messages: readonly T[],
  userMessageId: string
): T[] => {
  const index = messages.findIndex((message) => message.id === userMessageId);
  return index === -1 ? [...messages] : messages.slice(0, index);
};
