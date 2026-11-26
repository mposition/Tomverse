/**
 * Which windows the person can never pick for the computer tools. This is the only list: the window picker, the check at selection
 * and the check before every action all read it. It is by program (the executable name) and window class, never by title, because
 * a title is whatever the program writes; a program that is on the list stays out whatever it calls its window.
 *
 * Why these: a terminal or shell would run commands without the command approvals; a browser may hold a signed-in account, a bank
 * or a payment page (web pages are the browser tools' job); a password manager and system settings hold secrets and security
 * controls; remote desktop and screen sharing tools act on another computer; the shell of the desktop (taskbar, Start, the desktop
 * itself) and the system's own prompts (UAC, sign-in, credential dialogs) are not applications. Tomverse Desktop itself is refused
 * by process id as well, so it cannot be driven by renaming anything.
 *
 * Windows is the only platform with a backend, so only Windows names are listed. The other platforms are "not supported", not
 * "supported with a shorter list".
 */

/** Executable names without the extension, lower case. */
export const DENIED_PROGRAMS: ReadonlyArray<readonly [name: string, why: DenyReason]> = [
  // Terminals and shells
  ["cmd", "terminal"], ["powershell", "terminal"], ["powershell_ise", "terminal"], ["pwsh", "terminal"], ["windowsterminal", "terminal"],
  ["wt", "terminal"], ["conhost", "terminal"], ["openconsole", "terminal"], ["wsl", "terminal"], ["wslhost", "terminal"], ["bash", "terminal"],
  ["mintty", "terminal"], ["alacritty", "terminal"], ["wezterm-gui", "terminal"], ["putty", "terminal"], ["kitty", "terminal"],
  ["hyper", "terminal"], ["tabby", "terminal"], ["cmder", "terminal"], ["conemu64", "terminal"], ["conemu", "terminal"],
  // Browsers
  ["chrome", "browser"], ["msedge", "browser"], ["firefox", "browser"], ["brave", "browser"], ["opera", "browser"], ["opera_gx", "browser"],
  ["vivaldi", "browser"], ["iexplore", "browser"], ["arc", "browser"], ["chromium", "browser"], ["tor", "browser"], ["waterfox", "browser"],
  ["librewolf", "browser"], ["zen", "browser"], ["yandex", "browser"], ["duckduckgo", "browser"],
  // Password managers and secret stores
  ["1password", "secrets"], ["bitwarden", "secrets"], ["keepass", "secrets"], ["keepassxc", "secrets"], ["lastpass", "secrets"],
  ["dashlane", "secrets"], ["enpass", "secrets"], ["nordpass", "secrets"], ["roboform", "secrets"], ["keeper", "secrets"],
  ["protonpass", "secrets"], ["authy", "secrets"], ["yubikeymanager", "secrets"], ["yubioauthenticator", "secrets"], ["certmgr", "secrets"],
  // System settings, security and administration
  ["systemsettings", "system"], ["systemsettingsbroker", "system"], ["control", "system"], ["mmc", "system"], ["regedit", "system"],
  ["taskmgr", "system"], ["secpol", "system"], ["gpedit", "system"], ["compmgmt", "system"], ["eventvwr", "system"], ["services", "system"],
  ["msconfig", "system"], ["wf", "system"], ["windowsdefender", "system"], ["securityhealthsystray", "system"], ["securityhealthhost", "system"],
  ["applicationframehost", "system"], ["settingssynchost", "system"], ["credwiz", "system"], ["netplwiz", "system"],
  // The system's own prompts and sign-in
  ["consent", "prompt"], ["logonui", "prompt"], ["winlogon", "prompt"], ["credentialuibroker", "prompt"], ["lockapp", "prompt"],
  ["windows.immersivecontrolpanel", "prompt"], ["searchhost", "prompt"], ["startmenuexperiencehost", "prompt"], ["shellexperiencehost", "prompt"],
  ["textinputhost", "prompt"], ["dwm", "prompt"], ["explorer", "shell"],
  // Remote control of another computer
  ["mstsc", "remote"], ["anydesk", "remote"], ["teamviewer", "remote"], ["rustdesk", "remote"], ["vncviewer", "remote"], ["tightvnc", "remote"],
  ["parsecd", "remote"], ["splashtop", "remote"], ["screenconnect", "remote"], ["msra", "remote"], ["quickassist", "remote"],
];

/** Window classes the desktop itself and some terminals use, whatever program owns them. */
export const DENIED_CLASSES: ReadonlyArray<readonly [cls: string, why: DenyReason]> = [
  ["Shell_TrayWnd", "shell"], ["Shell_SecondaryTrayWnd", "shell"], ["Progman", "shell"], ["WorkerW", "shell"],
  ["NotifyIconOverflowWindow", "shell"], ["TopLevelWindowForOverflowXamlIsland", "shell"], ["XamlExplorerHostIslandWindow", "shell"],
  ["Windows.UI.Core.CoreWindow", "shell"], ["ApplicationFrameWindow", "system"], ["#32769", "shell"],
  ["ConsoleWindowClass", "terminal"], ["CASCADIA_HOSTING_WINDOW_CLASS", "terminal"], ["PseudoConsoleWindow", "terminal"], ["VirtualConsoleClass", "terminal"],
  ["mintty", "terminal"], ["TscShellContainerClass", "remote"], ["CredentialUIBroker", "prompt"],
  ["Credential Dialog Xaml Host", "prompt"], ["Credential UI", "prompt"],
];

export type DenyReason = "terminal" | "browser" | "secrets" | "system" | "prompt" | "shell" | "remote" | "self";

export type DeniableWindow = { app: string; cls: string; pid: number };

/** Why a window can never be chosen, or null. `ownPids`: the processes of Tomverse Desktop itself. */
export function windowDenial(window: DeniableWindow, ownPids: readonly number[]): DenyReason | null {
  if (ownPids.includes(window.pid)) return "self";
  const app = window.app.trim().toLowerCase().replace(/\.exe$/, "");
  if (!app) return "system";
  const program = DENIED_PROGRAMS.find(([name]) => name === app);
  if (program) return program[1];
  if (/^tomverse/.test(app)) return "self";
  const cls = DENIED_CLASSES.find(([name]) => name === window.cls);
  return cls ? cls[1] : null;
}
