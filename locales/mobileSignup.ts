import type { MobileLanguage } from "./mobile";

const en = {
  intro: "Enter your email to sign in or create a Tomverse account.",
  title: "Create your Tomverse account",
  verified: "Your email is verified. Create an account with this address to continue.",
  create: "Create account and continue",
  optionsChanged: "Sign-up options changed. Request a new code to continue.",
  incomplete: "Your account was created, but sign-up could not finish. Request a new code to sign in.",
  updateRequired: "Update the app to create an account here, or sign up on the Tomverse website.",
};
export const mobileSignupCopy: Record<MobileLanguage, typeof en> = {
  en,
  ko: {
    intro: "이메일을 입력해 로그인하거나 Tomverse에 새로 가입하세요.",
    title: "Tomverse 회원가입",
    verified: "이메일 인증이 완료되었습니다. 이 주소로 새 계정을 만들고 시작하세요.",
    create: "가입하고 시작하기",
    optionsChanged: "가입 옵션이 변경되었습니다. 새 인증 코드를 받아 계속해 주세요.",
    incomplete: "계정은 생성됐지만 가입을 마무리하지 못했습니다. 새 인증 코드로 로그인해 주세요.",
    updateRequired: "앱을 업데이트하면 여기서 가입할 수 있습니다. Tomverse 웹사이트에서도 가입할 수 있습니다.",
  },
  zh: {
    intro: "输入电子邮箱以登录或创建 Tomverse 账户。", title: "创建 Tomverse 账户",
    verified: "邮箱验证已完成。使用此邮箱创建账户以继续。", create: "创建账户并继续",
    optionsChanged: "注册选项已更改。请获取新的验证码以继续。", incomplete: "账户已创建，但注册未能完成。请获取新的验证码登录。",
    updateRequired: "请更新应用以在此注册，也可以在 Tomverse 网站注册。",
  },
  de: {
    intro: "Gib deine E-Mail-Adresse ein, um dich anzumelden oder ein Tomverse-Konto zu erstellen.", title: "Tomverse-Konto erstellen",
    verified: "Deine E-Mail-Adresse ist bestätigt. Erstelle mit dieser Adresse ein Konto, um fortzufahren.", create: "Konto erstellen und fortfahren",
    optionsChanged: "Die Registrierungsoptionen haben sich geändert. Fordere einen neuen Code an.", incomplete: "Dein Konto wurde erstellt, die Registrierung aber nicht abgeschlossen. Fordere einen neuen Code zur Anmeldung an.",
    updateRequired: "Aktualisiere die App, um hier ein Konto zu erstellen, oder registriere dich auf der Tomverse-Website.",
  },
  fr: {
    intro: "Saisissez votre adresse e-mail pour vous connecter ou créer un compte Tomverse.", title: "Créer votre compte Tomverse",
    verified: "Votre adresse e-mail est vérifiée. Créez un compte avec cette adresse pour continuer.", create: "Créer un compte et continuer",
    optionsChanged: "Les options d’inscription ont changé. Demandez un nouveau code pour continuer.", incomplete: "Votre compte a été créé, mais l’inscription n’a pas abouti. Demandez un nouveau code pour vous connecter.",
    updateRequired: "Mettez l’application à jour pour vous inscrire ici, ou inscrivez-vous sur le site Tomverse.",
  },
  es: {
    intro: "Introduce tu correo electrónico para iniciar sesión o crear una cuenta de Tomverse.", title: "Crea tu cuenta de Tomverse",
    verified: "Tu correo electrónico está verificado. Crea una cuenta con esta dirección para continuar.", create: "Crear cuenta y continuar",
    optionsChanged: "Las opciones de registro han cambiado. Solicita un código nuevo para continuar.", incomplete: "Tu cuenta se ha creado, pero el registro no se ha completado. Solicita un código nuevo para iniciar sesión.",
    updateRequired: "Actualiza la aplicación para registrarte aquí o regístrate en el sitio web de Tomverse.",
  },
  pt: {
    intro: "Introduza o seu e-mail para iniciar sessão ou criar uma conta Tomverse.", title: "Criar a sua conta Tomverse",
    verified: "O seu e-mail foi verificado. Crie uma conta com este endereço para continuar.", create: "Criar conta e continuar",
    optionsChanged: "As opções de registo foram alteradas. Peça um novo código para continuar.", incomplete: "A sua conta foi criada, mas o registo não foi concluído. Peça um novo código para iniciar sessão.",
    updateRequired: "Atualize a aplicação para se registar aqui ou registe-se no site Tomverse.",
  },
};
