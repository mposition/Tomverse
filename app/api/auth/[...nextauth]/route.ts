import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// 분리한 authOptions를 NextAuth에 집어넣습니다.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };