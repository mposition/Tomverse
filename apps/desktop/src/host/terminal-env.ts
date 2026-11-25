import { commandEnv } from "../../../tomverse-cli/src/env.js";

// Names a person's shell needs on top of the command environment. Everything else is left out, and the shell's own
// profile files set up the rest, so a Tomverse session, an API key or a token in the app's environment never reaches it.
const terminalNames = [
  "LANGUAGE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "LC_COLLATE", "LC_MONETARY", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "SystemDrive", "PSModulePath", "ProgramW6432", "CommonProgramW6432",
  "PROCESSOR_IDENTIFIER", "PROCESSOR_ARCHITEW6432",
];

export function terminalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = commandEnv(terminalNames, source);
  // commandEnv serves commands whose output a model reads; a terminal is for a person.
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "TomverseDesktop";
  return env;
}
