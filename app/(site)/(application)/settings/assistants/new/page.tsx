export const dynamic = "force-dynamic";

import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";

// A static segment beside [profileId]. Next resolves the literal first, so
// "new" is the create screen rather than a profile whose id happens to be
// "new" -- which is also why no profile id is ever the string "new".
export default function NewAssistantProfilePage() {
    return (
        <main>
            <AssistantProfileEditor />
        </main>
    );
}
