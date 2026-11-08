import { Component, type ReactNode } from 'react';

// Keeps one broken panel from blanking the whole page. A crash inside the boundary shows a small
// panel with the error and a way out instead of React unmounting everything (a black screen).
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string; onReset?: () => void; resetKey?: unknown },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[firstline] ${this.props.label} crashed:`, error);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    // Selecting another household (or closing it) clears a crashed card.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const reset = () => {
      this.setState({ error: null });
      this.props.onReset?.();
    };
    return (
      <section className="panel crashpanel" role="alert">
        <div className="label">{this.props.label} hit an error</div>
        <div className="nc muted">{this.state.error.message}</div>
        <div className="crashbtns">
          {this.props.onReset && (
            <button className="btn" onClick={reset}>
              Close
            </button>
          )}
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </section>
    );
  }
}
