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
 * Windows and Linux (X11) have a backend. The names of both are in this one list and are checked on both: a program that is a
 * terminal, browser or password manager is refused wherever it runs. macOS has no backend, so it has no names here: it is "not
 * supported", not "supported with a shorter list". On Linux `app` is the name of the executable of the window's process.
 */

/** Executable names without the extension, lower case. */
export const DENIED_PROGRAMS: ReadonlyArray<readonly [name: string, why: DenyReason]> = [
  // Terminals and shells
  ["cmd", "terminal"], ["powershell", "terminal"], ["powershell_ise", "terminal"], ["pwsh", "terminal"], ["windowsterminal", "terminal"],
  ["wt", "terminal"], ["conhost", "terminal"], ["openconsole", "terminal"], ["wsl", "terminal"], ["wslhost", "terminal"], ["bash", "terminal"],
  ["mintty", "terminal"], ["alacritty", "terminal"], ["wezterm-gui", "terminal"], ["putty", "terminal"], ["kitty", "terminal"],
  ["hyper", "terminal"], ["tabby", "terminal"], ["cmder", "terminal"], ["conemu64", "terminal"], ["conemu", "terminal"],
  ["gnome-terminal", "terminal"], ["gnome-terminal-server", "terminal"], ["konsole", "terminal"], ["xterm", "terminal"], ["uxterm", "terminal"],
  ["urxvt", "terminal"], ["rxvt", "terminal"], ["st", "terminal"], ["foot", "terminal"], ["terminator", "terminal"], ["tilix", "terminal"],
  ["xfce4-terminal", "terminal"], ["lxterminal", "terminal"], ["mate-terminal", "terminal"], ["qterminal", "terminal"], ["guake", "terminal"],
  ["yakuake", "terminal"], ["terminology", "terminal"], ["sakura", "terminal"], ["kgx", "terminal"], ["gnome-console", "terminal"],
  ["ptyxis", "terminal"], ["blackbox", "terminal"], ["wezterm", "terminal"], ["cool-retro-term", "terminal"], ["zsh", "terminal"],
  ["fish", "terminal"], ["sh", "terminal"], ["dash", "terminal"], ["ksh", "terminal"], ["tcsh", "terminal"], ["tmux", "terminal"],
  // Browsers
  ["chrome", "browser"], ["msedge", "browser"], ["firefox", "browser"], ["brave", "browser"], ["opera", "browser"], ["opera_gx", "browser"],
  ["vivaldi", "browser"], ["iexplore", "browser"], ["arc", "browser"], ["chromium", "browser"], ["tor", "browser"], ["waterfox", "browser"],
  ["librewolf", "browser"], ["zen", "browser"], ["yandex", "browser"], ["duckduckgo", "browser"],
  ["google-chrome", "browser"], ["google-chrome-stable", "browser"], ["google-chrome-beta", "browser"], ["chromium-browser", "browser"],
  ["brave-browser", "browser"], ["microsoft-edge", "browser"], ["microsoft-edge-stable", "browser"], ["firefox-bin", "browser"],
  ["firefox-esr", "browser"], ["vivaldi-bin", "browser"], ["vivaldi-stable", "browser"], ["opera-stable", "browser"], ["epiphany", "browser"],
  ["falkon", "browser"], ["midori", "browser"], ["qutebrowser", "browser"], ["thorium-browser", "browser"], ["zen-browser", "browser"],
  ["mullvad-browser", "browser"], ["tor-browser", "browser"], ["floorp", "browser"], ["konqueror", "browser"],
  // Password managers and secret stores
  ["1password", "secrets"], ["bitwarden", "secrets"], ["keepass", "secrets"], ["keepassxc", "secrets"], ["lastpass", "secrets"],
  ["dashlane", "secrets"], ["enpass", "secrets"], ["nordpass", "secrets"], ["roboform", "secrets"], ["keeper", "secrets"],
  ["protonpass", "secrets"], ["authy", "secrets"], ["yubikeymanager", "secrets"], ["yubioauthenticator", "secrets"], ["certmgr", "secrets"],
  ["seahorse", "secrets"], ["gnome-keyring", "secrets"], ["gnome-keyring-daemon", "secrets"], ["kwalletmanager5", "secrets"], ["kwalletmanager", "secrets"],
  ["kwalletd5", "secrets"], ["kwalletd6", "secrets"], ["keepass2", "secrets"], ["pass", "secrets"], ["gopass", "secrets"], ["bitwarden-desktop", "secrets"],
  // System settings, security and administration
  ["systemsettings", "system"], ["systemsettingsbroker", "system"], ["control", "system"], ["mmc", "system"], ["regedit", "system"],
  ["taskmgr", "system"], ["secpol", "system"], ["gpedit", "system"], ["compmgmt", "system"], ["eventvwr", "system"], ["services", "system"],
  ["msconfig", "system"], ["wf", "system"], ["windowsdefender", "system"], ["securityhealthsystray", "system"], ["securityhealthhost", "system"],
  ["gnome-control-center", "system"], ["gnome-system-monitor", "system"], ["ksysguard", "system"], ["plasma-systemmonitor", "system"],
  ["kcmshell5", "system"], ["kcmshell6", "system"], ["xfce4-settings-manager", "system"], ["synaptic", "system"], ["gnome-software", "system"],
  ["plasma-discover", "system"], ["gparted", "system"], ["gnome-disks", "system"], ["ufw", "system"], ["gufw", "system"], ["firewall-config", "system"],
  ["nm-connection-editor", "system"], ["blueman-manager", "system"], ["dconf-editor", "system"], ["virt-manager", "system"],
  ["applicationframehost", "system"], ["settingssynchost", "system"], ["credwiz", "system"], ["netplwiz", "system"],
  // The system's own prompts and sign-in
  ["consent", "prompt"], ["logonui", "prompt"], ["winlogon", "prompt"], ["credentialuibroker", "prompt"], ["lockapp", "prompt"],
  ["windows.immersivecontrolpanel", "prompt"], ["searchhost", "prompt"], ["startmenuexperiencehost", "prompt"], ["shellexperiencehost", "prompt"],
  ["textinputhost", "prompt"], ["dwm", "prompt"], ["explorer", "shell"],
  ["polkit-gnome-authentication-agent-1", "prompt"], ["polkit-kde-authentication-agent-1", "prompt"], ["lxpolkit", "prompt"], ["xfce-polkit", "prompt"],
  ["polkit-mate-authentication-agent-1", "prompt"], ["pkexec", "prompt"], ["gcr-prompter", "prompt"], ["pinentry", "prompt"], ["pinentry-gnome3", "prompt"],
  ["pinentry-qt", "prompt"], ["pinentry-gtk-2", "prompt"], ["ssh-askpass", "prompt"], ["gnome-screensaver", "prompt"], ["xscreensaver", "prompt"],
  ["xsecurelock", "prompt"], ["i3lock", "prompt"], ["light-locker", "prompt"], ["xfce4-screensaver", "prompt"], ["gdm", "prompt"], ["lightdm", "prompt"],
  ["sddm", "prompt"], ["gnome-shell", "shell"], ["plasmashell", "shell"], ["xfdesktop", "shell"], ["xfce4-panel", "shell"], ["nautilus", "shell"],
  ["dolphin", "shell"], ["thunar", "shell"], ["nemo", "shell"], ["pcmanfm", "shell"], ["pcmanfm-qt", "shell"], ["caja", "shell"], ["cinnamon", "shell"],
  ["mutter", "shell"], ["kwin_x11", "shell"], ["budgie-panel", "shell"], ["lxpanel", "shell"], ["lxqt-panel", "shell"], ["polybar", "shell"], ["tint2", "shell"],
  // Remote control of another computer
  ["mstsc", "remote"], ["anydesk", "remote"], ["teamviewer", "remote"], ["rustdesk", "remote"], ["vncviewer", "remote"], ["tightvnc", "remote"],
  ["parsecd", "remote"], ["splashtop", "remote"], ["screenconnect", "remote"], ["msra", "remote"], ["quickassist", "remote"],
  ["remmina", "remote"], ["vinagre", "remote"], ["xfreerdp", "remote"], ["wlfreerdp", "remote"], ["rdesktop", "remote"], ["krdc", "remote"],
  ["x11vnc", "remote"], ["tigervnc", "remote"], ["vncviewer.real", "remote"], ["gnome-connections", "remote"], ["ssh", "remote"], ["teamviewer.real", "remote"],
  ["nxplayer.bin", "remote"], ["nomachine", "remote"], ["rustdesk-bin", "remote"], ["chrome-remote-desktop", "remote"],
];

/** Window classes the desktop itself and some terminals use, whatever program owns them. */
export const DENIED_CLASSES: ReadonlyArray<readonly [cls: string, why: DenyReason]> = [
  ["Shell_TrayWnd", "shell"], ["Shell_SecondaryTrayWnd", "shell"], ["Progman", "shell"], ["WorkerW", "shell"],
  ["NotifyIconOverflowWindow", "shell"], ["TopLevelWindowForOverflowXamlIsland", "shell"], ["XamlExplorerHostIslandWindow", "shell"],
  ["Windows.UI.Core.CoreWindow", "shell"], ["ApplicationFrameWindow", "system"], ["#32769", "shell"],
  ["ConsoleWindowClass", "terminal"], ["CASCADIA_HOSTING_WINDOW_CLASS", "terminal"], ["PseudoConsoleWindow", "terminal"], ["VirtualConsoleClass", "terminal"],
  ["mintty", "terminal"], ["TscShellContainerClass", "remote"], ["CredentialUIBroker", "prompt"],
  ["Gnome-terminal", "terminal"], ["Gnome-shell", "shell"], ["Plasmashell", "shell"], ["Xfdesktop", "shell"], ["Xfce4-panel", "shell"], ["XTerm", "terminal"],
  ["UXTerm", "terminal"], ["URxvt", "terminal"], ["konsole", "terminal"], ["Konsole", "terminal"], ["Alacritty", "terminal"], ["kitty", "terminal"],
  ["Firefox", "browser"], ["firefox", "browser"], ["Navigator", "browser"], ["Google-chrome", "browser"], ["Chromium", "browser"], ["Chromium-browser", "browser"],
  ["Brave-browser", "browser"], ["Microsoft-edge", "browser"], ["Vivaldi-stable", "browser"], ["Opera", "browser"], ["epiphany", "browser"], ["Epiphany", "browser"],
  ["Polkit-gnome-authentication-agent-1", "prompt"], ["Pinentry", "prompt"], ["Pinentry-gtk-2", "prompt"], ["Ssh-askpass", "prompt"],
  ["KeePassXC", "secrets"], ["Seahorse", "secrets"], ["Bitwarden", "secrets"], ["1Password", "secrets"], ["Gnome-control-center", "system"], ["Remmina", "remote"],
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
