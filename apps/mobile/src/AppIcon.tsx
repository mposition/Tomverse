import menu from "./assets/menu.svg";
import menuDark from "./assets/menu-dark.svg";
import logo from "../../../public/tomverse-logo.png";
import spark from "./assets/spark.svg";
import idea from "./assets/idea.svg";
import file from "./assets/file.svg";
import attach from "./assets/attach.svg";
import mic from "./assets/mic.svg";
import send from "./assets/send.svg";
import newChat from "./assets/new.svg";
import settings from "./assets/settings.svg";
import report from "./assets/report.svg";

const assets = { menu, menuDark, logo, spark, idea, file, attach, mic, send, newChat, settings, report };
export function AppIcon({ name }: { name: keyof typeof assets }) {
  // eslint-disable-next-line @next/next/no-img-element -- Native Vite assets never pass through Next.js.
  return <img className={`app-icon icon-${name}`} src={assets[name]} alt="" aria-hidden="true" />;
}
