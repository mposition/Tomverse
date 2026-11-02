import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { appleCallbackOptions } from "@/lib/appleAuth";

const defaultHandler = NextAuth(authOptions);
const appleHandler = NextAuth(appleCallbackOptions(authOptions));

async function handler(request: Request, context: { params: Promise<{ nextauth: string[] }> }) {
  const { nextauth } = await context.params;
  return (nextauth[1] === "apple" ? appleHandler : defaultHandler)(request, context);
}

export { handler as GET, handler as POST };
