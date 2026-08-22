import { Component, type ErrorInfo, type ReactNode } from "react";
import { PRODUCT_NAME } from "../../core/contracts.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/** Keeps an unexpected render failure recoverable instead of a blank page. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${PRODUCT_NAME} UI failed to render`, error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="app error-boundary" role="alert">
          <p>The interface hit an unexpected error.</p>
          <button className="primary-action" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
