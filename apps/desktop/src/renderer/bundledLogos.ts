/**
 * The platform logos this app was built with (the web's own `public/plugins/providers` files). A logo the app carries is shown
 * from the app itself; only one it does not carry (a platform added to the server's list later) is fetched from the account
 * origin. A deployment behind an access gate (dev) answers those public files with a sign-in page, so a fetched logo cannot be
 * relied on there. A logo path is looked up as a whole key; nothing the server sends becomes a file path.
 */
const logos = import.meta.glob<string>("../../../../public/plugins/providers/*.{png,svg,jpg}", {
  eager: true, query: "?url", import: "default",
});

export const bundledLogoFile = (logo: string | null | undefined): string | undefined =>
  logo?.startsWith("/plugins/providers/") ? logos["../../../../public" + logo] : undefined;
