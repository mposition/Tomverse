/** Environment shared by a reviewer and its account usage probe. */
export function reviewerEnv(provider, source = process.env) {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SYSTEMROOT", "USERPROFILE", "APPDATA",
    "LOCALAPPDATA", ...(provider.passEnv ?? [])];
  const env = {};
  for (const name of names) if (source[name] !== undefined) env[name] = source[name];
  return env;
}
