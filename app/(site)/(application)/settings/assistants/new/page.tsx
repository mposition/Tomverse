export const dynamic = "force-dynamic";

import { NewAssistantProfileScreen } from "@/components/assistants/NewAssistantProfileScreen";

// A static segment beside [profileId]. Next resolves the literal first, so
// "new" is the create screen rather than a profile whose id happens to be
// "new" -- which is also why no profile id is ever the string "new".
//
// The screen is a client component of its own because it reads the query
// string to decide where a finished create goes. `useSearchParams` suspends
// during prerendering; this route is `force-dynamic`, so it does not here, and
// the boundary inside the screen keeps that true if the route's rendering mode
// ever changes.
export default function NewAssistantProfilePage() {
    return (
        <main>
            <NewAssistantProfileScreen />
        </main>
    );
}
