// Hours on their own tab in the menu (Alan, 2026-11-02: "move hours to the
// column on the left so the guys can log in their hours easier"). Same
// form as before; it used to be a tab inside My Schedule.
import MyHours from "@/components/MyHours";
import { tr } from "@/lib/i18n";

export default function MyHoursPage() {
  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <h1 className="mb-4 text-2xl font-bold">{tr("My Hours")}</h1>
      <MyHours />
    </div>
  );
}
