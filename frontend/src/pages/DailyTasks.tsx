import DailyTaskList from "@/components/DailyTaskList";

export default function DailyTasks() {
  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Daily Task List</h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
          Work every lead until you hear a yes or a no — nothing slips through the cracks.
        </p>
      </div>
      <DailyTaskList />
    </div>
  );
}
