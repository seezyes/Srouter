import { DashboardLayout } from "@/shared/components";
import IsoCubeBackground from "@/app/landing/components/IsoCubeBackground";

export default function DashboardRootLayout({ children }) {
  return (
    <DashboardLayout>
      {/* Static Iso Cube Field app background, filling <main> behind the dashboard content. */}
      <IsoCubeBackground variant="contained" baseClassName="bg-bg bg-app-gradient" />
      {children}
    </DashboardLayout>
  );
}

