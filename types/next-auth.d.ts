import type { DefaultSession } from "next-auth";

declare module "next-auth" {
    // 💡 기존 Session 인터페이스를 병합(Merge)하여 확장합니다.
    interface Session {
        user: {
            id: string;
        } & DefaultSession["user"];
    }
}
