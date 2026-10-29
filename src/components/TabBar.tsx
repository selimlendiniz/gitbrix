import { useStore } from "../store";
import { IconClose, IconPlus } from "./Icons";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const repo = useStore((s) => s.repo);
  const busy = useStore((s) => s.busy);
  const openRepo = useStore((s) => s.openRepo);
  const closeTab = useStore((s) => s.closeTab);
  const closeRepo = useStore((s) => s.closeRepo);
  if (tabs.length === 0) return null;

  return (
    <nav className="tabbar" role="tablist">
      {tabs.map((t) => {
        const active = t.path === repo?.path;
        return (
          <div
            key={t.path}
            role="tab"
            aria-selected={active}
            className={`tab${active ? " active" : ""}`}
            title={t.path}
            onClick={() => !active && !busy && openRepo(t.path)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
          >
            <span className="tab-name">{t.name}</span>
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.path);
              }}
            >
              <IconClose size={10} />
            </button>
          </div>
        );
      })}
      <button className="tab-new" title="Open another repository" onClick={() => !busy && closeRepo()}>
        <IconPlus size={12} />
      </button>
    </nav>
  );
}
