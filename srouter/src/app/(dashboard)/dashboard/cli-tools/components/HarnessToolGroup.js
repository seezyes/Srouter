"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Card } from "@/shared/components";
import ToolSummaryCard from "./ToolSummaryCard";

export default function HarnessToolGroup({ group, statuses }) {
  const [expanded, setExpanded] = useState(false);
  const focusRequested = useRef(false);
  const toggle = () => {
    focusRequested.current = true;
    setExpanded(value => !value);
  };
  const focusControl = node => {
    if (node && focusRequested.current) {
      node.focus();
      focusRequested.current = false;
    }
  };

  if (expanded) {
    return group.entries.map(([toolId, tool], index) => (
      <div key={toolId} className="relative flex min-w-0 flex-col [&>a]:flex-1">
        <ToolSummaryCard toolId={toolId} tool={tool} status={statuses[toolId]} />
        {index === 0 && (
          <button
            ref={focusControl}
            type="button"
            aria-expanded={true}
            aria-label={`Collapse ${group.name} harnesses`}
            onClick={toggle}
            className="absolute right-1 top-full z-20 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs leading-none text-text-muted shadow-sm hover:text-text-main focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span aria-hidden="true">⌃ </span>Collapse {group.name}
          </button>
        )}
      </div>
    ));
  }

  const tool = group.entries[0][1];
  return (
    <Card padding="none" className="h-full overflow-hidden hover:border-primary/50 transition-colors">
      <button
        ref={focusControl}
        type="button"
        aria-expanded={false}
        aria-label={`Expand ${group.name} harnesses: ${group.entries.map(([, item]) => item.name).join(", ")}`}
        onClick={toggle}
        className="flex h-full w-full items-center gap-3 p-4 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
      >
        <Image src={tool.image} alt="" width={32} height={32} className="size-8 shrink-0 object-contain rounded-lg" sizes="32px" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">{group.name}</span>
          <span className="block mt-1 text-[10px] text-text-muted">
            {group.entries.map(([, item]) => item.name).join(" · ")}
          </span>
        </span>
        <span aria-hidden="true" className="material-symbols-outlined text-text-muted text-[18px] shrink-0">expand_more</span>
      </button>
    </Card>
  );
}
