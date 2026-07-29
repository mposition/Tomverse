import { MarketingShell } from "@/components/marketing/MarketingShell";

export const dynamic = "force-static";
export const revalidate = false;

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <MarketingShell>{children}</MarketingShell>;
}
