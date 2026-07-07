import type { Config } from "tailwindcss";

const config: Config = {
    // 💡 클래스(html에 부착된 class="dark")를 기준으로 다크 모드를 제어하겠다고 명시합니다.
    darkMode: "class",
    content: [
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {},
    },
    plugins: [],
};
export default config;