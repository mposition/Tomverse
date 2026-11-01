import type { MobileLanguage } from "./mobile";

const en = {
  intro: "Enter your email. Enter the code here to stay in the app.",
  title: "Create your Tomverse account",
  verified: "Your email is verified. Create an account with this address to continue.",
  create: "Create account and continue",
  unavailable: "App sign-up is unavailable right now. Request a new code or sign up on the Tomverse website.",
};
export const mobileSignupCopy: Record<MobileLanguage, typeof en> = {
  en,
  ko: { intro: "이메일로 받은 인증 코드를 앱에서 입력하세요.", title: "Tomverse 회원가입", verified: "이메일 인증이 완료되었습니다. 이 주소로 새 계정을 만들고 시작하세요.", create: "가입하고 시작하기", unavailable: "현재 앱에서 가입을 완료할 수 없습니다. 새 코드를 받거나 Tomverse 웹사이트에서 가입해 주세요." },
  zh: { intro: "输入电子邮箱，并在应用内输入收到的验证码。", title: "创建 Tomverse 账户", verified: "邮箱验证已完成。使用此邮箱创建账户以继续。", create: "创建账户并继续", unavailable: "目前无法在应用内注册。请获取新验证码或在 Tomverse 网站注册。" },
  de: { intro: "Gib deine E-Mail-Adresse und anschließend den Code hier in der App ein.", title: "Tomverse-Konto erstellen", verified: "Deine E-Mail-Adresse ist bestätigt. Erstelle mit dieser Adresse ein Konto, um fortzufahren.", create: "Konto erstellen und fortfahren", unavailable: "Die Registrierung in der App ist derzeit nicht verfügbar. Fordere einen neuen Code an oder registriere dich auf der Tomverse-Website." },
  fr: { intro: "Saisissez votre adresse e-mail, puis le code reçu directement dans l’application.", title: "Créer votre compte Tomverse", verified: "Votre adresse e-mail est vérifiée. Créez un compte avec cette adresse pour continuer.", create: "Créer un compte et continuer", unavailable: "L’inscription dans l’application est indisponible. Demandez un nouveau code ou inscrivez-vous sur le site Tomverse." },
  es: { intro: "Introduce tu correo electrónico y después el código recibido aquí en la aplicación.", title: "Crea tu cuenta de Tomverse", verified: "Tu correo electrónico está verificado. Crea una cuenta con esta dirección para continuar.", create: "Crear cuenta y continuar", unavailable: "El registro en la aplicación no está disponible ahora. Solicita un código nuevo o regístrate en el sitio web de Tomverse." },
  pt: { intro: "Introduza o seu e-mail e depois o código recebido aqui na aplicação.", title: "Criar a sua conta Tomverse", verified: "O seu e-mail foi verificado. Crie uma conta com este endereço para continuar.", create: "Criar conta e continuar", unavailable: "O registo na aplicação está indisponível. Peça um novo código ou registe-se no site Tomverse." },
};
