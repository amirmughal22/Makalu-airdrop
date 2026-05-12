import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string;
  onValueChange: (v: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs components must be used within Tabs");
  return ctx;
}

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn("rounded-md bg-slate-100 p-1 text-slate-500 dark:bg-[#0a0a0a] dark:text-slate-400", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  value,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { value: string }) {
  const { value: selected, onValueChange } = useTabs();
  const isActive = selected === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:opacity-50 dark:ring-offset-[#111111]",
        isActive && "bg-white text-slate-950 shadow-sm dark:bg-[#111111] dark:text-slate-50 dark:shadow-none dark:ring-1 dark:ring-[#333333]",
        className
      )}
      onClick={() => onValueChange(value)}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  value,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: string }) {
  const { value: selected } = useTabs();
  if (selected !== value) return null;
  return <div role="tabpanel" className={cn("mt-2 ring-offset-white focus-visible:outline-none dark:ring-offset-[#111111]", className)} {...props} />;
}
