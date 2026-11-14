import { Component, type ReactNode } from 'react';

type Props = { name: string; children: ReactNode; onFailure?: () => void; onClose?: () => void };
export class FeatureBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Do not include props, messages, source labels or the caught exception in diagnostics.
    console.error('Feature rendering failed:', this.props.name);
    this.props.onFailure?.();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        className="feature-failure"
        role="alert"
        aria-label={this.props.name + ' unavailable'}
      >
        <p>{this.props.name} could not be displayed.</p>
        <button className="secondary" onClick={() => this.setState({ failed: false })}>
          Retry
        </button>
        {this.props.onClose && (
          <button className="text-button" onClick={this.props.onClose}>
            Close
          </button>
        )}
      </section>
    );
  }
}
