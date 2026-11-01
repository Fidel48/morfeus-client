import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  messageId: string;
  children: React.ReactNode;
}

/**
 * Contains render failures to a single chat message so one bad payload can never
 * blank the whole conversation or force the user to reset app state.
 */
export class MessageErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[Chat] message ${this.props.messageId} failed to render:`, error);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.messageId !== this.props.messageId) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center gap-2 w-full max-w-3xl ml-11 text-xs text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-xl px-3 py-2">
          <AlertTriangle size={13} />
          <span>This message couldn&apos;t be displayed.</span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="ml-auto underline underline-offset-2 hover:text-amber-200"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
