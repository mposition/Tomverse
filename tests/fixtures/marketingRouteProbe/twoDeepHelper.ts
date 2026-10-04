// The first helper: it names only the second one, so a check that stops after
// one hop sees nothing.
import { pauseInner } from "./innerHelper";

export const pauseViaHelper = () => pauseInner();
