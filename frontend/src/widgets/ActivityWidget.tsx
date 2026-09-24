import { memo } from 'react';
import './ActivityWidget.css';

export type ActivityEntry = {
  id: string;
  /** Short name of what happened — usually the tool that ran. */
  label: string;
  /** One line of detail: arguments, a result, an error message. */
  detail?: string;
  /** A page the agent opened, shown as a link. */
  url?: string;
  status: 'running' | 'done' | 'error';
  at: number;
};

export type ActivityWidgetData = {
  title?: string;
  entries: ActivityEntry[];
};

/**
 * ActivityWidget — what the agent is actually doing.
 *
 * When Synapse is fronting an external agent, the most valuable thing on the
 * canvas is not the finished artifact, it is the work in progress: which tool
 * just ran, which page it opened, what came back, what failed. This is that
 * feed. Newest first, because the live edge is what you are watching.
 */
function ActivityWidget({ data }: { data: ActivityWidgetData }) {
  const entries = data.entries ?? [];

  return (
    <div className="activity">
      <div className="activity-head">
        <span className="activity-title">{data.title ?? 'Activity'}</span>
        <span className="activity-count">{entries.length}</span>
      </div>

      {entries.length === 0 ? (
        <p className="activity-empty">Nothing yet.</p>
      ) : (
        <ol className="activity-list">
          {[...entries].reverse().map((e) => (
            <li key={e.id} className={`activity-row is-${e.status}`}>
              <span className="activity-dot" aria-hidden="true" />
              <div className="activity-main">
                <span className="activity-label">{e.label}</span>
                {e.detail && <span className="activity-detail">{e.detail}</span>}
                {e.url && (
                  // Opened pages are real links: seeing that an agent visited
                  // something is only half of it, you want to go look.
                  <a
                    className="activity-url"
                    href={e.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={e.url}
                  >
                    {safeHost(e.url)}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

export const MemoActivityWidget = memo(ActivityWidget, (a, b) => a.data === b.data);
