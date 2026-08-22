/**
 * The §13.3 disclosure for shared conversations and exports.
 *
 * Two properties make this line safe to show, and both are easy to lose:
 *
 *   * **It is unconditional.** Every shared conversation and every export
 *     carries it while memory injection is available, whether or not this
 *     author has a single stored memory. Showing it only when the author
 *     actually used memory would make its presence the disclosure — a reader
 *     could tell who personalises and who does not.
 *   * **It says nothing specific.** No count, no kind, no statement, no
 *     evidence. It states that answers may have been shaped and that the
 *     remembered notes are not part of what was shared, which is exactly the
 *     pair of facts a third party needs and the most they may have.
 *
 * The export copy is English because the export document is: its header
 * already reads "Tomverse Review Export", and a file has no viewer locale to
 * read. The share *page* has one, so it uses `share.personalizationNotice`
 * from the locale bundles instead of this string.
 */

export function conversationExportPersonalizationNotice(): string {
    return "Note: answers here may have been shaped by the author's personalisation settings. The remembered notes themselves are not included in this export.";
}
