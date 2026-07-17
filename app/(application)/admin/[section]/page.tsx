import { notFound } from "next/navigation";
import {
  AdminWorkspace,
  isAdminWorkspaceView,
} from "../page";

export default async function AdminSectionPage({
  params,
}: PageProps<"/admin/[section]">) {
  const { section } = await params;
  if (!isAdminWorkspaceView(section)) notFound();
  return <AdminWorkspace activeView={section} />;
}
