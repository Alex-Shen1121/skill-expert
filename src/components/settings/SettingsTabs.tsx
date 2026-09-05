import { useRef, type ReactNode } from "react";

interface SettingsTab {
  key: string;
  label: string;
  icon: ReactNode;
  description?: string;
  content: ReactNode;
}

interface SettingsTabsProps {
  id: string;
  label: string;
  tabs: SettingsTab[];
  selected: string;
  onSelect: (key: string) => void;
  purposes?: boolean;
}

export function SettingsTabs({
  id,
  label,
  tabs,
  selected,
  onSelect,
  purposes = false,
}: SettingsTabsProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <>
      <div
        className={purposes ? "settings-agent-choices" : "settings-tabs"}
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`${id}-tab-${tab.key}`}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            aria-controls={`${id}-panel-${tab.key}`}
            aria-selected={selected === tab.key}
            aria-label={tab.label}
            tabIndex={selected === tab.key ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              event.stopPropagation();
              onSelect(tabs[next].key);
              buttons.current[next]?.focus();
            }}
          >
            <span
              className={purposes ? "settings-purpose-icon" : "contents"}
              aria-hidden="true"
            >
              {tab.icon}
            </span>
            <span className="settings-tab-label">
              {tab.label}
              {tab.description && <small>{tab.description}</small>}
            </span>
            {purposes && <i aria-hidden="true" />}
          </button>
        ))}
      </div>
      {/* 保持面板挂载，让未保存输入和管理能力草稿随分类切换保留。 */}
      {tabs.map(({ key, content }) => (
        <div
          key={key}
          role="tabpanel"
          id={`${id}-panel-${key}`}
          aria-labelledby={`${id}-tab-${key}`}
          hidden={selected !== key}
          tabIndex={0}
          className="settings-tabpanel"
        >
          {content}
        </div>
      ))}
    </>
  );
}
